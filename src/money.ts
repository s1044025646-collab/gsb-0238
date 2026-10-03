// 金额一律以“分”为单位的整数保存与计算。
// 月利率以十进制小数输入（如 0.005 表示每期 0.5%），
// 内部转换为整数比例 num/den，利息用 BigInt 精确计算后四舍五入到分。

export interface RateRatio {
  num: bigint;
  den: bigint;
}

export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** 将十进制（含科学计数法）字符串展开为普通小数字符串。 */
function expandScientific(s: string): string {
  if (!/[eE]/.test(s)) return s;
  const n = Number(s);
  if (!Number.isFinite(n)) throw new ValidationError(`月利率格式非法: ${s}`);
  // toFixed 最多保留 20 位小数，足够覆盖常见利率精度
  const fixed = n.toFixed(20);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/** 解析月利率为整数比例。拒绝负数与非有限值；允许 0。 */
export function parseRate(input: number | string): RateRatio {
  const raw = typeof input === "number" ? String(input) : String(input).trim();
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) {
    throw new ValidationError(`月利率格式非法: ${raw}`);
  }
  const s = expandScientific(raw);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [intPart, fracPart = ""] = body.split(".");
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart + fracPart) * (neg ? -1n : 1n);
  if (num < 0n) throw new ValidationError("月利率不能为负数");
  return { num, den };
}

/** 利息 = round-half-up(balance * num / den)，全部使用 BigInt 避免浮点误差。 */
export function interestOn(balanceCents: number, rate: RateRatio): number {
  if (rate.num === 0n || balanceCents === 0) return 0;
  const numerator = BigInt(balanceCents) * rate.num;
  const den = rate.den;
  // 四舍五入（half-up）：floor((2*n + d) / (2*d))
  const rounded = (2n * numerator + den) / (2n * den);
  return Number(rounded);
}

/** 校验“分”为单位的金额：非负整数。 */
export function requireCents(value: unknown, field: string, opts: { allowZero?: boolean } = {}): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ValidationError(`${field} 必须是整数（单位：分）`);
  }
  if (value < 0 || (!opts.allowZero && value === 0)) {
    throw new ValidationError(`${field} 必须${opts.allowZero ? "不小于 0" : "大于 0"}`);
  }
  return value;
}
