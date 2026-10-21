import { readFileSync, existsSync } from 'node:fs';
import { openPortfolioDb, portfolioDbPath } from './db.js';
import { resolveAccountId } from './accounts.js';
import { calibrateFees, loadFeeContext, resolveFeeRules, saveFeeProfile, validateFeeProfile, type FeeProfile } from './fees.js';
import type { PortfolioCliHelpers } from './cli.js';

export const FEE_USAGE = `  portfolio-fees-list --account ID [--date YYYYMMDD] [--db PATH]
  portfolio-fees-set --account ID --file PROFILE.json --confirm [--dry-run] [--db PATH]
  portfolio-fees-calibrate --account ID --code CODE --file SAMPLES.json --date YYYYMMDD [--db PATH]
    Local private configuration only; profiles carry per-field evidence and an effective date.`;

export function runFeeCommand(command: string, h: PortfolioCliHelpers): boolean {
  if (!['portfolio-fees-list', 'portfolio-fees-set', 'portfolio-fees-calibrate'].includes(command)) return false;
  const path = h.arg('db') ?? portfolioDbPath();
  if (!existsSync(path)) throw new Error('Account database must already exist');
  const file = h.arg('file');
  const write = command === 'portfolio-fees-set' && !h.flag('dry-run');
  if (write && !h.flag('confirm')) throw new Error('Fee configuration requires --confirm');
  const db = openPortfolioDb(path, { writable: write });
  try {
    const accountId = resolveAccountId(db, h.arg('account')).account_id;
    const asOf = h.arg('date') ?? '99991231';
    if (command === 'portfolio-fees-list') h.print(loadFeeContext(db, accountId, asOf, h.arg('broker')));
    else {
      if (!file) throw new Error('--file required');
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (command === 'portfolio-fees-set') {
        const profile = parsed as FeeProfile;
        if (h.flag('dry-run')) {
          validateFeeProfile(profile);
          const context = loadFeeContext(db, accountId, profile.effective_from);
          if (profile.account_id && profile.account_id !== accountId) throw new Error('Fee profile account mismatch');
          h.print({ dry_run: true, account_id: accountId, profile: validateFeeProfile(profile), existing_profiles: context.profiles.length });
        } else h.print(saveFeeProfile(db, accountId, profile));
      } else {
        if (!h.arg('code') || !h.arg('date')) throw new Error('--code and --date required');
        const rules = resolveFeeRules({ db, accountId, code: h.arg('code')!, kind: h.arg('kind') === 'stock' ? 'STOCK' : 'ETF', asOf, brokerId: h.arg('broker') });
        h.print({ rules, ...calibrateFees(Array.isArray(parsed) ? parsed : parsed.samples, rules) });
      }
    }
  } finally { db.close(); }
  return true;
}
