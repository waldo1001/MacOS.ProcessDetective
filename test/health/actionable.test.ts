import { describe, expect, it } from 'vitest';
import {
  actionRootFor, actionsConfig, checkActionable, effectiveCatalog, isActionable, SANDBOX_ENTRY_ID, stampActionable,
  type ConfigProbe,
} from '../../src/health/actionable.js';
import { CLUTTER_CATALOG } from '../../src/health/catalog.js';
import type { ClutterItem, HealthFinding, SafetyClass } from '../../src/types.js';

const HOME = '/Users/test';
const SB = '/var/folders/zz/T/pd-actions-sandbox';

const item = (path: string, safety: SafetyClass = 'regenerates'): ClutterItem => ({ path, bytes: 1024, lastModified: null, safety });
const finding = (id: string, checkId: string, items: ClutterItem[]): HealthFinding => ({
  id, checkId, category: 'clutter', severity: 'info', title: id, detail: '', evidence: [], items,
});
const clutter = (id: string, path: string, safety: SafetyClass = 'regenerates'): [HealthFinding, ClutterItem] => {
  const it = item(path, safety);
  return [finding(id, 'disk-clutter', [it]), it];
};
const ok = (f: HealthFinding, it: ClutterItem, sandbox: string | null = null): boolean => isActionable(f, it, HOME, sandbox);

describe('isActionable: the shape rules', () => {
  it('a child directly in its catalog base is actionable, one level deeper is not', () => {
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/com.example.App`))).toBe(true);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/com.example.App/sub`))).toBe(false);
    expect(ok(...clutter('xcode-deriveddata', `${HOME}/Library/Developer/Xcode/DerivedData/MyApp-abc`))).toBe(true);
  });

  it('keep and manual items are never actionable', () => {
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/x`, 'keep'))).toBe(false);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/x`, 'manual'))).toBe(false);
    expect(checkActionable(...clutter('user-caches', `${HOME}/Library/Caches/x`, 'keep'), HOME)).toEqual({ ok: false, reason: 'keep items are never cleaned' });
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/x`, 'ask'))).toBe(true);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/x`, 'orphan'))).toBe(true);
  });

  it('the catalog folders themselves, a top-level home entry and a path with ".." are refused; the two-deep catalog paths pass', () => {
    // the base folder itself is never a child of itself
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches`))).toBe(false);
    expect(ok(...clutter('downloads-installers', `${HOME}/Downloads`, 'ask'))).toBe(false);
    expect(ok(...clutter('user-caches', `${HOME}/x`))).toBe(false);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/../Documents`))).toBe(false);
    expect(checkActionable(...clutter('user-caches', `${HOME}/Library/Caches/../Documents`), HOME)).toMatchObject({ ok: false, reason: 'the path contains ".."' });
    // from their own entries
    expect(ok(...clutter('npm-cache', `${HOME}/.npm/_cacache`))).toBe(true);
    expect(ok(...clutter('downloads-installers', `${HOME}/Downloads/x.dmg`, 'ask'))).toBe(true);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/x`))).toBe(true);
  });

  it('the depth rule alone: two segments under home, three under ~/Library (even for a hypothetical entry)', () => {
    // a runaway log directly in ~/Library/Logs is 3 segments deep and fine; a path 2 deep under Library is not
    const f = finding('runaway-logs:x', 'runaway-logs', []);
    expect(isActionable(f, item(`${HOME}/Library/Logs/App/big.log`), HOME)).toBe(true);
    expect(isActionable(f, item(`${HOME}/Library/Logs`), HOME)).toBe(false);
    expect(isActionable(f, item(`${HOME}/Library/big.log`), HOME)).toBe(false);
  });

  it('paths must be absolute, normalized and inside the home folder', () => {
    expect(ok(...clutter('user-caches', 'Library/Caches/x'))).toBe(false);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches//x`))).toBe(false);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/x/`))).toBe(false);
    expect(ok(...clutter('user-caches', '/Library/Caches/x'))).toBe(false);
    expect(ok(...clutter('user-caches', `/Users/other/Library/Caches/x`))).toBe(false);
  });

  it('a sandbox item directly in the sandbox dir is actionable; the same path without the sandbox set is not', () => {
    const [f, it] = clutter(SANDBOX_ENTRY_ID, `${SB}/pd-sandbox-junk-a`);
    expect(ok(f, it, SB)).toBe(true);
    expect(actionRootFor(f, it, HOME, SB)).toBe(SB);
    expect(ok(f, it, null)).toBe(false);
    // one level deeper, or in another directory, is not
    expect(ok(...clutter(SANDBOX_ENTRY_ID, `${SB}/a/b`), SB)).toBe(false);
    expect(ok(...clutter(SANDBOX_ENTRY_ID, `/var/folders/zz/T/other/x`), SB)).toBe(false);
    // a non-sandbox finding gets no exemption from the home rules just because a sandbox is set
    expect(ok(...clutter('user-caches', `${SB}/pd-sandbox-junk-a`), SB)).toBe(false);
  });

  it('coresimulator (noTrash) is never actionable, even for an ask item that otherwise fits', () => {
    expect(ok(...clutter('coresimulator', `${HOME}/Library/Developer/CoreSimulator/Devices/AAAA-1111`, 'ask'))).toBe(false);
    expect(checkActionable(...clutter('coresimulator', `${HOME}/Library/Developer/CoreSimulator/Devices/AAAA-1111`, 'ask'), HOME)).toMatchObject({ ok: false });
    expect(ok(...clutter('parallels-vms', `${HOME}/Parallels/Win.pvm`, 'ask'))).toBe(false);
    expect(CLUTTER_CATALOG.filter((e) => e.noTrash).map((e) => e.id)).toEqual(['coresimulator', 'parallels-vms']);
  });

  it('worktrees: .claude/worktrees/<name> is actionable, its contents and other folders are not', () => {
    expect(ok(...clutter('claude-worktrees', `${HOME}/SourceCode/proj/.claude/worktrees/lucid-1`, 'ask'))).toBe(true);
    expect(ok(...clutter('claude-worktrees', `${HOME}/SourceCode/proj/.claude/worktrees/lucid-1/src`, 'ask'))).toBe(false);
    expect(ok(...clutter('claude-worktrees', `${HOME}/SourceCode/proj/src`, 'ask'))).toBe(false);
  });

  it('devops agents: <home>/x/_work yes, <home>/x/y/_work no', () => {
    expect(ok(...clutter('devops-agents', `${HOME}/myagent/_work`, 'ask'))).toBe(true);
    expect(ok(...clutter('devops-agents', `${HOME}/x/y/_work`, 'ask'))).toBe(false);
    expect(ok(...clutter('devops-agents', `${HOME}/_work`, 'ask'))).toBe(false);
  });

  it('runaway logs: a file at most 3 levels under ~/Library/Logs', () => {
    const f = finding('runaway-logs:elgato', 'runaway-logs', []);
    expect(isActionable(f, item(`${HOME}/Library/Logs/ElgatoStreamDeck/x.log`), HOME)).toBe(true);
    expect(isActionable(f, item(`${HOME}/Library/Logs/a/b/c/x.log`), HOME)).toBe(false);
    expect(isActionable(f, item(`${HOME}/Library/Caches/x.log`), HOME)).toBe(false);
  });

  it('launch agents: a stray x.plist.bak is actionable, a .plist (a live job) never is', () => {
    const f = finding('launch-agents:stray-files', 'launch-agents', []);
    expect(isActionable(f, item(`${HOME}/Library/LaunchAgents/x.plist.bak`, 'orphan'), HOME)).toBe(true);
    expect(isActionable(f, item(`${HOME}/Library/LaunchAgents/x.plist`, 'orphan'), HOME)).toBe(false);
    expect(isActionable(f, item(`${HOME}/Library/LaunchAgents/X.PLIST`, 'orphan'), HOME)).toBe(false);
    expect(isActionable(f, item(`${HOME}/Library/LaunchAgents/sub/x.bak`, 'orphan'), HOME)).toBe(false);
    expect(isActionable(f, item(`/Library/LaunchAgents/x.bak`, 'orphan'), HOME)).toBe(false);
  });

  it('a finding from any other check is not actionable', () => {
    expect(isActionable(finding('login-items:warp', 'login-items', []), item(`${HOME}/Applications/Warp.app`, 'orphan'), HOME)).toBe(false);
    expect(isActionable(finding('x', 'brew', []), item(`${HOME}/Library/Caches/Homebrew`), HOME)).toBe(false);
    // a disk-clutter finding whose id is not in the catalog
    expect(ok(...clutter('not-in-catalog', `${HOME}/Library/Caches/x`))).toBe(false);
  });

  it('a children entry with a match/exclude pattern holds those patterns', () => {
    expect(ok(...clutter('android-avd', `${HOME}/.android/avd/Pixel.avd`, 'ask'))).toBe(true);
    expect(ok(...clutter('android-avd', `${HOME}/.android/avd/Pixel.ini`, 'ask'))).toBe(false);
    expect(ok(...clutter('user-caches', `${HOME}/Library/Caches/Homebrew`))).toBe(false);
  });
});

describe('stampActionable', () => {
  it('stamps exactly the items that pass, on copies, and strips a stale flag', () => {
    const good = item(`${HOME}/Library/Caches/a`);
    const bad = { ...item(`${HOME}/Library/Caches/b`, 'keep'), actionable: true };
    const f = finding('user-caches', 'disk-clutter', [good, bad]);
    const out = stampActionable([f], HOME, null);
    expect(out[0]!.items!.map((i) => [i.path.split('/').pop(), i.actionable])).toEqual([['a', true], ['b', undefined]]);
    expect(good.actionable).toBeUndefined(); // the cached object is untouched
    expect(f.items![1]).toBe(bad);
    expect('actionable' in out[0]!.items![1]!).toBe(false);
  });
  it('stamps nothing when the layer is off', () => {
    const f = finding('user-caches', 'disk-clutter', [{ ...item(`${HOME}/Library/Caches/a`), actionable: true }]);
    expect(stampActionable([f], HOME, null, false)[0]!.items![0]!.actionable).toBeUndefined();
  });
  it('passes findings without items through', () => {
    const f: HealthFinding = { id: 'x', checkId: 'x', category: 'tooling', severity: 'info', title: 'x', detail: '', evidence: [] };
    expect(stampActionable([f], HOME, null)).toEqual([f]);
  });
});

describe('actionsConfig: kill-switch and sandbox (fail closed)', () => {
  const probe = (dirs: string[], real: Record<string, string> = {}): ConfigProbe => ({
    isDir: (p) => dirs.includes(p),
    realpath: (p) => real[p] ?? p,
  });

  it('is on by default, with no sandbox', () => {
    expect(actionsConfig({}, probe([]), HOME)).toEqual({ enabled: true, sandbox: null });
  });
  it('PD_NO_ACTIONS=1 turns everything off', () => {
    expect(actionsConfig({ PD_NO_ACTIONS: '1' }, probe([]), HOME)).toEqual({ enabled: false, reason: 'PD_NO_ACTIONS=1', sandbox: null });
    expect(actionsConfig({ PD_NO_ACTIONS: '0' }, probe([]), HOME).enabled).toBe(true);
  });
  it('a valid sandbox is normalized (double slashes, trailing slash) and enables the layer', () => {
    const c = actionsConfig({ PD_ACTIONS_SANDBOX: '/var/folders/zz/T//pd-actions-sandbox/' }, probe([SB]), HOME);
    expect(c).toEqual({ enabled: true, sandbox: SB });
  });
  it('a sandbox that is set but unusable disables the layer instead of being ignored', () => {
    const off = (v: string, dirs: string[] = [SB]) => actionsConfig({ PD_ACTIONS_SANDBOX: v }, probe(dirs), HOME);
    expect(off('')).toMatchObject({ enabled: false, sandbox: null });
    expect(off('relative/dir').reason).toContain('absolute');
    expect(off('/var/folders/zz/T/missing').reason).toContain('existing directory');
    expect(off('/').reason).toContain('root');
    expect(off('/tmp', ['/tmp']).reason).toContain('root');
    expect(off(HOME, [HOME]).enabled).toBe(false); // the home folder itself
    expect(off('/Users', ['/Users']).enabled).toBe(false); // too close to the root / a parent of home
    expect(off('/Users/x/../test', ['/Users/test']).enabled).toBe(false);
    expect(off('/a/b/../..', ['/']).enabled).toBe(false);
  });
  it('a sandbox that resolves (symlink) to the home folder or a parent of it is refused', () => {
    const c = actionsConfig({ PD_ACTIONS_SANDBOX: '/var/x/link' }, probe(['/var/x/link'], { '/var/x/link': '/Users' }), HOME);
    expect(c).toMatchObject({ enabled: false, reason: expect.stringContaining('home folder') });
  });
});

describe('effectiveCatalog', () => {
  it('is the plain catalog without a sandbox', () => {
    expect(effectiveCatalog(null)).toBe(CLUTTER_CATALOG);
  });
  it('adds one children entry for the sandbox: regenerates, 1 MiB minimum', () => {
    const cat = effectiveCatalog(SB);
    expect(cat).toHaveLength(CLUTTER_CATALOG.length + 1);
    expect(cat.at(-1)).toMatchObject({ id: 'sandbox', kind: 'children', base: SB, safety: 'regenerates', minBytes: 1024 ** 2 });
    expect(CLUTTER_CATALOG.some((e) => e.id === 'sandbox')).toBe(false);
  });
});
