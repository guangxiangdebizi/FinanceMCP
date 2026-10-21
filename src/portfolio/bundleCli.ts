import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ashareDbPath } from '../ashare/db.js';
import { buildInvestmentResearchBundle } from './researchBundle.js';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { openMarketCache } from './quotes.js';
import type { CliHelpers } from '../ashare/commands.js';

/** Local trusted CLI; no bundle or account state is written unless an output path is explicit. */
export function runBundleCommand(h: CliHelpers): void {
  const path = h.arg('db') ?? portfolioDbPath();
  if (!existsSync(path)) throw new Error('private portfolio database unavailable');
  const db = openPortfolioDb(path, { writable: false });
  const market = openMarketCache(h.arg('market-db') ?? ashareDbPath());
  try {
    const bundle = buildInvestmentResearchBundle({ portfolioDb: db, marketDb: market, accountId: h.arg('account'),
      asOfTradeDate: h.arg('date'), maxCandidates: h.arg('max-candidates') ? Number(h.arg('max-candidates')) : undefined });
    const output = h.arg('output');
    if (output) {
      const target = resolve(output);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      // Exclusive creation preserves a prior dated bundle; repeated runs should use a new revision path.
      writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      chmodSync(target, 0o600);
    }
    h.print(bundle);
  } finally { market?.close(); db.close(); }
}
