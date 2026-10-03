// 金额一律以“分”为单位的整数保存与计算；月利率以十进制字符串输入，
// 解析为有理数 num/den，利息用 BigInt 精确计算后四舍五入到分（half-up）。

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface Rate {
  num: bigint;
  den: bigint;
  text: string;
}

export function parseRate(text: unknown): Rate {
  if (typeof text !== "string" || !/^\d+(\.\d+)?$/.test(text)) {
    throw new AppError("VALIDATION_ERROR", `月利率必须是非负十进制字符串，收到: ${String(text)}`);
  }
  const [intPart, fracPart = ""] = text.split(".");
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(intPart) * den + BigInt(fracPart === "" ? "0" : fracPart);
  if (num >= den) {
    throw new AppError("VALIDATION_ERROR", "月利率必须小于 1（即小于 100%）");
  }
  return { num, den, text };
}

// round(balance * num / den)，非负金额四舍五入到分
export function interestOn(balanceCents: number, rate: Rate): number {
  const b = BigInt(balanceCents);
  const rounded = (2n * b * rate.num + rate.den) / (2n * rate.den);
  return Number(rounded);
}

export function requireIntCents(value: unknown, field: string, { min = 0 }: { min?: number } = {}): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new AppError("VALIDATION_ERROR", `${field} 必须是整数（单位：分）`);
  }
  if (value < min) {
    throw new AppError("VALIDATION_ERROR", `${field} 不能小于 ${min} 分`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new AppError("VALIDATION_ERROR", `${field} 超出安全整数范围`);
  }
  return value;
}

// CLI 用：把“元”字符串（最多两位小数）转为分
export function yuanToCents(text: string, field: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new AppError("VALIDATION_ERROR", `${field} 必须是最多两位小数的非负金额（元），收到: ${text}`);
  }
  const [i, f = ""] = text.split(".");
  return Number(i) * 100 + Number((f + "00").slice(0, 2));
}

export function centsToYuan(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
