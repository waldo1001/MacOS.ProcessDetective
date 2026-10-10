import type http from 'node:http';
import { collectHealth, getLastReport, getScanJob, refreshAfterAction, startFullScan } from '../health/engine.js';
import { makeContext } from '../health/context.js';
import { ALL_CHECKS } from '../health/registry.js';
import { ACTIONS, ActionError, actionsEnabled, executePlan, planAction, storePlan, takePlan } from '../health/actions.js';
import { readAudit, startOfMonth, sumCleaned } from '../health/audit.js';
import { buildHealthMarkdown, buildHealthPrompt, buildHealthReport } from '../report/health.js';
import { MAX_BODY_BYTES } from './guard.js';
import type { ActionTarget, HealthReport } from '../types.js';

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function json(res: http.ServerResponse, code: number, obj: unknown): void {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

/** Concurrent quick requests share one run, so a double click cannot pile up checks. */
let quickInflight: Promise<HealthReport> | null = null;
function quickReport(): Promise<HealthReport> {
  quickInflight ??= collectHealth({ mode: 'quick', awaitCached: false }).finally(() => {
    quickInflight = null;
  });
  return quickInflight;
}

/** One run per on-demand check at a time: a double click must not raise two authorization dialogs. */
const onDemandInflight = new Map<string, Promise<HealthReport>>();
function onDemandReport(id: string): Promise<HealthReport> {
  let p = onDemandInflight.get(id);
  if (!p) {
    p = collectHealth({ mode: 'quick', awaitCached: false, include: [id] }).finally(() => onDemandInflight.delete(id));
    onDemandInflight.set(id, p);
  }
  return p;
}

/** A request the body reader or the validation turned away. */
class BadRequest extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The only body reader in the server: JSON only, 64 KiB at most. The clean-up routes below are the
 * only callers. Nothing here takes a pid or a free path — plans are made from the current report.
 */
function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooBig = true;
      else chunks.push(c);
    });
    req.on('error', () => reject(new BadRequest(400, 'could not read the request body')));
    req.on('end', () => {
      if (tooBig) return reject(new BadRequest(400, 'request body is larger than 64 KiB'));
      try {
        const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new BadRequest(400, 'the request body must be a JSON object'));
      }
    });
  });
}

const MAX_TARGETS = 500;
function parseTargets(v: unknown): ActionTarget[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_TARGETS) throw new BadRequest(400, `"targets" must be an array of at most ${MAX_TARGETS} items`);
  return v.map((t): ActionTarget => {
    const o = t as { findingId?: unknown; path?: unknown } | null;
    if (!o || typeof o.findingId !== 'string' || typeof o.path !== 'string' || o.findingId.length > 200 || o.path.length > 4096 || !o.path) {
      throw new BadRequest(400, 'each target must be { findingId: string, path: string }');
    }
    return { findingId: o.findingId, path: o.path };
  });
}

/**
 * Health endpoints. Returns true when the request was handled. `boundHost` is the address the
 * server is bound to; clean-up actions are refused unless it is a loopback address. The scan writes
 * the health cache; only the clean-up routes (plan, execute) can change anything else, and only
 * through src/health/actions.ts.
 */
export async function handleHealthRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  boundHost?: string,
): Promise<boolean> {
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    json(res, 200, await quickReport());
    return true;
  }

  if (pathname === '/api/health/scan' && method === 'POST') {
    const job = startFullScan();
    json(res, 202, { jobId: job.id, state: job.state });
    return true;
  }

  const jm = pathname.match(/^\/api\/health\/scan\/([A-Za-z0-9-]+)$/);
  if (jm && method === 'GET') {
    const job = getScanJob(jm[1]!);
    if (!job) json(res, 404, { error: `No scan job ${jm[1]}` });
    else json(res, 200, job);
    return true;
  }

  // On-demand checks raise a macOS authorization dialog, so they run only on this explicit request.
  const cm = pathname.match(/^\/api\/health\/check\/([a-z0-9-]+)$/);
  if (cm && method === 'POST') {
    const check = ALL_CHECKS.find((c) => c.id === cm[1] && c.optIn);
    if (!check) json(res, 404, { error: `No on-demand check "${cm[1]}"` });
    else json(res, 200, await onDemandReport(check.id));
    return true;
  }

  if (pathname === '/api/health/report' && method === 'GET') {
    const format = url.searchParams.get('format') ?? 'text';
    if (format !== 'text' && format !== 'prompt' && format !== 'md') {
      json(res, 400, { error: `Unknown format "${format}" — use text, prompt or md` });
      return true;
    }
    const report = getLastReport() ?? (await quickReport());
    const body = format === 'md' ? buildHealthMarkdown(report, await readAudit(100)) : format === 'prompt' ? buildHealthPrompt(report) : buildHealthReport(report);
    send(res, 200, 'text/plain; charset=utf-8', body);
    return true;
  }

  // ---- clean-up actions (Phase 2) ----
  const enabled = actionsEnabled(boundHost ?? ''); // no bound host given = not known to be loopback = off
  const disabled = (): void => json(res, 403, { error: `actions disabled (${enabled.reason ?? 'off'})` });

  if (pathname === '/api/health/actions' && method === 'GET') {
    json(res, 200, {
      enabled: enabled.enabled,
      ...(enabled.reason ? { reason: enabled.reason } : {}),
      sandbox: enabled.sandbox,
      actions: enabled.enabled
        ? ACTIONS.map((a) => ({ id: a.id, title: a.title, method: a.method, explain: a.explain, needsAck: a.needsAck === true, ...(a.findingId ? { findingId: a.findingId } : {}) }))
        : [],
    });
    return true;
  }

  if (pathname === '/api/health/actions/log' && method === 'GET') {
    const all = await readAudit(Number.MAX_SAFE_INTEGER);
    json(res, 200, { entries: all.slice(0, 100), cleanedThisMonthBytes: sumCleaned(all, startOfMonth()) });
    return true;
  }

  if (pathname === '/api/health/action/plan' && method === 'POST') {
    if (!enabled.enabled) return disabled(), true;
    try {
      const body = await readJsonBody(req);
      if (typeof body['actionId'] !== 'string') throw new BadRequest(400, '"actionId" must be a string');
      const targets = parseTargets(body['targets']);
      const report = getLastReport();
      if (!report) throw new ActionError(409, 'no current report — run a check first');
      json(res, 200, await planAction(body['actionId'], targets, { ctx: await makeContext(), report }));
    } catch (err) {
      if (err instanceof BadRequest || err instanceof ActionError) json(res, err.status, { error: err.message });
      else throw err;
    }
    return true;
  }

  if (pathname === '/api/health/action/execute' && method === 'POST') {
    if (!enabled.enabled) return disabled(), true;
    try {
      const body = await readJsonBody(req);
      if (typeof body['token'] !== 'string' || (body['ack'] !== undefined && typeof body['ack'] !== 'boolean')) {
        throw new BadRequest(400, 'expected { token: string, ack?: boolean }');
      }
      const report = getLastReport();
      if (!report) throw new ActionError(409, 'no current report — run a check first');
      const plan = takePlan(body['token']);
      if (!plan) throw new ActionError(409, 'unknown, expired or already used token — plan again');
      let result;
      try {
        result = await executePlan(plan, { ctx: await makeContext(), report, ack: body['ack'] === true });
      } catch (err) {
        if (err instanceof ActionError && err.status === 400) storePlan(plan); // a missing acknowledgement does not burn the token
        throw err;
      }
      // The clean-up is done; a failure while refreshing the report must not hide its result.
      let fresh: HealthReport | null = null;
      try {
        fresh = await refreshAfterAction(result);
      } catch {
        fresh = getLastReport();
      }
      json(res, 200, { result, report: fresh });
    } catch (err) {
      if (err instanceof BadRequest || err instanceof ActionError) json(res, err.status, { error: err.message });
      else throw err;
    }
    return true;
  }

  return false;
}
