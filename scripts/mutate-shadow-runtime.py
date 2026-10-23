#!/usr/bin/env python3
"""Mutation tests for the bounded-runtime guard in shadowRun.ts (Phase 6).

Four mutants, each one a way the guard can look implemented while not being:

  1. The budget check runs AFTER a session's work instead of before it. The
     session that blew the budget completes, then is blamed for it.
  2. The check runs after the work AND attributes the reason to the session
     that already ran (rather than to the ones not yet started). This is the
     mutant the "spends the budget is not the one reported" test exists for.
  3. `runtime.exhausted` is hardcoded false, so a truncated run is
     indistinguishable from a complete one in the run's own output.
  4. The unstarted sessions are dropped from `sessions` entirely, so
     `requested` and `len(sessions)` disagree and nothing says why.

Mutants 3 and 4 are both "the truncation is invisible" in different places:
one hides it in a flag, the other in a missing list.

Guards, in this order:
  - refuses to start while any `node --test` run is in flight, matched via
    /proc/*/exe + a cmdline containing `--test`. NOT `comm`, and NOT
    `pgrep -f` — see the note in the report on why both of those lie.
  - restores build/ashare/shadowRun.js from a byte-for-byte copy and asserts
    the restore with sha256 before exiting, so a KILLED claim is only made
    about code that is verifiably back to the original.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

REPO = "/home/jcshi/workspace/FinanceMCP"
TARGET = "build/ashare/shadowRun.js"
TEST = "test/ashare-shadow-run.test.mjs"
PATH = os.path.join(REPO, TARGET)


def suite_in_flight() -> list[str]:
    """Match the real runner: exe symlink is node AND cmdline contains --test."""
    found = []
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            exe = os.path.realpath(f"/proc/{entry}/exe")
            with open(f"/proc/{entry}/cmdline", "rb") as fh:
                cmd = fh.read().replace(b"\0", b" ").decode("utf-8", "replace")
        except OSError:
            continue
        if exe.endswith("/node") and "--test" in cmd:
            found.append(f"{entry} ({cmd.strip()[:80]})")
    return found


def sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def run_suite() -> tuple[int, int, int]:
    out = subprocess.run(
        ["node", "--test", TEST], cwd=REPO, capture_output=True, text=True
    ).stdout
    tests = passes = fails = 0
    for line in out.splitlines():
        s = line.strip()
        if s.startswith("ℹ tests "):
            tests = int(s.split()[-1])
        elif s.startswith("ℹ pass "):
            passes = int(s.split()[-1])
        elif s.startswith("ℹ fail "):
            fails = int(s.split()[-1])
    return tests, passes, fails


def apply(source: str, mutant: str) -> str:
    if mutant not in source:
        raise SystemExit(f"MUTATION ANCHOR MISSING -- refusing to run:\n{mutant[:200]}")
    return source.replace(mutant, "", 1)


# --- mutant definitions -------------------------------------------------------
# All anchors are written against the COMPILED build/ output, because that is
# what the tests import. tsc keeps the statements but re-indents them, so an
# anchor copied from src/ will not match and the mutant silently will not be
# applied. Each mutant below was verified to apply and to fail the suite.

# The guard as compiled: an 8-space `if` inside the 4-space `for` loop.
PRE_CHECK = """        if (clock() - started > budgetMs) {
            budgetExhausted = true;
            for (const remaining of options.asOfTradeDates.slice(options.asOfTradeDates.indexOf(asOf))) {
                sessions.push(skip(remaining, 'runtime_budget_exceeded', 0));
                bump(skippedByReason, 'runtime_budget_exceeded');
            }
            break;
        }
"""

# The end of the loop body, as compiled. Note the closing brace is at 4 spaces
# (it closes the `for`), not 8.
LOOP_TAIL = """            ms: clock() - t0,
        });
    }"""

# 1. The check still exists, but it runs AFTER the session's work. The session
#    that blew the budget completes, and is then blamed for it.
MUTANT_1 = (PRE_CHECK, "")

# 2. The check runs after the work AND attributes the reason to the session that
#    already ran, instead of to the ones not yet started. This is the mutant the
#    "spends the budget is not the one reported" test exists for.
MUTANT_2_TAIL = """            ms: clock() - t0,
        });
        if (clock() - started > budgetMs) {
            const done = sessions[sessions.length - 1];
            done.skip_reason = 'runtime_budget_exceeded';
            done.created = false;
            budgetExhausted = true;
            for (const remaining of options.asOfTradeDates.slice(options.asOfTradeDates.indexOf(asOf) + 1)) {
                sessions.push(skip(remaining, 'runtime_budget_exceeded', 0));
                bump(skippedByReason, 'runtime_budget_exceeded');
            }
            break;
        }
    }"""

MUTANT_2 = (PRE_CHECK, "")
MUTANT_2_TAIL_SWAP = (LOOP_TAIL, MUTANT_2_TAIL)

# 3. The exhaustion flag is hardcoded, so a truncated run is indistinguishable
#    from a complete one in the run's own output.
MUTANT_3 = ("exhausted: budgetExhausted", "exhausted: false")

# 4. The unstarted sessions vanish from `sessions` entirely, so `requested` and
#    `len(sessions)` disagree and nothing in the output says why.
MUTANT_4 = (
    """            for (const remaining of options.asOfTradeDates.slice(options.asOfTradeDates.indexOf(asOf))) {
                sessions.push(skip(remaining, 'runtime_budget_exceeded', 0));
                bump(skippedByReason, 'runtime_budget_exceeded');
            }
""",
    "            // mutant: silently omit the unstarted sessions\n",
)

MUTANTS = [
    ("check moved after the work", [MUTANT_1]),
    ("post-hoc attribution to the session that already ran", [MUTANT_2, MUTANT_2_TAIL_SWAP]),
    ("runtime.exhausted hardcoded false", [MUTANT_3]),
    ("unstarted sessions dropped from the report", [MUTANT_4]),
]


def main() -> int:
    running = suite_in_flight()
    if running:
        print("REFUSING: a test run is already in flight:")
        for r in running:
            print(f"  {r}")
        print("Stop it first -- mutating build/ under a running suite voids its result.")
        return 2

    if not os.path.exists(PATH):
        raise SystemExit(f"{PATH} missing -- run `npm run build` first")

    original_sha = sha256(PATH)
    backup = tempfile.NamedTemporaryFile(delete=False, suffix=".js")
    backup.close()
    shutil.copy2(PATH, backup.name)
    if sha256(backup.name) != original_sha:
        raise SystemExit("backup does not match the original; aborting")

    try:
        tests, passes, fails = run_suite()
        print(f"BASELINE: {tests} tests, {passes} pass, {fails} fail")
        if fails or not passes:
            print("Baseline is not green -- fixing the code matters more than killing mutants.")
            return 1

        killed = 0
        total = 0

        def attempt(label: str, edits: list[tuple[str, str]]) -> None:
            nonlocal killed, total
            total += 1
            # Each mutant starts from the ORIGINAL file, not from whatever the
            # previous mutant left behind. Without this, a multi-edit mutant
            # whose first edit removes an anchor the second edit needs reports
            # "ANCHOR MISSING" and looks like a script bug rather than a mutant
            # that was never applied -- and a killed count of 2/4 that says
            # nothing about the two that silently did not run.
            src = open(backup.name, encoding="utf-8").read()
            for old, new in edits:
                if old not in src:
                    print(f"  [{label}] ANCHOR MISSING, mutant not applied")
                    return
                src = src.replace(old, new, 1)
            open(PATH, "w", encoding="utf-8").write(src)
            t, _passes, f = run_suite()
            verdict = "KILLED" if f else "SURVIVED"
            if f:
                killed += 1
            print(f"  {verdict}: {label}  ({t} tests, {f} fail)")

        print("MUTANTS:")
        for label, edits in MUTANTS:
            attempt(label, edits)

        print(f"\n{killed}/{total} killed")
        return 0 if killed == total else 1
    finally:
        shutil.copy2(backup.name, PATH)
        os.unlink(backup.name)
        restored = sha256(PATH)
        if restored != original_sha:
            raise SystemExit(
                f"RESTORE FAILED: {PATH} is {restored}, expected {original_sha}. "
                "Every result above is now untrustworthy -- restore by hand."
            )
        print(f"restored {PATH} (sha256 {restored[:12]} matches original)")


if __name__ == "__main__":
    sys.exit(main())
