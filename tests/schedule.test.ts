import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSchedule } from "../src/schedule";
import { interestOn, parseRate, AppError } from "../src/money";

test("手算核对：1000元、月息1%、每期300元，4期结清且末期缩小", () => {
  const r = computeSchedule({ principalCents: 100000, monthlyRate: "0.01", monthlyPaymentCents: 30000 });
  assert.equal(r.status, "ok");
  assert.equal(r.payoffPeriods, 4);
  const expect = [
    { interest: 1000, ordinary: 30000, principal: 29000, balance: 71000 },
    { interest: 710, ordinary: 30000, principal: 29290, balance: 41710 },
    { interest: 417, ordinary: 30000, principal: 29583, balance: 12127 },
    { interest: 121, ordinary: 12248, principal: 12127, balance: 0 },
  ];
  r.rows.forEach((row, i) => {
    assert.equal(row.interestCents, expect[i].interest, `第${i + 1}期利息`);
    assert.equal(row.ordinaryPaymentCents, expect[i].ordinary, `第${i + 1}期普通还款`);
    assert.equal(row.principalPaidCents, expect[i].principal, `第${i + 1}期还本`);
    assert.equal(row.balanceAfterCents, expect[i].balance, `第${i + 1}期余额`);
  });
  assert.equal(r.totalInterestCents, 2248);
  assert.equal(r.totalPaymentCents, 102248); // = 本金 100000 + 利息 2248
});

test("零利率正常工作", () => {
  const r = computeSchedule({ principalCents: 10000, monthlyRate: "0", monthlyPaymentCents: 3000 });
  assert.equal(r.payoffPeriods, 4);
  assert.equal(r.totalInterestCents, 0);
  assert.deepEqual(
    r.rows.map((x) => x.ordinaryPaymentCents),
    [3000, 3000, 3000, 1000],
  );
});

test("分的舍入边界（四舍五入 half-up）", () => {
  const rate = parseRate("0.005");
  assert.equal(interestOn(1050, rate), 5); // 5.25 -> 5
  assert.equal(interestOn(1150, rate), 6); // 5.75 -> 6
  assert.equal(interestOn(100, rate), 1); // 0.50 -> 1（半点进位）
  assert.equal(interestOn(90, rate), 0); // 0.45 -> 0
  assert.equal(interestOn(110, rate), 1); // 0.55 -> 1
});

test("额外还款提前全部结清，超出部分记为未使用", () => {
  const r = computeSchedule({
    principalCents: 10000,
    monthlyRate: "0",
    monthlyPaymentCents: 3000,
    extras: [{ period: 2, amountCents: 99999 }],
  });
  assert.equal(r.payoffPeriods, 2);
  const p2 = r.rows[1];
  assert.equal(p2.extraAppliedCents, 4000);
  assert.equal(p2.extraUnusedCents, 95999);
  assert.equal(p2.balanceAfterCents, 0);
  assert.equal(r.totalExtraUnusedCents, 95999);
});

test("还款不足以覆盖利息时拒绝计划", () => {
  assert.throws(
    () => computeSchedule({ principalCents: 100000, monthlyRate: "0.01", monthlyPaymentCents: 1000 }),
    (e: unknown) => e instanceof AppError && (e as AppError).code === "INSUFFICIENT_PAYMENT",
  );
});

test("无效期次被拒绝", () => {
  assert.throws(
    () =>
      computeSchedule({
        principalCents: 10000,
        monthlyRate: "0",
        monthlyPaymentCents: 3000,
        extras: [{ period: 0, amountCents: 100 }],
      }),
    (e: unknown) => (e as AppError).code === "VALIDATION_ERROR",
  );
  assert.throws(
    () =>
      computeSchedule({
        principalCents: 10000,
        monthlyRate: "0",
        monthlyPaymentCents: 3000,
        maxPeriods: 5,
        extras: [{ period: 6, amountCents: 100 }],
      }),
    (e: unknown) => (e as AppError).code === "INVALID_PERIOD",
  );
});

test("达到最大期数未结清时返回限制原因，不宣称完整计划", () => {
  const r = computeSchedule({
    principalCents: 100000,
    monthlyRate: "0.005",
    monthlyPaymentCents: 600,
    maxPeriods: 5,
  });
  assert.equal(r.status, "limit_exceeded");
  assert.equal(r.payoffPeriods, null);
  assert.equal(r.rows.length, 5);
  assert.match(r.limitReason ?? "", /最大期数 5/);
});

test("不变量：余额衔接、本金总偿还=初始本金、总还款=本金+利息", () => {
  const r = computeSchedule({
    principalCents: 1_234_567,
    monthlyRate: "0.0073",
    monthlyPaymentCents: 45_678,
    extras: [
      { period: 3, amountCents: 100_000 },
      { period: 10, amountCents: 50_000 },
    ],
  });
  assert.equal(r.status, "ok");
  let prev = 1_234_567;
  let sumPrincipal = 0;
  for (const row of r.rows) {
    assert.equal(row.balanceAfterCents, prev - row.principalPaidCents - row.extraAppliedCents);
    prev = row.balanceAfterCents;
    sumPrincipal += row.principalPaidCents + row.extraAppliedCents;
    assert.equal(row.ordinaryPaymentCents - row.interestCents, row.principalPaidCents);
  }
  assert.equal(prev, 0);
  assert.equal(sumPrincipal, 1_234_567);
  assert.equal(r.totalPaymentCents, 1_234_567 + r.totalInterestCents);
  assert.equal(r.totalPaymentCents, r.totalOrdinaryPaymentCents + r.totalExtraAppliedCents);
});
