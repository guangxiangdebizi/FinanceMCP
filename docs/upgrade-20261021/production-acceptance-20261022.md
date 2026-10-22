# 生产验收记录（2026-10-22，V1.1）

本记录是 2026-10-22 事后生成的验收材料，不是原交易日的前瞻判断。已脱敏：不含令牌、成交金额、持仓数量和账户明细。

## 部署
- 升级前：运行镜像 revision 为 f08b77f，健康，容器内已有 `ashare_investment_research_bundle`（旧的"未部署"结论已过期）。
- 升级后：revision `0b6cee7ca7b45673bea387b13b132b8e1d911f4a`，容器 healthy，`/health` 正常。
- 备份：`upgrade.sh` 自动备份市场库、私有账户库、OAuth 库、研究库与配置，并保留回滚镜像 `finance-mcp-ashare:rollback-20261022T052906Z`（记录 `backups/rollback-20261022T052906Z.env`）。
- Caddy：`/private/mcp*` 与 OAuth 发现路由已存在，本次没有新增路由，不需要 root。无令牌访问 `/private/mcp` 返回 401，OAuth 发现端点返回 200。
- 私有端点静态令牌关闭，仅接受 OAuth，因此未用令牌在 VPS 外调用 `tools/list`；容器内工具定义共 7 个私有工具，含 `ashare_investment_research_bundle`。

## 已持久化的用户批准
- 风险政策 `portfolio-drawdown-policy-1.0.0`，批准日 20261022，10%/15%/20% = L1/L2/L3，单笔预算 0.5%，不自动减仓。写入私有库（`real-main`）。
- 多资产基准 `r2-benchmarks-1.1.0`，status approved，批准日 20261022；旧 `r2-benchmarks-1.0.0` 保留。早于 20261022 的窗口标为 `RETROSPECTIVE_COMPARISON`。
- 12 笔费率样本：仅写入 VPS 私有校准目录（目录 700、文件 600）；`portfolio-fees-set/calibrate` 已应用，样本逐笔复现。159558.SZ、560390.SH 为 SUPER_ETF（万 0.5，无最低佣金）；516080.SH 最低 5 元为 CONFIRMED，比例佣金保持 UNKNOWN；生效日 20261016，不回溯。未写入任何账本成交。分笔、舍入等规则仍未确认。

## 真实数据包
- `report_id`：`BUNDLE-20261021-8da6011f7c14f9c64493`
- `as_of_trade_date`：20261021（执行时 10-22 尚未收盘，使用最近已收盘日）；整体状态 `DEGRADED`
- 市场 READY；ETF 收盘行情 5/5 READY；账户身份 `REAL_ACCOUNT_VERIFIED`
- 账户完整性 `UNCONFIRMED_RISK`（`unreported_trade_risk`）：未新增用户确认，不输出可执行数量
- 证据状态 `UNVERIFIED`；交易预案 `NOT_EXECUTABLE`
- 三个基准均 OK（沪深300 买入持有、已批准多资产篮子、初始五只不交易）；因三者窗口不同，相对超额为 UNAVAILABLE
- 补数据：执行 `etf-sync` 后，510300 等成分的窗口起点缺口已补齐，无错误
- 风险政策在 as-of ≥ 20261022 的数据包中出现；20261021 的数据包按设计不含它，以保证历史报告可复现。首次出现将在 20261022 收盘后，待验证。

## 前瞻与复盘
- 冻结协议 `FRZ-3f35c357d68ad54e3d3f22bd`，起点 20261023，`FROZEN_RESEARCH_ONLY` / UNVERIFIED。
- `finance-ashare-account-daily` 手动触发一次成功：日志记录 1 条（`PRE_FORWARD_HISTORICAL`，不计入前瞻统计），复盘结论 `NO_MATURED_FORWARD_SAMPLE`。
- 定时器 21:15 CST 将自动运行；这是此前第一次成功。

## 未闭环
- ChatGPT 写回：MCP 无写日志工具，未实现；没有伪造 ChatGPT 记录。
- 没有任何证据证明策略优于被动基准。
