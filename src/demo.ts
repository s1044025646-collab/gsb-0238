// 演示：固定金额逐期归还，再于第 6 期增加一次额外还款，比较剩余期数与总利息。
import { validateAndBuild } from "./validate";

const base = { principal: 1_200_000, monthlyRate: "0.005", monthlyPayment: 23_000 };

const a = validateAndBuild(base);
const b = validateAndBuild({ ...base, extras: [{ period: 6, amount: 200_000 }] });

if (!a.result.ok || !b.result.ok) {
  console.error("演示输入被拒绝", a.result, b.result);
  process.exit(1);
}

console.log("方案 A（无额外还款）:");
console.log(`  期数 ${a.result.summary.periods}，总利息 ${a.result.summary.totalInterest} 分，总还款 ${a.result.summary.totalPaid} 分`);
console.log("  前 3 期:");
for (const r of a.result.rows.slice(0, 3)) {
  console.log(`    第 ${r.period} 期: 利息 ${r.interest}，冲本 ${r.principalPaid}，期末余额 ${r.closingBalance}`);
}
console.log(`  末期: 普通还款 ${a.result.rows[a.result.rows.length - 1].normalPayment} 分（自动缩小结清）`);

console.log("方案 B（第 6 期额外还款 200000 分）:");
console.log(`  期数 ${b.result.summary.periods}，总利息 ${b.result.summary.totalInterest} 分，总还款 ${b.result.summary.totalPaid} 分`);
const r6 = b.result.rows[5];
console.log(`  第 6 期: 普通还款 ${r6.normalPayment}，额外冲本 ${r6.extraApplied}，未使用 ${r6.extraUnused}，期末余额 ${r6.closingBalance}`);

console.log("对照 (A - B):");
console.log(`  期数减少 ${a.result.summary.periods - b.result.summary.periods} 期`);
console.log(`  利息节省 ${a.result.summary.totalInterest - b.result.summary.totalInterest} 分`);
