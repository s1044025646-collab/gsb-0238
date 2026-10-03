# 固定月息分期还款试算与提前还款对照（本地后端）

纯本地运行的还款计划试算服务：TypeScript + Node.js + SQLite（`node:sqlite` 内置模块），只提供 HTTP API 与 CLI，无前端、无 Docker、无外部在线服务。所有金额均为**虚构试算数据**，不接银行、不涉及真实账户，不实现贷款审批、资金收付或账务总账。

## 计算模型约定

- **金额精度**：所有金额以“分”为单位的整数保存与计算；利息用整数比例（BigInt）精确计算，四舍五入（half-up）到分，不使用浮点数，也不把误差留到最后一行修正。
- **期次**：从 1 开始，按期计算；不处理日期、日息、逾期费、浮动利率或任何优惠规则。
- **逐期顺序**：
  1. 当期利息 = round(期初剩余本金 × 月利率)，四舍五入到分；
  2. 普通还款 = min(固定还款额, 期初本金 + 当期利息)，先付息、剩余冲减本金（最后一期自动缩小到恰好结清）；
  3. 额外还款在当期普通还款**之后**冲减本金，超出剩余本金的部分记为“未使用金额”，不产生负余额。
- **拒绝与限制**：
  - 固定还款额不足以覆盖当期利息并减少本金时，整个计划被拒绝（`INSUFFICIENT_PAYMENT`）；
  - 达到最大期数（默认 1200，可用 `maxPeriods` 调整）仍未结清时返回 `LIMIT_EXCEEDED` 及剩余本金，**不宣称已生成完整计划**；
  - 额外还款期次必须是从 1 开始的整数且不超出实际还款期数，否则 `VALIDATION_ERROR`。
- **零利率**：正常工作，利息全为 0。
- **可复核**：每期输出普通还款、额外本金（计划/实扣/未用）分列；任意版本满足：本金总偿还 = 初始本金，总还款 = 本金 + 利息，期初余额逐期衔接。

## 环境要求

- Windows 本地，Node.js ≥ 22（使用内置 `node:sqlite`，开发环境为 Node 25）。
- 仅开发依赖 `typescript` 与 `@types/node`，无运行时第三方依赖。

## 快速开始

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 构建并运行全部单元测试
npm start         # 启动 HTTP 服务（默认由系统分配空闲端口）
npm start -- --port=8080   # 或 $env:PORT=8080; npm start 指定端口
npm run demo      # 演示：固定还款 vs 第 6 期额外还款的对照
```

数据文件保存在项目内 `data/plans.db`（自动创建）。

## CLI

```powershell
npm run cli -- preview '{"principal":1200000,"monthlyRate":"0.005","monthlyPayment":23000}'
npm run cli -- create 方案A '{"principal":1200000,"monthlyRate":"0.005","monthlyPayment":23000}'
npm run cli -- add-version 1 '{"principal":1200000,"monthlyRate":"0.005","monthlyPayment":23000,"extras":[{"period":6,"amount":200000}]}'
npm run cli -- list
npm run cli -- show 1 2
npm run cli -- compare 1 1 1 2
npm run cli -- export-csv 1 2 plan.csv
```

输入 JSON 字段：`principal`（本金，分）、`monthlyRate`（每期利率小数，如 `"0.005"`）、`monthlyPayment`（每期固定还款额，分）、`extras`（可选，`[{period, amount}]`）、`maxPeriods`（可选，默认 1200）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/preview` | 试算逐期表，不落库 |
| POST | `/api/plans` | 创建方案（保存为版本 1，事务内写入全部期次） |
| GET | `/api/plans` | 列出方案 |
| GET | `/api/plans/:id` | 查看最新版本（含完整输入与逐期结果） |
| POST | `/api/plans/:id/versions` | 以新输入（可改额外还款）保存新版本 |
| GET | `/api/plans/:id/versions/:v` | 查看指定版本，历史方案可重新核算 |
| GET | `/api/plans/:id/versions/:v/csv` | 导出该版本逐期表 CSV |
| POST | `/api/compare` | 比较两个版本：`{a:{planId,version?}, b:{planId,version?}}`，返回总利息与结清期数差异 |

错误统一为 `{"error":{"code","message"}}`：`VALIDATION_ERROR`(400)、`NOT_FOUND`(404)、`INSUFFICIENT_PAYMENT` / `LIMIT_EXCEEDED`(422)。

每个版本完整保存输入与全部期次结果；保存在一个 SQLite 事务中完成，任一步失败整体回滚，不会留下只有头部没有明细的记录。

## 逐期输出字段

`period, openingBalance, interest, normalPayment, principalPaid, extraPayment, extraApplied, extraUnused, totalPaid, closingBalance`（单位均为分）。合计字段：`periods, totalInterest, totalNormalPaid, totalPrincipalPaid, totalExtraPlanned, totalExtraApplied, totalExtraUnused, totalPaid`。

## 测试

`npm test` 覆盖：可手算小本金逐期核对、末期缩小、零利率、0.5 分舍入边界、提前全部结清（未使用金额）、无效期次、还款不足、最大期数限制、余额衔接与合计恒等式、重启后（新连接）版本查询、保存失败回滚。另有 `node test/api.smoke.mjs` 做 API 冒烟测试。

## 限制

- 仅展示本 README 约定的按期计算模型结果，不构成任何投资或借贷建议。
- 不支持日期/日息、逾期、浮动利率、部分提前还款后的还款额重算（额外还款只缩短期数，固定还款额不变）。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常现象。
