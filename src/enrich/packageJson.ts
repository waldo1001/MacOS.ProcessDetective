import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PackageJsonInfo } from '../types.js';

/** Parse package.json text into the subset we care about (name + scripts). */
export function parsePackageJson(text: string, path: string): PackageJsonInfo | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  const scripts: Record<string, string> = {};
  if (obj.scripts && typeof obj.scripts === 'object') {
    for (const [k, v] of Object.entries(obj.scripts as Record<string, unknown>)) {
      if (typeof v === 'string') scripts[k] = v;
    }
  }
  return {
    dir: dirname(path),
    path,
    name: typeof obj.name === 'string' ? obj.name : null,
    scripts,
  };
}

/** Read + parse a package.json from disk; null on any I/O or parse error. */
export function readPackageJson(path: string): PackageJsonInfo | null {
  try {
    return parsePackageJson(readFileSync(path, 'utf8'), path);
  } catch {
    return null;
  }
}

/**
 * Walk upward from `startDir` looking for the nearest readable package.json.
 * Returns null if startDir is null or none is found before the filesystem root.
 */
export function findNearestPackageJson(startDir: string | null): PackageJsonInfo | null {
  if (!startDir) return null;
  let dir = startDir;
  const seen = new Set<string>();
  while (dir && !seen.has(dir)) {
    seen.add(dir);
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const info = readPackageJson(candidate);
      if (info) return info;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Given a command line and a package's scripts, work out which npm/yarn/pnpm/bun
 * script (if any) it is running. Returns the script name (e.g. "dev") or null.
 *
 *   npm run dev / npm run-script dev   -> "dev"
 *   pnpm dev / bun dev                 -> "dev"  (only if scripts.dev exists)
 *   yarn dev / yarn run dev            -> "dev"
 */
export function resolveScriptName(
  command: string | null,
  scripts: Record<string, string>,
): string | null {
  if (!command) return null;
  const toks = command.split(/\s+/).filter(Boolean);
  const idx = toks.findIndex((t) => /(^|\/)(npm|pnpm|yarn|bun)$/.test(t));
  if (idx < 0) return null;
  const pm = (toks[idx]!.split('/').pop() ?? '').toLowerCase();
  const rest = toks.slice(idx + 1).filter((t) => !t.startsWith('-'));
  if (rest.length === 0) return null;

  if (rest[0] === 'run' || rest[0] === 'run-script') {
    return rest[1] ?? null;
  }
  // Shorthand `yarn dev` / `pnpm dev` / `bun dev` — only valid if the script exists.
  if (pm !== 'npm') {
    return rest[0] && scripts[rest[0]] ? rest[0] : null;
  }
  return null;
}
