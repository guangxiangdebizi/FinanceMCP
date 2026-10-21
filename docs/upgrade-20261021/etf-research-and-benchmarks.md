# ETF research, immutable journal and benchmark integration

Implementation baseline: FinanceMCP `476bfff3672ec2d20208650edbf8e045e6af12e8`. These changes do not imply a production deployment, data backfill, or approval of benchmark weights.

## ETF universe and coverage

`screenEtfCandidates(db, { asOf, categories?, limit?, heldCodes? })` retains its existing contract and adds `universe_discovery` plus each candidate's `research` object. `universe_version` stays `r2-etf-candidates-1.0.0` for the unchanged declared seeds; `research_version=etf-research-20261021-v2` and `universe_discovery.version` separately identify expanded calculations and discovery rules. Account callers should pass actual held codes; callers omitting them retain the original five-code compatibility default.

`discoverEtfUniverse` identifies ETFs from `fund_basic` metadata containing ETF/exchange-traded-fund identity, excludes LOF and non-ETF closed funds, and constrains listing and delisting dates to the requested date. It preserves the original 24 declared research seeds and discovers additional cached products across broad equity, industry/theme, bonds, gold and cross-border funds. Current metadata is explicitly labeled as current cached metadata, not a point-in-time historical instrument master. Classification is a metadata heuristic with declared overrides; it does not prove portfolio exposures, permissions or future returns.

At most 200 additional products are evaluated, ranked deterministically by cached average turnover over the preceding 30 calendar days. Discovery reports the total discovered, evaluated and omitted counts; the sample is never presented as the entire ETF market. Turnover is liquidity, never net fund inflow. Actual holdings remain visible even outside the sample or category filter.

The daily pipeline continues synchronizing market-wide daily prices and protecting held-instrument coverage. It requests additional history for at most 12 liquid dynamically discovered products, only when fewer than 60 bars exist in the 120-calendar-day research window. Recent history attempts, including empty or failed answers, have a seven-day cooldown per code. Adjustment and share queries cover the existing fixed seed set plus that bounded dynamic sample. This is a request budget, not a guarantee that upstream data exists. No network requests occur in screening or bundle reads.

Candidate output separates listing, stale/missing price, adjustment, liquidity, size, tracking, NAV/premium, trends, holdings correlations, historical relative returns and share changes. Stale bars cannot produce a current trend. Correlations require at least 20 paired returns with matching date intervals. Return calculations require adjustment factors without bridging missing factors. Share comparisons require valid trade-calendar dates, comparable dates and no observed factor changes. Missing NAV/IOPV and premium remain unavailable. Share changes are units outstanding, not real-time creation/redemption or capital inflows. Historical outperformance of cash or another holding remains `UNVERIFIED`; it does not establish an executable rotation advantage.

## Research journal

`recordResearchJournal(db, input)` writes only two new private research tables, leaving legacy `plan_tracking` rows intact. The original record stores the complete canonical JSON and SHA-256 digest. Re-importing the same ID and semantic JSON is idempotent; different content under that ID is rejected. Corrections use a new ID and `correction_of`. Database triggers reject UPDATE and DELETE on research records and evaluations.

Required record fields are `record_id`, `account_id`, `source`, `as_of_trade_date`, `bundle_id`, timezone-qualified `generated_at`, nonempty `versions`, `judgement`, `candidates`, `observations` and `evidence`. Optional `payload` retains the actual bundle or externally obtained research. `source` is `vps`, `chatgpt` or `combined`. ChatGPT and combined imports require `provenance.author`, `source_reference` and timezone-qualified `obtained_at`. Combined records additionally require actual VPS and ChatGPT parent records from the same account. This validates origin metadata and references; it does not authenticate who authored an arbitrary imported document or grant verified investment evidence status.

`recordVpsResearchSnapshot({ portfolioDb, accountId, bundle, observations?, versions?, generatedAt? })` preserves the complete actual bundle, including insufficient-data days. Its ID includes a content revision, so a changed rerun appends rather than replacing history. The actual generation timestamp is required. Legacy `recordPlanTracking` continues operating independently.

`listResearchJournal(db, { accountId, asOf?, limit? })` is read-only, never creates tables, and isolates accounts. The CLI helper is `runJournalCommand(command, h)` with `JOURNAL_USAGE`; the main CLI registers it. Commands:

- `portfolio-journal-import --file PATH --confirm [--db PATH]`
- `portfolio-journal-list [--account ID] [--date YYYYMMDD] [--limit N] [--db PATH]`
- `portfolio-journal-evaluate [--account ID] --date YYYYMMDD [--horizons 5,10,20,60] [--record --confirm] [--db PATH] [--market-db PATH]`

CLI JSON input is data, never executable code. CLI account resolution uses the deployment's existing resolver. MCP bundle reads must not call journal write APIs.

## Fixed-window evaluation

`evaluateResearchJournal({ portfolioDb, marketDb, accountId, asOf, horizons?, feeEstimator?, limit? })` is read-only. Default windows are 5, 10, 20 and 60 trading sessions; allowed windows are 1–252. Each source remains separately labeled. No ChatGPT or combined comparison is fabricated when records do not exist.

The origin date must exist as an open session in the calendar. A window matures after the exact number of subsequent open sessions. Unmatured windows remain `PENDING`; insufficient future calendar is explicit. Every intervening session, the original date and fixed maturity date must have actual prices and factors. Missing observations or benchmark data remain unavailable; the window is never shortened or substituted. Factor changes currently return `corporate_action_cashflows_unavailable`: reliable distributions/splits are needed before a quantity-based net return can be calculated. Prospective eligibility requires generation time, server-assigned first recording time, and any external acquisition time to fall no later than the stated research date in Asia/Shanghai. A caller cannot make a late import prospective by supplying an earlier `generated_at`; late records remain stored but are excluded from prospective evaluation. Finite positive price/factor values and valid OHLC bounds are required; malformed bars cannot create trigger or loss observations.

The result includes defined trigger/invalidation observations from future-session daily high/low, fixed-window gross and net returns, fee provenance, maximum drawdown, benchmark net return and excess return. Daily bars cannot establish event ordering, execution or fills. The return is a hypothetical opening/closing comparison, not actual account performance or a conditional strategy simulation. The candidate uses its originally declared quantity; the benchmark uses the same initial cash budget, whole lots and an explicitly retained cash remainder. A declared invalidation threshold is tracked as a loss-threshold breach; absent thresholds are not invented. Missing daily lows keep both invalidation and loss-breach assessment `UNKNOWN`. Each result explicitly preserves `direction`, identifies its `evaluation_basis`, and returns `actual_trade=false` and `realized_pnl_cents=null`. `observe` means a price observation with hypothetical transaction-cost comparison, while `long` means a hypothetical long fixed-window comparison; neither asserts a real trade or realized profit.

`journalFeeEstimator(portfolioDb, marketDb, accountId)` adapts the shared `resolveFeeRules`/`calculateFees` engine with instrument identity from cached metadata and effective dates per leg. It preserves estimated status and fee-rule versions. Unknown identity or missing estimation returns unavailable rather than zero fees. CLI evaluation injects this adapter; pure programmatic evaluation must explicitly provide an estimator. `recordJournalEvaluations(db, results)` appends separately hashed evaluation snapshots, validating original account and content digest, and preserves prior evaluations after data corrections.

## Benchmarks and boundaries

The separate benchmark owner maintains `buildBenchmarkComparison`. Its frozen CSI300 ETF, multi-asset basket and initial-five definitions must not be changed according to results. Multi-asset weights remain `provisional_pending_user_approval`. Bundle callers pass the common as-of explicitly as the benchmark end. Different actual start dates, especially the original-five baseline, must be exposed rather than implying equal observation intervals. Missing price history remains unavailable without replacement constituents.

The journal's per-candidate benchmark defaults to explicit frozen code `510300.SH`, overridable only through the original immutable observation. Exact observation sessions and shared fee logic apply equally to candidate and benchmark. This comparison is not the real account NAV; actual account performance belongs to the event-ledger unitized NAV path.

## Verification

Synthetic tests in `test/upgrade-etf.test.mjs` and `test/upgrade-journal.test.mjs` cover dynamic identity/classes, listing dates, bounded selection, actual holding retention, stale/as-of coverage, correlations, adjustment-dependent trends, share-factor changes, bounded history/cooldown, immutable conflicts/corrections, real source parents, calendar maturity, fees, same-window benchmarks, missing prices/factors and retrospective records. Tests use memory or temporary databases with stubbed upstream responses; they do not access production caches, account data or external services. Compilation can use an isolated `tsc --outDir` target without clearing the shared build.
