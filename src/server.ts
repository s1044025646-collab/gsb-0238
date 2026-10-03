import * as http from "node:http";
import { AddressInfo } from "node:net";
import { AppError, requireIntCents } from "./money";
import { computeSchedule, ScheduleInput } from "./schedule";
import { defaultDbPath, Store } from "./db";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    sendJson(res, err.status, { error: { code: err.code, message: err.message } });
  } else {
    sendJson(res, 500, { error: { code: "INTERNAL_ERROR", message: String(err) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("VALIDATION_ERROR", "请求体必须是合法 JSON");
  }
}

function toCsv(store: Store, versionId: number): string {
  const v = store.getVersion(versionId);
  const header =
    "period,interest_cents,ordinary_payment_cents,principal_paid_cents,extra_applied_cents,extra_unused_cents,balance_after_cents,cum_interest_cents,cum_principal_cents,cum_payment_cents";
  const lines = v.result.rows.map((r) =>
    [
      r.period,
      r.interestCents,
      r.ordinaryPaymentCents,
      r.principalPaidCents,
      r.extraAppliedCents,
      r.extraUnusedCents,
      r.balanceAfterCents,
      r.cumInterestCents,
      r.cumPrincipalCents,
      r.cumPaymentCents,
    ].join(","),
  );
  return [header, ...lines, ""].join("\r\n");
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const num = (s: string | undefined, what: string): number => {
        const n = Number(s);
        if (!Number.isInteger(n) || n < 1) throw new AppError("VALIDATION_ERROR", `${what} 必须是正整数`);
        return n;
      };

      if (method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && url.pathname === "/plans") {
        const body = (await readBody(req)) as { name?: string };
        return sendJson(res, 201, store.createPlan(String(body.name ?? "")));
      }
      if (method === "GET" && url.pathname === "/plans") {
        return sendJson(res, 200, store.listPlans());
      }
      if (method === "POST" && parts[0] === "plans" && parts[2] === "versions" && parts.length === 3) {
        const planId = num(parts[1], "planId");
        const body = (await readBody(req)) as ScheduleInput;
        return sendJson(res, 201, store.saveVersion(planId, body));
      }
      if (method === "GET" && parts[0] === "plans" && parts[2] === "versions" && parts.length === 3) {
        return sendJson(res, 200, store.listVersions(num(parts[1], "planId")));
      }
      if (method === "GET" && parts[0] === "versions" && parts.length === 2) {
        return sendJson(res, 200, store.getVersion(num(parts[1], "versionId")));
      }
      if (method === "GET" && parts[0] === "versions" && parts[2] === "csv" && parts.length === 3) {
        const csv = toCsv(store, num(parts[1], "versionId"));
        res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
        return res.end(csv);
      }
      if (method === "POST" && parts[0] === "versions" && parts[2] === "extras" && parts.length === 3) {
        const body = (await readBody(req)) as { period?: number; amountCents?: number };
        const version = store.upsertExtra(
          num(parts[1], "versionId"),
          num(String(body.period), "period"),
          requireIntCents(body.amountCents, "amountCents"), // 0 表示删除该期额外还款
        );
        return sendJson(res, 201, version);
      }
      if (method === "POST" && url.pathname === "/preview") {
        const body = (await readBody(req)) as ScheduleInput;
        return sendJson(res, 200, computeSchedule(body));
      }
      if (method === "GET" && url.pathname === "/compare") {
        const a = num(url.searchParams.get("a") ?? undefined, "a");
        const b = num(url.searchParams.get("b") ?? undefined, "b");
        return sendJson(res, 200, store.compare(a, b));
      }
      throw new AppError("NOT_FOUND", `路由不存在: ${method} ${url.pathname}`, 404);
    } catch (err) {
      sendError(res, err);
    }
  });
}

export function startServer(port: number, dbPath: string): Promise<{ port: number; close: () => void }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

if (require.main === module) {
  const argPort = process.argv.find((a) => a.startsWith("--port="));
  const port = argPort ? Number(argPort.split("=")[1]) : Number(process.env.PORT ?? 0); // 默认 0 = 自动选空闲端口
  startServer(port, defaultDbPath()).then(({ port: p }) => {
    console.log(`还款试算服务已启动: http://127.0.0.1:${p}  (数据目录: ./data)`);
  });
}
