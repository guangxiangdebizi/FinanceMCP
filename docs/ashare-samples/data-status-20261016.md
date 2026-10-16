# A股数据状态 20261016
- 数据质量：**READY**
- 日线 5567 条（前一交易日 5565），每日指标覆盖 1，复权因子覆盖 1
- 核心指数：000001.SH, 000300.SH, 000688.SH, 000852.SH, 000905.SH, 399001.SZ, 399006.SZ, 899050.BJ
- 缓存最新日线：20261016
- 当日报告：ASR-20261016-20261016163620-ddd0d0（READY，2026-10-17T00:36:20.909+08:00）
- 最近可用报告：ASR-20261016-20261016163620-ddd0d0（20261016）
```json
{
  "as_of_trade_date": "20261016",
  "quality": {
    "trade_date": "20261016",
    "status": "READY",
    "reasons": [],
    "counts": {
      "daily": 5567,
      "daily_basic": 5567,
      "adj_factor": 5577,
      "stk_limit": 5655,
      "prev_daily": 5565,
      "listed": 5577
    },
    "coverage": {
      "daily_vs_prev": 1.0004,
      "daily_vs_listed": 0.9982,
      "daily_basic_vs_daily": 1,
      "adj_factor_vs_daily": 1,
      "stk_limit_vs_daily": 1.0158
    },
    "anomalies": {
      "bad_close": 0,
      "ohlc_inconsistent": 0,
      "zero_amount": 0,
      "extreme_move": 1
    },
    "indices_present": [
      "000001.SH",
      "000300.SH",
      "000688.SH",
      "000852.SH",
      "000905.SH",
      "399001.SZ",
      "399006.SZ",
      "899050.BJ"
    ],
    "checked_at": "2026-10-16T16:38:59.722Z"
  },
  "recent_days": [
    {
      "trade_date": "20261012",
      "status": "READY",
      "daily": 5561,
      "daily_basic": 5561,
      "adj_factor": 5573
    },
    {
      "trade_date": "20261013",
      "status": "READY",
      "daily": 5561,
      "daily_basic": 5561,
      "adj_factor": 5574
    },
    {
      "trade_date": "20261014",
      "status": "READY",
      "daily": 5563,
      "daily_basic": 5563,
      "adj_factor": 5574
    },
    {
      "trade_date": "20261015",
      "status": "READY",
      "daily": 5565,
      "daily_basic": 5565,
      "adj_factor": 5576
    },
    {
      "trade_date": "20261016",
      "status": "READY",
      "daily": 5567,
      "daily_basic": 5567,
      "adj_factor": 5577
    }
  ],
  "latest_daily_in_cache": "20261016",
  "core_indices": {
    "000001.SH": "上证指数",
    "399001.SZ": "深证成指",
    "399006.SZ": "创业板指",
    "000300.SH": "沪深300",
    "000905.SH": "中证500",
    "000852.SH": "中证1000",
    "000688.SH": "科创50",
    "899050.BJ": "北证50"
  },
  "fina_indicator_periods": [
    {
      "period": "20260930",
      "rows": 58,
      "synced_at": "2026-10-16T16:36:18.208Z"
    },
    {
      "period": "20260630",
      "rows": 10758,
      "synced_at": "2026-10-16T16:36:19.545Z"
    },
    {
      "period": "20260331",
      "rows": 6897,
      "synced_at": "2026-10-16T16:36:20.884Z"
    },
    {
      "period": "20251231",
      "rows": 6841,
      "synced_at": "2026-10-16T16:03:26.987Z"
    }
  ],
  "last_sync": [
    {
      "dataset": "adj_factor",
      "synced_at": "2026-10-16T16:36:14.542Z"
    },
    {
      "dataset": "daily",
      "synced_at": "2026-10-16T16:36:13.289Z"
    },
    {
      "dataset": "daily_basic",
      "synced_at": "2026-10-16T16:36:13.959Z"
    },
    {
      "dataset": "fina_indicator",
      "synced_at": "2026-10-16T16:36:20.884Z"
    },
    {
      "dataset": "index_daily",
      "synced_at": "2026-10-16T16:36:17.837Z"
    },
    {
      "dataset": "stk_limit",
      "synced_at": "2026-10-16T16:36:15.134Z"
    },
    {
      "dataset": "stock_basic",
      "synced_at": "2026-10-16T16:36:11.049Z"
    },
    {
      "dataset": "trade_cal",
      "synced_at": "2026-10-16T16:36:07.918Z"
    }
  ],
  "report_for_date": {
    "report_id": "ASR-20261016-20261016163620-ddd0d0",
    "trade_date": "20261016",
    "status": "READY",
    "generated_at": "2026-10-17T00:36:20.909+08:00",
    "path": "/data/reports/20261016/ASR-20261016-20261016163620-ddd0d0.json"
  },
  "latest_ready_report": {
    "report_id": "ASR-20261016-20261016163620-ddd0d0",
    "trade_date": "20261016",
    "status": "READY",
    "generated_at": "2026-10-17T00:36:20.909+08:00",
    "path": "/data/reports/20261016/ASR-20261016-20261016163620-ddd0d0.json"
  },
  "evidence_window": {
    "start": "20240102",
    "end": "20261016",
    "computed_at": "2026-10-16T16:16:16.867Z"
  }
}
```
