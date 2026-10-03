import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthFinding } from '../../types.js';
import { loginItemSteps } from '../manual.js';
import { evidence, plural, slug } from '../util.js';

export interface BtmItem {
  uid: number;
  name: string;
  developer: string | null;
  type: string;            // 'app', 'user item', 'login item', 'agent', 'legacy agent', … (no "(0x…)")
  enabled: boolean;        // Disposition starts with "[enabled"
  url: string | null;      // raw
  path: string | null;     // decoded absolute path when url is file:// (trailing "/" stripped)
  identifier: string | null;
}

const KV = /^\s+([A-Za-z][A-Za-z. ]*?):\s(.*)$/;

function nullable(v: string | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' || t === '(null)' ? null : t;
}

/** Decode a `file://` URL into an absolute path (no trailing slash); null for anything else. */
export function fileUrlToPath(url: string | null): string | null {
  if (!url || !url.startsWith('file://')) return null;
  let p = url.slice('file://'.length);
  if (!p.startsWith('/')) p = p.slice(p.indexOf('/')); // file://localhost/…
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep the raw text */
  }
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/**
 * Parse `sfltool dumpbtm`. Sections start with ` Records for UID <n> :`; item
 * headers are a bare `#<n>:` line — `#1: 16.com.x` inside "Embedded Item
 * Identifiers" has text after the colon and is NOT an item.
 */
export function parseBtm(text: string): BtmItem[] {
  const items: BtmItem[] = [];
  let uid = 0;
  let cur: Record<string, string> | null = null;
  const flush = (): void => {
    if (!cur) return;
    const url = nullable(cur['URL']);
    const typeRaw = (cur['Type'] ?? '').replace(/\s*\(0x[0-9a-f]+\)\s*$/i, '').trim();
    items.push({
      uid: Number(cur['__uid']),
      name: cur['Name'] ?? '',
      developer: nullable(cur['Developer Name']),
      type: typeRaw,
      enabled: (cur['Disposition'] ?? '').trimStart().startsWith('[enabled'),
      url,
      path: fileUrlToPath(url),
      identifier: nullable(cur['Identifier']),
    });
    cur = null;
  };

  for (const line of text.split('\n')) {
    const section = line.match(/^\s*Records for UID (-?\d+)\s*:/);
    if (section) {
      flush();
      uid = parseInt(section[1]!, 10);
      continue;
    }
    if (/^#\d+:$/.test(line.trim())) {
      flush();
      cur = { __uid: String(uid) };
      continue;
    }
    if (!cur) continue;
    const kv = line.match(KV);
    if (kv && !(kv[1]! in cur)) cur[kv[1]!] = kv[2]!.trim();
  }
  flush();
  return items;
}

const LOGIN_TYPES = new Set(['app', 'user item']);
const AGENT_TYPES = new Set(['agent', 'daemon', 'legacy agent', 'legacy daemon']);

/** Classify the user's login items and summarise background items (pure). */
export function classifyLoginItems(items: BtmItem[], uid: number, exists: (p: string) => boolean): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const used = new Set<string>();
  const uniqueId = (base: string): string => {
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };

  const login = items.filter((i) => i.uid === uid && i.enabled && LOGIN_TYPES.has(i.type));
  for (const it of login) {
    const ev = [
      evidence('sfltool dumpbtm', [`Name: ${it.name}`, `Type: ${it.type}`, `URL: ${it.url ?? '(none)'}`]),
    ];
    const id = uniqueId(`login-items:${slug(it.name)}`);
    if (it.path && it.path.includes('/.Trash/')) {
      findings.push({
        id,
        checkId: 'login-items',
        category: 'startup',
        severity: 'warn',
        title: `Login item “${it.name}” points into the Trash`,
        detail: `${it.name} is still registered to open at login, but its app is in the Trash (${it.path}). Remove the entry so macOS stops trying to launch it.`,
        evidence: ev,
        safety: 'orphan',
        manualSteps: loginItemSteps(it.name),
      });
    } else if (it.path && !exists(it.path)) {
      findings.push({
        id,
        checkId: 'login-items',
        category: 'startup',
        severity: 'warn',
        title: `Login item “${it.name}” points at an app that no longer exists`,
        detail: `${it.name} is registered to open at login, but ${it.path} is gone. Remove the entry so macOS stops trying to launch it.`,
        evidence: ev,
        safety: 'orphan',
        manualSteps: loginItemSteps(it.name),
      });
    } else if (it.path && /\/node_modules\/|\/Temp\/|\/tmp\//.test(it.path)) {
      findings.push({
        id,
        checkId: 'login-items',
        category: 'startup',
        severity: 'advice',
        title: `Login item “${it.name}” is a dev build registered as a login item`,
        detail: `${it.name} launches from ${it.path}, a development or temporary location. It will break when that folder is cleaned up.`,
        evidence: ev,
        manualSteps: loginItemSteps(it.name),
      });
    }
  }

  const agentUids = new Set([uid, 0, -2]);
  const agents = new Map<string, BtmItem>();
  for (const it of items) {
    if (it.enabled && agentUids.has(it.uid) && AGENT_TYPES.has(it.type)) {
      agents.set(it.identifier ?? `${it.uid}:${it.name}`, it);
    }
  }
  const legacy = [...agents.values()].filter((a) => a.type.startsWith('legacy')).length;
  findings.push({
    id: 'login-items',
    checkId: 'login-items',
    category: 'startup',
    severity: 'info',
    title: `${plural(login.length, 'login item')} · ${agents.size} background agents/daemons enabled (${legacy} legacy)`,
    detail:
      'Login items open at login; background agents and daemons are launchd jobs registered by apps. Read from the Background Task Management database, the same source System Settings uses.',
    evidence: [evidence('sfltool dumpbtm', `${login.length} login items, ${agents.size} agents/daemons (${legacy} legacy)`)],
  });
  return findings;
}

async function run(ctx: HealthContext): Promise<CheckResult> {
  // The BTM dump lists every login item (same data as System Settings), but the tool
  // asks macOS for the admin right on EVERY run: a Touch ID / password dialog. That is
  // why this check is on demand (optIn) and waits a full minute for the user to answer.
  if (process.env['PD_NO_ELEVATED'] === '1') {
    throw new Error('disabled (PD_NO_ELEVATED=1) — this check needs the macOS authorization dialog');
  }
  const r = await ctx.run('/usr/bin/sfltool', ['dumpbtm'], 60_000);
  if (!r.stdout.includes('Records for UID')) {
    throw new Error(
      `sfltool dumpbtm gave no records (${r.stderr.trim().split('\n')[0] || 'the authorization dialog was cancelled or not answered within 60 s'})`,
    );
  }
  return { findings: classifyLoginItems(parseBtm(r.stdout), ctx.uid, ctx.exists) };
}

export const loginItemsCheck: HealthCheck = {
  id: 'login-items',
  category: 'startup',
  scope: 'quick',
  optIn: {
    label: 'Check login items',
    note: 'macOS asks for Touch ID or your password each time — the background-items database is admin-only',
  },
  timeoutMs: 65_000,
  run,
};
