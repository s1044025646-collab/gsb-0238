import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAndBuild } from "../src/validate";
import { ValidationError } from "../src/money";
import { PeriodRow, ScheduleSummary } from "../src/schedule";

function okRows(input: unknown): { rows: PeriodRow[]; summary: ScheduleSummary } {
  const { result } = validateAndBuild(input);
  assert.ok(result.ok, result.ok ? "" : result.message);
  return { rows: result.rows, summary: result.summary };
}

function assertConsistent(rows: PeriodRow[], summary: ScheduleSummary, principal: number): void {
  // 余额衔接
  let prev = principal;
  for (const r of rows) {
    assert.equal(r.openingBalance, prev, `第 ${r.period} 期期初余额应等于上一期期末余额`);
    assert.equal(r.closingBalance, r.openingBalance - r.principalPaid - r.extraApplied);
    assert.equal(r.normalPayment, r.interest + r.principalPaid);
    assert.equal(r.totalPaid, r.normalPayment + r.extraApplied);
    prev = r.closingBalance;
  }
  assert.equal(prev, 0, "最终必须结清");
  // 合计复核
  assert.equal(summary.totalInterest, rows.reduce((a, r) => a + r.interest, 0));
  assert.equal(summary.totalPrincipalPaid + summary.totalExtraApplied, principal, "本金总偿还等于初始本金");
  assert.equal(summary.totalPaid, principal + summary.totalInterest, "总还款 = 本金 + 利息");
  assert.equal(summary.totalExtraPlanned, summary.totalExtraApplied + summary.totalExtraUnused);
}

test("手算小本金：本金 100000 分，月息 1%，每期还 51000 分", () => {
  const { rows, summary } = okRows({ principal: 100000, monthlyRate: "0.01", monthlyPayment: 51000 });
  // 第1期: 利息1000, 还51000, 冲本50000, 余50000
  // 第2期: 利息500, 应还50500（缩小）, 冲本50000, 余0
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.interest, r.normalPayment, r.principalPaid, r.closingBalance]),
    [[1000, 51000, 50000, 50000], [500, 50500, 50000, 0]]
  );
  assert.equal(summary.totalInterest, 1500);
  assert.equal(summary.totalPaid, 101500);
  assertConsistent(rows, summary, 100000);
});

test("末期自动缩小到恰好结清", () => {
  const { rows } = okRows({ principal: 10000, monthlyRate: "0", monthlyPayment: 4000 });
  assert.deepEqual(rows.map((r) => r.normalPayment), [4000, 4000, 2000]);
});

test("零利率正常工作且无利息", () => {
  const { rows, summary } = okRows({ principal: 9999, monthlyRate: 0, monthlyPayment: 3333 });
  assert.equal(summary.totalInterest, 0);
  assert.equal(rows.length, 3);
  assert.equal(summary.totalPaid, 9999);
  assertConsistent(rows, summary, 9999);
});

test("分的舍入边界：0.5 分向上进位", () => {
  // 本金 1 分，月息 50%：利息 = 0.5 分 -> 四舍五入为 1 分
  const { rows } = okRows({ principal: 1, monthlyRate: "0.5", monthlyPayment: 100 });
  assert.equal(rows[0].interest, 1);
  assert.equal(rows[0].normalPayment, 2);
  // 本金 3 分，月息 50%：利息 = 1.5 分 -> 2 分
  const r2 = okRows({ principal: 3, monthlyRate: "0.5", monthlyPayment: 100 });
  assert.equal(r2.rows[0].interest, 2);
  // 本金 5 分，月息 10%：利息 = 0.5 分 -> 1 分
  const r3 = okRows({ principal: 5, monthlyRate: "0.1", monthlyPayment: 100 });
  assert.equal(r3.rows[0].interest, 1);
});

test("提前全部结清：额外还款超出部分列为未使用", () => {
  const { rows, summary } = okRows({
    principal: 100000,
    monthlyRate: "0.01",
    monthlyPayment: 51000,
    extras: [{ period: 1, amount: 60000 }],
  });
  // 第1期: 利息1000, 普通还款51000冲本50000, 余50000; 额外60000中50000冲本, 10000未使用
  assert.equal(rows.length, 1);
  assert.equal(rows[0].extraApplied, 50000);
  assert.equal(rows[0].extraUnused, 10000);
  assert.equal(summary.totalExtraPlanned, 60000);
  assertConsistent(rows, summary, 100000);
});

test("额外还款指定期次生效并缩短期数", () => {
  const base = { principal: 100000, monthlyRate: "0.01", monthlyPayment: 11000 };
  const a = okRows(base);
  const b = okRows({ ...base, extras: [{ period: 3, amount: 50000 }] });
  assert.ok(b.summary.periods < a.summary.periods);
  assert.ok(b.summary.totalInterest < a.summary.totalInterest);
  assert.equal(b.rows[2].extraApplied, 50000);
  assertConsistent(b.rows, b.summary, 100000);
});

test("无效期次被拒绝", () => {
  assert.throws(() => validateAndBuild({ principal: 1000, monthlyRate: "0.01", monthlyPayment: 100, extras: [{ period: 0, amount: 100 }] }), ValidationError);
  assert.throws(() => validateAndBuild({ principal: 1000, monthlyRate: "0.01", monthlyPayment: 100, extras: [{ period: -2, amount: 100 }] }), ValidationError);
  assert.throws(() => validateAndBuild({ principal: 1000, monthlyRate: "0.01", monthlyPayment: 100, extras: [{ period: 1.5, amount: 100 }] }), ValidationError);
  // 超出实际还款期数
  assert.throws(() => validateAndBuild({ principal: 1000, monthlyRate: "0.01", monthlyPayment: 100, extras: [{ period: 99, amount: 100 }] }), ValidationError);
});

test("还款不足以覆盖利息时拒绝计划", () => {
  const { result } = validateAndBuild({ principal: 100000, monthlyRate: "0.01", monthlyPayment: 1000 });
  assert.ok(!result.ok);
  assert.equal(result.ok ? "" : result.code, "INSUFFICIENT_PAYMENT");
});

test("达到最大期数仍未结清时返回限制原因", () => {
  const { result } = validateAndBuild({ principal: 100000, monthlyRate: "0.01", monthlyPayment: 1100, maxPeriods: 5 });
  assert.ok(!result.ok);
  assert.equal(result.ok ? "" : result.code, "LIMIT_EXCEEDED");
  assert.match(result.ok ? "" : result.message, /未生成完整计划/);
});

test("参数校验：负本金、负利率、非整数金额", () => {
  assert.throws(() => validateAndBuild({ principal: -1, monthlyRate: "0.01", monthlyPayment: 100 }), ValidationError);
  assert.throws(() => validateAndBuild({ principal: 1000, monthlyRate: "-0.01", monthlyPayment: 100 }), ValidationError);
  assert.throws(() => validateAndBuild({ principal: 1000.5, monthlyRate: "0.01", monthlyPayment: 100 }), ValidationError);
  assert.throws(() => validateAndBuild({ principal: 1000, monthlyRate: "abc", monthlyPayment: 100 }), ValidationError);
});

test("长期方案合计一致性（360 期房贷式场景）", () => {
  const { rows, summary } = okRows({ principal: 100_000_000, monthlyRate: "0.004", monthlyPayment: 600_000 });
  assertConsistent(rows, summary, 100_000_000);
});
