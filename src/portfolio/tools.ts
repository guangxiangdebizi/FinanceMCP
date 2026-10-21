import type { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { accountSummary, currentSnapshot, latestSnapshot, readSnapshot, reconcile } from './account.js';
import { openPortfolioDb, portfolioDbPath, portfolioEnabled } from './db.js';
import { buildScenarioQuotes, openMarketCache, type ScenarioMode } from './quotes.js';
import type { EtfQuoteInput, ScenarioAction, ScenarioEvidence } from './scenario.js';
import { buildScenario } from './scenario.js';
import { resolveAccountId, resolveAccountSnapshot, resolveAccountState } from './accounts.js';
import { loadFeeContext } from './fees.js';
import { evaluateAccountStatus } from './decision.js';

/**
 * MCP 账户工具实现。与市场工具隔离：账户数据只从 `portfolio.sqlite`（只读）读取；
 * 换仓情景**只读**打开本地市场缓存（`ashare.sqlite`）以取得可信标的身份与行情，
 * 绝不写入任何数据库，也不调用外部数据源。
 *
 * 默认关闭（ASHARE_PORTFOLIO_ENABLED=1 才可用）。即使工具不可见，直接调用也会
 * 得到明确拒绝而不是账户数据。
 */

type ToolResult = { content: { type: 'text'; text: string }[] };
const json = (body: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] });

const DISABLED = {
  refused: true,
  reason: 'portfolio_tools_disabled',
  message: '账户工具默认关闭。请在受信任的私有部署中设置 ASHARE_PORTFOLIO_ENABLED=1 后再启动服务；公网 ashare_daily profile 不应暴露账户数据。',
};

function readDb(): DatabaseSync {
  if (!portfolioEnabled()) throw new Error(DISABLED.message);
  const path = portfolioDbPath();
  if (!existsSync(path)) throw new Error(`账户数据库不存在（${path}），请先运行 finance-ashare portfolio-import`);
  return openPortfolioDb(path, { writable: false });
}

function summaryTool(args: Record<string, any>): ToolResult {
  const db = readDb();
  try {
    const accountId = resolveAccountId(db, args.account_id).account_id;
    const resolved = resolveAccountSnapshot(db, accountId, args.snapshot_id);
    const snapshot = resolveAccountState(db, accountId, ymdOr(args.as_of_trade_date, resolved.snapshot.as_of.replace(/-/g, '')), args.snapshot_id).snapshot;
    if (!snapshot) throw new Error('账户库中没有任何快照，请先运行 finance-ashare portfolio-import');
    const body: Record<string, unknown> = {
      summary: accountSummary(snapshot),
      reconciliation: args.include_checks === false ? { ok: reconcile(snapshot).ok, reasons: reconcile(snapshot).reasons } : reconcile(snapshot),
      db: portfolioDbPath(),
    };
    return json(body);
  } finally {
    db.close();
  }
}

function scenarioTool(args: Record<string, any>): ToolResult {
  const db = readDb();
  const market = openMarketCache();
  try {
    const actionRaw = String(args.action ?? 'hold');
    if (actionRaw !== 'hold' && actionRaw !== 'sell-buy') throw new Error('action 需要 hold 或 sell-buy');
    const accountId = resolveAccountId(db, args.account_id).account_id;
    const original = resolveAccountSnapshot(db, accountId, args.snapshot_id).snapshot;
    const tradeDate = ymdOr(args.as_of_trade_date, original.as_of.replace(/-/g, ''));
    const snapshot = resolveAccountState(db, accountId, tradeDate, args.snapshot_id).snapshot;
    const summary = accountSummary(snapshot);
    const accountGate = evaluateAccountStatus(db, original, accountId, tradeDate);

    // 默认只信任服务端只读缓存；只有调用方显式声明 mode:'research' 才接受自填价格。
    const mode: ScenarioMode = String(args.mode ?? 'server').toLowerCase() === 'research' ? 'research' : 'server';

    let action: ScenarioAction;
    if (actionRaw === 'hold') {
      action = { type: 'HOLD' };
    } else {
      if (!args.sell_code || !args.buy_code) throw new Error('sell-buy 需要 sell_code 与 buy_code');
      action = {
        type: 'SELL_AND_BUY',
        sell_code: String(args.sell_code),
        sell_shares: Number(args.sell_shares),
        buy_code: String(args.buy_code),
        // 声明只用于核对，身份以服务端解析为准（见 scenario.ts identityOfBuy）。
        // 未提供时不产生声明，避免用默认值去覆盖服务端判定。
        buy_instrument: {
          kind: (args.buy_kind ? String(args.buy_kind).toUpperCase() : undefined) as 'ETF' | 'STOCK',
          board: args.buy_board ? String(args.buy_board) : undefined,
        },
      };
    }

    // 研究/演示模式才读取调用方价格；这些报价被标记为 caller_supplied，结果最多 ILLUSTRATIVE。
    const callerQuotes = new Map<string, EtfQuoteInput>();
    if (mode === 'research') {
      const quoteDate = ymdOr(args.quote_date, tradeDate);
      if (args.sell_code && Number.isFinite(Number(args.sell_price))) {
        callerQuotes.set(String(args.sell_code), { trade_date: quoteDate, close: Number(args.sell_price), quality: 'READY' });
      }
      if (args.buy_code && Number.isFinite(Number(args.buy_price))) {
        callerQuotes.set(String(args.buy_code), { trade_date: quoteDate, close: Number(args.buy_price), quality: 'READY' });
      }
    }

    const bundle = buildScenarioQuotes({
      marketDb: market, asOf: tradeDate,
      sellCode: action.type === 'SELL_AND_BUY' ? action.sell_code : undefined,
      buyCode: action.type === 'SELL_AND_BUY' ? action.buy_code : undefined,
      mode, callerQuotes,
    });

    const evidence: ScenarioEvidence | null = args.advantage === undefined && args.advantage_basis === undefined
      && args.evidence_source === undefined && args.evidence_id === undefined
      ? null
      : {
          advantage: args.advantage === undefined ? true : args.advantage === true,
          basis: String(args.advantage_basis ?? ''),
          source: args.evidence_source === 'RESEARCH_VERIFIED' ? 'RESEARCH_VERIFIED' : 'UNVERIFIED',
          evidence_id: args.evidence_id === undefined ? undefined : String(args.evidence_id),
          as_of: args.evidence_as_of === undefined ? undefined : ymdOr(args.evidence_as_of, tradeDate),
        };

    const result = buildScenario({
      snapshot: summary,
      as_of_trade_date: tradeDate,
      quotes: bundle.quotes,
      action,
      evidence,
      resolved: bundle.resolved,
      preconditions: [...bundle.preconditions, ...(!accountGate.ok || accountGate.unreported_trade_risk ? [{ code: 'account_not_current' as const, detail: 'Account ledger completeness or verification is insufficient' }] : [])],
      fee_context: loadFeeContext(db, accountId, tradeDate),
      share_data_available: false,
    });

    return json({
      ...result,
      quote_mode: bundle.mode,
      server_quote_source: 'market_cache',
      server_quotes: bundle.server_quotes.map(q => ({
        ts_code: q.ts_code, found: q.found, trade_date: q.trade_date, quality: q.quality,
        reasons: q.reasons, expected_trade_date: q.expected_trade_date, list_status: q.list_status,
        suspended: q.suspended, adj_factor: q.adj_factor, suspension_known: q.suspension_known,
      })),
      account: { snapshot_id: snapshot.snapshot_id, is_current: snapshot.is_current, as_of: snapshot.as_of },
      warnings: [...new Set([...(result.warnings ?? []), ...bundle.warnings])],
      execution_price_is_reference: true,
      execution_price_note: '行情收盘价只是参考价，不是下一交易日的保证成交价；实际成交价由市场决定。',
      caller_prices_ignored: mode === 'server'
        && (args.sell_price !== undefined || args.buy_price !== undefined),
    });
  } finally {
    market?.close();
    db.close();
  }
}

function ymdOr(raw: unknown, fallback: string): string {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).replace(/-/g, '');
  if (!/^\d{8}$/.test(value)) throw new Error('日期需要 YYYYMMDD 格式');
  return value;
}

export async function runPortfolioTool(name: string, args: Record<string, any>): Promise<ToolResult> {
  if (!portfolioEnabled()) return json(DISABLED);
  switch (name) {
    case 'ashare_portfolio_summary': return summaryTool(args ?? {});
    case 'ashare_portfolio_scenario': return scenarioTool(args ?? {});
    default: throw new Error(`Unknown tool: ${name}`);
  }
}
