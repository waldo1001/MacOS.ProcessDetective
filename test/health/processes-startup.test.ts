import { describe, expect, it } from 'vitest';
import {
  duplicateHelpersCheck, findDuplicateHelpers, helperLabel, normalizeCommand,
} from '../../src/health/checks/duplicate-helpers.js';
import { checkLaunchAgents, isDanglingProgram } from '../../src/health/checks/launch-agents.js';
import {
  checkRunawayLogs, classifyLogGroup, dominantLine, logOwner, repetitionRatio, type LogFile,
} from '../../src/health/checks/runaway-logs.js';
import { fail, fakeContext, fakeFs, fixture, NOW, ok, proc, scriptedRun } from './helpers.js';

describe('findDuplicateHelpers', () => {
  const node = (pid: number, ppid: number, command = 'node /Users/x/.npm/_npx/abc123/node_modules/.bin/mcp-server --port 3001') =>
    proc({ pid, ppid, command });

  it('4 identical node helpers under 3 parents form one group', () => {
    const r = findDuplicateHelpers([node(1, 10), node(2, 10), node(3, 11), node(4, 12)]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.members).toHaveLength(4);
    expect(r.groups[0]!.parents).toEqual([10, 11, 12]);
    expect(r.groups[0]!.label).toBe('mcp-server');
    expect(r.orphans).toEqual([]);
  });

  it('a member re-parented to launchd while siblings still have a parent is an orphan', () => {
    const r = findDuplicateHelpers([node(1, 10), node(2, 1), node(3, 11), node(4, 12)]);
    expect(r.orphans.map((o) => o.proc.pid)).toEqual([2]);
  });

  it('ignores shells: 5 identical zsh are not helpers', () => {
    const zsh = (pid: number, ppid: number) => proc({ pid, ppid, name: 'zsh', command: '-zsh' });
    expect(findDuplicateHelpers([zsh(1, 10), zsh(2, 11), zsh(3, 12), zsh(4, 13), zsh(5, 14)]).groups).toEqual([]);
  });

  it('ignores members younger than 10 minutes and groups under a single parent', () => {
    const young = (pid: number, ppid: number) => proc({ pid, ppid, elapsedSeconds: 599, command: 'node /srv/a.js' });
    expect(findDuplicateHelpers([young(1, 10), young(2, 11), young(3, 12)]).groups).toEqual([]);
    expect(findDuplicateHelpers([node(1, 10), node(2, 10), node(3, 10)]).groups).toEqual([]);
  });

  it('/_npx/<hash>/ variants fall into one group; other paths do not', () => {
    const a = (pid: number, ppid: number, hash: string) =>
      proc({ pid, ppid, command: `node /Users/x/.npm/_npx/${hash}/node_modules/.bin/mcp-x` });
    const r = findDuplicateHelpers([a(1, 10, 'aaa111'), a(2, 11, 'bbb222'), a(3, 12, 'ccc333'), proc({ pid: 4, ppid: 13, command: 'node /other/thing.js' })]);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.members).toHaveLength(3);
  });

  it('normalizes ports, UUIDs and long numbers; labels by the first path argument', () => {
    expect(normalizeCommand('node s.js --port 8080')).toBe('node s.js --port #');
    expect(normalizeCommand('node s.js --port=80')).toBe('node s.js --port #');
    expect(normalizeCommand('node s.js 11111111-2222-3333-4444-555555555555 12345')).toBe('node s.js # #');
    expect(helperLabel('node --inspect /a/b/server.js --x')).toBe('server.js');
    expect(helperLabel('python3 -m http.server')).toBe('http.server');
    expect(helperLabel('node')).toBe('node');
  });

  it('check: one advice, plus one warn only when orphans exist; never leaks arguments', async () => {
    const procs = [node(1, 10), node(2, 1), node(3, 11), node(4, 12)];
    const r = await duplicateHelpersCheck.run(fakeContext({ processes: procs }));
    expect(r.findings.map((f) => [f.id, f.severity])).toEqual([
      ['duplicate-helpers', 'advice'],
      ['duplicate-helpers:orphans', 'warn'],
    ]);
    expect(r.findings[0]!.title).toMatch(/^1 helper runs 3\+ copies \(4 processes, ~/);
    expect(JSON.stringify(r.findings)).not.toContain('--port');
    const none = await duplicateHelpersCheck.run(fakeContext({ processes: [node(1, 10)] }));
    expect(none.findings).toEqual([]);
  });
});

describe('launch-agents', () => {
  const plist = (dir: string, name: string) => `${dir}/${name}`;
  const userDir = '/Users/test/Library/LaunchAgents';
  const tree = fakeFs({
    [userDir]: { kind: 'dir', children: ['com.ok.plist', 'com.gone.plist', 'com.rel.plist', 'com.none.plist', 'old.plist.bak', '.DS_Store'] },
    '/Library/LaunchAgents': { kind: 'dir', children: [] },
    '/Library/LaunchDaemons': { kind: 'dir', children: ['com.sys.gone.plist'] },
    [`${userDir}/old.plist.bak`]: { kind: 'file', blocks: 8 },
    [`${userDir}/.DS_Store`]: { kind: 'file', blocks: 8 },
  });
  const programs: Record<string, string | null> = {
    [plist(userDir, 'com.ok.plist')]: '/bin/ls',
    [plist(userDir, 'com.gone.plist')]: '/Applications/Gone.app/Contents/MacOS/Gone',
    [plist(userDir, 'com.rel.plist')]: 'relative/prog',
    [plist(userDir, 'com.none.plist')]: null,
    '/Library/LaunchDaemons/com.sys.gone.plist': '/Library/PrivilegedHelperTools/gone',
  };
  const run = (async (_cmd: string, args: string[]) => {
    const file = args[args.length - 1]!;
    const key = args[1];
    const prog = programs[file];
    if (prog && key === 'Program') return ok(`${prog}\n`);
    return fail('', 'no such key');
  }) as ReturnType<typeof scriptedRun>;

  it('flags only absolute programs that no longer exist; relative and missing keys are silent', async () => {
    const ctx = fakeContext({ run, exists: (p) => p === '/bin/ls' });
    const r = await checkLaunchAgents(ctx, tree);
    const warns = r.findings.filter((f) => f.severity === 'warn');
    expect(warns.map((f) => f.id).sort()).toEqual(['launch-agents:com-gone', 'launch-agents:com-sys-gone']);
    expect(warns.every((f) => f.safety === 'orphan' && f.category === 'startup')).toBe(true);
    expect(warns.find((f) => f.id === 'launch-agents:com-sys-gone')!.title).toContain('LaunchDaemon');
    expect(warns.find((f) => f.id === 'launch-agents:com-sys-gone')!.manualSteps!.join('\n')).toContain('/Library/LaunchDaemons');
    expect(warns.find((f) => f.id === 'launch-agents:com-gone')!.manualSteps!.join('\n')).toContain('launchctl bootout gui/');
  });

  it('lists stray non-plist files as orphan items in one info finding', async () => {
    const r = await checkLaunchAgents(fakeContext({ run, exists: () => true }), tree);
    const info = r.findings.find((f) => f.id === 'launch-agents:stray-files')!;
    expect(info.severity).toBe('info');
    expect(info.items!.map((i) => i.path)).toEqual([`${userDir}/old.plist.bak`]); // dotfiles are not strays
    expect(info.items![0]!.safety).toBe('orphan');
    expect(r.findings.filter((f) => f.severity === 'warn')).toEqual([]);
  });

  it('isDanglingProgram', () => {
    expect(isDanglingProgram('/nope', () => false)).toBe(true);
    expect(isDanglingProgram('/yes', () => true)).toBe(false);
    expect(isDanglingProgram('relative', () => false)).toBe(false);
  });
});

describe('runaway-logs', () => {
  const runaway = fixture('runaway-log-tail.txt');
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima',
    'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray', 'yankee', 'zulu',
    'amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'glade', 'harbor', 'iris', 'jade', 'kelp', 'lotus', 'maple', 'nectar'];
  const varied = Array.from({ length: 120 }, (_, i) => `2026-10-02T15:${String(i % 60).padStart(2, '0')}:00 Info ${words[i % 40]}: cache ${words[(i * 7) % 40]} finished in ${i} ms`).join('\n');

  it('repetitionRatio: >= 0.8 for the runaway tail, < 0.3 for a varied log, 0 below 50 lines', () => {
    expect(repetitionRatio(runaway)).toBeGreaterThanOrEqual(0.8);
    expect(repetitionRatio(varied)).toBeLessThan(0.3);
    expect(repetitionRatio(runaway.split('\n').slice(0, 40).join('\n'))).toBe(0);
    expect(repetitionRatio('')).toBe(0);
  });

  it('quotes the dominant normalized line', () => {
    expect(dominantLine(runaway)!.line).toBe('Info AppClient: Trying to connect to port #...');
    expect(dominantLine(runaway)!.count).toBe(200);
  });

  it('classifies a folder: warn over 500 MiB or repetitive, risk when still growing', () => {
    const f = (bytes: number, ratio: number, ageMin: number): LogFile => ({ path: '/x', bytes, ratio, mtimeMs: NOW - ageMin * 60_000, dominant: null });
    const MIB = 1024 ** 2;
    expect(classifyLogGroup([f(300 * MIB, 0.1, 600)], NOW)).toBeNull();
    expect(classifyLogGroup([f(600 * MIB, 0.1, 600)], NOW)).toBe('warn');
    expect(classifyLogGroup([f(300 * MIB, 0.9, 600)], NOW)).toBe('warn');
    expect(classifyLogGroup([f(300 * MIB, 0.9, 5)], NOW)).toBe('risk');
  });

  it('owner names come from a small map, unknown folders use their own name', () => {
    expect(logOwner('ElgatoStreamDeck')).toBe('Stream Deck');
    expect(logOwner('SomethingElse')).toBe('SomethingElse');
  });

  it('check: groups files by folder and reports a runaway Stream Deck log as a risk while it grows', async () => {
    const root = '/Users/test/Library/Logs/ElgatoStreamDeck';
    const files = ['a.log', 'b.log'].map((n) => `${root}/${n}`);
    const fs = fakeFs(Object.fromEntries(files.map((p) => [p, { kind: 'file' as const, blocks: (1.5 * 1024 ** 3) / 512, mtimeMs: NOW - 120_000 }])));
    const run = scriptedRun([
      ['find /Users/test/Library/Logs', ok(`${files.join('\n')}\n`)],
      ['tail -n 2000', ok(runaway)],
    ]);
    const r = await checkRunawayLogs(fakeContext({ run }), fs);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.id).toBe('runaway-logs:elgatostreamdeck');
    expect(f.severity).toBe('risk');
    expect(f.category).toBe('stability');
    expect(f.title).toBe('Stream Deck is writing a runaway log (3.0 GB, 2 files)');
    expect(f.detail).toContain('Trying to connect to port #');
    expect(f.items!.map((i) => i.safety)).toEqual(['regenerates', 'regenerates']);
    expect(f.reclaimableBytes).toBe(3 * 1024 ** 3);
  });

  it('no big files: no finding; a failed find with no output is skipped, not "clean"', async () => {
    expect((await checkRunawayLogs(fakeContext({ run: async () => ok('') }), fakeFs({}))).findings).toEqual([]);
    await expect(checkRunawayLogs(fakeContext({ run: async () => fail('', '') }), fakeFs({}))).rejects.toThrow(/timed out/);
  });
});
