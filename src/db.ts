import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { AppError } from "./money";
import { computeSchedule, ExtraPayment, ScheduleInput, ScheduleResult, validateAndNormalize } from "./schedule";

export interface VersionRecord {
  id: number;
  planId: number;
  versionNo: number;
  input: Required<ScheduleInput>;
  result: ScheduleResult;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        version_no INTEGER NOT NULL,
        principal_cents INTEGER NOT NULL,
        monthly_rate TEXT NOT NULL,
        monthly_payment_cents INTEGER NOT NULL,
        max_periods INTEGER NOT NULL,
        status TEXT NOT NULL,
        limit_reason TEXT,
        total_interest_cents INTEGER NOT NULL,
        total_ordinary_payment_cents INTEGER NOT NULL,
        total_extra_applied_cents INTEGER NOT NULL,
        total_extra_unused_cents INTEGER NOT NULL,
        total_payment_cents INTEGER NOT NULL,
        periods INTEGER NOT NULL,
        payoff_periods INTEGER,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE (plan_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS version_extras (
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        period INTEGER NOT NULL,
        amount_cents INTEGER NOT NULL,
        PRIMARY KEY (version_id, period)
      );
      CREATE TABLE IF NOT EXISTS schedule_rows (
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        period INTEGER NOT NULL,
        interest_cents INTEGER NOT NULL,
        ordinary_payment_cents INTEGER NOT NULL,
        principal_paid_cents INTEGER NOT NULL,
        extra_applied_cents INTEGER NOT NULL,
        extra_unused_cents INTEGER NOT NULL,
        balance_after_cents INTEGER NOT NULL,
        cum_interest_cents INTEGER NOT NULL,
        cum_principal_cents INTEGER NOT NULL,
        cum_payment_cents INTEGER NOT NULL,
        PRIMARY KEY (version_id, period)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  createPlan(name: string): { id: number; name: string } {
    if (typeof name !== "string" || name.trim() === "") {
      throw new AppError("VALIDATION_ERROR", "方案名称 name 不能为空");
    }
    const stmt = this.db.prepare("INSERT INTO plans (name) VALUES (?)");
    const r = stmt.run(name.trim());
    return { id: Number(r.lastInsertRowid), name: name.trim() };
  }

  listPlans(): unknown[] {
    return this.db
      .prepare(
        `SELECT p.id, p.name, p.created_at AS createdAt, COUNT(v.id) AS versionCount
         FROM plans p LEFT JOIN versions v ON v.plan_id = p.id
         GROUP BY p.id ORDER BY p.id`,
      )
      .all();
  }

  private planExists(planId: number): void {
    const row = this.db.prepare("SELECT id FROM plans WHERE id = ?").get(planId);
    if (!row) throw new AppError("NOT_FOUND", `方案 ${planId} 不存在`, 404);
  }

  // 一次事务保存版本头部、额外还款与全部期次明细；任何一步失败整体回滚。
  saveVersion(planId: number, input: ScheduleInput): VersionRecord {
    this.planExists(planId);
    const result = computeSchedule(input); // 计算失败（如还款不足）时不落库
    const normalized = inputNormalized(input);

    this.db.exec("BEGIN");
    try {
      const noRow = this.db
        .prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS no FROM versions WHERE plan_id = ?")
        .get(planId) as { no: number };
      const r = this.db
        .prepare(
          `INSERT INTO versions (plan_id, version_no, principal_cents, monthly_rate, monthly_payment_cents,
             max_periods, status, limit_reason, total_interest_cents, total_ordinary_payment_cents,
             total_extra_applied_cents, total_extra_unused_cents, total_payment_cents, periods, payoff_periods)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          planId,
          noRow.no,
          normalized.principalCents,
          normalized.monthlyRate,
          normalized.monthlyPaymentCents,
          normalized.maxPeriods,
          result.status,
          result.limitReason,
          result.totalInterestCents,
          result.totalOrdinaryPaymentCents,
          result.totalExtraAppliedCents,
          result.totalExtraUnusedCents,
          result.totalPaymentCents,
          result.periods,
          result.payoffPeriods,
        );
      const versionId = Number(r.lastInsertRowid);

      const insExtra = this.db.prepare(
        "INSERT INTO version_extras (version_id, period, amount_cents) VALUES (?,?,?)",
      );
      for (const e of normalized.extras) {
        insExtra.run(versionId, e.period, e.amountCents);
      }

      const insRow = this.db.prepare(
        `INSERT INTO schedule_rows (version_id, period, interest_cents, ordinary_payment_cents,
           principal_paid_cents, extra_applied_cents, extra_unused_cents, balance_after_cents,
           cum_interest_cents, cum_principal_cents, cum_payment_cents)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const row of result.rows) {
        insRow.run(
          versionId,
          row.period,
          row.interestCents,
          row.ordinaryPaymentCents,
          row.principalPaidCents,
          row.extraAppliedCents,
          row.extraUnusedCents,
          row.balanceAfterCents,
          row.cumInterestCents,
          row.cumPrincipalCents,
          row.cumPaymentCents,
        );
      }
      this.db.exec("COMMIT");
      return this.getVersion(versionId);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  getVersion(versionId: number): VersionRecord {
    const v = this.db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId) as
      | Record<string, unknown>
      | undefined;
    if (!v) throw new AppError("NOT_FOUND", `版本 ${versionId} 不存在`, 404);
    const extras = (
      this.db
        .prepare("SELECT period, amount_cents AS amountCents FROM version_extras WHERE version_id = ? ORDER BY period")
        .all(versionId) as unknown as ExtraPayment[]
    ).map((e) => ({ period: e.period, amountCents: e.amountCents }));
    const rows = this.db
      .prepare(
        `SELECT period, interest_cents AS interestCents, ordinary_payment_cents AS ordinaryPaymentCents,
           principal_paid_cents AS principalPaidCents, extra_applied_cents AS extraAppliedCents,
           extra_unused_cents AS extraUnusedCents, balance_after_cents AS balanceAfterCents,
           cum_interest_cents AS cumInterestCents, cum_principal_cents AS cumPrincipalCents,
           cum_payment_cents AS cumPaymentCents
         FROM schedule_rows WHERE version_id = ? ORDER BY period`,
      )
      .all(versionId) as Record<string, unknown>[];
    const plainRows = rows.map((r) => ({ ...r }));
    return {
      id: versionId,
      planId: v.plan_id as number,
      versionNo: v.version_no as number,
      createdAt: v.created_at as string,
      input: {
        principalCents: v.principal_cents as number,
        monthlyRate: v.monthly_rate as string,
        monthlyPaymentCents: v.monthly_payment_cents as number,
        maxPeriods: v.max_periods as number,
        extras,
      },
      result: {
        status: v.status as "ok" | "limit_exceeded",
        limitReason: (v.limit_reason as string | null) ?? null,
        rows: plainRows as never,
        totalInterestCents: v.total_interest_cents as number,
        totalOrdinaryPaymentCents: v.total_ordinary_payment_cents as number,
        totalExtraAppliedCents: v.total_extra_applied_cents as number,
        totalExtraUnusedCents: v.total_extra_unused_cents as number,
        totalPaymentCents: v.total_payment_cents as number,
        periods: v.periods as number,
        payoffPeriods: (v.payoff_periods as number | null) ?? null,
      },
    };
  }

  listVersions(planId: number): unknown[] {
    this.planExists(planId);
    return this.db
      .prepare(
        `SELECT id, plan_id AS planId, version_no AS versionNo, principal_cents AS principalCents,
           monthly_rate AS monthlyRate, monthly_payment_cents AS monthlyPaymentCents,
           status, payoff_periods AS payoffPeriods, total_interest_cents AS totalInterestCents,
           total_payment_cents AS totalPaymentCents, created_at AS createdAt
         FROM versions WHERE plan_id = ? ORDER BY version_no`,
      )
      .all(planId);
  }

  // 基于已有版本加入/修改某一期的额外还款，另存为新版本
  upsertExtra(versionId: number, period: number, amountCents: number): VersionRecord {
    const base = this.getVersion(versionId);
    const extras = base.input.extras.filter((e) => e.period !== period);
    if (amountCents > 0) extras.push({ period, amountCents });
    return this.saveVersion(base.planId, { ...base.input, extras });
  }

  compare(versionIdA: number, versionIdB: number): unknown {
    const a = this.getVersion(versionIdA);
    const b = this.getVersion(versionIdB);
    return {
      a: summarize(a),
      b: summarize(b),
      diff: {
        totalInterestCents: b.result.totalInterestCents - a.result.totalInterestCents,
        payoffPeriods:
          a.result.payoffPeriods !== null && b.result.payoffPeriods !== null
            ? b.result.payoffPeriods - a.result.payoffPeriods
            : null,
        totalPaymentCents: b.result.totalPaymentCents - a.result.totalPaymentCents,
      },
    };
  }
}

function summarize(v: VersionRecord): unknown {
  return {
    versionId: v.id,
    planId: v.planId,
    versionNo: v.versionNo,
    status: v.result.status,
    payoffPeriods: v.result.payoffPeriods,
    totalInterestCents: v.result.totalInterestCents,
    totalPaymentCents: v.result.totalPaymentCents,
    totalExtraAppliedCents: v.result.totalExtraAppliedCents,
    totalExtraUnusedCents: v.result.totalExtraUnusedCents,
  };
}

function inputNormalized(input: ScheduleInput): Required<ScheduleInput> {
  return validateAndNormalize(input);
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "loan-scheduler.db");
}
