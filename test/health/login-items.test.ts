import { describe, expect, it } from 'vitest';
import { classifyLoginItems, loginItemsCheck, parseBtm, fileUrlToPath } from '../../src/health/checks/login-items.js';
import { fail, fakeContext, fixture, ok } from './helpers.js';

const items = parseBtm(fixture('sfltool-dumpbtm.txt'));
const byName = (name: string, uid = 501) => items.find((i) => i.name === name && i.uid === uid)!;

describe('parseBtm', () => {
  it('finds 18 items: 5 in uid -2, 0 in uid 0, 13 in uid 501', () => {
    expect(items).toHaveLength(18);
    const count = (uid: number) => items.filter((i) => i.uid === uid).length;
    expect([count(-2), count(0), count(501)]).toEqual([5, 0, 13]);
  });

  it('does not turn "Embedded Item Identifiers" sub-lines into items', () => {
    // "#1: 16.com.microsoft.autoupdate.helper" sits inside Microsoft AutoUpdate's block
    expect(items.filter((i) => i.name === 'com.microsoft.autoupdate.helper')).toHaveLength(1);
    expect(items.find((i) => i.name === '16.com.microsoft.autoupdate.helper')).toBeUndefined();
  });

  it('decodes file URLs into paths without a trailing slash', () => {
    expect(byName('Mouse Glide').path).toBe('/Users/waldo/.Trash/Mouse Glide.app');
    expect(byName('Mouse Glide').url).toBe('file:///Users/waldo/.Trash/Mouse%20Glide.app/');
    expect(fileUrlToPath('file:///Applications/')).toBe('/Applications');
    expect(fileUrlToPath('Contents/Library/LoginItems/x.app')).toBeNull();
  });

  it('relative URLs have no path; Disposition drives enabled; Type loses its hex suffix', () => {
    expect(byName('OneDrive Launcher').path).toBeNull();
    expect(byName('OneDrive Launcher').type).toBe('login item');
    expect(byName('Alarm').enabled).toBe(false);
    expect(byName('Dropbox').enabled).toBe(true);
    expect(byName('Dropbox').type).toBe('app');
    expect(byName('amelia-gateway').type).toBe('user item');
    expect(byName('Dropbox').developer).toBeNull(); // "(null)"
  });
});

describe('classifyLoginItems', () => {
  const exists = (p: string) => p !== '/Applications/Warp.app';
  const f = classifyLoginItems(items, 501, exists);

  it('flags the Trash and missing targets as warn, the dev build as advice, and summarises', () => {
    const warns = f.filter((x) => x.severity === 'warn');
    expect(warns.map((x) => x.id).sort()).toEqual([
      'login-items:dockdoor',
      'login-items:mouse-glide',
      'login-items:warp',
    ]);
    expect(warns.find((x) => x.id === 'login-items:dockdoor')!.title).toBe('Login item “DockDoor” points into the Trash');
    expect(warns.find((x) => x.id === 'login-items:warp')!.title).toBe('Login item “Warp” points at an app that no longer exists');
    expect(warns.every((x) => x.safety === 'orphan' && (x.manualSteps?.length ?? 0) > 0)).toBe(true);

    const advice = f.filter((x) => x.severity === 'advice');
    expect(advice).toHaveLength(1);
    expect(advice[0]!.title).toContain('Electron');

    const info = f.filter((x) => x.severity === 'info');
    expect(info).toHaveLength(1);
    expect(info[0]!.id).toBe('login-items');
    expect(info[0]!.title).toContain('9 login items');
    expect(info[0]!.title).toContain('5 background agents/daemons enabled (4 legacy)');
  });

  it('produces nothing for healthy items and for the disabled Alarm', () => {
    const ids = f.map((x) => x.id).join(' ');
    expect(ids).not.toContain('dropbox');
    expect(ids).not.toContain('alarm');
    expect(ids).not.toContain('rectangle');
  });

  it('only looks at the given uid', () => {
    const other = classifyLoginItems(items, 502, () => true);
    expect(other.filter((x) => x.severity !== 'info')).toEqual([]);
    expect(other[0]!.title).toContain('0 login items');
  });
});

describe('login-items check', () => {
  it('runs sfltool dumpbtm, never a scripting bridge', async () => {
    const seen: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      seen.push(`${cmd} ${args.join(' ')}`);
      return ok(fixture('sfltool-dumpbtm.txt'));
    };
    const r = await loginItemsCheck.run(fakeContext({ run, exists: (p) => p !== '/Applications/Warp.app' }));
    expect(seen).toEqual(['/usr/bin/sfltool dumpbtm']);
    expect(r.findings.length).toBeGreaterThanOrEqual(1);
    // sfltool raises a Touch ID / password dialog on every run: on demand, never cached-and-refreshed.
    expect(loginItemsCheck.optIn?.label).toBe('Check login items');
    expect(loginItemsCheck.ttlMs).toBeUndefined();
  });

  it('PD_NO_ELEVATED=1 refuses to raise the authorization dialog', async () => {
    const before = process.env['PD_NO_ELEVATED'];
    process.env['PD_NO_ELEVATED'] = '1';
    let ran = 0;
    try {
      await expect(loginItemsCheck.run(fakeContext({ run: async () => { ran++; return ok(''); } }))).rejects.toThrow(/PD_NO_ELEVATED/);
    } finally {
      if (before === undefined) delete process.env['PD_NO_ELEVATED']; else process.env['PD_NO_ELEVATED'] = before;
    }
    expect(ran).toBe(0);
  });

  it('a dump without records (timed out, or waiting on a prompt) is a failure, never "0 login items"', async () => {
    await expect(loginItemsCheck.run(fakeContext({ run: async () => fail('', '') }))).rejects.toThrow(/no records/);
  });
});
