import { AppError, interestOn, parseRate, requireIntCents } from "./money";

export const DEFAULT_MAX_PERIODS = 1200; // 公开的最大期数上限（100 年）

export interface ExtraPayment {
  period: number; // 从 1 开始
  amountCents: number;
}

export interface ScheduleInput {
  principalCents: number;
  monthlyRate: string; // 十进制字符串，如 "0.005"
  monthlyPaymentCents: number;
  extras?: ExtraPayment[];
  maxPeriods?: number;
}

export interface ScheduleRow {
  period: number;
  interestCents: number; // 当期利息
  ordinaryPaymentCents: number; // 普通还款（最后一期自动缩小）
  principalPaidCents: number; // 普通还款中冲减本金部分
  extraAppliedCents: number; // 额外还款实际冲减本金
  extraUnusedCents: number; // 额外还款超出剩余本金、未使用部分
  balanceAfterCents: number; // 期末余额
  cumInterestCents: number;
  cumPrincipalCents: number;
  cumPaymentCents: number; // 普通还款 + 已使用额外还款 累计
}

export interface ScheduleResult {
  status: "ok" | "limit_exceeded";
  limitReason: string | null;
  rows: ScheduleRow[];
  totalInterestCents: number;
  totalOrdinaryPaymentCents: number;
  totalExtraAppliedCents: number;
  totalExtraUnusedCents: number;
  totalPaymentCents: number; // 普通还款 + 已使用额外还款
  periods: number; // 已计算的期数
  payoffPeriods: number | null; // 结清期数（未结清为 null）
}

export function validateAndNormalize(input: ScheduleInput): Required<ScheduleInput> {
  const principalCents = requireIntCents(input.principalCents, "principalCents", { min: 1 });
  const monthlyPaymentCents = requireIntCents(input.monthlyPaymentCents, "monthlyPaymentCents", { min: 1 });
  const rate = parseRate(input.monthlyRate); // 校验
  void rate;
  const maxPeriods =
    input.maxPeriods === undefined
      ? DEFAULT_MAX_PERIODS
      : requireIntCents(input.maxPeriods, "maxPeriods", { min: 1 });
  if (maxPeriods > DEFAULT_MAX_PERIODS) {
    throw new AppError("VALIDATION_ERROR", `maxPeriods 不能超过公开上限 ${DEFAULT_MAX_PERIODS}`);
  }
  const extras: ExtraPayment[] = [];
  const seen = new Map<number, number>();
  for (const e of input.extras ?? []) {
    const period = requireIntCents(e.period, "extras[].period", { min: 1 });
    const amountCents = requireIntCents(e.amountCents, "extras[].amountCents", { min: 1 });
    if (period > maxPeriods) {
      throw new AppError("INVALID_PERIOD", `额外还款期次 ${period} 超出最大期数 ${maxPeriods}`);
    }
    seen.set(period, (seen.get(period) ?? 0) + amountCents);
  }
  for (const [period, amountCents] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    extras.push({ period, amountCents });
  }
  return { principalCents, monthlyRate: input.monthlyRate, monthlyPaymentCents, extras, maxPeriods };
}

// 统一摊还模型：
// 1) 利息 = round(期初余额 * 月利率)，四舍五入到分；
// 2) 普通还款先付利息、剩余冲本金，且不超过当期本金+利息（末期自动缩小）；
// 3) 额外还款在普通还款之后冲减本金，超出剩余本金的部分记为未使用。
export function computeSchedule(raw: ScheduleInput): ScheduleResult {
  const input = validateAndNormalize(raw);
  const rate = parseRate(input.monthlyRate);
  const extraByPeriod = new Map(input.extras.map((e) => [e.period, e.amountCents]));

  const rows: ScheduleRow[] = [];
  let balance = input.principalCents;
  let cumInterest = 0;
  let cumPrincipal = 0;
  let cumPayment = 0;
  let totalOrdinary = 0;
  let totalExtraApplied = 0;
  let totalExtraUnused = 0;
  let period = 0;

  while (balance > 0 && period < input.maxPeriods) {
    period += 1;
    const interest = interestOn(balance, rate);
    if (input.monthlyPaymentCents <= interest) {
      throw new AppError(
        "INSUFFICIENT_PAYMENT",
        `第 ${period} 期：固定还款额 ${input.monthlyPaymentCents} 分不足以覆盖当期利息 ${interest} 分并减少本金，计划被拒绝`,
        422,
      );
    }
    const ordinary = Math.min(input.monthlyPaymentCents, balance + interest);
    const principalPaid = ordinary - interest;
    balance -= principalPaid;

    const extra = extraByPeriod.get(period) ?? 0;
    const extraApplied = Math.min(extra, balance);
    const extraUnused = extra - extraApplied;
    balance -= extraApplied;

    cumInterest += interest;
    cumPrincipal += principalPaid + extraApplied;
    cumPayment += ordinary + extraApplied;
    totalOrdinary += ordinary;
    totalExtraApplied += extraApplied;
    totalExtraUnused += extraUnused;

    rows.push({
      period,
      interestCents: interest,
      ordinaryPaymentCents: ordinary,
      principalPaidCents: principalPaid,
      extraAppliedCents: extraApplied,
      extraUnusedCents: extraUnused,
      balanceAfterCents: balance,
      cumInterestCents: cumInterest,
      cumPrincipalCents: cumPrincipal,
      cumPaymentCents: cumPayment,
    });
  }

  const paidOff = balance === 0;
  return {
    status: paidOff ? "ok" : "limit_exceeded",
    limitReason: paidOff ? null : `达到最大期数 ${input.maxPeriods} 期仍未结清（剩余本金 ${balance} 分），未生成完整计划`,
    rows,
    totalInterestCents: cumInterest,
    totalOrdinaryPaymentCents: totalOrdinary,
    totalExtraAppliedCents: totalExtraApplied,
    totalExtraUnusedCents: totalExtraUnused,
    totalPaymentCents: cumPayment,
    periods: rows.length,
    payoffPeriods: paidOff ? rows.length : null,
  };
}
