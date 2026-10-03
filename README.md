# 固定月息分期还款试算与提前还款对照（本地后端）

使用虚构金额的本地还款计划试算服务。仅实现本题约定的按期计算模型：不接银行、不使用真实账户，
不做贷款审批、资金收付或账务总账，不含日期、日息、逾期费、浮动利率或优惠规则，也不构成任何投资建议。

- 技术栈：TypeScript + Node.js（≥ 22.5，推荐 24+）+ SQLite（Node 内置 `node:sqlite`，零原生依赖）
- 形态：HTTP API + CLI，Windows 本地直接运行，不依赖 Docker / WSL / 外部服务
- 数据目录：项目内 `./data/loan-scheduler.db`

## 计算模型（约定）

期次从 1 开始，逐期摊还，顺序固定：

1. **计息**：`当期利息 = 四舍五入(期初剩余本金 × 月利率)`，精确到分。
2. **普通还款**：先支付利息，剩余部分冲减本金。普通还款不超过当期「本金 + 利息」，
   最后一期自动缩小到恰好结清。
3. **额外还款**：在当期普通还款之后冲减本金；超出剩余本金的部分记为**未使用金额**，
   不产生负余额。

### 精度

- 所有金额以**分**为单位的整数保存与计算（SQLite 中也是整数分）。
- 月利率以十进制字符串输入（如 `"0.005"`），内部解析为有理数，利息用 BigInt 精确计算后
  四舍五入（half-up）到分；不存在浮点误差，也不需要末期“修正”。
- 合计均可从明细复核：`总还款 = 总普通还款 + 已使用额外还款 = 初始本金 + 总利息`。

### 限制

- 固定还款额不足以覆盖当期利息并减少本金时，**拒绝整个计划**（错误码 `INSUFFICIENT_PAYMENT`）。
- 公开的最大期数上限为 **1200 期**（可用 `maxPeriods` 调小，不能调大）。达到上限仍未结清时，
  返回 `status = "limit_exceeded"` 及 `limitReason`，`payoffPeriods = null`，不宣称已生成完整计划。
- 零利率正常工作。

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 API（默认自动选择空闲端口，--port=8080 或 PORT 环境变量可指定）
npm run demo      # 内置演示：固定还款方案 + 第 6 期额外还款 2000 元对照
```

## CLI

```powershell
node dist/src/cli.js create-plan --name=我的方案
node dist/src/cli.js preview --principal=12000 --rate=0.005 --payment=500        # 预览，不保存
node dist/src/cli.js add-version --plan=1 --principal=12000 --rate=0.005 --payment=500 --extra6=2000
node dist/src/cli.js add-extra --version=1 --period=6 --amount=2000              # 另存为新版本；amount=0 删除
node dist/src/cli.js show --version=1
node dist/src/cli.js compare --a=1 --b=2
node dist/src/cli.js export-csv --version=1 --out=plan.csv
node dist/src/cli.js serve --port=8080
```

CLI 金额单位为**元**（最多两位小数），`--extraN=金额` 表示第 N 期额外还款。

## HTTP API

金额单位一律为**分**（整数）。错误统一为 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/plans` | 创建方案 `{name}` |
| GET | `/plans` | 列出方案 |
| POST | `/plans/:id/versions` | 计算并保存新版本 `{principalCents, monthlyRate, monthlyPaymentCents, extras?, maxPeriods?}` |
| GET | `/plans/:id/versions` | 列出方案版本 |
| GET | `/versions/:id` | 版本完整输入 + 逐期结果 |
| POST | `/versions/:id/extras` | 加/改某期额外还款 `{period, amountCents}`（0 删除），另存新版本 |
| POST | `/preview` | 仅计算不保存，入参同 versions |
| GET | `/compare?a=1&b=2` | 比较两版本总利息、结清期数、总还款 |
| GET | `/versions/:id/csv` | 导出逐期 CSV |
| GET | `/health` | 健康检查 |

### 错误码

| code | HTTP | 含义 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | 参数缺失/非法（金额须为整数分、利率须为非负十进制字符串且 < 1） |
| `INVALID_PERIOD` | 400 | 额外还款期次超出最大期数 |
| `INSUFFICIENT_PAYMENT` | 422 | 固定还款额不足以覆盖当期利息并减少本金 |
| `NOT_FOUND` | 404 | 方案/版本/路由不存在 |
| `INTERNAL_ERROR` | 500 | 未预期错误 |

### 逐期字段

`interestCents`（利息）、`ordinaryPaymentCents`（普通还款）、`principalPaidCents`（普通还款中的还本）、
`extraAppliedCents`（额外还款实际冲本）、`extraUnusedCents`（额外还款未使用部分）、
`balanceAfterCents`（期末余额），以及累计列 `cumInterestCents / cumPrincipalCents / cumPaymentCents`。

## 持久化与一致性

- 每个版本完整保存输入（本金、利率、固定还款、全部额外还款、最大期数）与逐期结果，
  历史方案可随时重新查询核对。
- 版本头部、额外还款、全部期次明细在**单个事务**中写入；任一步失败整体回滚，
  不会留下只有头部没有明细的记录；计算被拒绝（如还款不足）时不落库。

## 测试

`npm test` 覆盖：可手算的小本金逐期核对、末期缩小、零利率、分的舍入边界（含半点进位）、
提前全部结清与未使用金额、无效期次、还款不足拒绝、最大期数限制原因、余额衔接 /
本金总偿还 = 初始本金 / 总还款 = 本金 + 利息等不变量、重启后版本查询、API 全流程与错误码。

## 已知限制

- 仅本地单用户，无鉴权；服务绑定 `127.0.0.1`。
- 使用 Node 内置 `node:sqlite`（Node 22.5+，启动时可能有 ExperimentalWarning，不影响功能）。
- 金额为安全整数分（约 9 千万亿元以内），超出返回校验错误。
