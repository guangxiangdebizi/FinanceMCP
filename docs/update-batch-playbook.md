# FinanceMCP Batch Update Playbook

This file describes the standard batch-update loop for this repo.

## Goal

Keep interface expansion architecture-aligned instead of drifting into one-tool-per-endpoint sprawl.

## Required Loop

### 1. Propose the next batch

- Start from current public tool surface, not from the full official endpoint list.
- Ask: which missing interfaces are the highest-leverage next batch under the current architecture?
- Prefer extending an existing tool before creating a new one.

### 2. Run architecture discussion first

- Use a cloud-side or delegated agent first.
- The first pass should only produce a decision memo:
  - which interfaces to add
  - why these
  - where they belong
  - exact files likely to change
  - default field budget
  - formatter/output strategy

### 3. Run a review pass against the proposal

- Use a second pass to challenge the proposal before code changes.
- That pass should try to reject weak additions, over-broad new tools, and schema mistakes.
- Only after the review pass should the final Vn scope be locked.

### 4. Implement on cloud first

- Sync the latest trusted code to the cloud host.
- Implement there first.
- Keep unrelated untracked files out of git.
- Do not push local-only `reports/` or `scripts/` analysis artifacts.

### 5. Verify with real smoke tests

- Build first.
- Then run real smoke tests against codepaths using a valid token.
- Test:
  - at least one old pre-existing behavior per touched tool
  - all new branches added in that batch
- If production HTTP logs may expose tokens, inject the token through request context or a direct codepath instead of public HTTP headers.

### 6. Update coverage docs every time

After each successful batch update:

- update `docs/tushare-interface-coverage.md`
- if local analysis under `reports/` was refreshed, update that too
- keep local and cloud copies aligned

### 7. Sync and git hygiene

- keep only `main`
- remove temporary branches after fast-forward merge
- clean up temporary Claude / agent discussion artifacts
- push only the intended code changes
- never include the local-only secret-bearing directories

## Non-Negotiable Rules

- `1 official api_name != 1 MCP tool`
- small public tool surface beats endpoint completeness
- every new branch needs a field budget
- schema contracts must match real branch semantics
- HTTP and stdio parity must not regress
- if a new tool is introduced, it must reflect a real intent change
