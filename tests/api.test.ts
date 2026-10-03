import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../src/server";

let base = "";
let close: () => void = () => {};

before(async () => {
  const s = await startServer(0, ":memory:");
  base = `http://127.0.0.1:${s.port}`;
  close = s.close;
});

after(() => close());

async function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("API 全流程：建方案、存版本、加额外还款、比较、CSV", async () => {
  const plan = await post("/plans", { name: "api测试" });
  assert.equal(plan.status, 201);
  const planId = plan.json.id;

  const v1 = await post(`/plans/${planId}/versions`, {
    principalCents: 100000,
    monthlyRate: "0.01",
    monthlyPaymentCents: 30000,
  });
  assert.equal(v1.status, 201);
  assert.equal(v1.json.result.payoffPeriods, 4);

  const v2 = await post(`/versions/${v1.json.id}/extras`, { period: 1, amountCents: 50000 });
  assert.equal(v2.status, 201);
  assert.equal(v2.json.versionNo, 2);

  const cmpRes = await fetch(`${base}/compare?a=${v1.json.id}&b=${v2.json.id}`);
  const cmp = (await cmpRes.json()) as any;
  assert.ok(cmp.diff.totalInterestCents < 0);

  const csvRes = await fetch(`${base}/versions/${v1.json.id}/csv`);
  assert.equal(csvRes.headers.get("content-type"), "text/csv; charset=utf-8");
  const csv = await csvRes.text();
  assert.match(csv, /^period,interest_cents/);
  assert.equal(csv.trim().split("\r\n").length, 1 + 4);

  const getRes = await fetch(`${base}/versions/${v1.json.id}`);
  assert.equal(getRes.status, 200);
});

test("API 错误码：还款不足 422、校验失败 400、不存在 404", async () => {
  const plan = await post("/plans", { name: "err" });
  const bad = await post(`/plans/${plan.json.id}/versions`, {
    principalCents: 100000,
    monthlyRate: "0.01",
    monthlyPaymentCents: 500,
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "INSUFFICIENT_PAYMENT");

  const invalid = await post(`/plans/${plan.json.id}/versions`, {
    principalCents: -1,
    monthlyRate: "0.01",
    monthlyPaymentCents: 500,
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "VALIDATION_ERROR");

  const nf = await fetch(`${base}/versions/9999`);
  assert.equal(nf.status, 404);
  assert.equal(((await nf.json()) as any).error.code, "NOT_FOUND");
});
