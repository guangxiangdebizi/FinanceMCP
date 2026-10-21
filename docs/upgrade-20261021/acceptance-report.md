# 验收报告（2026-10-21）

分支 `feat/investment-research-20261021`。以下只记录已执行并核实的事项。

## 一、完成情况

| 模块 | 状态 |
| --- | --- |
| Phase 1 统一费率引擎 | 本地完成并测试；未部署 |
| Phase 2 账本与对账 | 本地完成并测试；未部署；Excel 导入未做（无可靠读取能力，需另存 UTF-8 CSV） |
| Phase 3 信号验证与股票池审计 | 本地完成并测试；证据等级映射 `evidenceTier.ts` 尚未接入日报输出 |
| Phase 4 ETF、基准、情景 | 本地完成并测试；用户真实账户历史表现尚未接入基准比较 |
| Phase 5 统一研究数据包 | 本地完成并测试；**生产尚无该工具** |
| Phase 6 研究日志与复盘 | 本地完成并测试 |
| Phase 7 ChatGPT 迁移材料 | 材料已备；**网页端任务未修改** |
| Phase 8 测试 | 本地全量通过；生产验收未做 |

## 二、测试

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过 |
| `npm run test:ashare`（改动前基线） | 194/194 通过 |
| `npm test`（改动后全量） | 562 项，562 通过，0 失败，0 跳过 |

中途出现过一次失败：`test/portfolio-decision.test.mjs` 第 9 项，原因是测试夹具的证据没有来源，被可信策略正确拒绝。只修了夹具，没有放宽门控。

## 三、研究效果

- 股票池（2026-07-14 至 2026-10-13，60 个成熟日期）：五日平均超额 -1.68%，跑赢等权基准 13/60（21.7%）。复核后与原报告逐位一致。结论：没有证据支持生产池有正优势，权重不变。
- 回顾性验证（`VAL-0c89db24dcd36ed659c595e7`）：8 个模型扣费超额均为负（-0.09% 到 -0.66%），原模型 -0.4734%，区间均跨 0；232 项检验经 Holm 校正无一通过 0.05。这是 RETROSPECTIVE_HOLDOUT，不是真正的前瞻样本。
- 没有证据证明策略改善。

## 四、部署与数据库（只读检查结果）

- 容器 `finance-mcp-ashare` 健康，监听 127.0.0.1:8130。
- 运行镜像 OCI revision `476bfff3`（`feat/ashare-v1`），落后于分支 HEAD；容器内没有 `ashare_investment_research_bundle`。
- 回退镜像存在：`rollback-20261019T152938Z`、`rollback-pre-v1`。
- 本次未部署、未重启、未改生产库。
- 部署命令：`deploy/ashare/upgrade.sh --revision <完整 sha> --branch feat/investment-research-20261021 [--dry-run]`，需工作区干净。
- 阻塞：Caddy 新路由需要 root，由用户执行。

## 五、剩余问题

1. 生产部署待用户执行（Caddy 需 root）。
2. 真实数据驱动的日报验收样例待部署后在真实交易日填写（`daily-report-integration.md` 有待填表）。
3. ChatGPT 网页任务需用户按迁移材料手动应用。
4. 组合级风险预算未经用户确认，`risk_budget` 只标 `NO_USER_CONFIRMED_PORTFOLIO_BUDGET`。
5. 多资产基准权重仍为 `provisional_pending_user_approval`。
