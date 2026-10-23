#!/usr/bin/env python3
"""Mutation tests for the bounded-heap guard in shadowRun.ts (Phase 6).

Four mutants, each one a way the guard can look implemented while not being:

  1. The heap check is removed entirely: an over-budget run completes every
     session and reports heap.exhausted=false. This is the "mark the property
     done without enforcing it" shape.
  2. The check runs AFTER a session's work instead of before it: the session
     that grew the heap completes and is then blamed for it.
  3. `heap.exhausted` is hardcoded false, so a truncated run is
     indistinguishable from a complete one in the run's own output.
  4. The skip reason is collapsed to `runtime_budget_exceeded`: a caller
     diffing two truncated runs cannot tell which axis failed.

Same guards as mutate-shadow-runtime.py:
  - refuses to start while any `node --test` run is in flight, matched via
    /proc/*/exe + a cmdline containing `--test`. NOT `comm`, NOT `pgrep -f`.
  - restores build/ashare/shadowRun.js from a byte-for-byte copy and asserts
    the restore with sha256 before exiting.
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


# --- mutant definitions -------------------------------------------------------
# Anchors are written against the COMPILED build/ output. tsc re-indents, so an
# anchor copied from src/ will not match and the mutant will silently not apply.

# The compiled heap guard: an 8-space `if` inside the 4-space `for` loop,
# immediately after the runtime-budget guard.
HEAP_CHECK = """        if (heapUsage() > heapBudgetBytes) {
            heapExhausted = true;
            for (const remaining of options.asOfTradeDates.slice(options.asOfTradeDates.indexOf(asOf))) {
                sessions.push(skip(remaining, 'heap_budget_exceeded', 0));
                bump(skippedByReason, 'heap_budget_exceeded');
            }
            break;
        }
"""

MUTANTS = [
    ("heap check removed entirely", [(HEAP_CHECK, "")]),
    (
        "check moved after the session's work",
        [
            (HEAP_CHECK, ""),
            (
                """            ms: clock() - t0,
        });
    }
    return {""",
                """            ms: clock() - t0,
        });
        if (heapUsage() > heapBudgetBytes) {
            const done = sessions[sessions.length - 1];
            done.skip_reason = 'heap_budget_exceeded';
            done.created = false;
            heapExhausted = true;
            for (const remaining of options.asOfTradeDates.slice(options.asOfTradeDates.indexOf(asOf) + 1)) {
                sessions.push(skip(remaining, 'heap_budget_exceeded', 0));
                bump(skippedByReason, 'heap_budget_exceeded');
            }
            break;
        }
    }
    return {""",
            ),
        ],
    ),
    ("heap.exhausted hardcoded false", [("exhausted: heapExhausted", "exhausted: false")]),
    (
        "skip reason collapsed to runtime_budget_exceeded",
        [
            (
                """                sessions.push(skip(remaining, 'heap_budget_exceeded', 0));
                bump(skippedByReason, 'heap_budget_exceeded');""",
                """                sessions.push(skip(remaining, 'runtime_budget_exceeded', 0));
                bump(skippedByReason, 'runtime_budget_exceeded');""",
            )
        ],
    ),
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
