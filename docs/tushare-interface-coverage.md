# Tushare Interface Coverage Status

## Snapshot

- Official Tushare MCP interfaces observed: `258`
- Local registered MCP tools: `19`
- Official interfaces currently covered: `78`
- Official interfaces not yet covered: `180`
- Coverage ratio: `30.23%`

This file is the **safe, committed coverage snapshot** for the repo. It should be updated after every interface-expansion batch.

The local-only artifacts under `reports/` may contain richer extraction detail and temporary analysis, but they are not the canonical committed status because that directory is intentionally excluded from pushes.

## Current Public Tool Surface

| Tool | Role | Notes |
|---|---|---|
| `current_timestamp` | local utility | no upstream data source |
| `finance_news` | external news search | Baidu crawler, not Tushare |
| `stock_data` | multi-market historical bars | Tushare + Binance |
| `stock_data_minutes` | minute bars | Tushare + Binance |
| `index_data` | index daily/basic/valuation | Tushare aggregate |
| `macro_econ` | macro indicators | Tushare aggregate |
| `company_performance` | company financial and market snapshot data | Tushare aggregate |
| `fund_data` | fund and ETF-adjacent data | Tushare aggregate |
| `fund_manager_by_name` | manager lookup | Tushare aggregate |
| `convertible_bond` | convertible bond lifecycle data | Tushare aggregate |
| `block_trade` | block trade data | Tushare aggregate |
| `money_flow` | stock/market/sector/northbound flows | Tushare aggregate |
| `margin_trade` | margin and securities lending | Tushare aggregate |
| `company_performance_hk` | HK financial statements | Tushare aggregate |
| `company_performance_us` | US financial statements | Tushare aggregate |
| `csi_index_constituents` | CSI constituents + valuation/quality summary | multi-call aggregate |
| `dragon_tiger_inst` | institution activity on dragon-tiger list | Tushare aggregate |
| `hot_news_7x24` | fast news | Tushare `news` |
| `futures_data` | futures positioning | Tushare aggregate |

## Official Interfaces Currently Covered

`adj_factor`, `balancesheet`, `block_trade`, `cashflow`, `cb_basic`, `cb_call`, `cb_daily`, `cb_issue`, `cb_share`, `cn_cpi`, `cn_gdp`, `cn_m`, `cn_pmi`, `cn_ppi`, `daily`, `daily_basic`, `dividend`, `express`, `fina_audit`, `fina_indicator`, `fina_mainbz`, `forecast`, `fund_basic`, `fund_daily`, `fund_div`, `fund_manager`, `fund_nav`, `fund_portfolio`, `fund_share`, `fut_daily`, `fut_holding`, `fx_daily`, `hibor`, `hk_balancesheet`, `hk_cashflow`, `hk_daily`, `hk_hold`, `hk_income`, `hsgt_top10`, `income`, `index_basic`, `index_daily`, `index_dailybasic`, `index_weight`, `libor`, `margin`, `margin_detail`, `margin_secs`, `moneyflow`, `moneyflow_ind_dc`, `moneyflow_mkt_dc`, `monthly`, `new_share`, `news`, `opt_daily`, `pledge_detail`, `pledge_stat`, `repo_daily`, `repurchase`, `share_float`, `shibor`, `shibor_quote`, `slb_len_mm`, `stk_holdernumber`, `stk_holdertrade`, `stk_managers`, `stk_mins`, `stock_basic`, `stock_company`, `top10_floatholders`, `top10_holders`, `top_inst`, `us_balancesheet`, `us_cashflow`, `us_daily`, `us_fina_indicator`, `us_income`, `weekly`

## Recent Expansion History

### V1

Added or newly exposed through the public aggregate surface:

- `weekly`
- `monthly`
- `index_basic`
- `daily_basic` as explicit `company_performance` branch
- `stock_basic` as explicit `company_performance` branch (`stk_basic`)

Architecture work completed:

- shared `dispatch.ts`
- shared `timestampTool.ts`
- HTTP/stdio parity fix for `money_flow`

### V2

Added or newly exposed through the public aggregate surface:

- `index_dailybasic`
- `hk_hold`
- `hsgt_top10`
- `cb_call`
- `cb_share`
- `new_share`
- `fut_holding`

Architecture work completed:

- shared `tushareClient.ts` for V2 codepaths
- `index_data` table-oriented daily/valuation output
- schema cleanup for `money_flow` and `company_performance`
- new high-level tool `futures_data`

## Highest-Priority Remaining Families

These are the best next expansion areas under the current architecture style:

1. `index_data`
   Current likely next candidates: `index_weekly`, `index_monthly`, `index_global`

2. `money_flow`
   Current likely next candidates: `moneyflow_hsgt`, `moneyflow_ths`, `moneyflow_cnt_ths`

3. `convertible_bond`
   Current likely next candidates: `cb_rate`, `cb_rating`, `top10_cb_holders`

4. `fund_data`
   Current likely next candidates: `fund_company`, `fund_adj`, `fund_sales_vol`, `fund_factor_pro`

5. Distinct new domain tools
   Current likely future candidates: `theme_board_data`, `market_reference`, `market_state`

## Update Rule

After each accepted batch:

1. update this file
2. update the local-only `reports/` snapshot if you generated one
3. verify cloud and local repo copies are aligned
4. keep the numbers in this file honest
