import * as fs from "node:fs";
import { AppError, centsToYuan, yuanToCents } from "./money";
import { computeSchedule, ScheduleResult } from "./schedule";
import { defaultDbPath, Store, VersionRecord } from "./db";
import { startServer } from "./server";

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const [cmd = "help", ...rest] = argv;
  const opts: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) opts[a.slice(2, eq)] = a.slice(eq + 1);
      else opts[a.slice(2)] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : "true";
    }
  }
  return { cmd, opts };
}

function printSchedule(result: ScheduleResult): void {
  console.log(
    "期次 | 利息(元) | 普通还款(元) | 还本(元) | 额外还本(元) | 额外未用(元) | 期末余额(元) | 累计利息(元)",
  );
  for (const r of result.rows) {
    console.log(
      [
        r.period,
        centsToYuan(r.interestCents),
        centsToYuan(r.ordinaryPaymentCents),
        centsToYuan(r.principalPaidCents),
        centsToYuan(r.extraAppliedCents),
        centsToYuan(r.extraUnusedCents),
        centsToYuan(r.balanceAfterCents),
        centsToYuan(r.cumInterestCents),
      ].join(" | "),
    );
  }
  console.log(
    `状态: ${result.status}${result.limitReason ? `（${result.limitReason}）` : ""} | 结清期数: ${
      result.payoffPeriods ?? "未结清"
    } | 总利息: ${centsToYuan(result.totalInterestCents)} 元 | 总还款: ${centsToYuan(
      result.totalPaymentCents,
    )} 元`,
  );
}

function inputFromOpts(opts: Record<string, string>) {
  const extras = Object.keys(opts)
    .filter((k) => k.startsWith("extra"))
    .map((k) => {
      // --extra3=5000.00 表示第 3 期额外还款 5000 元
      const period = Number(k.slice(5));
      return { period, amountCents: yuanToCents(opts[k], `extra${period}`) };
    });
  return {
    principalCents: yuanToCents(required(opts, "principal"), "principal"),
    monthlyRate: required(opts, "rate"),
    monthlyPaymentCents: yuanToCents(required(opts, "payment"), "payment"),
    extras,
    ...(opts.maxPeriods ? { maxPeriods: Number(opts.maxPeriods) } : {}),
  };
}

function required(opts: Record<string, string>, key: string): string {
  const v = opts[key];
  if (v === undefined) throw new AppError("VALIDATION_ERROR", `缺少参数 --${key}`);
  return v;
}

function printVersion(v: VersionRecord): void {
  console.log(`版本 ${v.id}（方案 ${v.planId} 第 ${v.versionNo} 版）`);
  printSchedule(v.result);
}

const HELP = `用法: node dist/src/cli.js <命令> [参数]
  serve [--port=0]                      启动 HTTP API（默认自动选空闲端口）
  create-plan --name=名称               创建方案
  list-plans                            列出方案
  preview --principal=元 --rate=月利率 --payment=元 [--extraN=元] [--maxPeriods=N]
                                        预览逐期表（不保存）
  add-version --plan=ID 同上参数        计算并保存为新版本
  list-versions --plan=ID               列出方案版本
  show --version=ID                     查看版本完整输入与逐期表
  add-extra --version=ID --period=N --amount=元
                                        在版本基础上加/改额外还款，另存新版本（amount=0 删除）
  compare --a=ID --b=ID                 比较两个版本的总利息与结清期数
  export-csv --version=ID [--out=文件]  导出 CSV
  demo                                  运行内置演示
`;

export async function runCli(argv: string[], dbPath: string = defaultDbPath()): Promise<void> {
  const { cmd, opts } = parseArgs(argv);
  if (cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "serve") {
    const port = opts.port !== undefined ? Number(opts.port) : Number(process.env.PORT ?? 0);
    const { port: p } = await startServer(port, dbPath);
    console.log(`还款试算服务已启动: http://127.0.0.1:${p}  (数据目录: ./data)`);
    return;
  }
  if (cmd === "preview") {
    printSchedule(computeSchedule(inputFromOpts(opts)));
    return;
  }
  if (cmd === "demo") {
    await demo(dbPath);
    return;
  }

  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case "create-plan":
        console.log(store.createPlan(required(opts, "name")));
        break;
      case "list-plans":
        console.log(store.listPlans());
        break;
      case "add-version":
        printVersion(store.saveVersion(Number(required(opts, "plan")), inputFromOpts(opts)));
        break;
      case "list-versions":
        console.log(store.listVersions(Number(required(opts, "plan"))));
        break;
      case "show":
        printVersion(store.getVersion(Number(required(opts, "version"))));
        break;
      case "add-extra":
        printVersion(
          store.upsertExtra(
            Number(required(opts, "version")),
            Number(required(opts, "period")),
            yuanToCents(required(opts, "amount"), "amount"),
          ),
        );
        break;
      case "compare": {
        const r = store.compare(Number(required(opts, "a")), Number(required(opts, "b"))) as {
          diff: { totalInterestCents: number; payoffPeriods: number | null; totalPaymentCents: number };
        };
        console.log(JSON.stringify(r, null, 2));
        console.log(
          `利息差(B-A): ${centsToYuan(r.diff.totalInterestCents)} 元, 结清期数差(B-A): ${
            r.diff.payoffPeriods ?? "N/A"
          }`,
        );
        break;
      }
      case "export-csv": {
        const id = Number(required(opts, "version"));
        const v = store.getVersion(id);
        const header =
          "period,interest_cents,ordinary_payment_cents,principal_paid_cents,extra_applied_cents,extra_unused_cents,balance_after_cents,cum_interest_cents,cum_principal_cents,cum_payment_cents";
        const lines = v.result.rows.map((r) =>
          [
            r.period, r.interestCents, r.ordinaryPaymentCents, r.principalPaidCents,
            r.extraAppliedCents, r.extraUnusedCents, r.balanceAfterCents,
            r.cumInterestCents, r.cumPrincipalCents, r.cumPaymentCents,
          ].join(","),
        );
        const csv = [header, ...lines, ""].join("\r\n");
        if (opts.out) {
          fs.writeFileSync(opts.out, csv);
          console.log(`已导出 ${opts.out}`);
        } else {
          process.stdout.write(csv);
        }
        break;
      }
      default:
        console.log(HELP);
    }
  } finally {
    store.close();
  }
}

async function demo(dbPath: string): Promise<void> {
  const store = new Store(dbPath);
  try {
    console.log("== 演示：本金 12000 元，月利率 0.5%，每期固定还款 500 元 ==");
    const plan = store.createPlan("演示方案");
    const v1 = store.saveVersion(plan.id, {
      principalCents: 1_200_000,
      monthlyRate: "0.005",
      monthlyPaymentCents: 50_000,
    });
    console.log(`-- 基准版本 ${v1.id} --`);
    printSchedule(v1.result);

    console.log("\n== 在第 6 期增加一次额外还款 2000 元，另存为新版本 ==");
    const v2 = store.upsertExtra(v1.id, 6, 200_000);
    console.log(`-- 提前还款版本 ${v2.id} --`);
    printSchedule(v2.result);

    console.log("\n== 对照 ==");
    const cmp = store.compare(v1.id, v2.id) as {
      diff: { totalInterestCents: number; payoffPeriods: number | null };
    };
    console.log(
      `结清期数: ${v1.result.payoffPeriods} -> ${v2.result.payoffPeriods}（差 ${
        (v2.result.payoffPeriods ?? 0) - (v1.result.payoffPeriods ?? 0)
      } 期）`,
    );
    console.log(
      `总利息: ${centsToYuan(v1.result.totalInterestCents)} -> ${centsToYuan(
        v2.result.totalInterestCents,
      )} 元（差 ${centsToYuan(cmp.diff.totalInterestCents)} 元）`,
    );
  } finally {
    store.close();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((err) => {
    if (err instanceof AppError) {
      console.error(`错误 [${err.code}] ${err.message}`);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  });
}
