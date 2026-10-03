import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthFinding } from '../../types.js';
import { usrLocalNodeSteps } from '../manual.js';
import { evidence, plural, realFs, runPool, tilde, type FsLike } from '../util.js';

export type NodeOrigin = 'nvm' | 'fnm' | 'volta' | 'asdf' | 'mise' | 'homebrew' | 'pkg' | 'other';

/** Keep only `…/node` lines (a login shell's rc files print noise) and de-duplicate in order. */
export function parseWhichNode(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const p = line.trim();
    if (/^\/.*\/node$/.test(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Where a (real) node path comes from. The runner resolves symlinks first. */
export function classifyNodeOrigin(realPath: string): NodeOrigin {
  if (realPath.includes('/.nvm/')) return 'nvm';
  if (realPath.includes('/.fnm/') || realPath.includes('/fnm_multishells/')) return 'fnm';
  if (realPath.includes('/.volta/')) return 'volta';
  if (realPath.includes('/.asdf/')) return 'asdf';
  if (realPath.includes('/mise/')) return 'mise';
  if (realPath.startsWith('/opt/homebrew/') || realPath.includes('/Cellar/')) return 'homebrew';
  if (realPath === '/usr/local/bin/node') return 'pkg'; // the nodejs.org installer
  return 'other';
}

export interface NodeInstall {
  path: string;
  realPath: string;
  version: string | null;
}

/**
 * Turn the resolved installs into findings (pure). Several versions under one
 * version manager are ONE origin; more than one origin is a PATH conflict.
 */
export function classifyNodeInstalls(
  installs: NodeInstall[],
  pathOrderKnown: boolean,
  home = '',
  whichOutput = '',
): HealthFinding[] {
  if (installs.length === 0) return [];
  const byOrigin = new Map<NodeOrigin, NodeInstall[]>();
  for (const i of installs) {
    const o = classifyNodeOrigin(i.realPath);
    (byOrigin.get(o) ?? byOrigin.set(o, []).get(o)!).push(i);
  }
  const ev = evidence(
    pathOrderKnown ? `${process.env['SHELL'] ?? '/bin/zsh'} -lic '/usr/bin/which -a node'` : 'ls /opt/homebrew/bin/node /usr/local/bin/node',
    whichOutput || installs.map((i) => i.path),
  );

  const winner = installs[0]!;
  const winnerOrigin = classifyNodeOrigin(winner.realPath);
  if (byOrigin.size <= 1) {
    const versions = installs.map((i) => i.version).filter(Boolean);
    return [
      {
        id: 'node-installs',
        checkId: 'node-installs',
        category: 'tooling',
        severity: 'info',
        title: `Node.js: one install (${winnerOrigin}${installs.length > 1 ? `, ${plural(installs.length, 'version')}` : winner.version ? ` ${winner.version}` : ''})`,
        detail: `Every node on PATH comes from ${winnerOrigin}${versions.length ? ` (${versions.join(', ')})` : ''}; there is no conflicting install.`,
        evidence: [ev],
      },
    ];
  }

  const lines = [...byOrigin.entries()].map(
    ([origin, list]) =>
      `${origin}: ${list.map((i) => `${tilde(i.path, home)}${i.version ? ` (${i.version})` : ''}`).join(', ')}`,
  );
  const finding: HealthFinding = {
    id: 'node-installs',
    checkId: 'node-installs',
    category: 'tooling',
    severity: 'warn',
    title: pathOrderKnown
      ? `${byOrigin.size} Node.js installs on PATH (${winnerOrigin} wins${winner.version ? `: ${winner.version}` : ''})`
      : `${byOrigin.size} Node.js installs found (PATH order unknown)`,
    detail: `${lines.join(' · ')}. Which node runs depends on PATH order and on which shell or app starts it, so builds and tools can silently use different versions.`,
    evidence: [ev],
    safety: 'manual',
  };
  if (byOrigin.has('pkg')) finding.manualSteps = usrLocalNodeSteps();
  return [finding];
}

/** Probe for installs (exported with an injectable fs for tests). */
export async function checkNodeInstalls(ctx: HealthContext, fs: FsLike = realFs): Promise<CheckResult> {
  // The app's PATH has no version manager, so ask the user's login shell.
  const shell = process.env['SHELL'] ?? '/bin/zsh';
  const r = await ctx.run(shell, ['-lic', '/usr/bin/which -a node'], 6000);
  let paths = parseWhichNode(r.stdout);
  let pathOrderKnown = true;
  if (paths.length === 0) {
    pathOrderKnown = false;
    paths = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].filter((p) => ctx.exists(p));
  }

  const installs = await runPool(paths, 4, async (path): Promise<NodeInstall> => {
    let realPath = path;
    try {
      realPath = await fs.realpath(path);
    } catch {
      /* dangling symlink: classify the path as given */
    }
    const v = await ctx.run(path, ['--version'], 3000);
    return { path, realPath, version: !v.failed && v.stdout.trim() ? v.stdout.trim() : null };
  });
  return { findings: classifyNodeInstalls(installs, pathOrderKnown, ctx.home, pathOrderKnown ? parseWhichNode(r.stdout).join('\n') : '') };
}

export const nodeInstallsCheck: HealthCheck = {
  id: 'node-installs',
  category: 'tooling',
  scope: 'quick',
  timeoutMs: 12_000,
  run: (ctx) => checkNodeInstalls(ctx),
};
