import { describe, expect, it } from 'vitest';
import { parseAgentFile, parseDuK, surveyClutter } from '../../src/health/checks/disk-clutter.js';
import { APP_SUPPORT_OWNERS, CLUTTER_CATALOG, classifyAppSupport, type ClutterEntry } from '../../src/health/catalog.js';
import { fail, fakeContext, fakeFs, fixture, NOW, ok, proc, scriptedRun } from './helpers.js';

const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

describe('parseDuK', () => {
  it('returns kb and path; the du error line and noise are ignored', () => {
    const rows = parseDuK(fixture('du-k-d1.txt'));
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ kb: 1310720, path: '/Users/test/Library/Caches/com.apple.Safari' });
    expect(rows[0]!.kb * KIB).toBe(1310720 * 1024);
    expect(rows.at(-1)).toEqual({ kb: 2703360, path: '/Users/test/Library/Caches' });
    expect(rows.some((r) => r.path.includes('HomeKit'))).toBe(false);
  });
  it('a path with spaces survives', () => {
    expect(parseDuK('524288\t/Users/test/Library/Caches/Microsoft Edge\n')[0]!.path).toBe('/Users/test/Library/Caches/Microsoft Edge');
  });
});

describe('parseAgentFile', () => {
  it('parses an .agent file that starts with a UTF-8 BOM', () => {
    const text = fixture('devops-agent.json');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(() => JSON.parse(text)).toThrow(); // the BOM is exactly why a plain JSON.parse fails
    expect(parseAgentFile(text)).toEqual({ agentName: 'waldos-Mac-2', poolName: 'IFX-UBUNTU-BUILD', agentId: 18, poolId: 10 });
  });
  it('garbage is null', () => {
    expect(parseAgentFile('{ nope')).toBeNull();
  });
});

describe('classifyAppSupport', () => {
  it('an Autodesk folder with no Autodesk/Fusion app installed is an orphan', () => {
    expect(classifyAppSupport('Autodesk', ['Safari', 'Xcode']).safety).toBe('orphan');
  });
  it('the same folder with Autodesk Fusion installed is kept', () => {
    const r = classifyAppSupport('Autodesk', ['Autodesk Fusion', 'Safari']);
    expect(r.safety).toBe('keep');
    expect(r.note).toContain('Autodesk Fusion');
  });
  it('a folder not in the map is keep with "owner unknown", never an orphan', () => {
    const r = classifyAppSupport('Code', []);
    expect(r.safety).toBe('keep');
    expect(r.note).toContain('owner unknown');
    expect(classifyAppSupport('constructor', []).safety).toBe('keep'); // prototype keys are not owners
  });
  it('maps the documented owners', () => {
    expect(Object.keys(APP_SUPPORT_OWNERS)).toEqual(
      expect.arrayContaining(['Autodesk', 'dev.warp.Warp-Stable', 'Spotify', 'Slack', 'discord', 'zoom.us', 'Docker Desktop', 'Cursor', 'UniFi OS Server', 'com.elgato.StreamDeck', 'Steam', 'obs-studio']),
    );
    expect(classifyAppSupport('dev.warp.Warp-Stable', ['Warp']).safety).toBe('keep');
    expect(classifyAppSupport('dev.warp.Warp-Stable', ['Safari']).safety).toBe('orphan');
  });
});

describe('the catalog', () => {
  it('has the documented entries and never asks for a whole-gigabyte du', () => {
    expect(CLUTTER_CATALOG.map((e) => e.id)).toEqual([
      'xcode-deriveddata', 'xcode-devicesupport', 'coresimulator', 'android-avd', 'brew-cache', 'user-caches', 'user-logs',
      'npm-cache', 'nuget-cache', 'hf-models', 'orbstack-disk', 'docker-desktop', 'claude-vm', 'parallels-vms',
      'downloads-installers', 'wallpaper-cache', 'app-support-orphans', 'claude-worktrees', 'devops-agents',
    ]);
    expect(CLUTTER_CATALOG.find((e) => e.id === 'parallels-vms')!.safety).toBe('keep');
    expect(CLUTTER_CATALOG.find((e) => e.id === 'user-caches')!.exclude!.test('Homebrew')).toBe(true);
  });
});

describe('surveyClutter', () => {
  const caches: ClutterEntry = {
    id: 'user-caches', title: 'App caches', kind: 'children', base: '~/Library/Caches', exclude: /^Homebrew$/,
    safety: 'regenerates', regenNote: 'apps rebuild caches',
  };
  const base = '/Users/test/Library/Caches';
  const split = (text: string) => ({
    out: text.split('\n').filter((l) => /^\d+\t/.test(l)).join('\n') + '\n',
    err: text.split('\n').filter((l) => l.startsWith('du:')).join('\n') + '\n',
  });
  const dirFs = (extra: Record<string, never> = {}) => fakeFs({ [base]: { kind: 'dir', children: [] }, ...extra });

  it('children: top items by size above minBytes, the rest summed, partial noted, sizes on-disk', async () => {
    const { out, err } = split(fixture('du-k-d1.txt'));
    const run = scriptedRun([['/usr/bin/du -k -d 1 -P -x --', ok(out, err)]]);
    // the permission line arrives with a non-zero exit, like real du
    run.calls.length = 0;
    const withExit = (async (...a: Parameters<typeof run>) => ({ ...(await run(...a)), code: 1, failed: true })) as typeof run;
    const r = await surveyClutter(fakeContext({ run: withExit }), [caches], undefined, dirFs());
    expect(r.skipped).toEqual([]);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.id).toBe('user-caches');
    expect(f.checkId).toBe('disk-clutter');
    expect(f.category).toBe('clutter');
    expect(f.items!.map((i) => [i.path.replace(`${base}/`, ''), i.bytes])).toEqual([
      ['com.apple.Safari', 1310720 * KIB],
      ['Google', 819200 * KIB],
      ['Microsoft Edge', 524288 * KIB],
    ]);
    expect(f.severity).toBe('advice'); // 2.5 GB reclaimable >= 1 GiB
    expect(f.title).toBe('App caches: 2.5 GB in 3 items');
    expect(f.detail).toContain('+ 2 smaller');
    expect(f.detail).toContain('partial: some sub-folders unreadable');
    expect(f.reclaimableBytes).toBe((1310720 + 819200 + 524288) * KIB);
    expect(f.evidence[0]!.command).toBe(`du -k -d 1 -P -x -- ${base}`);
  });

  it('a base that does not exist is no finding and not a skip', async () => {
    const r = await surveyClutter(fakeContext({ run: async () => ok('') }), [caches], undefined, fakeFs({}));
    expect(r).toEqual({ findings: [], skipped: [] });
  });

  it('permission denied with no size line is skipped, never "0 B"', async () => {
    const run = async () => fail('', `du: ${base}: Operation not permitted\n`);
    const r = await surveyClutter(fakeContext({ run }), [caches], undefined, dirFs());
    expect(r.findings).toEqual([]);
    expect(r.skipped).toEqual([{ id: 'disk-clutter:user-caches', reason: 'no permission — grant Full Disk Access to include' }]);
  });

  it('a du that times out keeps the lines it printed and adds a partial skip', async () => {
    const partial = '1310720\t/Users/test/Library/Caches/com.apple.Safari\n819200\t/Users/test/Library/Caches/Google\n';
    const r = await surveyClutter(fakeContext({ run: async () => fail(partial, '') }), [caches], undefined, dirFs());
    expect(r.findings[0]!.items).toHaveLength(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped![0]!.id).toBe('disk-clutter:user-caches');
    expect(r.skipped![0]!.reason).toMatch(/^partial: timed out after \d+ s$/);
  });

  it("another app's container that never answers is reported as a pending macOS prompt, not as a plain timeout", async () => {
    const wall: ClutterEntry = {
      id: 'wallpaper-cache', title: 'Wallpaper cache', kind: 'path',
      base: '~/Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches', safety: 'regenerates', regenNote: 'aerials re-download',
    };
    const p = '/Users/test/Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches';
    const fs = fakeFs({ [p]: { kind: 'dir', children: [] } });
    const r = await surveyClutter(fakeContext({ run: async () => fail('', '') }), [wall], undefined, fs);
    expect(r.findings).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped![0]!.reason).toMatch(/access data from other apps/);
  });

  it('PD_HEALTH_SKIP leaves a catalog entry out without touching the disk', async () => {
    const before = process.env['PD_HEALTH_SKIP'];
    process.env['PD_HEALTH_SKIP'] = 'user-caches';
    let ran = 0;
    try {
      const r = await surveyClutter(fakeContext({ run: async () => { ran++; return ok(''); } }), [caches], undefined, dirFs());
      expect(r).toEqual({ findings: [], skipped: [{ id: 'disk-clutter:user-caches', reason: 'disabled by PD_HEALTH_SKIP' }] });
    } finally {
      if (before === undefined) delete process.env['PD_HEALTH_SKIP']; else process.env['PD_HEALTH_SKIP'] = before;
    }
    expect(ran).toBe(0);
  });

  it('a symlinked base is not followed', async () => {
    const fs = fakeFs({ [base]: { kind: 'symlink' } });
    const r = await surveyClutter(fakeContext({ run: async () => ok('') }), [caches], undefined, fs);
    expect(r.skipped).toEqual([{ id: 'disk-clutter:user-caches', reason: 'symlink — not followed' }]);
  });

  it('path: one item, with the running hint from the process list', async () => {
    const entry: ClutterEntry = {
      id: 'orbstack-disk', title: 'OrbStack disk image', kind: 'path', base: '~/Library/Group Containers/x/data.img.raw',
      runningHint: { name: /orbstack/i, label: 'OrbStack' }, safety: 'ask', regenNote: 'ALL Docker images',
    };
    const p = '/Users/test/Library/Group Containers/x/data.img.raw';
    const fs = fakeFs({ [p]: { kind: 'file', blocks: 100 } });
    const run = scriptedRun([['/usr/bin/du -sk -P -x --', ok(`${15 * 1024 * 1024}\t${p}\n`)]]);
    const off = await surveyClutter(fakeContext({ run }), [entry], undefined, fs);
    expect(off.findings[0]!.items![0]).toMatchObject({ path: p, bytes: 15 * GIB, safety: 'ask', note: 'OrbStack is not running' });
    expect(off.findings[0]!.title).toBe('OrbStack disk image: 15 GB');
    const on = await surveyClutter(fakeContext({ run, processes: [proc({ pid: 9, name: 'OrbStack Helper' })] }), [entry], undefined, fs);
    expect(on.findings[0]!.items![0]!.note).toBe('OrbStack is running');
    expect(run.calls[0]).toContain('-sk -P -x --'); // never du -sg
  });

  it('files: only matching, old enough, big enough regular files; on-disk size from blocks', async () => {
    const entry: ClutterEntry = {
      id: 'downloads-installers', title: 'Old installers', kind: 'files', base: '~/Downloads',
      match: /\.(dmg|pkg|iso)$/i, olderThanDays: 30, minBytes: 50 * MIB, safety: 'ask', regenNote: 're-downloadable',
    };
    const d = '/Users/test/Downloads';
    const old = NOW - 40 * 86_400_000;
    const fs = fakeFs({
      [d]: { kind: 'dir', children: ['big.dmg', 'new.dmg', 'small.pkg', 'notes.txt', 'sub'] },
      [`${d}/big.dmg`]: { kind: 'file', blocks: (400 * MIB) / 512, mtimeMs: old },
      [`${d}/new.dmg`]: { kind: 'file', blocks: (400 * MIB) / 512, mtimeMs: NOW - 86_400_000 },
      [`${d}/small.pkg`]: { kind: 'file', blocks: (10 * MIB) / 512, mtimeMs: old },
      [`${d}/notes.txt`]: { kind: 'file', blocks: (900 * MIB) / 512, mtimeMs: old },
      [`${d}/sub`]: { kind: 'dir', children: [] },
    });
    const r = await surveyClutter(fakeContext({ run: async () => ok('') }), [entry], undefined, fs);
    expect(r.findings[0]!.items!.map((i) => [i.path, i.bytes])).toEqual([[`${d}/big.dmg`, 400 * MIB]]);
  });

  it('worktrees: clean → regenerates, dirty → keep with the count, not a repo → keep', async () => {
    const entry: ClutterEntry = {
      id: 'claude-worktrees', title: 'Claude Code worktrees', kind: 'worktrees', base: '', minBytes: 50 * MIB,
      safety: 'ask', regenNote: 'clean worktree — the branch is kept',
    };
    const wt = '/Users/test/SourceCode/proj/.claude/worktrees';
    const run = scriptedRun([
      ['/usr/bin/find /Users/test/SourceCode', ok(`${wt}\n`)],
      [`du -k -d 1 -P -x -- ${wt}`, ok(`204800\t${wt}/clean\n102400\t${wt}/dirty\n81920\t${wt}/plain\n10\t${wt}/tiny\n389130\t${wt}\n`)],
      [`-C ${wt}/clean status`, ok('')],
      [`-C ${wt}/dirty status`, ok(' M a.ts\n?? b.ts\n')],
      [`-C ${wt}/plain status`, fail('', 'fatal: not a git repository')],
    ]);
    const ctx = fakeContext({ run, exists: (p) => p === '/Users/test/SourceCode' });
    const r = await surveyClutter(ctx, [entry], undefined, fakeFs({}));
    const items = Object.fromEntries(r.findings[0]!.items!.map((i) => [i.path.split('/').pop(), [i.safety, i.note]]));
    expect(items).toEqual({
      clean: ['regenerates', 'clean worktree'],
      dirty: ['keep', '2 uncommitted changes'],
      plain: ['keep', 'not a git worktree'],
    });
    // git status must not refresh (write) the index
    expect(run.calls.filter((c) => c.includes('status')).every((c) => c.includes('--no-optional-locks'))).toBe(true);
    // 'ask' finding counts only the regenerates + ask items; keep is not reclaimable
    expect(r.findings[0]!.reclaimableBytes).toBe(204800 * KIB);
  });

  it('devops-agents: finds the _work folder of an agent dir, strips the BOM, skips protected folders', async () => {
    const entry: ClutterEntry = {
      id: 'devops-agents', title: 'Azure Pipelines agents', kind: 'devops-agents', base: '', minBytes: 100 * MIB,
      safety: 'ask', regenNote: 'build output',
    };
    const h = '/Users/test';
    const fs = fakeFs({
      [h]: { kind: 'dir', children: ['myagent', 'Documents', 'notanagent', '.hidden'] },
      [`${h}/myagent`]: { kind: 'dir', children: ['_work'] },
      [`${h}/myagent/_work`]: { kind: 'dir', children: [] },
      [`${h}/myagent/.agent`]: { kind: 'file', content: fixture('devops-agent.json') },
      [`${h}/Documents`]: { kind: 'dir', children: [] },
      [`${h}/Documents/_work`]: { kind: 'dir', children: [] },
      [`${h}/notanagent`]: { kind: 'dir', children: [] },
      [`${h}/notanagent/_work`]: { kind: 'dir', children: [] },
    });
    const run = scriptedRun([['du -sk -P -x -- /Users/test/myagent/_work', ok(`${3 * 1024 * 1024}\t${h}/myagent/_work\n`)]]);
    const r = await surveyClutter(fakeContext({ run }), [entry], undefined, fs);
    expect(r.findings[0]!.items).toHaveLength(1);
    expect(r.findings[0]!.items![0]).toMatchObject({ path: `${h}/myagent/_work`, bytes: 3 * GIB, note: 'agent waldos-Mac-2 (pool IFX-UBUNTU-BUILD)' });
    expect(run.calls.every((c) => !c.includes('Documents'))).toBe(true);
  });

  it('app-support: classifies each child with the installed apps', async () => {
    const entry = CLUTTER_CATALOG.find((e) => e.id === 'app-support-orphans')!;
    const b = '/Users/test/Library/Application Support';
    const fs = fakeFs({
      [b]: { kind: 'dir', children: [] },
      '/Applications': { kind: 'dir', children: ['Safari.app'] },
    });
    const du = `${2 * 1024 * 1024}\t${b}/Autodesk\n${2 * 1024 * 1024}\t${b}/Code\n${100}\t${b}/small\n${4 * 1024 * 1024}\t${b}\n`;
    const r = await surveyClutter(fakeContext({ run: scriptedRun([['/usr/bin/du -k -d 1', ok(du)]]) }), [entry], undefined, fs);
    const items = Object.fromEntries(r.findings[0]!.items!.map((i) => [i.path.split('/').pop(), i.safety]));
    expect(items).toEqual({ Autodesk: 'orphan', Code: 'keep' });
    expect(r.findings[0]!.reclaimableBytes).toBe(2 * GIB); // only the orphan counts
  });

  it('entries not started by the deadline are skipped, never silently dropped; progress is reported', async () => {
    const seen: string[] = [];
    const r = await surveyClutter(fakeContext(), [caches, { ...caches, id: 'two', title: 'Two' }], (c) => seen.push(c), fakeFs({}), 0);
    expect(r.skipped!.map((s) => s.reason)).toEqual(['survey budget exhausted', 'survey budget exhausted']);
    expect(seen).toEqual([]);
    const r2 = await surveyClutter(fakeContext({ run: async () => ok('') }), [caches], (c) => seen.push(c), fakeFs({}));
    expect(r2.skipped).toEqual([]);
    expect(seen).toEqual(['App caches']);
  });

  it('a thrown measuring error becomes a skip with the reason', async () => {
    const boom = fakeFs({ [base]: { kind: 'dir', children: [] } });
    const r = await surveyClutter(
      fakeContext({ run: async () => { throw new Error('kaboom'); } }),
      [caches], undefined, boom,
    );
    expect(r.skipped![0]!.reason).toBe('failed: kaboom');
  });
});
