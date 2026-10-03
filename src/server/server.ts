import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { enrich, snapshot } from '../service.js';
import { collectSystem } from '../collect/system.js';
import { collectProcStats } from '../collect/proctop.js';
import { getFdCount } from '../collect/lsof.js';
import { getStackSample, getStackSampleElevated } from '../collect/sample.js';
import { getPowermetrics } from '../collect/powermetrics.js';
import { dockerStats } from '../collect/docker.js';
import { getProcessLog } from '../collect/oslog.js';
import { getFsChurn } from '../collect/fsusage.js';
import { getReadActivity } from '../collect/readactivity.js';
import { inspectPayload, processesPayload } from './payload.js';
import { AdviceError, getAdvice } from './advice.js';
import type { HistoryStore } from '../history/collector.js';
import { RANGES } from '../history/store.js';

/** The single-page app, loaded once at startup (copied next to this module by the build). */
const PAGE = readFileSync(fileURLToPath(new URL('./page.html', import.meta.url)), 'utf8');

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function json(res: http.ServerResponse, code: number, obj: unknown): void {
  send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));
}

/**
 * Start the read-only local web server. Bound to localhost by default so the
 * snapshot data never leaves the machine. Each request takes a fresh snapshot.
 *
 * Pass a `historyStore` to enable `GET /api/history`.
 */
export function startServer(
  port: number,
  host = '127.0.0.1',
  historyStore?: HistoryStore,
): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${host}:${port}`);

      if (url.pathname === '/' || url.pathname === '/index.html') {
        return send(res, 200, 'text/html; charset=utf-8', PAGE);
      }

      if (url.pathname === '/api/processes') {
        const [tree, stats] = await Promise.all([snapshot(), collectProcStats()]);
        return json(res, 200, { processes: processesPayload(tree, stats), at: Date.now() });
      }

      if (url.pathname === '/api/system') {
        return json(res, 200, await collectSystem());
      }

      if (url.pathname === '/api/history') {
        if (!historyStore) {
          return json(res, 200, { samples: [], cadenceMs: 15_000, retentionDays: 14 });
        }
        const rangeKey = url.searchParams.get('range') ?? '1h';
        const sinceParam = url.searchParams.get('since');
        const maxPointsParam = url.searchParams.get('maxPoints');

        const maxPoints = maxPointsParam
          ? Math.max(50, Math.min(2000, parseInt(maxPointsParam, 10) || 600))
          : 600;

        let sinceMs: number | null = null;
        if (sinceParam) {
          sinceMs = parseInt(sinceParam, 10) || null;
        } else if (rangeKey in RANGES) {
          const duration = RANGES[rangeKey]!;
          sinceMs = duration != null ? Date.now() - duration : null;
        }

        const samples = historyStore.getSamples(sinceMs, maxPoints);
        return json(res, 200, {
          samples,
          cadenceMs: historyStore.config.intervalMs,
          retentionDays: historyStore.config.retentionDays,
        });
      }

      const m = url.pathname.match(/^\/api\/inspect\/(\d+)$/);
      if (m) {
        const pid = parseInt(m[1]!, 10);
        const tree = await snapshot();
        const node = tree.byPid.get(pid);
        if (!node) return json(res, 404, { error: `No process with PID ${pid}` });
        const [enr, fdCount, stats] = await Promise.all([
          enrich(node),
          getFdCount(pid),
          collectProcStats(),
        ]);
        const s = stats.get(pid);
        return json(res, 200, inspectPayload(node, enr, {
          threads: s?.threads ?? null,
          energy: s?.energy ?? null,
          fdCount,
        }));
      }

      const sm = url.pathname.match(/^\/api\/sample\/(\d+)$/);
      if (sm && req.method === 'POST') {
        const pid = parseInt(sm[1]!, 10);
        const tree = await snapshot();
        const node = tree.byPid.get(pid);
        if (!node) return json(res, 404, { error: `No process with PID ${pid}` });

        // Opt-in elevated branch: ?elevated=1 or JSON body { "elevated": true }.
        // The kill-switch (PD_NO_ELEVATED=1) is enforced inside getStackSampleElevated.
        const elevatedFlag = url.searchParams.get('elevated');
        const useElevated = elevatedFlag === '1' || elevatedFlag === 'true';

        // Run sample on-demand (~2s) — never on the polled /api/inspect path
        const [enr, sample] = await Promise.all([
          enrich(node),
          useElevated ? getStackSampleElevated(pid, 2) : getStackSample(pid, 2),
        ]);
        // Attach the stack sample to enrichment so report/prompt include it
        const enrichedWithSample = { ...enr, stackSample: sample };
        const [fdCount, stats] = await Promise.all([getFdCount(pid), collectProcStats()]);
        const s = stats.get(pid);
        const payload = inspectPayload(node, enrichedWithSample, {
          threads: s?.threads ?? null,
          energy: s?.energy ?? null,
          fdCount,
        });
        return json(res, 200, { sample, report: payload.report, prompt: payload.prompt, detail: payload });
      }

      const lm = url.pathname.match(/^\/api\/log\/(\d+)$/);
      if (lm && req.method === 'POST') {
        const pid = parseInt(lm[1]!, 10);
        const tree = await snapshot();
        const node = tree.byPid.get(pid);
        if (!node) return json(res, 404, { error: `No process with PID ${pid}` });
        const minutesParam = url.searchParams.get('minutes');
        const minutes = minutesParam ? Math.max(1, Math.min(10, parseInt(minutesParam, 10) || 3)) : 3;
        const [enr, logTail] = await Promise.all([enrich(node), getProcessLog(pid, minutes)]);
        const enriched = { ...enr, logTail };
        const [fdCount, stats] = await Promise.all([getFdCount(pid), collectProcStats()]);
        const s = stats.get(pid);
        const payload = inspectPayload(node, enriched, {
          threads: s?.threads ?? null, energy: s?.energy ?? null, fdCount,
        });
        return json(res, 200, { logTail, report: payload.report, prompt: payload.prompt, detail: payload });
      }

      const fm = url.pathname.match(/^\/api\/fschurn\/(\d+)$/);
      if (fm && req.method === 'POST') {
        const pid = parseInt(fm[1]!, 10);
        const tree = await snapshot();
        const node = tree.byPid.get(pid);
        if (!node) return json(res, 404, { error: `No process with PID ${pid}` });
        const secondsParam = url.searchParams.get('seconds');
        const seconds = secondsParam ? Math.max(2, Math.min(5, parseInt(secondsParam, 10) || 3)) : 3;
        const [enr, fsChurn] = await Promise.all([enrich(node), getFsChurn(seconds)]);
        const enriched = { ...enr, fsChurn };
        const [fdCount, stats] = await Promise.all([getFdCount(pid), collectProcStats()]);
        const s = stats.get(pid);
        const payload = inspectPayload(node, enriched, {
          threads: s?.threads ?? null, energy: s?.energy ?? null, fdCount,
        });
        return json(res, 200, { fsChurn, report: payload.report, prompt: payload.prompt, detail: payload });
      }

      const rm = url.pathname.match(/^\/api\/readdelta\/(\d+)$/);
      if (rm && req.method === 'POST') {
        const pid = parseInt(rm[1]!, 10);
        const tree = await snapshot();
        const node = tree.byPid.get(pid);
        if (!node) return json(res, 404, { error: `No process with PID ${pid}` });
        const gapParam = url.searchParams.get('gap');
        const gap = gapParam ? Math.max(500, Math.min(3000, parseInt(gapParam, 10) || 1500)) : 1500;
        const [enr, readActivity] = await Promise.all([enrich(node), getReadActivity(pid, gap)]);
        const enriched = { ...enr, readActivity };
        const [fdCount, stats] = await Promise.all([getFdCount(pid), collectProcStats()]);
        const s = stats.get(pid);
        const payload = inspectPayload(node, enriched, {
          threads: s?.threads ?? null, energy: s?.energy ?? null, fdCount,
        });
        return json(res, 200, { readActivity, report: payload.report, prompt: payload.prompt, detail: payload });
      }

      if (url.pathname === '/api/docker' && req.method === 'POST') {
        // On-demand only (~1-2s). Never call dockerPs here — it already rides on /api/inspect.
        const snap = await dockerStats();
        return json(res, 200, snap);
      }

      if (url.pathname === '/api/powermetrics' && req.method === 'POST') {
        const secondsParam = url.searchParams.get('seconds');
        const seconds = secondsParam ? Math.max(1, Math.min(3, parseInt(secondsParam, 10) || 1)) : 1;
        const snapshot = await getPowermetrics(seconds);
        return json(res, 200, snapshot);
      }

      const am = url.pathname.match(/^\/api\/advice\/(\d+)$/);
      if (am && req.method === 'POST') {
        const pid = parseInt(am[1]!, 10);
        const tree = await snapshot();
        const node = tree.byPid.get(pid);
        if (!node) return json(res, 404, { error: `No process with PID ${pid}` });
        try {
          const advice = await getAdvice(node, await enrich(node));
          return json(res, 200, { advice });
        } catch (err) {
          // Surface expected problems (missing key, model errors) to the UI as data.
          const message =
            err instanceof AdviceError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          return json(res, 200, { error: message });
        }
      }

      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
