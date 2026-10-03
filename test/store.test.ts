import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store";
import { validateAndBuild } from "../src/validate";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "loanlab-")), "test.db");
}

const INPUT = { principal: 100000, monthlyRate: "0.01", monthlyPayment: 51000 };

test("保存后可在新连接（模拟重启）中查询版本", () => {
  const db = tmpDb();
  const s1 = new Store(db);
  const { input, result } = validateAndBuild(INPUT);
  assert.ok(result.ok);
  const saved = s1.saveVersion(null, "测试方案", input, result.summary, result.rows);
  s1.close();

  const s2 = new Store(db);
  const loaded = s2.getVersion(saved.planId, 1);
  assert.ok(loaded);
  assert.equal(loaded.summary.totalInterest, result.summary.totalInterest);
  assert.deepEqual(loaded.rows, result.rows);
  assert.deepEqual(loaded.input, input);
  s2.close();
});

test("多版本保存与比较", () => {
  const db = tmpDb();
  const s = new Store(db);
  const v1in = validateAndBuild(INPUT);
  const v2in = validateAndBuild({ ...INPUT, extras: [{ period: 1, amount: 20000 }] });
  assert.ok(v1in.result.ok && v2in.result.ok);
  s.saveVersion(null, "方案", v1in.input, v1in.result.summary, v1in.result.rows);
  const v2 = s.saveVersion(1, "", v2in.input, v2in.result.summary, v2in.result.rows);
  assert.equal(v2.version, 2);
  const latest = s.getVersion(1);
  assert.equal(latest?.version, 2);
  assert.equal(s.getVersion(1, 1)?.summary.totalInterest, v1in.result.summary.totalInterest);
  s.close();
});

test("保存失败不留下只有头部没有明细的记录", () => {
  const db = tmpDb();
  const s = new Store(db);
  const { input, result } = validateAndBuild(INPUT);
  assert.ok(result.ok);
  // 构造一行缺字段的明细，强制 INSERT 失败
  const badRows = result.rows.map((r) => ({ ...r }));
  (badRows[0] as { interest: unknown }).interest = null;
  assert.throws(() => s.saveVersion(null, "坏方案", input, result.summary, badRows));
  assert.equal(s.listPlans().length, 0, "失败后不应残留方案记录");
  s.close();
});
