import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enrich, snapshot } from '../service.js';
import { isDevProcess } from '../enrich/classify.js';
import { parentChain } from '../tree/build.js';
import { generateReport } from '../report/report.js';
import { color } from '../util/color.js';
import { fmtPct, friendlyNodeName, homePath, shorten } from './format.js';
import type { Enrichment, ProcessNode, ProcessTree } from '../types.js';

export interface UiOptions {
  threshold: number;
  interval: number;
  devOnly: boolean;
}

interface UiState {
  tree: ProcessTree | null;
  list: ProcessNode[];
  selectedPid: number | null;
  selectedIndex: number;
  threshold: number;
  interval: number;
  devOnly: boolean;
  paused: boolean;
  cache: Map<number, Enrichment>;
  pending: Set<number>;
  toast: string | null;
  toastUntil: number;
  updatedAt: string;
}

// ---- small rendering helpers (visible-width aware) -------------------------

function clip(s: string, w: number): string {
  if (w <= 0) return '';
  if (s.length <= w) return s;
  return `${s.slice(0, Math.max(0, w - 1))}…`;
}
function padClip(s: string, w: number): string {
  return clip(s, w).padEnd(w);
}
function bar(cpu: number, scale: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((cpu / scale) * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

// ---- frame construction ----------------------------------------------------

function buildList(tree: ProcessTree, devOnly: boolean): ProcessNode[] {
  return tree.all
    .filter((n) => !devOnly || isDevProcess(n.proc))
    .sort((a, b) => b.proc.cpu - a.proc.cpu);
}

function rowLine(node: ProcessNode, selected: boolean, scale: number, cols: number, threshold: number): string {
  const p = node.proc;
  const marker = selected ? ' ▸ ' : '   ';
  const pid = String(p.pid).padStart(6);
  const cpu = fmtPct(p.cpu).padStart(7);
  const gauge = `[${bar(p.cpu, scale, 16)}]`;
  const name = padClip(p.name, 14);
  const cmd = friendlyNodeName(node);
  const raw = padClip(`${marker}${pid} ${cpu} ${gauge} ${name} ${cmd}`, cols);

  if (selected) return color.inverse(raw);
  if (p.cpu >= threshold) return color.red(raw);
  if (p.cpu >= threshold / 2) return color.yellow(raw);
  return raw;
}

function detailLines(node: ProcessNode, enr: Enrichment | undefined, cols: number): string[] {
  const p = node.proc;
  const out: string[] = [];
  const head = `${p.name}  PID ${p.pid}  ${fmtPct(p.cpu)} CPU  ${fmtPct(p.mem)} MEM`;
  out.push(color.bold(clip(head, cols)));

  if (!enr) {
    out.push(color.dim('  resolving cwd / ports / package.json …'));
    return out;
  }

  const chain = parentChain(node).map(friendlyNodeName).join(' › ');
  out.push(`${color.dim('chain  ')} ${clip(chain, cols - 9)}`);
  if (enr.interpretation.label) out.push(`${color.dim('is     ')} ${color.cyan(enr.interpretation.label)}`);
  if (enr.packageJson) {
    out.push(`${color.dim('project')} ${clip(enr.packageJson.name ?? homePath(enr.packageJson.dir) ?? '', cols - 9)}`);
  } else if (enr.cwd) {
    out.push(`${color.dim('cwd    ')} ${clip(homePath(enr.cwd) ?? '', cols - 9)}`);
  }
  if (enr.interpretation.scriptName && enr.interpretation.resolvedScript) {
    out.push(`${color.dim('script ')} scripts.${enr.interpretation.scriptName} = ${clip(enr.interpretation.resolvedScript, cols - 24)}`);
  }
  if (enr.ports.length) {
    const ports = enr.ports.map((p2) => `${p2.address}${p2.state ? `(${p2.state})` : ''}`).join('  ');
    out.push(`${color.dim('ports  ')} ${color.green(clip(ports, cols - 9))}`);
  }
  out.push(`${color.dim('cmd    ')} ${clip(shorten(p.command, 200), cols - 9)}`);
  return out;
}

function frame(state: UiState): string {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 24;
  const list = state.list;
  const scale = Math.max(100, list[0]?.proc.cpu ?? 100);

  const selected = state.selectedIndex >= 0 ? list[state.selectedIndex] : undefined;
  const detail = selected
    ? detailLines(selected, state.cache.get(selected.proc.pid), cols)
    : [color.dim('no process selected')];

  const reserved = 3 /*header*/ + 2 /*footer*/ + detail.length + 1 /*sep*/;
  const visible = Math.max(3, rows - reserved);
  const shown = list.slice(0, visible);

  const lines: string[] = [];
  const title = color.bold(' process-detective — live');
  const right = state.updatedAt + (state.paused ? color.yellow('  ⏸ paused') : '');
  lines.push(padClip(' ', 1) + title + ' '.repeat(Math.max(1, cols - 26 - right.length + (state.paused ? 9 : 0))) + color.dim(right));
  lines.push(
    color.dim(
      `  threshold ${state.threshold}%  ·  ${state.devOnly ? 'dev-only' : 'all procs'}  ·  refresh ${state.interval}s  ·  ${list.length} processes`,
    ),
  );
  lines.push('');

  for (let i = 0; i < shown.length; i++) {
    lines.push(rowLine(shown[i]!, i === state.selectedIndex, scale, cols, state.threshold));
  }

  lines.push(color.dim('─'.repeat(cols)));
  for (const d of detail) lines.push(d);

  // footer
  const help = color.dim('  ↑/↓ select · f dev-filter · +/- threshold · p pause · r report→clipboard · q quit');
  if (state.toast && Date.now() < state.toastUntil) {
    lines.push(color.green(clip(`  ${state.toast}`, cols)));
  } else {
    lines.push(help);
  }

  return '\x1b[H\x1b[2J' + lines.map((l) => l + '\x1b[K').join('\n');
}

// ---- side effects ----------------------------------------------------------

function copyToClipboard(text: string): boolean {
  try {
    const p = spawn('pbcopy');
    p.stdin.write(text);
    p.stdin.end();
    return true;
  } catch {
    return false;
  }
}

// ---- main loop -------------------------------------------------------------

/**
 * Interactive full-screen TUI. Built on raw-mode keypresses + ANSI only — no
 * TUI framework. Only the selected process is enriched (lazily, cached), so it
 * stays cheap even with hundreds of processes.
 */
export async function runUi(opts: UiOptions): Promise<void> {
  const state: UiState = {
    tree: null,
    list: [],
    selectedPid: null,
    selectedIndex: 0,
    threshold: opts.threshold,
    interval: opts.interval,
    devOnly: opts.devOnly,
    paused: false,
    cache: new Map(),
    pending: new Set(),
    toast: null,
    toastUntil: 0,
    updatedAt: '',
  };

  const interactive = Boolean(process.stdin.isTTY);

  const reconcile = (): void => {
    if (!state.tree) return;
    state.list = buildList(state.tree, state.devOnly);
    if (state.selectedPid != null) {
      const idx = state.list.findIndex((n) => n.proc.pid === state.selectedPid);
      state.selectedIndex = idx >= 0 ? idx : Math.min(state.selectedIndex, state.list.length - 1);
    }
    if (state.selectedIndex < 0) state.selectedIndex = 0;
    const sel = state.list[state.selectedIndex];
    state.selectedPid = sel ? sel.proc.pid : null;
  };

  const render = (): void => {
    process.stdout.write(frame(state));
  };

  const ensureEnriched = (): void => {
    const sel = state.list[state.selectedIndex];
    if (!sel) return;
    const pid = sel.proc.pid;
    if (state.cache.has(pid) || state.pending.has(pid)) return;
    state.pending.add(pid);
    enrich(sel)
      .then((e) => {
        state.cache.set(pid, e);
      })
      .catch(() => {})
      .finally(() => {
        state.pending.delete(pid);
        render();
      });
  };

  const refresh = async (): Promise<void> => {
    state.tree = await snapshot();
    state.updatedAt = new Date().toLocaleTimeString();
    state.cache.clear(); // CPU/ports drift; re-enrich the selection on demand
    reconcile();
    ensureEnriched();
    render();
  };

  // --- non-interactive fallback (piped output / no TTY): one frame, then exit.
  if (!interactive) {
    await refresh();
    process.stdout.write('\n');
    return;
  }

  // --- enter alternate screen buffer, hide cursor, raw keypresses.
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  await refresh();
  const timer = setInterval(() => {
    if (!state.paused) void refresh();
  }, Math.max(500, opts.interval * 1000));

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      clearInterval(timer);
      process.stdin.setRawMode(false);
      process.stdin.removeListener('keypress', onKey);
      process.stdout.write('\x1b[?25h\x1b[?1049l'); // show cursor, leave alt buffer
      resolve();
    };

    const toast = (msg: string): void => {
      state.toast = msg;
      state.toastUntil = Date.now() + 4000;
      render();
    };

    const onKey = (_str: string, key: readline.Key): void => {
      const name = key?.name ?? '';
      if (name === 'q' || name === 'escape' || (key?.ctrl && name === 'c')) {
        cleanup();
        return;
      }
      switch (name) {
        case 'up':
        case 'k':
          state.selectedIndex = Math.max(0, state.selectedIndex - 1);
          break;
        case 'down':
        case 'j':
          state.selectedIndex = Math.min(state.list.length - 1, state.selectedIndex + 1);
          break;
        case 'g':
          state.selectedIndex = 0;
          break;
        case 'f':
          state.devOnly = !state.devOnly;
          reconcile();
          break;
        case 'p':
          state.paused = !state.paused;
          break;
        case 'r': {
          const sel = state.list[state.selectedIndex];
          if (sel) void emitReport(sel, state, toast);
          break;
        }
        default:
          if (_str === '+' || _str === '=') state.threshold += 10;
          else if (_str === '-' || _str === '_') state.threshold = Math.max(0, state.threshold - 10);
          else return; // ignore, no re-render
      }
      const sel = state.list[state.selectedIndex];
      state.selectedPid = sel ? sel.proc.pid : null;
      ensureEnriched();
      render();
    };

    process.stdin.on('keypress', onKey);
    process.on('SIGINT', cleanup);
  });
}

async function emitReport(
  node: ProcessNode,
  state: UiState,
  toast: (m: string) => void,
): Promise<void> {
  const enr = state.cache.get(node.proc.pid) ?? (await enrich(node));
  const text = generateReport(node, enr);
  const file = join(process.cwd(), `process-detective-report-${node.proc.pid}.txt`);
  try {
    writeFileSync(file, text + '\n');
  } catch {
    /* ignore */
  }
  const copied = copyToClipboard(text);
  toast(`Report for PID ${node.proc.pid} ${copied ? 'copied to clipboard + ' : ''}saved to ${homePath(file)}`);
}
