/** `research-cadence` — the CLI entry for the weekly/monthly research cadence.
 *
 * Disabled by default: `runResearchCadence` reads `RESEARCH_CADENCE_ENABLED` on every
 * call, so the only way this does anything is a caller that set it. The systemd unit
 * sets it explicitly (`docker exec -e`), which keeps the activation visible in a file
 * that is reviewed, rather than ambient in the container's environment.
 *
 * It prints a summary, never the report body: the monthly review carries account
 * performance, the body is already persisted (0600, private volume), and a copy in
 * stdout would be a copy in journald.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ashareDbPath } from './db.js';
import { runRealCadence } from './cadenceProducers.js';
import type { ResearchCadence } from './researchCadence.js';

export const CADENCE_USAGE = 'research-cadence <weekly|monthly> --as-of <YYYYMMDD|latest> --account-id <ID> [--dry-run]';

/** Latest trade date in the market cache, read-only. Null when there is no cache or no data. */
function latestCachedDate(path: string): string | null {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT MAX(trade_date) d FROM daily').get() as { d: string | null } | undefined;
    return row?.d ?? null;
  } finally { db.close(); }
}

export async function runCadenceCommand(
  args: string[], env: Record<string, string | undefined> = process.env,
): Promise<Record<string, unknown>> {
  const arg = (key: string) => { const i = args.indexOf(`--${key}`); return i < 0 ? undefined : args[i + 1]; };
  const cadence = args[0];
  if (cadence !== 'weekly' && cadence !== 'monthly') throw new Error(`cadence must be weekly or monthly; usage: ${CADENCE_USAGE}`);
  // No default account: a cadence report is account-scoped, and substituting one account's
  // name for another's is the one thing a research report must not do on the operator's behalf.
  const accountId = arg('account-id');
  if (!accountId) throw new Error(`--account-id is required (no default account); usage: ${CADENCE_USAGE}`);
  let asOf = arg('as-of');
  if (asOf === 'latest') {
    const latest = latestCachedDate(ashareDbPath());
    if (!latest) return { status: 'UNAVAILABLE', reason: 'no_market_cache_to_resolve_latest', cadence, account_id: accountId };
    asOf = latest;
  }
  if (!asOf || !/^\d{8}$/.test(asOf)) throw new Error(`--as-of must be YYYYMMDD or latest; usage: ${CADENCE_USAGE}`);

  // Weekly output must land on the mounted data volume: the producer's own default is a
  // relative path, which inside a container is a directory that disappears with it.
  const dataDir = env.ASHARE_DATA_DIR;
  const result = await runRealCadence(cadence as ResearchCadence, {
    asOf, accountId, env, dryRun: args.includes('--dry-run'),
    ...(cadence === 'weekly' && dataDir ? { outputDir: join(dataDir, 'research-cadence', 'diagnosis') } : {}),
  });
  const { report, ...rest } = result;
  return {
    ...rest,
    // Present-or-absent only; the body lives at `written_to`.
    report: report === null || report === undefined ? null : '<omitted: see written_to>',
    report_keys: report && typeof report === 'object' ? Object.keys(report as object).sort() : null,
  };
}
