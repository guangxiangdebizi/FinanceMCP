# 前瞻研究自动化（goal-1022 §七、§八）

审计时间：2026-10-22（上海时间）。代码基线：分支 `feat/investment-research-20261021`，HEAD f08b77f 之上的未提交改动。主机检查全部只读。

## 1. 结论

| 环节 | 状态 |
| --- | --- |
| 行情同步 / 质量检查 / 日报（`finance-ashare-daily.timer`，18:40、21:10 CST） | **已自动运行**，10-20、10-21 各两次成功 |
| VPS 原始研究快照写入不可变日志（`finance-ashare-account-daily.timer`，21:15 CST） | **尚未成功运行过**：10-20 失败（exit 127），10-21 失败（exit 2）；生产私有库里还没有 `research_journal` 表 |
| 冻结前瞻观察规则（`research-validation observe`） | **未运行**：`run-daily.sh` 只在 `/data/research-validation/validation.sqlite` 存在时才执行，该文件不存在，此前无声跳过 |
| 5/10/20/60 日到期评价 | 此前**无定时入口**（`portfolio-journal-evaluate` 只能手工运行）；本次接入 |
| 相对沪深300 / 多资产篮子 / 初始五只 ETF 的扣费后超额、波动、回撤、失效统计 | 此前不存在；本次新增 `portfolio-journal-review` |
| 无显著改善如实报告 | 本次新增，结论枚举固定，不改历史规则 |
| ChatGPT 写回 | **未闭环**（见 §5） |

## 2. 主机实际状态（只读核对）

- 两个 user timer 均 `enabled` / `active (waiting)`；`~/.config/systemd/user/` 下四个单元文件与仓库 `deploy/ashare/` 逐字节一致。
- `finance-ashare-daily`：10-20 18:42、21:12，10-21 18:42、21:12 均 `Finished`，当日报告 READY。下一次 10-22 18:40 CST 之后将首次在容器 f08b77f 上运行。
- `finance-ashare-account-daily`：
  - 10-20 21:16 CST：`exit 127`，日志 `node: not found`（当时脚本直接用宿主机 node，已被现脚本的 `docker exec` 取代）。
  - 10-21 21:16 CST：`exit 2`，日志只有 CLI 用法文本——当时运行中的镜像还没有 `investment-research-record` 命令。
  - 容器现已是 f08b77f（OCI revision 标签核对）并含该命令，但**尚无一次成功运行**；下一次触发 10-22 21:15 CST。
- 生产 `portfolio.sqlite`：`research_journal`、`research_journal_evaluation`、`plan_tracking` 均不存在（仅读表计数）。
- 容器内 `build/portfolio/journalCli.js` 还没有 `portfolio-journal-review`：新代码需要经批准的重新部署后，21:15 的复盘步骤才会生效。部署前该步骤会失败并让单元显式失败（见 §3），不会静默。

## 3. 本次代码改动

- `src/portfolio/forwardReview.ts`（新）：`buildForwardReview`，确定性、无时钟。
  - 证据分级：`as_of_trade_date < 20261022` → `PRE_FORWARD_HISTORICAL`；之后但生成/写入/取得晚于该交易日（上海时间）→ `RETROSPECTIVE_RECORD`；其余 `TRUE_FORWARD`。前两类只计数并列出，**不进入任何统计**。
  - 按来源（vps / chatgpt / combined）分开统计，不混合。
  - 5/10/20/60 个交易日窗口，仅 `EVALUATED` 的成熟窗口入统计；`PENDING`、`UNAVAILABLE`（含原因）单独计数，不缩短窗口、不估值。
  - 每个窗口按各标的投入金额加权，得到扣费后收益、成员最大回撤；相对三个基准的超额（百分点）：
    - 沪深300 ETF：沿用日志评价的同预算整手含买卖费用比较；
    - 已冻结多资产篮子：调用 `buildBenchmarkComparison({start: 研究日, end: 成熟日})`，输出同时带 `definition_version` 与 `weights_status`；其基准版本由另一工作线维护，本模块只读取，不改定义；
    - 初始五只 ETF 不交易：该基准锚定在 20261016 基线，不能晚起点，故取同一条锚定路径上“研究日→成熟日”的市值比（数量常量、不交易、现金计入）。
  - 统计量：均值/中位数/窗口间标准差/最差值、基准窗口平均年化波动与回撤、命中率；失效统计：净收益为负的窗口数、跑输沪深300 的窗口数、触及失效价的观察数。
  - 不重叠窗口数低于 12 不下改进/无改进结论（`INSUFFICIENT_SAMPLE`；12 是披露门槛，不是显著性检验）。结论枚举：`NO_MATURED_FORWARD_SAMPLE` / `INSUFFICIENT_FORWARD_SAMPLE` / `NO_IMPROVEMENT_DEMONSTRATED` / `IMPROVEMENT_OBSERVED_NOT_SIGNIFICANT`，附固定中文说明；即使平均为正也明示“不构成前瞻有效性的证据”。
- `src/portfolio/researchJournal.ts`：评价的每个观察增加 `invested_cents`（加权用）。仅增字段，不改任何已有字段与哈希口径。
- `src/portfolio/journalCli.ts`：新增 `portfolio-journal-review [--account] [--date] [--record --confirm]`。默认日期取行情缓存最新 ETF 日线日期；`--record` 先追加成熟评价（不可变表，同内容幂等），再把复盘写成 `forward-reviews/<日期>-FR-<内容哈希>.json`（0600，`wx`，内容变化即新文件，不覆盖）。不写账本、风险配置，不下单。
- `deploy/ashare/run-account-daily.sh`：先记录 VPS 快照，**无论记录是否 DATA_INSUFFICIENT 都继续运行复盘**（让既有窗口继续成熟）；任一步失败单元显式失败（记录失败沿用其退出码，复盘失败 exit 77）。
- `deploy/ashare/run-daily.sh`：冻结规则不存在时不再静默，输出 `validation observation SKIPPED` 到 stderr/journal（仍非致命）。
- 测试：`test/upgrade-forward-review.test.mjs`（6 项）。

## 4. 需要用户/负责人执行的交接项（未擅自操作）

1. 经批准后重新部署，使容器含 `portfolio-journal-review`。
2. 启动冻结规则的前瞻记录：`research-validation freeze` 要求 `--start` 晚于当天，且会写生产的 `/data/research-validation`，属于生产状态变更，未执行。建议在 10-22 收盘后执行并取 `--start 20261023`，此后 `run-daily.sh` 自动 observe。10-22 当天因此不会出现在冻结规则的前瞻序列中（VPS 日志快照仍从 10-22 起算）。
3. 多资产篮子权重目前在代码里为 `provisional_pending_user_approval`；复盘报告原样带出该状态，批准后随基准版本更新。

## 5. ChatGPT 研究判断写回：未闭环

已核对：
- 日志 schema 支持 `source: chatgpt | combined`，且强制真实 `provenance`（作者、来源引用、取得时间），拒绝无来源的 ChatGPT 结论；`combined` 必须有真实 VPS 与 ChatGPT 父记录。
- 唯一写入口是 CLI `portfolio-journal-import --file PATH --confirm`（需要宿主机/容器内操作，追加式，同 ID 同内容幂等，冲突拒绝，表有 UPDATE/DELETE/REPLACE 触发器保护）。
- MCP 与 OAuth 路由**没有任何**写日志的工具（测试断言 `researchTools.ts`、`tools.ts`、`oauth/router.ts` 不引用 journal 写函数）。ChatGPT 定时任务因此没有写回能力，库里也没有任何 ChatGPT 记录，也不会被伪造。

最小授权方案（待批准后再做，不在本次实现）：
- 新增只追加的 MCP 工具 `append_chatgpt_research_record`，使用独立 scope（如 `research:append`），与读取、账本、风险配置、下单 scope 完全分离；服务端固定 `source='chatgpt'`，拒绝 `vps/combined`。
- 服务端自行写 `provenance.obtained_at`/`recorded_at`（不信任调用方时间），只接受 judgement/candidates/observations/evidence 的 JSON，带大小上限与每日条数限额；不接受任何数量以外的账户字段，不接受 `correction_of` 以外的改历史方式。
- 不返回账户明细，只返回 `record_id` 与 `content_hash`。
- 在此之前，如需录入：由用户把 ChatGPT 实际输出保存为 JSON，通过 `portfolio-journal-import` 导入；review 将其作为独立来源统计。

## 6. 诚实边界

- 观察对象是账户持仓的价格纸面观察，不是实际成交，也没有候选 ETF 的前瞻命中评价；候选研究的前瞻评价依赖上面第 4 条的冻结规则。
- 窗口逐日重叠，统计量相关；未做显著性检验；基准对照对研究侧略偏严格（篮子仅含建仓费、五只 ETF 无费用）。
- 2026-10-22 之前的数据一律标为历史，不会被包装成前瞻样本。
- 没有新成交信息时日报照常运行；账户完整性声明不会被自动延长。
