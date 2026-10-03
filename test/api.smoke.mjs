// API 冒烟测试：起服务 -> preview/create/compare/csv -> 关服务
import { spawn } from "node:child_process";

const server = spawn(process.execPath, ["dist/src/server.js", "--port=18099"], { stdio: "pipe" });
await new Promise((r) => setTimeout(r, 1500));
const base = "http://127.0.0.1:18099";

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

try {
  const preview = await post("/api/preview", { principal: 100000, monthlyRate: "0.01", monthlyPayment: 51000 });
  console.log("preview:", preview.status, "periods=", preview.body.summary.periods, "interest=", preview.body.summary.totalInterest);

  const created = await post("/api/plans", { name: "smoke", principal: 100000, monthlyRate: "0.01", monthlyPayment: 51000 });
  console.log("create:", created.status, "planId=", created.body.planId);

  const v2 = await post(`/api/plans/${created.body.planId}/versions`, { principal: 100000, monthlyRate: "0.01", monthlyPayment: 51000, extras: [{ period: 1, amount: 30000 }] });
  console.log("add-version:", v2.status, "version=", v2.body.version, "interest=", v2.body.summary.totalInterest);

  const cmp = await post("/api/compare", { a: { planId: created.body.planId, version: 1 }, b: { planId: created.body.planId, version: 2 } });
  console.log("compare:", cmp.status, JSON.stringify(cmp.body.diff));

  const csv = await fetch(`${base}/api/plans/${created.body.planId}/versions/1/csv`);
  console.log("csv:", csv.status, (await csv.text()).split("\r\n")[0]);

  const bad = await post("/api/preview", { principal: 100000, monthlyRate: "0.01", monthlyPayment: 500 });
  console.log("insufficient:", bad.status, JSON.stringify(bad.body.error));

  const badExtra = await post("/api/preview", { principal: 100000, monthlyRate: "0.01", monthlyPayment: 51000, extras: [{ period: 0, amount: 100 }] });
  console.log("invalid-extra:", badExtra.status, JSON.stringify(badExtra.body.error));
} finally {
  server.kill();
}
