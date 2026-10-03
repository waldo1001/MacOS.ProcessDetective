import type http from 'node:http';
import { collectHealth, getLastReport, getScanJob, startFullScan } from '../health/engine.js';
import { ALL_CHECKS } from '../health/registry.js';
import { buildHealthMarkdown, buildHealthPrompt, buildHealthReport } from '../report/health.js';
import type { HealthReport } from '../types.js';

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

/**
 * Health endpoints. Returns true when the request was handled. Nothing here reads
 * a request body or takes a pid; the only thing a scan writes is the health cache file.
 */
export async function handleHealthRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
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
    const body = format === 'md' ? buildHealthMarkdown(report) : format === 'prompt' ? buildHealthPrompt(report) : buildHealthReport(report);
    send(res, 200, 'text/plain; charset=utf-8', body);
    return true;
  }

  return false;
}
