import { describe, expect, it } from 'vitest';
import { parseTrashOutput, TRASH_BATCH, TRASH_JXA, trashPaths } from '../../src/health/trash.js';
import { fail, fakeContext, ok } from './helpers.js';

const line = (o: object): string => JSON.stringify(o);

describe('TRASH_JXA', () => {
  it('is a constant: the paths of a request are never part of its text', () => {
    const paths = ['/Users/test/Library/Caches/com.example.App', '/Users/test/.npm/_cacache'];
    for (const p of paths) expect(TRASH_JXA).not.toContain(p);
    expect(TRASH_JXA).toContain('trashItemAtURLResultingItemURLError');
    expect(TRASH_JXA).toContain('function run(argv)');
  });

  it('trashPaths passes the script as a constant and every path as its own argument', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const paths = ['/Users/test/a b', "/Users/test/it's", '/Users/test/$(touch x)'];
    const ctx = fakeContext({
      run: async (cmd, args = []) => {
        calls.push({ cmd, args });
        return ok(paths.map((p) => line({ path: p, ok: true, trashedTo: `/Users/test/.Trash/${p.split('/').pop()}`, error: null })).join('\n'));
      },
    });
    const out = await trashPaths(ctx, paths);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('/usr/bin/osascript');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(calls[0]!.args[3]).toBe(TRASH_JXA);
    expect(calls[0]!.args.slice(4)).toEqual(paths);
    expect(out.every((o) => o.ok)).toBe(true);
  });
});

describe('parseTrashOutput', () => {
  const paths = ['/Users/test/a', '/Users/test/b'];

  it('reads an ok line and a failed line, in request order', () => {
    const text = [
      line({ path: '/Users/test/b', ok: false, trashedTo: null, error: 'The file “b” doesn’t exist.' }),
      line({ path: '/Users/test/a', ok: true, trashedTo: '/Users/test/.Trash/a', error: null }),
    ].join('\n');
    expect(parseTrashOutput(text, paths)).toEqual([
      { path: '/Users/test/a', ok: true, trashedTo: '/Users/test/.Trash/a' },
      { path: '/Users/test/b', ok: false, error: 'The file “b” doesn’t exist.' },
    ]);
  });

  it('ignores garbage lines and lines about paths nobody asked for', () => {
    const text = ['warning: something', '{not json', line({ path: '/etc/passwd', ok: true, trashedTo: '/x' }), line({ path: '/Users/test/a', ok: true, trashedTo: '/Users/test/.Trash/a' })].join('\n');
    const out = parseTrashOutput(text, paths);
    expect(out[0]).toMatchObject({ path: '/Users/test/a', ok: true });
    expect(out[1]).toMatchObject({ path: '/Users/test/b', ok: false });
  });

  it('empty output makes every path a failure, never a silent success', () => {
    expect(parseTrashOutput('', paths).map((o) => o.ok)).toEqual([false, false]);
    expect(parseTrashOutput('', paths)[0]!.error).toContain('nothing was confirmed');
  });

  it('an "ok" line without a destination counts as failed', () => {
    expect(parseTrashOutput(line({ path: '/Users/test/a', ok: true, trashedTo: null }), ['/Users/test/a'])[0]!.ok).toBe(false);
  });
});

describe('trashPaths', () => {
  it('splits more than 50 paths over several calls and answers every path once', async () => {
    const paths = Array.from({ length: TRASH_BATCH * 2 + 3 }, (_, i) => `/Users/test/Library/Caches/p${i}`);
    const sizes: number[] = [];
    const ctx = fakeContext({
      run: async (_c, args = []) => {
        const batch = args.slice(4);
        sizes.push(batch.length);
        return ok(batch.map((p) => line({ path: p, ok: true, trashedTo: `/Users/test/.Trash/${p.split('/').pop()}` })).join('\n'));
      },
    });
    const out = await trashPaths(ctx, paths);
    expect(sizes).toEqual([50, 50, 3]);
    expect(out.map((o) => o.path)).toEqual(paths);
    expect(out.every((o) => o.ok)).toBe(true);
  });

  it('reads the result from stderr too (osascript prints a JavaScript result there on some systems)', async () => {
    const ctx = fakeContext({ run: async () => ok('', line({ path: '/Users/test/a', ok: true, trashedTo: '/Users/test/.Trash/a' })) });
    expect((await trashPaths(ctx, ['/Users/test/a']))[0]!.ok).toBe(true);
  });

  it('a failing osascript run fails every path in the batch, with no fallback to anything else', async () => {
    const calls: string[] = [];
    const ctx = fakeContext({ run: async (cmd) => (calls.push(cmd), fail('', 'osascript: boom')) });
    const out = await trashPaths(ctx, ['/Users/test/a', '/Users/test/b']);
    expect(out.map((o) => o.ok)).toEqual([false, false]);
    expect(calls).toEqual(['/usr/bin/osascript']);
  });

  it('a run that throws is a failure, not an exception', async () => {
    const ctx = fakeContext({ run: async () => { throw new Error('spawn failed'); } });
    const out = await trashPaths(ctx, ['/Users/test/a']);
    expect(out[0]).toMatchObject({ ok: false });
    expect(out[0]!.error).toContain('spawn failed');
  });

  it('a relative path or one with a NUL is refused before anything runs', async () => {
    const calls: string[] = [];
    const ctx = fakeContext({ run: async (cmd) => (calls.push(cmd), ok('')) });
    const out = await trashPaths(ctx, ['-rf', 'relative', '/Users/test/a\0b']);
    expect(out.map((o) => o.ok)).toEqual([false, false, false]);
    expect(calls).toEqual([]);
  });
});
