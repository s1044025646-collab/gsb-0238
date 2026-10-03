import http from "node:http";
import { Store, toCsv } from "./store";
import { validateAndBuild } from "./validate";
import { ValidationError } from "./money";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  const e = err as { code?: string; message?: string };
  const code = e.code ?? "INTERNAL_ERROR";
  const status =
    code === "NOT_FOUND" ? 404 :
    code === "VALIDATION_ERROR" ? 400 :
    code === "INSUFFICIENT_PAYMENT" || code === "LIMIT_EXCEEDED" ? 422 : 500;
  send(res, status, { error: { code, message: e.message ?? "内部错误" } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") {
        return send(res, 200, { ok: true });
      }

      // POST /api/preview 试算（不落库）
      if (method === "POST" && url.pathname === "/api/preview") {
        const { input, result } = validateAndBuild(await readBody(req));
        if (!result.ok) return send(res, 422, { error: { code: result.code, message: result.message } });
        return send(res, 200, { input, summary: result.summary, rows: result.rows });
      }

      // POST /api/plans 创建方案（版本 1）
      if (method === "POST" && url.pathname === "/api/plans") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : "未命名方案";
        const { input, result } = validateAndBuild(body);
        if (!result.ok) return send(res, 422, { error: { code: result.code, message: result.message } });
        const saved = store.saveVersion(null, name, input, result.summary, result.rows);
        return send(res, 201, saved);
      }

      if (parts[0] === "api" && parts[1] === "plans" && parts.length >= 3) {
        const planId = Number(parts[2]);
        if (!Number.isInteger(planId)) throw new ValidationError("planId 非法");

        // GET /api/plans/:id/versions/:v/csv
        if (method === "GET" && parts[3] === "versions" && parts.length === 6 && parts[5] === "csv") {
          const v = store.getVersion(planId, Number(parts[4]));
          if (!v) return send(res, 404, { error: { code: "NOT_FOUND", message: "方案版本不存在" } });
          res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="plan-${planId}-v${v.version}.csv"` });
          return res.end(toCsv(v.rows));
        }

        // GET /api/plans/:id/versions/:v
        if (method === "GET" && parts[3] === "versions" && parts.length === 5) {
          const v = store.getVersion(planId, Number(parts[4]));
          if (!v) return send(res, 404, { error: { code: "NOT_FOUND", message: "方案版本不存在" } });
          return send(res, 200, v);
        }

        // POST /api/plans/:id/versions 新增版本（修改输入或额外还款）
        if (method === "POST" && parts[3] === "versions" && parts.length === 4) {
          const { input, result } = validateAndBuild(await readBody(req));
          if (!result.ok) return send(res, 422, { error: { code: result.code, message: result.message } });
          const saved = store.saveVersion(planId, "", input, result.summary, result.rows);
          return send(res, 201, saved);
        }

        // GET /api/plans/:id （最新版本）
        if (method === "GET" && parts.length === 3) {
          const v = store.getVersion(planId);
          if (!v) return send(res, 404, { error: { code: "NOT_FOUND", message: "方案不存在" } });
          return send(res, 200, v);
        }
      }

      // GET /api/plans
      if (method === "GET" && url.pathname === "/api/plans") {
        return send(res, 200, { plans: store.listPlans() });
      }

      // POST /api/compare { a: {planId, version?}, b: {planId, version?} }
      if (method === "POST" && url.pathname === "/api/compare") {
        const body = (await readBody(req)) as { a?: { planId: number; version?: number }; b?: { planId: number; version?: number } };
        if (!body.a || !body.b) throw new ValidationError("compare 需要 a 与 b 两个方案引用");
        const va = store.getVersion(body.a.planId, body.a.version);
        const vb = store.getVersion(body.b.planId, body.b.version);
        if (!va || !vb) return send(res, 404, { error: { code: "NOT_FOUND", message: "方案版本不存在" } });
        return send(res, 200, {
          a: { planId: va.planId, version: va.version, periods: va.summary.periods, totalInterest: va.summary.totalInterest, totalPaid: va.summary.totalPaid },
          b: { planId: vb.planId, version: vb.version, periods: vb.summary.periods, totalInterest: vb.summary.totalInterest, totalPaid: vb.summary.totalPaid },
          diff: {
            periods: vb.summary.periods - va.summary.periods,
            totalInterest: vb.summary.totalInterest - va.summary.totalInterest,
            totalPaid: vb.summary.totalPaid - va.summary.totalPaid,
          },
        });
      }

      send(res, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    } catch (err) {
      sendError(res, err);
    }
  });
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  // 默认 0：由系统分配空闲端口；可用 --port= 或 PORT 指定
  const port = portArg ? Number(portArg.split("=")[1]) : Number(process.env.PORT ?? 0);
  const store = new Store();
  const server = createServer(store);
  server.listen(port, () => {
    const addr = server.address();
    const p = typeof addr === "object" && addr ? addr.port : port;
    console.log(`还款试算服务已启动: http://127.0.0.1:${p}`);
  });
}
