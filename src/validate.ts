import { ValidationError, parseRate, requireCents } from "./money";
import { ExtraPayment, ScheduleInput, ScheduleResult, buildSchedule } from "./schedule";

/** 校验并规范化输入；额外还款期次必须落在实际还款期数内。 */
export function validateAndBuild(raw: unknown): { input: Required<ScheduleInput> & { extras: ExtraPayment[] }; result: ScheduleResult } {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("请求体必须是对象");
  }
  const o = raw as Record<string, unknown>;
  const principal = requireCents(o.principal, "principal");
  const monthlyPayment = requireCents(o.monthlyPayment, "monthlyPayment");
  if (o.monthlyRate === undefined) throw new ValidationError("缺少 monthlyRate");
  const rate = parseRate(o.monthlyRate as number | string);

  const extras: ExtraPayment[] = [];
  if (o.extras !== undefined) {
    if (!Array.isArray(o.extras)) throw new ValidationError("extras 必须是数组");
    for (const item of o.extras) {
      if (typeof item !== "object" || item === null) throw new ValidationError("extras 元素必须是对象");
      const e = item as Record<string, unknown>;
      if (typeof e.period !== "number" || !Number.isInteger(e.period) || e.period < 1) {
        throw new ValidationError("额外还款期次必须是从 1 开始的整数");
      }
      extras.push({ period: e.period, amount: requireCents(e.amount, "extras.amount") });
    }
  }

  let maxPeriods: number | undefined;
  if (o.maxPeriods !== undefined) {
    if (typeof o.maxPeriods !== "number" || !Number.isInteger(o.maxPeriods) || o.maxPeriods < 1) {
      throw new ValidationError("maxPeriods 必须是正整数");
    }
    maxPeriods = o.maxPeriods;
  }

  const input: ScheduleInput & { extras: ExtraPayment[] } = { principal, monthlyRate: o.monthlyRate as number | string, monthlyPayment, extras };
  if (maxPeriods !== undefined) input.maxPeriods = maxPeriods;
  const result = buildSchedule(input, rate);
  if (result.ok) {
    for (const e of extras) {
      if (e.period > result.summary.periods) {
        throw new ValidationError(`额外还款期次 ${e.period} 超出实际还款期数 ${result.summary.periods}`);
      }
    }
  }
  return { input: input as Required<ScheduleInput> & { extras: ExtraPayment[] }, result };
}
