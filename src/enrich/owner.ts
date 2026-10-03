import { basename } from 'node:path';
import type { OwnerAttribution, OwnerExtension } from '../types.js';

interface HostPattern {
  /** Matches `.../<marker>/extensions/<dirname>/...`. */
  re: RegExp;
  host: 'VS Code' | 'Cursor' | null;
  builtin: boolean;
}

// Order matters only for readability — all patterns are tried against every path.
const HOST_PATTERNS: HostPattern[] = [
  { re: /\/\.vscode\/extensions\/([^/]+)\//, host: 'VS Code', builtin: false },
  { re: /\/\.vscode-insiders\/extensions\/([^/]+)\//, host: 'VS Code', builtin: false },
  { re: /\/\.cursor\/extensions\/([^/]+)\//, host: 'Cursor', builtin: false },
  { re: /\/Contents\/Resources\/app\/extensions\/([^/]+)\//, host: null, builtin: true },
];

/** Best-effort host guess for a built-in extension from its containing .app bundle name. */
function hostFromAppBundle(path: string): 'VS Code' | 'Cursor' | null {
  const m = path.match(/\/([^/]+)\.app\//);
  if (!m) return null;
  const bundle = m[1]!;
  if (/cursor/i.test(bundle)) return 'Cursor';
  if (/code/i.test(bundle)) return 'VS Code';
  return null;
}

/** Parse an extension directory name into { id, version }. */
function parseExtDir(dirName: string): { id: string; version: string | null } {
  // Directory names look like "anthropic.claude-code-2.1.218-darwin-arm64".
  // The id is everything before the first "-<digit>" run; the version is the
  // dotted numeric run that follows (platform suffix dropped).
  const m = dirName.match(/^(.*?)-(\d[\d.]*)(?:-.*)?$/);
  if (!m) return { id: dirName, version: null };
  return { id: m[1]!, version: m[2]! };
}

/**
 * PURE. Identify hosted extensions from a process's open file paths.
 * Returns null when nothing matched — the report then omits the section.
 */
export function attributeOwners(paths: string[]): OwnerAttribution | null {
  // dirKey -> accumulated info
  interface Acc {
    id: string;
    version: string | null;
    builtin: boolean;
    host: 'VS Code' | 'Cursor' | null;
    dirPrefix: string; // the matched "..../extensions/<dirname>/" prefix
    files: Set<string>;
  }
  const byKey = new Map<string, Acc>();

  for (const path of paths) {
    for (const { re, host, builtin } of HOST_PATTERNS) {
      const m = path.match(re);
      if (!m) continue;
      const dirName = m[1]!;
      const { id, version } = builtin ? { id: dirName, version: null } : parseExtDir(dirName);
      const dirPrefix = path.slice(0, (m.index ?? 0) + m[0].length);
      const resolvedHost = builtin ? hostFromAppBundle(path) : host;
      const key = `${builtin ? 'builtin' : 'ext'}:${dirPrefix}`;
      let acc = byKey.get(key);
      if (!acc) {
        acc = { id, version, builtin, host: resolvedHost, dirPrefix, files: new Set() };
        byKey.set(key, acc);
      }
      acc.files.add(path);
      break; // first matching pattern wins for this path
    }
  }

  if (byKey.size === 0) return null;

  // Native modules: basenames of every path ending in .node, de-duplicated, sorted.
  const nativeModules = [
    ...new Set(paths.filter((p) => p.endsWith('.node')).map((p) => basename(p))),
  ].sort();

  const extensions: OwnerExtension[] = [...byKey.values()].map((acc) => {
    // Only THIS extension's own modules — attributing the whole process's native
    // modules to every extension would be exactly the kind of misleading evidence
    // this section exists to remove.
    const nativeModuleNames = [
      ...new Set(
        paths
          .filter((p) => p.endsWith('.node') && p.startsWith(acc.dirPrefix))
          .map((p) => basename(p)),
      ),
    ].sort();
    return {
      id: acc.id,
      version: acc.version,
      builtin: acc.builtin,
      fileCount: acc.files.size,
      hasNativeModule: nativeModuleNames.length > 0,
      nativeModuleNames,
    };
  });

  // User-installed extensions first: a bundled extension is present in every VS
  // Code process and is almost never the anomaly, so it must not bury the one
  // extension the user actually chose to install.
  extensions.sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
    if (a.hasNativeModule !== b.hasNativeModule) return a.hasNativeModule ? -1 : 1;
    if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Host detection: whichever of VS Code / Cursor has more attributed paths;
  // ties broken in favour of VS Code. null only when no extension was identified.
  const byHostCount = new Map<string, number>();
  for (const acc of byKey.values()) {
    if (!acc.host) continue;
    byHostCount.set(acc.host, (byHostCount.get(acc.host) ?? 0) + acc.files.size);
  }
  const vsCount = byHostCount.get('VS Code') ?? 0;
  const cursorCount = byHostCount.get('Cursor') ?? 0;
  const host = cursorCount > vsCount ? 'Cursor' : 'VS Code';

  return { host, extensions, nativeModules };
}
