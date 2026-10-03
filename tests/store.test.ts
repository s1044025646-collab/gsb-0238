import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/db";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "loan-")), "test.db");
}

const INPUT = { principalCents: 100000, monthlyRate: "0.01", monthlyPaymentCents: 30000 };

test("重启后版本可完整查询（输入与逐期明细一致）", () => {
  const db = tmpDb();
  let versionId = 0;
  {
    const store = new Store(db);
    const plan = store.createPlan("持久化测试");
    const v = store.saveVersion(plan.id, INPUT);
    versionId = v.id;
    store.close();
  }
  {
    const store = new Store(db);
    const v = store.getVersion(versionId);
    assert.deepEqual(v.input.extras, []);
    assert.equal(v.input.principalCents, 100000);
    assert.equal(v.input.monthlyRate, "0.01");
    assert.equal(v.result.rows.length, 4);
    assert.equal(v.result.rows[3].ordinaryPaymentCents, 12248);
    assert.equal(v.result.totalInterestCents, 2248);
    store.close();
  }
});

test("还款不足被拒绝时不留下任何版本记录", () => {
  const store = new Store(tmpDb());
  const plan = store.createPlan("p");
  assert.throws(() =>
    store.saveVersion(plan.id, { principalCents: 100000, monthlyRate: "0.01", monthlyPaymentCents: 1000 }),
  );
  assert.equal((store.listVersions(plan.id) as unknown[]).length, 0);
  store.close();
});

test("加入/修改额外还款生成新版本，可比较", () => {
  const store = new Store(tmpDb());
  const plan = store.createPlan("p");
  const v1 = store.saveVersion(plan.id, INPUT);
  const v2 = store.upsertExtra(v1.id, 1, 50000);
  assert.equal(v2.versionNo, 2);
  assert.deepEqual(v2.input.extras, [{ period: 1, amountCents: 50000 }]);
  const cmp = store.compare(v1.id, v2.id) as {
    diff: { totalInterestCents: number; payoffPeriods: number };
  };
  assert.ok(cmp.diff.totalInterestCents < 0, "提前还款应减少总利息");
  assert.ok(cmp.diff.payoffPeriods < 0, "提前还款应减少结清期数");
  const v3 = store.upsertExtra(v2.id, 1, 0); // amount=0 删除该期额外还款
  assert.deepEqual(v3.input.extras, []);
  store.close();
});
