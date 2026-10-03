import { describe, expect, it } from 'vitest';
import { collectionStatus, generateReport } from '../src/report/report.js';
import { parentChain, buildTree } from '../src/tree/build.js';
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

function baseEnr(over: Partial<Enrichment> = {}): Enrichment {
  return {
    cwd: null,
    packageJson: null,
    ports: [],
    openFiles: [],
    recentCrashes: [],
    sysHint: null,
    interpretation: { isDev: false, label: null, scriptName: null, resolvedScript: null, bin: null, summary: null },
    ...over,
  };
}

describe('collectionStatus', () => {
  it('reports not collected (click "Sample stack") when stackSample is absent', () => {
    const lines = collectionStatus(baseEnr());
    expect(lines).toContain('stack sample: not collected (click "Sample stack")');
  });

  it('reports attempted — unavailable (<note>) when stackSample.available === false', () => {
    const lines = collectionStatus(
      baseEnr({
        stackSample: {
          available: false,
          cpuBound: null,
          verdict: null,
          topFrames: [],
          threadCount: 0,
          note: 'not permitted',
        },
      }),
    );
    expect(lines).toContain('stack sample: attempted — unavailable (not permitted)');
  });

  it('falls back to a plain "attempted — unavailable" when note is null', () => {
    const lines = collectionStatus(
      baseEnr({
        stackSample: {
          available: false,
          cpuBound: null,
          verdict: null,
          topFrames: [],
          threadCount: 0,
          note: null,
        },
      }),
    );
    expect(lines).toContain('stack sample: attempted — unavailable');
  });

  it('reports collected — none in the last hour for zero crashes', () => {
    const lines = collectionStatus(baseEnr());
    expect(lines).toContain('crashes: collected — none in the last hour');
  });

  it('reports collected — N entries for open files', () => {
    const lines = collectionStatus(baseEnr({ openFiles: [{ type: 'file', path: '/a' }] }));
    expect(lines).toContain('open files: collected — 1 entries');
  });

  it('reports not collected (only gathered for container-runtime processes) for containers when absent', () => {
    const lines = collectionStatus(baseEnr());
    expect(lines).toContain('containers: not collected (only gathered for container-runtime processes)');
  });

  it('reports collected when an on-demand field is present and available', () => {
    const lines = collectionStatus(
      baseEnr({
        readActivity: {
          available: true,
          gapMs: 1500,
          fdsBefore: 1,
          fdsAfter: 1,
          fdsAdded: 0,
          fdsRemoved: 0,
          offsetsAdvanced: 0,
          sampleAdded: [],
          commonDir: null,
          verdict: 'file descriptors idle over this window',
          note: null,
        },
      }),
    );
    expect(lines).toContain('read activity: collected');
  });
});

describe('generateReport — new sections', () => {
  it('always includes a Collection status: block', () => {
    const procs = [proc({ pid: 1, ppid: 0, name: 'launchd' }), proc({ pid: 2, ppid: 1, name: 'node', cpu: 90 })];
    const tree = buildTree(procs);
    const node = tree.byPid.get(2)!;
    const report = generateReport(node, baseEnr());
    expect(report).toContain('Collection status:');
    expect(report).toContain('collected — none in the last hour');
  });

  it('includes a Directory hotspots: block above Open files when dirHotspots is populated', () => {
    const procs = [proc({ pid: 1, ppid: 0, name: 'launchd' }), proc({ pid: 2, ppid: 1, name: 'node', cpu: 90 })];
    const tree = buildTree(procs);
    const node = tree.byPid.get(2)!;
    const enr = baseEnr({
      openFiles: [{ type: 'file', path: '/Users/waldo/.claude/projects/demo/aaa.jsonl' }],
      dirHotspots: [
        {
          dir: '/Users/waldo/.claude/projects/demo',
          fdCount: 24,
          sizeKb: 334848,
          sampleFiles: ['aaa.jsonl', 'bbb.jsonl'],
          dominantExt: 'jsonl',
        },
      ],
    });
    const report = generateReport(node, enr);
    expect(report).toContain('Directory hotspots:');
    expect(report).toContain('mostly .jsonl');
    expect(report).toContain('327.0 MB');
    expect(report.indexOf('Directory hotspots:')).toBeLessThan(report.indexOf('Open files (notable):'));
  });

  it('includes a Hosted extensions: block right after System process:', () => {
    const procs = [proc({ pid: 1, ppid: 0, name: 'launchd' }), proc({ pid: 2, ppid: 1, name: 'node', cpu: 90 })];
    const tree = buildTree(procs);
    const node = tree.byPid.get(2)!;
    const enr = baseEnr({
      owners: {
        host: 'VS Code',
        extensions: [
          { id: 'anthropic.claude-code', version: '2.1.218', builtin: false, fileCount: 1, hasNativeModule: true, nativeModuleNames: ['audio-capture.node'] },
          { id: 'copilot', version: null, builtin: true, fileCount: 1, hasNativeModule: false, nativeModuleNames: [] },
        ],
        nativeModules: ['audio-capture.node'],
      },
    });
    const report = generateReport(node, enr);
    expect(report).toContain('Hosted extensions (VS Code):');
    expect(report).toContain('anthropic.claude-code 2.1.218');
    expect(report).toContain('← native module loaded (audio-capture.node)');
    expect(report).toContain('copilot (built-in)');
  });

  it('includes a Read activity: block only when available', () => {
    const procs = [proc({ pid: 1, ppid: 0, name: 'launchd' }), proc({ pid: 2, ppid: 1, name: 'node', cpu: 90 })];
    const tree = buildTree(procs);
    const node = tree.byPid.get(2)!;
    const enr = baseEnr({
      readActivity: {
        available: true,
        gapMs: 1500,
        fdsBefore: 193,
        fdsAfter: 191,
        fdsAdded: 18,
        fdsRemoved: 20,
        offsetsAdvanced: 4,
        sampleAdded: ['/Users/waldo/.claude/projects/demo/agent-a1403ebc.jsonl'],
        commonDir: '/Users/waldo/.claude/projects/demo',
        verdict: 'churning file handles — actively streaming through many files',
        note: null,
      },
    });
    const report = generateReport(node, enr);
    expect(report).toContain('Read activity (2 lsof snapshots, 1500ms apart):');
    expect(report).toContain('fds: 193 → 191');
    expect(report).toContain('Active under: ~/.claude/projects/demo');
  });
});
