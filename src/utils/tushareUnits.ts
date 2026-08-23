const AMOUNT_TO_WAN_DIVISOR: Record<string, number> = {
  daily: 10,       // 千元 -> 万元
  fund_daily: 10,  // 千元 -> 万元
  weekly: 10000,   // 元 -> 万元
  monthly: 10000,  // 元 -> 万元
  hk_daily: 10000, // 港元 -> 万港元
  us_daily: 10000, // 美元 -> 万美元
  stk_mins: 10000, // 元 -> 万元
  repo_daily: 1,   // 接口已返回万元
  cb_daily: 1,     // 接口已返回万元
  opt_daily: 1,    // 接口已返回万元
  fut_daily: 1,    // 接口已返回万元
};

export function formatTushareAmountWan(value: unknown, apiName: string): string {
  const num = Number(value);
  if (value == null || value === '' || !Number.isFinite(num)) return 'N/A';

  const divisor = AMOUNT_TO_WAN_DIVISOR[apiName];
  if (divisor == null) return 'N/A';
  return (num / divisor).toFixed(2);
}
