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
import { writeFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { applyResultToCache, collectHealth } from './health/engine.js';
import { makeContext } from './health/context.js';
import { ALL_CHECKS } from './health/registry.js';
import { ACTIONS, ActionError, actionsEnabled, executePlan, offeredCommands, planAction, selectTargets, takePlan } from './health/actions.js';
import { checkActionable } from './health/actionable.js';
import { readAudit } from './health/audit.js';
import { buildHealthMarkdown, buildHealthReport } from './report/health.js';
import { fmtBytes, fmtPct, homePath } from './render/format.js';
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
    .command('health')
    .description('Mac health check: verdict, vitals and findings (read-only, no sudo)')
    .option('--full', 'also survey disk clutter (bounded du, up to ~90 s)')
    .option('--json', 'print the HealthReport as JSON')
    .option('--md <file>', 'write the findings as markdown to <file> and print its path')
    .option('--no-cache', 'ignore cached results of the slow checks (re-run them now)')
    .option('--login-items', 'also check login items (macOS asks for Touch ID or your password)')
    .action(async (opts) => {
      // A one-shot process cannot refresh in the background, so cached checks are awaited.
      const full = Boolean(opts.full);
      const progress = full && process.stderr.isTTY
        ? (p: { done: number; total: number; current: string }) =>
            process.stderr.write(`\r\x1b[K${p.done}/${p.total} · ${p.current}`)
        : undefined;
      const report = await collectHealth({
        mode: full ? 'full' : 'quick',
        awaitCached: true,
        noCache: opts.cache === false,
        ...(opts.loginItems ? { include: ['login-items'] } : {}),
        ...(progress ? { onProgress: progress } : {}),
      });
      if (progress) process.stderr.write('\r\x1b[K');

      let mdPath: string | null = null;
      if (opts.md) {
        mdPath = resolvePath(String(opts.md));
        try {
          await writeFile(mdPath, buildHealthMarkdown(report, await readAudit(100)), 'utf8');
        } catch (err) {
          return fail(`Could not write ${mdPath}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        if (mdPath) console.error(mdPath);
      } else if (mdPath) {
        console.log(mdPath);
      } else {
        console.log(buildHealthReport(report));
      }
    });

  program
    .command('clean')
    .description('Clean-up actions: a dry run first, then move to the Trash (opt-in; PD_NO_ACTIONS=1 turns it off)')
    .argument('[actionId]', ACTIONS.map((a) => a.id).join(' | '))
    .option('--list', 'list the actionable items and the available command actions')
    .option('--json', 'print the list, plan or result as JSON')
    .option('--finding <id>', "select that finding's actionable regenerates/orphan items (repeatable)", collect, [] as string[])
    .option('--path <p>', 'select one item of the report (repeatable)', collect, [] as string[])
    .option('--include-ask', "also select 'ask' items, and acknowledge a plan that needs it")
    .option('--apply', 'perform the plan (needs --confirm <token> from the dry run)')
    .option('--confirm <token>', 'the token the dry run printed')
    .action(async (actionId: string | undefined, opts) => {
      const cfg = actionsEnabled('127.0.0.1');
      if (!cfg.enabled) return fail(`Clean-up actions are off: ${cfg.reason}.`);
      if (!opts.list && !actionId) return fail('Name an action (see --list), or use --list.');

      // A quick report carries the last full scan's clutter. Only the checks the clean-up layer needs run.
      const keep = ['runaway-logs', 'launch-agents', 'apfs-snapshots', 'brew', 'disk-clutter'];
      const report = await collectHealth({ mode: 'quick', awaitCached: true, checks: ALL_CHECKS.filter((c) => keep.includes(c.id)) });
      if (report.fullScan.at === null) return fail('No full scan on record — run `pdetective health --full` first.');
      const ctx = await makeContext();

      if (opts.list) {
        const groups = report.findings
          .map((f) => ({ f, items: (f.items ?? []).filter((it) => checkActionable(f, it, ctx.home, cfg.sandbox).ok) }))
          .filter((g) => g.items.length > 0);
        const commands = offeredCommands(report, ctx);
        if (opts.json) {
          console.log(JSON.stringify({
            enabled: true, sandbox: cfg.sandbox,
            findings: groups.map(({ f, items }) => ({ id: f.id, title: f.title, items })),
            commands: commands.map((a) => ({ id: a.id, title: a.title, findingId: a.findingId, needsAck: a.needsAck === true })),
          }, null, 2));
          return;
        }
        if (cfg.sandbox) console.log(color.yellow(`SANDBOX ${cfg.sandbox} — only items inside it can be cleaned`));
        console.log(color.bold('Actionable items (moved to the Trash, never deleted)'));
        if (groups.length === 0) console.log('  none');
        for (const { f, items } of groups) {
          console.log(`\n${color.cyan(f.id)}  ${f.title}`);
          for (const it of items) {
            console.log(`  ${fmtBytes(it.bytes).padStart(9)}  ${it.safety.padEnd(11)} ${homePath(it.path)}${it.note ? color.dim(`  [${it.note}]`) : ''}`);
          }
        }
        console.log(`\n${color.bold('Command actions')}`);
        if (commands.length === 0) console.log('  none offered by the current report');
        for (const a of commands) console.log(`  ${a.id.padEnd(28)} ${a.title}${a.needsAck ? color.dim('  (needs --include-ask)') : ''}`);
        console.log(color.dim('\nDry run: pdetective clean trash-paths --path <p>   |   pdetective clean <commandActionId>'));
        return;
      }

      try {
        const action = ACTIONS.find((a) => a.id === actionId);
        if (!action) return fail(`Unknown action "${actionId}". Available: ${ACTIONS.map((a) => a.id).join(', ')}`);
        let targets: { findingId: string; path: string }[] = [];
        if (action.method === 'trash') {
          const sel = selectTargets(report, { findingIds: opts.finding, paths: opts.path, includeAsk: Boolean(opts.includeAsk) }, ctx.home, cfg.sandbox);
          for (const p of sel.problems) console.error(color.yellow(p));
          targets = sel.targets;
          if (targets.length === 0) return fail('Nothing selected: use --finding <id> and/or --path <p> (see --list).');
        } else if (opts.finding.length || opts.path.length) {
          return fail(`${action.id} takes no --finding/--path: it runs one fixed command.`);
        }

        const plan = await planAction(action.id, targets, { ctx, report });
        if (!opts.apply) {
          if (opts.json) console.log(JSON.stringify(plan, null, 2));
          else {
            console.log(color.bold(`Dry run: ${action.id}`) + color.dim(`   token ${plan.token}`));
            console.log(plan.command ? `  Command: ${plan.command}` : '  Method: to the Trash — recoverable until you empty it');
            for (const t of plan.targets) console.log(`  ${fmtBytes(t.bytes).padStart(9)}  ${t.safety.padEnd(11)} ${homePath(t.path)}`);
            for (const r of plan.refused) console.log(color.yellow(`  refused  ${homePath(r.path)} — ${r.reason}`));
            if (plan.method === 'trash') console.log(`  Total ${fmtBytes(plan.totalBytes)} in ${plan.targets.length} item${plan.targets.length === 1 ? '' : 's'}`);
            console.log(`  ${plan.explain}`);
            if (plan.method === 'command' || plan.targets.length > 0) {
              console.log(color.dim(`\nTo perform it: add --apply --confirm ${plan.token}${plan.needsAck ? ' --include-ask' : ''}`));
            } else {
              console.log(color.yellow('\nNothing to do: every target was refused.'));
            }
          }
          if (plan.method === 'trash' && plan.targets.length === 0) process.exitCode = 1;
          return;
        }

        if (!opts.confirm) return fail('--apply needs --confirm <token> from the dry run.');
        if (opts.confirm !== plan.token) return fail('The token does not match this plan: it is wrong, or the paths changed since the dry run. Nothing was done — run the dry run again.');
        if (plan.needsAck && !opts.includeAsk) return fail('This plan needs --include-ask: it removes things you may want back.');
        if (plan.method === 'trash' && plan.targets.length === 0) return fail('Nothing to do: every target was refused.');
        takePlan(plan.token); // the plan is run directly; drop the stored copy
        const result = await executePlan(plan, { ctx, report, ack: Boolean(opts.includeAsk) });
        await applyResultToCache(result);
        if (opts.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(color.bold(`${action.id}: ${result.result.toUpperCase()}`));
          for (const t of result.targets) console.log(`  ${t.ok ? color.green('✓') : color.red('✗')} ${homePath(t.path)}${t.trashedTo ? color.dim(` → ${homePath(t.trashedTo)}`) : ''}${t.error ? color.red(` — ${t.error}`) : ''}`);
          if (result.output) console.log(color.dim(result.output));
          console.log(result.note);
        }
        if (result.result !== 'ok') process.exitCode = 1;
      } catch (err) {
        fail(err instanceof ActionError ? `Refused: ${err.message}` : `Clean-up failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
      console.log(color.dim('Read-only by default (clean-up is opt-in, PD_NO_ACTIONS=1 turns it off) · bound to localhost · Ctrl-C to stop'));
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

/** commander accumulator for repeatable options. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function fail(msg: string): void {
  console.error(color.red(msg));
  process.exitCode = 1;
}

/** Entry point used by the bin shim. */
export async function main(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
