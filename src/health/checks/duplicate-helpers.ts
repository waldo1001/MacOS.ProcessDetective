import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthFinding, RawProcess } from '../../types.js';
import { fmtBytes } from '../../render/format.js';
import { evidence, plural } from '../util.js';

/** Interpreter-hosted helpers only — shells and browser renderers legitimately run many copies. */
const HELPER_NAME = /^(node|python[\d.]*|dotnet|deno|bun|java|ruby)$/;
const MIN_ELAPSED_SECONDS = 600;

export interface HelperGroup {
  key: string;
  label: string;
  members: RawProcess[];
  /** Distinct parent pids, ascending. */
  parents: number[];
}
export interface DuplicateHelpers {
  groups: HelperGroup[];
  /** Group members whose parent is gone (ppid 1) while siblings still have a live parent. */
  orphans: { proc: RawProcess; label: string }[];
}

/**
 * Collapse the parts of a command line that differ between otherwise identical
 * helper copies: npx cache hashes, UUIDs, ports and long numbers.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\/_npx\/[^/\s]+\//g, '/_npx/#/')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '#')
    .replace(/--port[= ]\d+/g, '--port #')
    .replace(/\d{4,}/g, '#');
}

/** Basename of the first path-like argument, else the first non-option argument. */
export function helperLabel(command: string): string {
  const parts = command.trim().split(/\s+/);
  const args = parts.slice(1);
  const pathArg = args.find((a) => !a.startsWith('-') && a.includes('/'));
  const pick = pathArg ?? args.find((a) => !a.startsWith('-')) ?? args[0] ?? parts[0] ?? command;
  const base = pick.replace(/\/+$/, '').split('/').pop();
  return base || pick;
}

/** Find interpreter-hosted helpers that run in 3+ copies under 2+ parents (pure). */
export function findDuplicateHelpers(procs: RawProcess[]): DuplicateHelpers {
  const byKey = new Map<string, RawProcess[]>();
  for (const p of procs) {
    if (p.command == null || p.elapsedSeconds < MIN_ELAPSED_SECONDS) continue;
    if (!HELPER_NAME.test(p.name.toLowerCase())) continue;
    const key = normalizeCommand(p.command);
    (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(p);
  }

  const groups: HelperGroup[] = [];
  const orphans: DuplicateHelpers['orphans'] = [];
  for (const [key, members] of byKey) {
    const parents = [...new Set(members.map((m) => m.ppid))].sort((a, b) => a - b);
    if (members.length < 3 || parents.length < 2) continue;
    const label = helperLabel(members[0]!.command!);
    groups.push({ key, label, members, parents });
    if (members.some((m) => m.ppid !== 1)) {
      for (const m of members) if (m.ppid === 1) orphans.push({ proc: m, label });
    }
  }
  groups.sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
  return { groups, orphans };
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  const { groups, orphans } = findDuplicateHelpers(ctx.processes);
  if (groups.length === 0) return { findings: [] };

  const names = new Map(ctx.processes.map((p) => [p.pid, p.name]));
  const parentText = (pids: number[]): string =>
    pids
      .slice(0, 4)
      .map((pid) => (pid === 1 ? 'launchd' : `${names.get(pid) ?? '?'}(${pid})`))
      .join(', ') + (pids.length > 4 ? ', …' : '');

  const total = groups.reduce((s, g) => s + g.members.length, 0);
  const rssBytes = groups.reduce(
    (s, g) => s + g.members.reduce((a, m) => a + (m.mem / 100) * ctx.system.memory.totalBytes, 0),
    0,
  );
  const findings: HealthFinding[] = [
    {
      id: 'duplicate-helpers',
      checkId: 'duplicate-helpers',
      category: 'processes',
      severity: 'advice',
      title: `${groups.length} ${groups.length === 1 ? 'helper runs' : 'helpers run'} 3+ copies (${plural(total, 'process', 'processes')}, ~${fmtBytes(rssBytes)})`,
      detail:
        'The same interpreter-hosted helper (an MCP server, language server or script) is running several times under different parents. Closing finished IDE and agent sessions releases them; the memory figure is an estimate from the %MEM column.',
      evidence: [
        evidence(
          'ps -axww -o pid=,ppid=,etime=,pmem=,args=   # grouped by normalised command',
          groups.slice(0, 10).map((g) => `${g.members.length} × ${g.label} (parents: ${parentText(g.parents)})`),
        ),
      ],
    },
  ];
  if (orphans.length) {
    findings.push({
      id: 'duplicate-helpers:orphans',
      checkId: 'duplicate-helpers',
      category: 'processes',
      severity: 'warn',
      title: `${plural(orphans.length, 'leaked helper process', 'leaked helper processes')} (parent gone)`,
      detail:
        'These helpers were re-parented to launchd while identical copies still have a live parent: the session that started them ended without stopping them. They keep running and holding memory.',
      evidence: [
        evidence(
          'ps -axww -o pid=,ppid=,etime=,args=   # ppid 1 members of the groups above',
          orphans.slice(0, 12).map((o) => `pid ${o.proc.pid}  ${o.label}`),
        ),
      ],
    });
  }
  return { findings };
}

export const duplicateHelpersCheck: HealthCheck = {
  id: 'duplicate-helpers',
  category: 'processes',
  scope: 'quick',
  timeoutMs: 3000,
  run,
};
