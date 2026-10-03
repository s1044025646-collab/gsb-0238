import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { PeriodRow, ScheduleSummary } from "./schedule";

export interface StoredVersion {
  planId: number;
  version: number;
  name: string;
  createdAt: string;
  input: unknown;
  summary: ScheduleSummary;
  rows: PeriodRow[];
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath?: string) {
    const file = dbPath ?? path.join(process.cwd(), "data", "plans.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        plan_id INTEGER NOT NULL REFERENCES plans(id),
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        input_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        PRIMARY KEY (plan_id, version)
      );
      CREATE TABLE IF NOT EXISTS periods (
        plan_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        period INTEGER NOT NULL,
        opening_balance INTEGER NOT NULL,
        interest INTEGER NOT NULL,
        normal_payment INTEGER NOT NULL,
        principal_paid INTEGER NOT NULL,
        extra_payment INTEGER NOT NULL,
        extra_applied INTEGER NOT NULL,
        extra_unused INTEGER NOT NULL,
        total_paid INTEGER NOT NULL,
        closing_balance INTEGER NOT NULL,
        PRIMARY KEY (plan_id, version, period),
        FOREIGN KEY (plan_id, version) REFERENCES versions(plan_id, version)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** 一次事务保存方案头部、版本与全部期次；任何失败整体回滚。 */
  saveVersion(planId: number | null, name: string, input: unknown, summary: ScheduleSummary, rows: PeriodRow[]): StoredVersion {
    this.db.exec("BEGIN");
    try {
      let pid = planId;
      const now = new Date().toISOString();
      if (pid === null) {
        const r = this.db.prepare("INSERT INTO plans (name, created_at) VALUES (?, ?)").run(name, now);
        pid = Number(r.lastInsertRowid);
      } else {
        const exists = this.db.prepare("SELECT id FROM plans WHERE id = ?").get(pid);
        if (!exists) throw Object.assign(new Error(`方案 ${pid} 不存在`), { code: "NOT_FOUND" });
      }
      const vrow = this.db.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM versions WHERE plan_id = ?").get(pid) as { v: number };
      const version = vrow.v;
      this.db.prepare("INSERT INTO versions (plan_id, version, created_at, input_json, summary_json) VALUES (?, ?, ?, ?, ?)")
        .run(pid, version, now, JSON.stringify(input), JSON.stringify(summary));
      const ins = this.db.prepare(`INSERT INTO periods
        (plan_id, version, period, opening_balance, interest, normal_payment, principal_paid, extra_payment, extra_applied, extra_unused, total_paid, closing_balance)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows) {
        ins.run(pid, version, r.period, r.openingBalance, r.interest, r.normalPayment, r.principalPaid,
          r.extraPayment, r.extraApplied, r.extraUnused, r.totalPaid, r.closingBalance);
      }
      this.db.exec("COMMIT");
      return { planId: pid, version, name, createdAt: now, input, summary, rows };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  listPlans(): { id: number; name: string; createdAt: string; versions: number }[] {
    const rows = this.db.prepare(`
      SELECT p.id, p.name, p.created_at AS createdAt, COUNT(v.version) AS versions
      FROM plans p LEFT JOIN versions v ON v.plan_id = p.id
      GROUP BY p.id ORDER BY p.id`).all() as unknown as { id: number; name: string; createdAt: string; versions: number }[];
    return rows;
  }

  getVersion(planId: number, version?: number): StoredVersion | null {
    const v = version ?? (this.db.prepare("SELECT MAX(version) AS v FROM versions WHERE plan_id = ?").get(planId) as { v: number | null }).v;
    if (v === null || v === undefined) return null;
    const head = this.db.prepare(`
      SELECT p.id AS planId, p.name, v.version, v.created_at AS createdAt, v.input_json, v.summary_json
      FROM versions v JOIN plans p ON p.id = v.plan_id
      WHERE v.plan_id = ? AND v.version = ?`).get(planId, v) as
      { planId: number; name: string; version: number; createdAt: string; input_json: string; summary_json: string } | undefined;
    if (!head) return null;
    const rows = (this.db.prepare(`SELECT period, opening_balance AS openingBalance, interest, normal_payment AS normalPayment,
        principal_paid AS principalPaid, extra_payment AS extraPayment, extra_applied AS extraApplied,
        extra_unused AS extraUnused, total_paid AS totalPaid, closing_balance AS closingBalance
      FROM periods WHERE plan_id = ? AND version = ? ORDER BY period`).all(planId, v) as unknown as PeriodRow[]).map((r) => ({ ...r }));
    return {
      planId: head.planId,
      version: head.version,
      name: head.name,
      createdAt: head.createdAt,
      input: JSON.parse(head.input_json),
      summary: JSON.parse(head.summary_json),
      rows,
    };
  }
}

export function toCsv(rows: PeriodRow[]): string {
  const header = "period,opening_balance,interest,normal_payment,principal_paid,extra_payment,extra_applied,extra_unused,total_paid,closing_balance";
  const lines = rows.map((r) =>
    [r.period, r.openingBalance, r.interest, r.normalPayment, r.principalPaid, r.extraPayment, r.extraApplied, r.extraUnused, r.totalPaid, r.closingBalance].join(","));
  return [header, ...lines].join("\r\n") + "\r\n";
}
