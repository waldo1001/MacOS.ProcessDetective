import { describe, expect, it } from 'vitest';
import { buildTree, descendants, parentChain } from '../src/tree/build.js';
import type { RawProcess } from '../src/types.js';

function proc(pid: number, ppid: number, name: string, cpu = 0): RawProcess {
  return {
    pid,
    ppid,
    cpu,
    mem: 0,
    elapsedSeconds: 0,
    elapsedRaw: '00:00',
    user: 'waldo',
    execPath: `/bin/${name}`,
    name,
    command: name,
  };
}

describe('buildTree', () => {
  const procs = [
    proc(1, 0, 'launchd'),
    proc(100, 1, 'claude'),
    proc(200, 100, 'zsh'),
    proc(300, 200, 'npm', 5),
    proc(400, 300, 'node', 183),
    proc(401, 300, 'node', 12),
  ];

  it('links parents and children and finds roots', () => {
    const tree = buildTree(procs);
    expect(tree.roots.map((n) => n.proc.pid)).toEqual([1]);
    expect(tree.byPid.get(300)!.children.map((n) => n.proc.pid)).toEqual([400, 401]);
    expect(tree.byPid.get(400)!.parent!.proc.pid).toBe(300);
  });

  it('sorts children by CPU descending', () => {
    const tree = buildTree(procs);
    const kids = tree.byPid.get(300)!.children;
    expect(kids[0]!.proc.cpu).toBe(183);
    expect(kids[1]!.proc.cpu).toBe(12);
  });

  it('treats a process whose parent is absent as a root', () => {
    const tree = buildTree([proc(500, 999, 'orphan')]);
    expect(tree.roots.map((n) => n.proc.pid)).toEqual([500]);
  });

  it('does not loop on a self-parented process', () => {
    const tree = buildTree([proc(7, 7, 'weird')]);
    expect(tree.roots.map((n) => n.proc.pid)).toEqual([7]);
  });
});

describe('parentChain', () => {
  it('returns ancestry root-first, inclusive of the node', () => {
    const tree = buildTree([
      proc(1, 0, 'launchd'),
      proc(100, 1, 'claude'),
      proc(200, 100, 'zsh'),
      proc(300, 200, 'npm'),
      proc(400, 300, 'node'),
    ]);
    const chain = parentChain(tree.byPid.get(400)!);
    expect(chain.map((n) => n.proc.name)).toEqual(['launchd', 'claude', 'zsh', 'npm', 'node']);
  });
});

describe('descendants', () => {
  it('returns all transitive children', () => {
    const tree = buildTree([
      proc(1, 0, 'launchd'),
      proc(100, 1, 'a'),
      proc(200, 100, 'b'),
      proc(300, 200, 'c'),
    ]);
    const ids = descendants(tree.byPid.get(100)!).map((n) => n.proc.pid).sort();
    expect(ids).toEqual([200, 300]);
  });
});
