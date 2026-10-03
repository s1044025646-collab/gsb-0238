import { RateRatio, interestOn } from "./money";

export interface ExtraPayment {
  period: number; // 期次，从 1 开始
  amount: number; // 分
}

export interface ScheduleInput {
  principal: number; // 初始本金，分
  monthlyRate: number | string; // 月利率，十进制小数
  monthlyPayment: number; // 每期固定还款额，分
  extras?: ExtraPayment[]; // 指定期次的额外还款
  maxPeriods?: number; // 最大期数上限，默认 1200
}

export interface PeriodRow {
  period: number;
  openingBalance: number; // 期初余额
  interest: number; // 当期利息
  normalPayment: number; // 普通还款（最后一期自动缩小）
  principalPaid: number; // 普通还款中冲减的本金
  extraPayment: number; // 额外还款计划金额
  extraApplied: number; // 额外还款实际冲减本金
  extraUnused: number; // 额外还款未使用金额
  totalPaid: number; // normalPayment + extraApplied
  closingBalance: number; // 期末余额
}

export interface ScheduleSummary {
  periods: number;
  totalInterest: number;
  totalNormalPaid: number;
  totalPrincipalPaid: number; // 普通还款冲减本金合计
  totalExtraPlanned: number;
  totalExtraApplied: number;
  totalExtraUnused: number;
  totalPaid: number; // 实际支付总额 = 本金 + 利息
}

export type ScheduleResult =
  | { ok: true; rows: PeriodRow[]; summary: ScheduleSummary }
  | { ok: false; code: "INSUFFICIENT_PAYMENT" | "LIMIT_EXCEEDED"; message: string };

export const DEFAULT_MAX_PERIODS = 1200;

/**
 * 逐期摊还：
 * 1. 利息 = round(期初余额 * 月利率)，四舍五入到分；
 * 2. 普通还款 = min(固定还款额, 期初余额 + 利息)，先付息后冲本；
 * 3. 额外还款在普通还款之后冲减本金，超出部分记为未使用；
 * 4. 固定还款额不足以覆盖利息并减少本金时拒绝整个计划。
 */
export function buildSchedule(
  input: ScheduleInput,
  rate: RateRatio
): ScheduleResult {
  const maxPeriods = input.maxPeriods ?? DEFAULT_MAX_PERIODS;
  const extras = new Map<number, number>();
  for (const e of input.extras ?? []) {
    extras.set(e.period, (extras.get(e.period) ?? 0) + e.amount);
  }

  const rows: PeriodRow[] = [];
  let balance = input.principal;
  let period = 0;

  while (balance > 0) {
    period += 1;
    if (period > maxPeriods) {
      return {
        ok: false,
        code: "LIMIT_EXCEEDED",
        message: `达到最大期数 ${maxPeriods} 仍未结清（剩余本金 ${balance} 分），未生成完整计划`,
      };
    }
    const interest = interestOn(balance, rate);
    const due = balance + interest;
    if (input.monthlyPayment <= interest && due > input.monthlyPayment) {
      return {
        ok: false,
        code: "INSUFFICIENT_PAYMENT",
        message: `第 ${period} 期固定还款额 ${input.monthlyPayment} 分不足以覆盖当期利息 ${interest} 分并减少本金`,
      };
    }
    const normalPayment = Math.min(input.monthlyPayment, due);
    const principalPaid = normalPayment - interest;
    balance -= principalPaid;

    const planned = extras.get(period) ?? 0;
    const extraApplied = Math.min(planned, balance);
    const extraUnused = planned - extraApplied;
    balance -= extraApplied;

    rows.push({
      period,
      openingBalance: balance + principalPaid + extraApplied,
      interest,
      normalPayment,
      principalPaid,
      extraPayment: planned,
      extraApplied,
      extraUnused,
      totalPaid: normalPayment + extraApplied,
      closingBalance: balance,
    });
  }

  const summary: ScheduleSummary = {
    periods: rows.length,
    totalInterest: rows.reduce((a, r) => a + r.interest, 0),
    totalNormalPaid: rows.reduce((a, r) => a + r.normalPayment, 0),
    totalPrincipalPaid: rows.reduce((a, r) => a + r.principalPaid, 0),
    totalExtraPlanned: rows.reduce((a, r) => a + r.extraPayment, 0),
    totalExtraApplied: rows.reduce((a, r) => a + r.extraApplied, 0),
    totalExtraUnused: rows.reduce((a, r) => a + r.extraUnused, 0),
    totalPaid: rows.reduce((a, r) => a + r.totalPaid, 0),
  };
  return { ok: true, rows, summary };
}
