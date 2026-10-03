import { Store, toCsv } from "./store";
import { validateAndBuild } from "./validate";
import fs from "node:fs";

const store = new Store();

function parseJsonArg(args: string[], i: number): unknown {
  const v = args[i];
  if (v === undefined) throw new Error("缺少 JSON 参数");
  return JSON.parse(v);
}

function fail(err: unknown): never {
  const e = err as { code?: string; message?: string };
  console.error(`错误 [${e.code ?? "ERROR"}] ${e.message ?? String(err)}`);
  process.exit(1);
}

function printSummary(s: { periods: number; totalInterest: number; totalPaid: number; totalExtraApplied?: number; totalExtraUnused?: number }): void {
  console.log(`期数: ${s.periods}  总利息: ${s.totalInterest} 分  实际总还款: ${s.totalPaid} 分` +
    (s.totalExtraApplied !== undefined ? `  额外还款(实扣/未用): ${s.totalExtraApplied}/${s.totalExtraUnused} 分` : ""));
}

function printRows(rows: { period: number; openingBalance: number; interest: number; normalPayment: number; principalPaid: number; extraApplied: number; extraUnused: number; closingBalance: number }[]): void {
  console.log("期次  期初余额  利息  普通还款  冲减本金  额外冲本  未使用  期末余额");
  for (const r of rows) {
    console.log([r.period, r.openingBalance, r.interest, r.normalPayment, r.principalPaid, r.extraApplied, r.extraUnused, r.closingBalance].join("  "));
  }
}

function main(): void {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "preview": {
        const { result } = validateAndBuild(parseJsonArg(args, 0));
        if (!result.ok) fail(Object.assign(new Error(result.message), { code: result.code }));
        printSummary(result.summary);
        printRows(result.rows);
        break;
      }
      case "create": {
        const name = args[0] ?? "未命名方案";
        const { input, result } = validateAndBuild(parseJsonArg(args, 1));
        if (!result.ok) fail(Object.assign(new Error(result.message), { code: result.code }));
        const saved = store.saveVersion(null, name, input, result.summary, result.rows);
        console.log(`已保存 方案 ${saved.planId} 版本 ${saved.version}`);
        printSummary(saved.summary);
        break;
      }
      case "add-version": {
        const planId = Number(args[0]);
        const { input, result } = validateAndBuild(parseJsonArg(args, 1));
        if (!result.ok) fail(Object.assign(new Error(result.message), { code: result.code }));
        const saved = store.saveVersion(planId, "", input, result.summary, result.rows);
        console.log(`已保存 方案 ${saved.planId} 版本 ${saved.version}`);
        printSummary(saved.summary);
        break;
      }
      case "list": {
        for (const p of store.listPlans()) console.log(`方案 ${p.id}  ${p.name}  版本数 ${p.versions}  创建于 ${p.createdAt}`);
        break;
      }
      case "show": {
        const v = store.getVersion(Number(args[0]), args[1] ? Number(args[1]) : undefined);
        if (!v) fail(Object.assign(new Error("方案版本不存在"), { code: "NOT_FOUND" }));
        console.log(`方案 ${v.planId} 版本 ${v.version}  输入: ${JSON.stringify(v.input)}`);
        printSummary(v.summary);
        printRows(v.rows);
        break;
      }
      case "compare": {
        const va = store.getVersion(Number(args[0]), args[1] ? Number(args[1]) : undefined);
        const vb = store.getVersion(Number(args[2]), args[3] ? Number(args[3]) : undefined);
        if (!va || !vb) fail(Object.assign(new Error("方案版本不存在"), { code: "NOT_FOUND" }));
        console.log(`A: 方案 ${va.planId} v${va.version}  期数 ${va.summary.periods}  总利息 ${va.summary.totalInterest} 分`);
        console.log(`B: 方案 ${vb.planId} v${vb.version}  期数 ${vb.summary.periods}  总利息 ${vb.summary.totalInterest} 分`);
        console.log(`差异(B-A): 期数 ${vb.summary.periods - va.summary.periods}  总利息 ${vb.summary.totalInterest - va.summary.totalInterest} 分`);
        break;
      }
      case "export-csv": {
        const v = store.getVersion(Number(args[0]), args[1] ? Number(args[1]) : undefined);
        if (!v) fail(Object.assign(new Error("方案版本不存在"), { code: "NOT_FOUND" }));
        const out = args[2] ?? `plan-${v.planId}-v${v.version}.csv`;
        fs.writeFileSync(out, toCsv(v.rows), "utf8");
        console.log(`已导出 ${out}`);
        break;
      }
      default:
        console.log(`用法:
  preview '<json>'                    试算（不落库）
  create <名称> '<json>'              创建方案（版本 1）
  add-version <方案id> '<json>'       新增版本（可改额外还款）
  list                                列出方案
  show <方案id> [版本]                查看版本明细
  compare <idA> [vA] <idB> [vB]       比较两个版本
  export-csv <方案id> [版本] [文件]   导出 CSV
json 示例: {"principal":1200000,"monthlyRate":"0.005","monthlyPayment":23000,"extras":[{"period":6,"amount":100000}]}
金额单位：分；monthlyRate 为每期利率的小数（0.005 = 0.5%）。`);
    }
  } catch (err) {
    fail(err);
  } finally {
    store.close();
  }
}

main();
