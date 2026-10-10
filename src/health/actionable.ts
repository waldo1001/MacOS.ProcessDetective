import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClutterItem, HealthFinding } from '../types.js';
import { CLUTTER_CATALOG, type ClutterEntry } from './catalog.js';

/**
 * Which report items the clean-up layer may ever touch. Everything here is PURE (the
 * environment and the file system are injectable), so the rules that decide what can be
 * moved to the Trash are unit-tested without a single real path.
 */

const MIB = 1024 ** 2;

/** Id of the extra survey entry that exists only while PD_ACTIONS_SANDBOX is set. */
export const SANDBOX_ENTRY_ID = 'sandbox';

// ---------------------------------------------------------------------------
// Kill-switch and sandbox (environment)
// ---------------------------------------------------------------------------

export interface ActionsConfig {
  enabled: boolean;
  /** Why actions are off (a short sentence fragment, shown to the user). */
  reason?: string;
  /** Normalized absolute sandbox directory, or null when no sandbox is configured. */
  sandbox: string | null;
}

export interface ConfigProbe {
  isDir(p: string): boolean;
  realpath(p: string): string;
}
const realProbe: ConfigProbe = {
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  realpath: (p) => realpathSync(p),
};

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);
/** `child` is `parent` or lies below it (lexical; callers resolve real paths first). */
export const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(`${trimSlash(parent)}/`);

/**
 * The kill-switch (PD_NO_ACTIONS=1) and the sandbox (PD_ACTIONS_SANDBOX=<dir>).
 * Fails closed: a sandbox that is set but is not an absolute, existing directory — or that
 * is the file system root, a top-level folder, or the home folder or one of its parents —
 * turns every action off instead of being ignored.
 */
export function actionsConfig(
  env: NodeJS.ProcessEnv = process.env,
  probe: ConfigProbe = realProbe,
  home: string = os.homedir(),
): ActionsConfig {
  if (env['PD_NO_ACTIONS'] === '1') return { enabled: false, reason: 'PD_NO_ACTIONS=1', sandbox: null };
  const raw = env['PD_ACTIONS_SANDBOX'];
  if (raw === undefined) return { enabled: true, sandbox: null };

  const bad = (why: string): ActionsConfig => ({ enabled: false, reason: `PD_ACTIONS_SANDBOX ${why}`, sandbox: null });
  if (raw === '' || raw.includes('\0') || !path.isAbsolute(raw)) return bad('is not an absolute path');
  const dir = path.resolve(raw);
  if (dir.split('/').filter(Boolean).length < 2) return bad('is too close to the file system root');
  if (!probe.isDir(dir)) return bad('is not an existing directory');
  try {
    const real = probe.realpath(dir);
    const realHome = probe.realpath(home);
    if (isInside(realHome, real) || isInside(home, dir)) return bad('contains your home folder');
  } catch {
    return bad('could not be resolved');
  }
  return { enabled: true, sandbox: dir };
}

/** The survey catalog plus, while a sandbox is configured, one extra entry that lists its children. */
export function effectiveCatalog(sandbox: string | null = actionsConfig().sandbox): ClutterEntry[] {
  if (!sandbox) return CLUTTER_CATALOG;
  return [
    ...CLUTTER_CATALOG,
    {
      id: SANDBOX_ENTRY_ID, title: 'Actions sandbox', kind: 'children', base: sandbox,
      safety: 'regenerates', regenNote: 'throw-away test data for the clean-up layer', minBytes: MIB,
    },
  ];
}

// ---------------------------------------------------------------------------
// Shape rules
// ---------------------------------------------------------------------------

export type Actionable = { ok: true; root: string } | { ok: false; reason: string };

const CLEANABLE = new Set<string>(['regenerates', 'orphan', 'ask']);
const expand = (base: string, home: string): string => (base.startsWith('~/') ? home + base.slice(1) : base);
const no = (reason: string): Actionable => ({ ok: false, reason });

/** The catalog entry behind a `disk-clutter` finding (its id is the entry id), if any. */
export function clutterEntryFor(finding: HealthFinding, sandbox: string | null = null): ClutterEntry | undefined {
  return finding.checkId === 'disk-clutter' ? effectiveCatalog(sandbox).find((e) => e.id === finding.id) : undefined;
}

/**
 * May this item of this finding be moved to the Trash, and which directory is its root?
 * `root` is the directory the shape rule names; the caller re-checks, on disk, that the
 * item still resolves inside it.
 */
export function checkActionable(
  finding: HealthFinding,
  item: ClutterItem,
  home: string,
  sandbox: string | null = null,
): Actionable {
  if (!CLEANABLE.has(item.safety)) return no(`${item.safety} items are never cleaned`);
  const p = item.path;
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return no('the path is not absolute');
  if (p.split('/').includes('..')) return no('the path contains ".."');
  // A trailing slash is refused on purpose: lstat("link/") follows the link, which would hide a symlink.
  if (path.normalize(p) !== p || p.endsWith('/')) return no('the path is not normalized');

  // The sandbox entry is the one exemption from the home-folder rules: its items sit directly in the sandbox.
  if (sandbox && finding.checkId === 'disk-clutter' && finding.id === SANDBOX_ENTRY_ID) {
    return path.dirname(p) === sandbox ? { ok: true, root: sandbox } : no('not directly inside the sandbox');
  }

  const h = trimSlash(home);
  if (!path.isAbsolute(h) || h.split('/').filter(Boolean).length < 2) return no('the home folder is unknown');
  if (!p.startsWith(`${h}/`)) return no('outside your home folder');
  const rel = p.slice(h.length + 1).split('/');
  if (rel.length < (rel[0] === 'Library' ? 3 : 2)) return no('too close to the top of your home folder');

  if (finding.checkId === 'runaway-logs') {
    const logs = `${h}/Library/Logs`;
    const depth = p.startsWith(`${logs}/`) ? p.slice(logs.length + 1).split('/').length : 0;
    return depth >= 1 && depth <= 3 ? { ok: true, root: logs } : no('not a log file under ~/Library/Logs');
  }

  if (finding.checkId === 'launch-agents') {
    const dir = `${h}/Library/LaunchAgents`;
    if (path.dirname(p) !== dir) return no('not directly inside ~/Library/LaunchAgents');
    if (path.basename(p).toLowerCase().endsWith('.plist')) return no('a .plist is a live launchd job, never cleaned');
    return { ok: true, root: dir };
  }

  if (finding.checkId === 'disk-clutter') {
    const entry = clutterEntryFor(finding, sandbox);
    if (!entry) return no('not a catalog entry');
    if (entry.noTrash) return no(`${entry.title} are managed by their own tool and never moved to the Trash`);
    const name = path.basename(p);
    switch (entry.kind) {
      case 'path': {
        const base = expand(entry.base, h);
        return p === base ? { ok: true, root: path.dirname(base) } : no('not the catalog folder itself');
      }
      case 'children':
      case 'files': {
        const base = expand(entry.base, h);
        if (path.dirname(p) !== base) return no(`not directly inside ${entry.base}`);
        if (entry.match && !entry.match.test(name)) return no('the name does not match the catalog entry');
        if (entry.exclude && entry.exclude.test(name)) return no('the name is excluded from the catalog entry');
        return { ok: true, root: base };
      }
      case 'worktrees':
        return /\/\.claude\/worktrees\/[^/]+$/.test(p) ? { ok: true, root: path.dirname(p) } : no('not a .claude/worktrees folder');
      case 'devops-agents': {
        const m = p.match(/^(.*)\/([^/]+)\/_work$/);
        return m && m[1] === h ? { ok: true, root: path.dirname(p) } : no('not an agent _work folder directly under your home');
      }
    }
  }
  return no('this finding is not a clean-up candidate');
}

/** Pure yes/no form of {@link checkActionable}. */
export function isActionable(finding: HealthFinding, item: ClutterItem, home: string, sandbox: string | null = null): boolean {
  return checkActionable(finding, item, home, sandbox).ok;
}

/** The directory an actionable item must still resolve inside, or null when it is not actionable. */
export function actionRootFor(finding: HealthFinding, item: ClutterItem, home: string, sandbox: string | null = null): string | null {
  const a = checkActionable(finding, item, home, sandbox);
  return a.ok ? a.root : null;
}

/**
 * Copy the findings with `item.actionable` set on exactly the items that pass {@link isActionable}.
 * Never mutates its input — cached findings are shared objects and must not persist the flag.
 */
export function stampActionable(findings: HealthFinding[], home: string, sandbox: string | null, enabled = true): HealthFinding[] {
  return findings.map((f) => {
    if (!f.items) return f;
    const items = f.items.map((it): ClutterItem => {
      const { actionable: _drop, ...rest } = it;
      return enabled && isActionable(f, it, home, sandbox) ? { ...rest, actionable: true } : rest;
    });
    return { ...f, items };
  });
}
