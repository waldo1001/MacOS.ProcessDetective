import { describe, expect, it } from 'vitest';
import { detectBin, friendlyLabel, isDevProcess } from '../src/enrich/classify.js';
import { interpret } from '../src/enrich/interpret.js';
import { parsePackageJson } from '../src/enrich/packageJson.js';
import { parentChain, buildTree } from '../src/tree/build.js';
import { generateReport } from '../src/report/report.js';
import { buildInvestigationPrompt } from '../src/report/prompt.js';
import type { Enrichment, RawProcess } from '../src/types.js';

function proc(over: Partial<RawProcess>): RawProcess {
  return {
    pid: 1,
    ppid: 0,
    cpu: 0,
    mem: 0,
    elapsedSeconds: 0,
    elapsedRaw: '00:00',
    user: 'waldo',
    execPath: null,
    name: 'node',
    command: null,
    ...over,
  };
}

describe('classify', () => {
  it('detects dev processes by name and by .bin path', () => {
    expect(isDevProcess(proc({ name: 'vite' }))).toBe(true);
    expect(isDevProcess(proc({ name: 'sleep', command: 'sleep 100' }))).toBe(false);
    expect(
      isDevProcess(proc({ name: 'node', command: 'node /r/node_modules/.bin/eslint .' })),
    ).toBe(true);
  });

  it('detects the resolved bin from a command line', () => {
    expect(detectBin('node /repo/node_modules/.bin/vite --host')).toBe('vite');
    expect(detectBin('node /repo/node_modules/vite/bin/vite.js')).toBe('vite');
    expect(detectBin('node server.js')).toBeNull();
  });

  it('labels known tools', () => {
    expect(friendlyLabel('node', 'vite')).toBe('Vite dev server');
    expect(friendlyLabel('claude', null)).toBe('Claude Code');
  });
});

describe('interpret', () => {
  it('resolves an npm script to its body and a friendly label', () => {
    const pkg = parsePackageJson(
      JSON.stringify({ name: 'customer-x', scripts: { dev: 'vite --host 0.0.0.0' } }),
      '/repo/package.json',
    )!;
    const i = interpret(proc({ name: 'npm', command: 'npm run dev' }), pkg);
    expect(i.scriptName).toBe('dev');
    expect(i.resolvedScript).toBe('vite --host 0.0.0.0');
    expect(i.bin).toBe('vite');
    expect(i.label).toBe('Vite dev server');
    expect(i.summary).toContain('customer-x');
  });
});

describe('generateReport', () => {
  it('produces a readable diagnostic that names the launcher and script', () => {
    const procs = [
      proc({ pid: 1, ppid: 0, name: 'launchd', execPath: '/sbin/launchd' }),
      proc({ pid: 100, ppid: 1, name: 'claude', execPath: '/Applications/Claude.app/Contents/MacOS/Claude' }),
      proc({ pid: 200, ppid: 100, name: 'zsh' }),
      proc({ pid: 300, ppid: 200, name: 'npm', command: 'npm run dev' }),
      proc({ pid: 400, ppid: 300, name: 'node', cpu: 183, command: 'node /repo/node_modules/.bin/vite --host 0.0.0.0' }),
    ];
    const tree = buildTree(procs);
    const node = tree.byPid.get(400)!;
    expect(parentChain(node).map((n) => n.proc.name)).toEqual([
      'launchd', 'claude', 'zsh', 'npm', 'node',
    ]);

    const enr: Enrichment = {
      cwd: '/Users/waldo/repos/customer-x',
      packageJson: parsePackageJson(
        JSON.stringify({ name: 'customer-x', scripts: { dev: 'vite --host 0.0.0.0' } }),
        '/Users/waldo/repos/customer-x/package.json',
      ),
      ports: [{ protocol: 'TCP', address: '127.0.0.1:5173', state: 'LISTEN' }],
      openFiles: [],
      recentCrashes: [],
      sysHint: null,
      interpretation: interpret(node.proc, null),
    };
    // Re-interpret against the package so the report has script info.
    enr.interpretation = interpret(
      proc({ name: 'npm', command: 'npm run dev' }),
      enr.packageJson,
    );

    const report = generateReport(node, enr);
    expect(report).toContain('CPU spike investigation');
    expect(report).toContain('node PID 400, 183.0% CPU');
    expect(report).toContain('vite --host 0.0.0.0');
    expect(report).toContain('127.0.0.1:5173 (LISTEN)');
    expect(report).toMatch(/Claude/); // launcher named in root cause / chain

    // The investigation prompt wraps the same report with the question set.
    const prompt = buildInvestigationPrompt(node, enr);
    expect(prompt).toContain('What this process almost certainly is');
    expect(prompt).toContain('process snapshot');
    expect(prompt).toContain(report);
  });
});
