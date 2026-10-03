import type { RawProcess } from '../types.js';

/** Process names worth flagging as "developer tooling" for `--hot` filtering. */
export const DEV_NAMES = new Set([
  'node', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'deno',
  'vite', 'tsserver', 'eslint', 'esbuild', 'rollup', 'webpack',
  'next', 'nuxt', 'ts-node', 'tsx', 'jest', 'vitest', 'nodemon', 'turbo',
  'claude', 'code', 'electron',
]);

/** Maps a known binary/tool name to a friendly, human description. */
const BIN_LABELS: Record<string, string> = {
  vite: 'Vite dev server',
  next: 'Next.js',
  nuxt: 'Nuxt',
  eslint: 'ESLint',
  tsserver: 'TypeScript language server (tsserver)',
  tsc: 'TypeScript compiler',
  webpack: 'Webpack bundler',
  rollup: 'Rollup bundler',
  esbuild: 'esbuild bundler',
  jest: 'Jest test runner',
  vitest: 'Vitest test runner',
  nodemon: 'nodemon (auto-restart watcher)',
  turbo: 'Turborepo',
  electron: 'Electron app',
  storybook: 'Storybook',
};

/**
 * Pull the resolved binary name out of a command line, e.g. a reference to
 * `node_modules/.bin/vite` or `node_modules/vite/bin/vite.js` -> "vite".
 */
export function detectBin(command: string | null): string | null {
  if (!command) return null;
  const dotBin = command.match(/node_modules\/\.bin\/([\w.-]+)/);
  if (dotBin) return dotBin[1]!;
  const pkgBin = command.match(/node_modules\/(?:@[\w.-]+\/)?([\w.-]+)\/(?:bin|dist|lib)\//);
  if (pkgBin && BIN_LABELS[pkgBin[1]!]) return pkgBin[1]!;
  return null;
}

/** Best friendly label for a process, given its name and any resolved bin. */
export function friendlyLabel(name: string, bin: string | null): string | null {
  if (bin && BIN_LABELS[bin]) return BIN_LABELS[bin];
  const n = name.toLowerCase();
  if (BIN_LABELS[n]) return BIN_LABELS[n];
  if (n === 'claude') return 'Claude Code';
  if (n === 'code') return 'VS Code';
  if (n === 'node') return 'Node.js process';
  if (['npm', 'pnpm', 'yarn', 'npx', 'bun'].includes(n)) return 'Package manager';
  return null;
}

/** Heuristic: is this a developer-tooling process? */
export function isDevProcess(proc: RawProcess): boolean {
  const n = proc.name.toLowerCase();
  if (DEV_NAMES.has(n)) return true;
  const cmd = (proc.command ?? '').toLowerCase();
  if (cmd.includes('node_modules/.bin/')) return true;
  for (const d of DEV_NAMES) {
    if (cmd.includes(`/${d} `) || cmd.endsWith(`/${d}`) || cmd.includes(`/${d}.js`)) {
      return true;
    }
  }
  return false;
}
