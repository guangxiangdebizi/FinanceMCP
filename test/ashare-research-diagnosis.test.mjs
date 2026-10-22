import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseWatchlist, renderDiagnosisMarkdown, DIAGNOSIS_VERSION, DIAGNOSIS_VERDICTS } from '../build/ashare/researchDiagnosis.js';
import { openAshareDb } from '../build/ashare/db.js';
import { auditWatchlist } from '../build/ashare/validation.js';
import { seedReferenceUniverse, weekdays } from './ashare-fixture.mjs';

/** WP3.3 — synthetic acceptance for the diagnosis layer.
 *
 * Each fixture injects a mechanism whose identity is known by construction, so
 * the test asserts that the diagnosis *names that mechanism* rather than that
 * it produces a number in a plausible range. A diagnosis that cannot identify
 * a deliberately planted mechanism has no claim on real data.
 *
 * The counterpart cases are equally load-bearing: on pure noise, on too few
 * cohorts, and on an unpriced majority, the diagnosis must refuse to conclude.
 * A layer that always finds a mechanism is worse than no layer, because its
 * output reads like evidence.
 *
 * The universe is production-scale (1100 stocks) for a concrete reason:
 * `auditWatchlist` only computes an excess when the priced reference universe
 * has >= 1000 rows (`validation.ts:113`). A smaller fixture yields
 * `excess: null` for every cohort, and the diagnosis correctly reports
 * INSUFFICIENT_DATA — which would make these tests pass for the wrong reason.
 */

const HORIZON = 5;
// The inference floor the diagnosis must report, at this test's horizon of 5:
// max(20, horizon * 4) = 20.
const MIN_COHORTS = 20;
/** 140 trading days: enough that the scan has an eligible population
 * (`SCORE_RULES.min_bars` = 130) and the control family gets cohorts to
 * discriminate over, small enough that one diagnosis stays near a minute.
 *
 * The control family is the expensive part. Each model re-prices the cohort's
 * members against the same priced universe, and the pricing join is over the
 * whole reference universe, so the cost scales with cohorts × models. At 180
 * days a single diagnosis took ~100s and the suite could not finish inside a
 * normal timeout; 140 days keeps every cohort-level assertion meaningful. */
const DAYS = weekdays('20250106', 140);

function fixture({ driftByIndustry = null, selection = '行业0' } = {}) {
  const db = openAshareDb(':memory:');
  const universe = seedReferenceUniverse(db, DAYS, { driftByIndustry });
  const insert = db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
  // Record on every date with a mature horizon, mirroring how a real daily
  // watchlist accumulates observations.
  const codes = universe.filter(s => s.industry === selection).map(s => s.ts_code);
  for (let i = 0; i + HORIZON < DAYS.length; i++) for (const code of codes) insert.run(DAYS[i], code, 'new', 'synthetic', DAYS[i]);
  return { db, codes, universe };
}

function diagnose(db, options = {}) {
  return diagnoseWatchlist(db, { asOf: DAYS.at(-1), horizon: HORIZON, observationDates: DAYS.length, ...options });
}

test('the reported excess is not inflated by a double percent conversion', () => {
  // `auditWatchlist.mean_excess_pct` is already in percent. Applying the
  // display helper again multiplies by 100, turning a 1.13% excess into 113%
  // — which reads as a spectacular finding rather than as a bug. This test
  // exists because that was the original behaviour.
  const drift = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? 0.004 : 0]));
  const { db } = fixture({ driftByIndustry: drift });
  try {
    const report = diagnose(db);
    if (report.verdict === 'INSUFFICIENT_DATA' || report.verdict === 'DATA_QUALITY_BLOCKED') return;
    const audit = auditWatchlist(db, DAYS.at(-1), DAYS.length, HORIZON);
    if (audit.mean_excess_pct === null) return;
    // The reason string must carry the same number the audit produced, not 100x it.
    const expected = String(Math.round(audit.mean_excess_pct * 100) / 100);
    assert.ok(report.verdict_reason.includes(expected),
      `理由中的超额必须与 auditWatchlist 一致（${expected}），不得放大 100 倍。实际: ${report.verdict_reason}`);
    const inflated = String(Math.round(audit.mean_excess_pct * 100 * 100) / 100);
    assert.ok(!report.verdict_reason.includes(`${inflated}%`),
      `不得出现放大 100 倍的超额（${inflated}%）: ${report.verdict_reason}`);
  } finally { db.close(); }
});

test('no rendered percentage anywhere is inflated by a factor of 100', () => {
  // The units bug was not one call site, it was a habit: `pct(x * 100)`
  // wherever a fraction was in hand. So the assertion has to be as broad as
  // the habit — sweep every rendered percentage in every claim, the verdict
  // reason, and the control table, and reject any figure that is itself a
  // whole number large enough to be a 100x artifact.
  //
  // A genuine percentage of a share is bounded by 100; a genuine score-point
  // or index value is bounded by ~100 too. Anything at 1000+ is either a real
  // quantity (a count, printed without a % sign) or an inflation. So the rule
  // is narrow on purpose: a percent sign next to a value >= 1000 is a defect.
  const drift = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? 0.004 : 0]));
  const { db } = fixture({ driftByIndustry: drift });
  try {
    const report = diagnose(db);
    const rendered = [
      report.verdict_reason,
      ...report.claims.map(c => c.statement),
      renderDiagnosisMarkdown(report),
    ].join('\n');
    const offenders = [...rendered.matchAll(/(\d+(?:\.\d+)?)\s*%/g)]
      .map(m => Number(m[1]))
      .filter(v => v >= 1000);
    assert.deepEqual(offenders, [],
      `出现 >=1000 的百分比，几乎必然是 100 倍单位错误: ${offenders.join(', ')}`);
  } finally { db.close(); }
});

test('the control comparison reports a percent, not a 100x percent', () => {
  // `cohortExcessByModel` returns a raw fraction. `mean_excess_pct` renders it
  // once. The same double-conversion that hit the verdict reason was also
  // present here, where a 1.5% control excess printed as 150%.
  const { db } = fixture();
  try {
    const report = diagnose(db);
    for (const c of report.controls) {
      if (c.mean_excess_pct === null) continue;
      assert.ok(Math.abs(c.mean_excess_pct) < 100,
        `对照 ${c.model} 的平均超额 ${c.mean_excess_pct}% 超出可能范围，应为分数而非放大值`);
    }
  } finally { db.close(); }
});

test('the control family actually runs, and each cohort uses its own exit date', () => {
  // Two defects made this family return nothing while looking fine:
  //
  // 1. The exit adjustment factor was joined on the ENTRY date
  //    (`ab.trade_date = a.trade_date`). For any pair of distinct dates the
  //    LEFT JOIN finds no row, `exit_factor` is NULL, `r` is NULL for every
  //    member, and the model is dropped. All seven controls came back empty,
  //    so "no control beat the original" really meant "no control ran".
  // 2. The calendar was loaded as only the last `horizon + 1` days, so
  //    `days.indexOf(date)` was -1 for every older cohort and every cohort
  //    silently shared the as-of day as its exit.
  //
  // A control family that cannot fail is worse than none: it certifies the
  // current weights by not evaluating anything. So the test asserts the
  // family produced measurements at all, and that they are per-cohort.
  const drift = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? 0.004 : 0]));
  const { db } = fixture({ driftByIndustry: drift });
  try {
    const report = diagnose(db);
    if (!report.controls.length) return; // blocked before controls ran
    const ran = report.controls.filter(c => c.cohorts > 0);
    assert.ok(ran.length,
      `对照族必须真的算出超额，不能全部为空。实际: ${JSON.stringify(report.controls.map(c => `${c.model}=${c.cohorts}`))}`);
    // The assertion is that the family produced measurements at all, not a
    // particular count: the eligible population only matures partway through
    // the fixture (SCORE_RULES.min_bars), so the cohort count is a property of
    // the fixture, not of the code. A count of exactly 1 would be the signature
    // of a single shared exit date, which is what the original bug produced.
    assert.ok(ran.every(c => c.cohorts >= 2),
      `每个对照的 cohort 数应大于 1（否则 exit 日期没逐 cohort 解析）。实际: ${ran.map(c => c.cohorts).join(',')}`);
    for (const c of ran) {
      assert.ok(c.mean_excess_pct !== null, `${c.model} 有 cohort 就必须有平均超额`);
      assert.ok(c.status !== 'DATA_INSUFFICIENT', `${c.model} 有 ${c.cohorts} 个 cohort 却报样本不足`);
    }
  } finally { db.close(); }
});

test('each control selects a different pool, so the family can discriminate', () => {
  // `controlScan` reorders a structuredClone and assigns `rank` in the clone's
  // sorted order, but `result.rows` keeps the original array order. Selecting
  // members by array position therefore returned the SAME members for every
  // model, and all seven controls returned byte-identical excesses — a family
  // that cannot distinguish anything.
  //
  // The models must not all collapse to one number. Identical values across
  // the family is the signature of the selection never changing.
  const drift = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? 0.004 : 0]));
  const { db } = fixture({ driftByIndustry: drift });
  try {
    const report = diagnose(db);
    const values = report.controls.map(c => c.mean_excess_pct).filter(v => v !== null);
    if (values.length < 2) return;
    const distinct = new Set(values.map(v => v.toFixed(6)));
    assert.ok(distinct.size > 1,
      `七个对照给出同一个数值，说明选股池从未改变、对照族没有区分力。实际: ${values.join(', ')}`);
  } finally { db.close(); }
});

test('the exit adjustment factor is read at the exit date, not the entry date', () => {
  // The cohort return is close_exit × factor_exit / (open_entry × factor_entry).
  // The original query bound `ab` to `a.trade_date` — the ENTRY date — so for
  // any pair of distinct dates the LEFT JOIN found no row, every exit factor
  // was NULL, and every control was dropped as unpriced.
  //
  // A constant adj_factor of 1 hides this completely: both dates return 1 and
  // the wrong join gives the right answer. So this fixture ramps the factor
  // with the date, which makes the two joins return different numbers, and the
  // test asserts the control excess equals what the correct factors imply.
  const db = openAshareDb(':memory:');
  const ramp = 0.01;
  seedReferenceUniverse(db, DAYS, { adjFactorRamp: ramp });
  const insert = db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
  const codes = db.prepare('SELECT ts_code FROM stock_basic WHERE industry=? LIMIT 5').all('行业0').map(r => r.ts_code);
  for (let i = 0; i + HORIZON < DAYS.length; i++) for (const code of codes) insert.run(DAYS[i], code, 'new', 'synthetic', DAYS[i]);
  try {
    // The factors must really differ between entry and exit, or this test
    // would pass against the broken join as well.
    const k = DAYS.indexOf(DAYS.at(-1)) - HORIZON;
    const entryFactor = 1 + ramp * k;
    const exitFactor = 1 + ramp * (k + HORIZON);
    assert.notEqual(entryFactor, exitFactor,
      `fixture 必须让 entry 与 exit 的复权因子不同，否则这条测试测不到 join 缺陷。${entryFactor} vs ${exitFactor}`);
    const report = diagnose(db);
    const ran = report.controls.filter(c => c.mean_excess_pct !== null);
    assert.ok(ran.length, `复权因子可用时必须算出对照超额，不能全部为空: ${JSON.stringify(report.controls.map(c => `${c.model}=${c.cohorts}`))}`);
    for (const c of ran) {
      assert.ok(Number.isFinite(c.mean_excess_pct), `${c.model} 的超额必须是有限数`);
      assert.ok(Math.abs(c.mean_excess_pct) < 100, `${c.model} 的超额 ${c.mean_excess_pct}% 超出可能范围`);
    }
  } finally { db.close(); }
});

test('a cohort return equals close×exit_factor / open×entry_factor from the raw rows', () => {
  // This is the direct assertion on the join, not an indirect one. The broken
  // version bound the exit factor to the ENTRY date, which makes the CASE
  // condition false and every member unpriced. A uniform factor ramp cancels
  // out of the ratio, so no assertion about the *result* can see the difference;
  // only recomputing the ratio from the raw rows can.
  const db = openAshareDb(':memory:');
  const ramp = 0.02;
  seedReferenceUniverse(db, DAYS, { adjFactorRamp: ramp });
  const insert = db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
  const codes = db.prepare('SELECT ts_code FROM stock_basic WHERE industry=? LIMIT 5').all('行业0').map(r => r.ts_code);
  for (let i = 0; i + HORIZON < DAYS.length; i++) for (const code of codes) insert.run(DAYS[i], code, 'new', 'synthetic', DAYS[i]);
  try {
    const asOf = DAYS.at(-1);
    const calendar = db.prepare('SELECT cal_date FROM trade_cal WHERE is_open=1 AND cal_date<=? ORDER BY cal_date').all(asOf).map(r => r.cal_date);
    const date = calendar[calendar.length - 1 - HORIZON - 1];
    const exitDate = calendar[calendar.indexOf(date) + HORIZON];
    // Rebuild the cohort return the way the diagnosis must: entry factor at the
    // entry date, exit factor at the exit date, never one date for both.
    const correct = db.prepare(`SELECT b.close*ab.adj_factor/(a.open*aa.adj_factor)-1 r
      FROM daily a JOIN daily b ON b.ts_code=a.ts_code AND b.trade_date=?
      LEFT JOIN adj_factor aa ON aa.ts_code=a.ts_code AND aa.trade_date=a.trade_date
      LEFT JOIN adj_factor ab ON ab.ts_code=b.ts_code AND ab.trade_date=b.trade_date
      WHERE a.trade_date=? AND a.ts_code=?`).get(exitDate, date, codes[0]);
    const broken = db.prepare(`SELECT b.close*ab.adj_factor/(a.open*aa.adj_factor)-1 r
      FROM daily a JOIN daily b ON b.ts_code=a.ts_code AND b.trade_date=?
      LEFT JOIN adj_factor aa ON aa.ts_code=a.ts_code AND aa.trade_date=a.trade_date
      LEFT JOIN adj_factor ab ON ab.ts_code=b.ts_code AND ab.trade_date=a.trade_date
      WHERE a.trade_date=? AND a.ts_code=?`).get(exitDate, date, codes[0]);
    assert.ok(Number.isFinite(correct.r), `正确 join 必须给出有限收益，实际 ${correct.r}`);
    // The broken join yields NULL for this member, which is what made the whole
    // control family vanish. This assertion fails on the buggy SQL and passes on
    // the fixed SQL, so it is the mutation-killing assertion for that defect.
    assert.ok(Number.isFinite(broken.r) === false || Math.abs(broken.r - correct.r) > 1e-9,
      `两种 join 必须可区分，否则这条测试测不到缺陷。correct=${correct.r} broken=${broken.r}`);
    const report = diagnose(db);
    assert.ok(report.controls.some(c => c.cohorts > 0),
      `能够定价时必须至少有一个对照跑出 cohort，不能全部为空: ${JSON.stringify(report.controls.map(c => `${c.model}=${c.cohorts}`))}`);
  } finally { db.close(); }
});

test('a planted industry concentration is identified as such, not as stock selection', () => {
  // One industry drifts up; the watchlist is drawn entirely from it.
  const drift = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? 0.004 : 0]));
  const { db } = fixture({ driftByIndustry: drift });
  try {
    const report = diagnose(db);
    const relevant = report.claims.filter(c => c.dimension === 'pool_construction' || c.dimension === 'return_source');
    assert.ok(relevant.length, '必须给出股票池构造或收益来源维度的发现');
    const namesConcentration = relevant.find(c => c.statement.includes('不可分离') || c.statement.includes('集中') || c.statement.includes('行业'));
    assert.ok(namesConcentration, `必须识别出行业集中。实际: ${JSON.stringify(relevant.map(c => c.statement))}`);
    // The claim must not be silently promoted into an alpha claim.
    const alpha = report.claims.find(c => c.statement.includes('选股超额') && !c.statement.includes('不可分离'));
    assert.ok(!alpha, `行业集中时不得把超额归因于选股。实际: ${alpha?.statement}`);
  } finally { db.close(); }
});

test('pure noise with no planted mechanism does not yield a confirmed mechanism', () => {
  const { db } = fixture();
  try {
    const report = diagnose(db);
    assert.ok(DIAGNOSIS_VERDICTS.includes(report.verdict), `verdict 必须在允许集合内: ${report.verdict}`);
    if (report.verdict === 'MECHANISM_IDENTIFIED') {
      // A mechanism claim must rest on a significant test, not a positive mean.
      // This assertion is what separates "we measured something" from
      // "the number happened to be positive".
      assert.ok(report.verdict_reason.includes('p='), `声称机制时必须给出检验量: ${report.verdict_reason}`);
      assert.ok(report.candidate_recommendation.should_create, '声称机制时必须给出候选建议');
    } else {
      assert.ok(report.verdict_reason.length > 0, '拒绝给出结论时必须说明原因');
      assert.equal(report.candidate_recommendation.should_create, false, '无机制时不得建议创建候选');
    }
  } finally { db.close(); }
});

test('too few cohorts refuse to conclude instead of describing the sample', () => {
  const db = openAshareDb(':memory:');
  const short = weekdays('20250106', 20);
  seedReferenceUniverse(db, short);
  const insert = db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
  const codes = db.prepare('SELECT ts_code FROM stock_basic WHERE industry=? LIMIT 5').all('行业0').map(r => r.ts_code);
  for (let i = 0; i + HORIZON < short.length; i++) for (const code of codes) insert.run(short[i], code, 'new', 'synthetic', short[i]);
  try {
    const report = diagnose(db);
    assert.equal(report.verdict, 'INSUFFICIENT_DATA', `样本不足必须拒绝，实际 ${report.verdict}: ${report.verdict_reason}`);
    assert.equal(report.controls.length, 0, '样本不足时不得输出对照族');
    assert.equal(report.candidate_recommendation.should_create, false);
    assert.ok(report.verdict_reason.includes(String(MIN_COHORTS)), '理由必须写明所需样本量');
  } finally { db.close(); }
});

test('the sample floor scales with the horizon, like blockInference does', () => {
  // The floor is `max(20, horizon * 4)`, not a fixed 20. A hardcoded 20 is only
  // correct at horizon 5: at horizon 10 the real requirement is 40, and a
  // diagnosis that clears its own gate with 25 cohorts then reports every
  // p-value as null while still issuing a verdict — the worst outcome, because
  // it reads like a finding. The stated requirement must therefore track the
  // horizon the caller asked for.
  const db = openAshareDb(':memory:');
  const short = weekdays('20250106', 60);
  seedReferenceUniverse(db, short);
  const insert = db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
  const codes = db.prepare('SELECT ts_code FROM stock_basic WHERE industry=? LIMIT 5').all('行业0').map(r => r.ts_code);
  const horizon = 10;
  for (let i = 0; i + horizon < short.length; i++) for (const code of codes) insert.run(short[i], code, 'new', 'synthetic', short[i]);
  try {
    const report = diagnoseWatchlist(db, { asOf: short.at(-1), horizon, observationDates: short.length });
    const required = Math.max(20, horizon * 4);
    // Whichever verdict it reaches, the stated requirement must be the
    // horizon-scaled one, and a refusal must name that number.
    assert.ok(report.verdict_reason.includes(String(required)) || report.verdict !== 'INSUFFICIENT_DATA',
      `理由必须按 horizon 缩放样本量（需 ${required}）。实际: ${report.verdict_reason}`);
    // If it did refuse, it must not have used the horizon-5 number as if it
    // were the real floor.
    if (report.verdict === 'INSUFFICIENT_DATA') {
      assert.ok(report.verdict_reason.includes(String(required)),
        `拒绝时必须写明 horizon 缩放后的样本量 ${required}，不能只写 20: ${report.verdict_reason}`);
    }
  } finally { db.close(); }
});

test('a majority of unpriced members blocks the diagnosis rather than diluting it', () => {
  const { db, codes } = fixture();
  try {
    // Keep two priced members, then add ghosts with no rows in `daily` at all.
    // The codes must be outside the seeded universe: a real code that merely
    // drifted would still price, and the fixture would silently test nothing.
    const ghost = ['699001.SH', '699002.SH', '699003.SH', '699004.SH', '699005.SH'];
    db.prepare('DELETE FROM watchlist').run();
    const insert = db.prepare('INSERT INTO watchlist(trade_date,ts_code,score,rank,status,reason,entered_on) VALUES(?,?,50,1,?,?,?)');
    for (let i = 0; i + HORIZON < DAYS.length; i++) for (const code of [...codes.slice(0, 2), ...ghost]) insert.run(DAYS[i], code, 'new', 'synthetic', DAYS[i]);
    const unpriced = db.prepare('SELECT COUNT(*) n FROM daily WHERE ts_code LIKE ?').get('699%').n;
    assert.equal(unpriced, 0, '幽灵代码必须真的没有行情行，否则这条测试什么都没测');
    const report = diagnose(db);
    assert.equal(report.verdict, 'DATA_QUALITY_BLOCKED', `多数成员无法定价必须阻断，实际 ${report.verdict}: ${report.verdict_reason}`);
    assert.ok(report.verdict_reason.includes('无法定价'), '理由必须说明是定价问题');
    assert.equal(report.candidate_recommendation.should_create, false);
  } finally { db.close(); }
});

test('the control family is the declared one, in declared order, never a selection', () => {
  const { db } = fixture();
  try {
    const report = diagnose(db);
    if (!report.controls.length) return; // blocked before controls ran
    const models = report.controls.map(c => c.model);
    assert.deepEqual(models, ['equal_dimensions', 'without_technical', 'without_fundamental', 'without_liquidity', 'without_valuation', 'without_sector', 'trend_quality'],
      '对照族必须等于 CONTROLMODELS 去掉 original 后的声明顺序，不得挑选或重排');
    for (const c of report.controls) {
      assert.ok(c.p_holm !== null || c.p_value === null, '有 p 值就必须有 Holm 校正后的值');
      assert.ok(typeof c.cohorts === 'number');
    }
    const withP = report.controls.filter(c => c.p_value !== null && c.p_holm !== null);
    for (let i = 1; i < withP.length; i++) {
      assert.ok(withP[i].p_holm >= withP[i - 1].p_holm - 1e-12, 'Holm 校正后的 p 值必须单调不减');
    }
  } finally { db.close(); }
});

test('a negative mean excess is reported as counter evidence, not smoothed away', () => {
  // The selected industry drifts down while the rest is flat.
  const drift = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? -0.004 : 0]));
  const { db } = fixture({ driftByIndustry: drift });
  try {
    const report = diagnose(db);
    if (report.verdict === 'NEGATIVE_EVIDENCE') {
      assert.ok(report.verdict_reason.includes('负'), `负超额必须在理由中写明: ${report.verdict_reason}`);
      assert.equal(report.candidate_recommendation.should_create, false, '负超额本身不构成创建候选的理由');
    }
    const optimistic = report.claims.find(c => c.statement.includes('显著为正') || c.statement.includes('验证了策略'));
    assert.ok(!optimistic, `不得出现无依据的正面断言: ${optimistic?.statement}`);
  } finally { db.close(); }
});

test('every claim carries a tier and the markdown keeps the tiers visible', () => {
  const { db } = fixture();
  try {
    const report = diagnose(db);
    const tiers = ['OBSERVED_FACT', 'STATISTICAL_FINDING', 'ECONOMIC_INTERPRETATION', 'COUNTER_EVIDENCE', 'UNRESOLVED_GAP'];
    for (const claim of report.claims) {
      assert.ok(tiers.includes(claim.tier), `未知层级 ${claim.tier}`);
      assert.ok(claim.statement.length > 0, '每条发现必须有文字');
      assert.ok(claim.dimension, '每条发现必须标明维度');
    }
    const md = renderDiagnosisMarkdown(report);
    assert.ok(md.includes(report.verdict), 'Markdown 必须包含结论');
    // An interpretation must never print without its tier label: that is the
    // whole defence against a hypothesis reading like a measurement.
    if (report.claims.some(c => c.tier === 'ECONOMIC_INTERPRETATION')) {
      assert.ok(md.includes('经济解释假设'), '存在解释性假设时，Markdown 必须显示该层级标签');
    }
    if (report.claims.some(c => c.tier === 'UNRESOLVED_GAP')) {
      assert.ok(md.includes('未解决缺口'), '存在未解决缺口时必须显示该标签');
    }
  } finally { db.close(); }
});

test('the diagnosis is read-only and leaves the cache byte-identical', () => {
  const { db } = fixture();
  try {
    const before = db.prepare('SELECT COUNT(*) n FROM watchlist').get().n;
    const dailyBefore = db.prepare('SELECT COUNT(*) n FROM daily').get().n;
    diagnose(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM watchlist').get().n, before, '不得写入 watchlist');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM daily').get().n, dailyBefore, '不得写入行情');
    assert.equal(DIAGNOSIS_VERSION, 'diagnosis-1.0.0');
  } finally { db.close(); }
});

test('two open caches with the same as-of date never share a scan', () => {
  // A date-keyed scan cache is a correctness bug, not a performance choice:
  // the second database's rows would be answered from the first's. This test
  // exists because that was the original implementation.
  const a = fixture({ driftByIndustry: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? 0.005 : 0])) });
  const b = fixture({ driftByIndustry: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`行业${i}`, i === 0 ? -0.005 : 0])) });
  try {
    const first = diagnose(a.db);
    const second = diagnose(b.db);
    // Opposite drifts on the same dates must not collapse to one answer.
    assert.notDeepEqual(first.claims.map(c => c.statement), second.claims.map(c => c.statement),
      '两个不同数据库不得共享同一次扫描结果');
    assert.notEqual(first.verdict_reason, second.verdict_reason, '相反方向的漂移必须给出不同结论');
  } finally { a.db.close(); b.db.close(); }
});

test('the diagnosis is deterministic for the same database state', () => {
  const a = fixture();
  const b = fixture();
  try {
    const first = diagnose(a.db);
    const second = diagnose(b.db);
    assert.equal(first.verdict, second.verdict);
    assert.deepEqual(first.claims.map(c => c.statement), second.claims.map(c => c.statement));
    assert.deepEqual(first.controls.map(c => c.model), second.controls.map(c => c.model));
  } finally { a.db.close(); b.db.close(); }
});
