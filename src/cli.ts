import { Command } from 'commander';
import { enrich, hotProcesses, snapshot } from './service.js';
import { isDevProcess } from './enrich/classify.js';
import { parentChain } from './tree/build.js';
import { generateReport } from './report/report.js';
import { buildInvestigationPrompt } from './report/prompt.js';
import { renderInspect } from './render/inspect.js';
import { renderChain, renderSubtree } from './render/tree.js';
import { renderTop } from './render/top.js';
import { runUi } from './render/ui.js';
import { startServer } from './server/server.js';
import { startHistoryStore } from './history/collector.js';
import { spawn } from 'node:child_process';
import { fmtPct, homePath } from './render/format.js';
import { color } from './util/color.js';
import type { ProcessNode, ProcessTree } from './types.js';

function findNode(tree: ProcessTree, pid: number): ProcessNode | undefined {
  return tree.byPid.get(pid);
}

/** Shared rendering for one hot process: chain + interpretation block. */
async function renderHotBlock(node: ProcessNode): Promise<string> {
  const enr = await enrich(node);
  const lines: string[] = [];
  lines.push(
    `${color.cyan(color.bold(node.proc.name))}  ` +
      `${color.gray(`PID ${node.proc.pid}`)}  ` +
      `CPU ${color.red(color.bold(fmtPct(node.proc.cpu)))}`,
  );
  const ancestors = renderChain(parentChain(node)).split('\n').slice(0, -1).join('\n');
  lines.push(ancestors || color.dim('  (no parent recorded)'));
  if (enr.interpretation.label) lines.push(`${color.dim('Likely:')} ${enr.interpretation.label}`);
  if (enr.packageJson) {
    lines.push(`${color.dim('Project:')} ${enr.packageJson.name ?? homePath(enr.packageJson.dir)}`);
  } else if (enr.cwd) {
    lines.push(`${color.dim('Cwd:')} ${homePath(enr.cwd)}`);
  }
  if (enr.interpretation.scriptName && enr.interpretation.resolvedScript) {
    lines.push(
      `${color.dim('Script:')} package.json → scripts.${enr.interpretation.scriptName} = ` +
        `"${enr.interpretation.resolvedScript}"`,
    );
  }
  return lines.join('\n');
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('process-detective')
    .description('macOS CPU/process detective — find out why that node process is eating your fans')
    .version('0.1.0');

  program
    .command('top')
    .description('Show the top CPU-consuming processes')
    .option('-n, --limit <count>', 'number of rows', (v) => parseInt(v, 10), 15)
    .option('-t, --threshold <pct>', 'highlight processes at/above this CPU%', (v) => parseFloat(v), 0)
    .option('--dev', 'only show developer-related processes')
    .action(async (opts) => {
      const tree = await snapshot();
      let procs = tree.all.map((n) => n.proc);
      if (opts.dev) procs = procs.filter(isDevProcess);
      console.log(renderTop(procs, { limit: opts.limit, threshold: opts.threshold }));
    });

  program
    .command('tree')
    .description('Show process trees; with --hot, focus on hot developer processes')
    .option('--hot', 'show hot developer processes with their parent chains')
    .option('-p, --pid <pid>', 'render the subtree rooted at this PID', (v) => parseInt(v, 10))
    .option('-t, --threshold <pct>', 'CPU% considered "hot"', (v) => parseFloat(v), 20)
    .option('-n, --limit <count>', 'max hot processes to show', (v) => parseInt(v, 10), 8)
    .action(async (opts) => {
      const tree = await snapshot();

      if (opts.pid != null) {
        const node = findNode(tree, opts.pid);
        if (!node) return fail(`No process with PID ${opts.pid} in this snapshot.`);
        console.log(renderSubtree(node));
        return;
      }

      // Default behaviour is --hot (a full launchd tree is rarely what you want).
      const hot = hotProcesses(tree, opts.threshold, true).slice(0, opts.limit);
      if (!hot.length) {
        console.log(color.dim(`No developer processes at/above ${opts.threshold}% CPU.`));
        return;
      }
      console.log(color.bold('Hot processes\n'));
      const blocks = await Promise.all(hot.map(renderHotBlock));
      console.log(blocks.join('\n\n'));
    });

  program
    .command('inspect')
    .description('Show full detail for one process')
    .argument('<pid>', 'process id', (v) => parseInt(v, 10))
    .action(async (pid: number) => {
      const tree = await snapshot();
      const node = findNode(tree, pid);
      if (!node) return fail(`No process with PID ${pid} in this snapshot.`);
      console.log(renderInspect(node, await enrich(node)));
    });

  program
    .command('report')
    .description('Generate a copy-friendly diagnostic report for one process')
    .argument('<pid>', 'process id', (v) => parseInt(v, 10))
    .action(async (pid: number) => {
      const tree = await snapshot();
      const node = findNode(tree, pid);
      if (!node) return fail(`No process with PID ${pid} in this snapshot.`);
      console.log(generateReport(node, await enrich(node)));
    });

  program
    .command('serve')
    .description('Launch the web UI — a graphical dashboard in your browser')
    .option('-p, --port <port>', 'port to listen on', (v) => parseInt(v, 10), 7878)
    .option('--host <host>', 'host to bind (localhost only by default)', '127.0.0.1')
    .option('--no-open', 'do not open the browser automatically')
    .option('--no-history', 'disable history persistence (env: PD_HISTORY=0)')
    .option('--data-dir <path>', 'history data directory (env: PD_DATA_DIR)')
    .option('--history-interval <sec>', 'history sample interval in seconds (env: PD_HISTORY_INTERVAL_MS)', (v) => parseFloat(v))
    .option('--history-retention <days>', 'history retention in days (env: PD_HISTORY_RETENTION_DAYS)', (v) => parseInt(v, 10))
    .action(async (opts) => {
      // Determine whether history is enabled
      const historyEnv = process.env['PD_HISTORY'];
      const historyEnabled =
        historyEnv !== '0' &&
        opts.history !== false;

      let historyStore: Awaited<ReturnType<typeof startHistoryStore>> | undefined;

      if (historyEnabled) {
        const historyCfg: {
          dataDir?: string;
          intervalMs?: number;
          retentionDays?: number;
        } = {};
        if (opts.dataDir) historyCfg.dataDir = opts.dataDir as string;
        if (opts.historyInterval != null) {
          historyCfg.intervalMs = Math.round((opts.historyInterval as number) * 1000);
        }
        if (opts.historyRetention != null) {
          historyCfg.retentionDays = opts.historyRetention as number;
        }

        try {
          historyStore = await startHistoryStore(historyCfg);
        } catch (err) {
          console.error(
            color.dim(`[history] failed to start (continuing without persistence): ${err instanceof Error ? err.message : err}`),
          );
        }
      } else {
        console.log(color.dim('[history] disabled (PD_HISTORY=0 or --no-history)'));
      }

      try {
        await startServer(opts.port, opts.host, historyStore);
      } catch (err) {
        return fail(`Could not start server: ${err instanceof Error ? err.message : err}`);
      }
      const url = `http://${opts.host}:${opts.port}`;
      console.log(`${color.bold('Process Detective web UI')}  →  ${color.cyan(url)}`);
      console.log(color.dim('Read-only · bound to localhost · Ctrl-C to stop'));
      if (opts.open && opts.host === '127.0.0.1') {
        spawn('open', [url], { stdio: 'ignore' }).on('error', () => {});
      }
    });

  program
    .command('ui')
    .description('Interactive live view: navigate hot processes and drill into one')
    .option('-t, --threshold <pct>', 'CPU% considered hot', (v) => parseFloat(v), 50)
    .option('-i, --interval <sec>', 'refresh interval in seconds', (v) => parseFloat(v), 2)
    .option('--dev', 'start filtered to developer processes')
    .action(async (opts) => {
      await runUi({ threshold: opts.threshold, interval: opts.interval, devOnly: Boolean(opts.dev) });
    });

  program
    .command('prompt')
    .description('Print a copy-paste investigation prompt to hand to your AI agent of choice')
    .argument('<pid>', 'process id', (v) => parseInt(v, 10))
    .action(async (pid: number) => {
      const tree = await snapshot();
      const node = findNode(tree, pid);
      if (!node) return fail(`No process with PID ${pid} in this snapshot.`);
      console.log(buildInvestigationPrompt(node, await enrich(node)));
    });

  program
    .command('watch')
    .description('Continuously watch for CPU spikes')
    .option('-t, --threshold <pct>', 'spike threshold CPU%', (v) => parseFloat(v), 80)
    .option('-i, --interval <sec>', 'refresh interval in seconds', (v) => parseFloat(v), 2)
    .option('-n, --limit <count>', 'rows to display', (v) => parseInt(v, 10), 15)
    .action(async (opts) => {
      await runWatch(opts.threshold, opts.interval, opts.limit);
    });

  return program;
}

interface Spike {
  at: string;
  pid: number;
  name: string;
  cpu: number;
}

async function runWatch(threshold: number, intervalSec: number, limit: number): Promise<void> {
  const history: Spike[] = [];
  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });

  // eslint-disable-next-line no-constant-condition
  while (!stop) {
    const tree = await snapshot();
    const procs = tree.all.map((n) => n.proc);
    const spiking = procs.filter((p) => p.cpu >= threshold).sort((a, b) => b.cpu - a.cpu);
    const now = new Date().toLocaleTimeString();
    for (const p of spiking.slice(0, 5)) {
      history.push({ at: now, pid: p.pid, name: p.name, cpu: p.cpu });
    }
    while (history.length > 10) history.shift();

    process.stdout.write('\x1b[2J\x1b[H'); // clear screen + home
    console.log(
      color.bold(`process-detective watch`) +
        color.dim(`  threshold ${threshold}%  every ${intervalSec}s  (Ctrl-C to exit)  ${now}`),
    );
    console.log();
    console.log(renderTop(procs, { limit, threshold }));

    if (spiking.length) {
      console.log();
      console.log(color.red(color.bold(`⚠ ${spiking.length} process(es) above ${threshold}%`)));
      for (const p of spiking.slice(0, 5)) {
        console.log(
          `  ${color.red(fmtPct(p.cpu).padStart(7))}  ${color.cyan(p.name)}  ` +
            color.gray(`PID ${p.pid}`) +
            color.dim(`   → process-detective report ${p.pid}`),
        );
      }
    }

    if (history.length) {
      console.log();
      console.log(color.dim('Recent spikes:'));
      for (const h of history.slice(-6)) {
        console.log(color.dim(`  ${h.at}  ${h.name} (PID ${h.pid})  ${fmtPct(h.cpu)}`));
      }
    }

    await sleep(intervalSec * 1000, () => stop);
  }
  console.log('\nStopped.');
}

function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = 100;
    let waited = 0;
    const tick = setInterval(() => {
      waited += step;
      if (waited >= ms || shouldStop()) {
        clearInterval(tick);
        resolve();
      }
    }, step);
  });
}

function fail(msg: string): void {
  console.error(color.red(msg));
  process.exitCode = 1;
}

/** Entry point used by the bin shim. */
export async function main(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
