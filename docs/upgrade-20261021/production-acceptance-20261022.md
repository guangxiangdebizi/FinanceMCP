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

## 收盘后补充验证（2026-10-22 21:15 CST 之后）
- `finance-ashare-account-daily` 21:15 CST 自动运行成功（exit 0），账户记录与复盘均 ok。这是该单元第一次成功的定时运行。
- `finance-ashare-daily` 在 18:40、21:10 CST 的行情同步与日报均成功（3 个交易日 READY），但随后的冻结规则观察步骤失败，单元以 exit 76 结束。原因：`run-daily.sh` 调用 `research-validation observe` 时漏了必需的 `--as-of`。这是早已存在的缺陷，此前因 `validation.sqlite` 不存在而被静默跳过，10-22 冻结规则后才暴露。已修复为取日报输出末尾的 `trade_date` 作为 `--as-of`；手动验证返回 `UNAVAILABLE / matching_active_freeze_unavailable`（冻结起点为 20261023，之前无前瞻观察），exit 0。脚本由 systemd 直接从仓库路径执行，无需重新部署；下一次定时运行（10-23 18:40 CST）才是它第一次自动运行的验证。
- 数据包 `BUNDLE-20261022-10a8a27935d1a234f36d`：as-of 20261022，市场 READY，整体 DEGRADED（仅因 `account_completeness: unreported_trade_risk`），证据状态 UNVERIFIED。
- `portfolio_risk` 首次出现：政策 `portfolio-drawdown-policy-1.0.0`（批准日 20261022）；回撤基于已核验、出入金调整的账户净值，当前回撤低于一级阈值，预警等级 NONE；净值点仅 5 个（自 20261016 基线起），历史很短；`action_boundary` 为仅研究复核、无卖出数量、无自动交易。
- 三个基准均 OK；基准版本 `r2-benchmarks-1.1.0` 标记 `approved:20261022:RETROSPECTIVE_COMPARISON`。

## 收尾阶段（2026-10-22，revision 79efbb7）
- **OAuth 私有 MCP**：用户刷新连接器后，服务端日志显示 ChatGPT 在 14:31 UTC 完成 OAuth 握手与 `tools/list`，14:32 UTC 成功调用 `ashare_investment_research_bundle`（`status=ok`）。ChatGPT 看不到新工具的原因是插件端缓存的旧工具清单，服务端与 Caddy 均无问题，Caddy 未修改。
- **账户完整性**：用户在对话中说明 2026-10-16 收盘基线之后至 2026-10-22 没有买卖、出入金、分红等账本事件；据此写入声明（`recorded_by=user-statement-relayed-via-claude-code`，非用户直接执行 CLI），写入前已对私有库做一致性备份。数据包状态由 DEGRADED 变为 READY；证据状态仍为 UNVERIFIED，交易预案仍为 NOT_EXECUTABLE（缺经验证的优势证据）。
- **口径统一**（`e7a8fc5`）：风险政策、回撤、预算与费用字段在旧日报与研究包之间统一。
  - 回撤明确标注为 `OBSERVATION_WINDOW_SINCE_BASELINE`（自 20261016 起 5 个净值点），`full_history=false`，不得当作全历史最大回撤；旧日报 `drawdown` 块继续声明全历史不可得。
  - 五个情景的 `risk_budget` 状态改为 `PORTFOLIO_RISK_POLICY_APPROVED`，携带政策版本、预警等级与回撤窗口；单笔计划风险预算仍为 0.5%，没有新增仓位上限。
  - 日报 `assumptions.fees` 新增 `per_code`，列出逐代码的分类、档案 ID、费率、最低佣金与证据等级。逐代码费率核查：159558.SZ、560390.SH 按 SUPER_ETF 档案计费，其余按类别默认；516080.SH 比例佣金 UNKNOWN，回退默认，最低 5 元为 CONFIRMED。
  - 目标日早于 20261022 的输出与 `report_id` 不变。
- **ChatGPT 追加式写回**（`0a7d401`）：新增私有工具 `ashare_chatgpt_research_record_append`，仅出现在 OAuth 私有端点。只 INSERT 不可变的 `research_journal`；`source` 固定为 chatgpt，时间戳、`record_id`、哈希由服务器生成；字段严格白名单，多余字段整次拒绝；必须关联已存在的同日 VPS 快照 `report_id`；幂等、同键不同内容拒绝、更正为新版本；有大小与每日条数上限；不触及账本、持仓、完整性、风险、费用、订单。可用 `ASHARE_CHATGPT_INTAKE_DISABLED=1` 关闭。局限：OAuth 仅有一个 `portfolio:read` scope，写入口与读取共用授权；记录无 `observations`，复盘中只留判断痕迹，不产生收益统计。本次未调用该工具，库中没有任何 ChatGPT 记录。
- **部署**：升级前自动备份；回滚记录 `rollback-20261022T161641Z.env`；镜像 revision `79efbb70f193e9ffff66a93b996ded5d3d1d8f09`，healthy；随后的数据包 `BUNDLE-20261022-4fa601f739be03234525` 状态 READY。
- **测试**：全量 602/602 通过。
- **事故记录**：合并前一个 agent 的 worktree 清理误删了主仓库的 `node_modules`，并把 `node_modules` 符号链接误提交；已用 `npm ci` 重建并另提交取消跟踪，未推送过含该符号链接的历史。
