import type { ProcessNode, ProcessTree, RawProcess } from '../types.js';

/**
 * Build a parent/child tree from a flat snapshot using PID -> PPID links.
 * Children are sorted by CPU (desc) so hot branches surface first.
 */
export function buildTree(procs: RawProcess[]): ProcessTree {
  const byPid = new Map<number, ProcessNode>();
  for (const proc of procs) {
    byPid.set(proc.pid, { proc, parent: null, children: [] });
  }

  const roots: ProcessNode[] = [];
  for (const node of byPid.values()) {
    const ppid = node.proc.ppid;
    // Guard against self-parenting and missing parents (process exited mid-scan).
    const parent = ppid && ppid !== node.proc.pid ? byPid.get(ppid) : undefined;
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  for (const node of byPid.values()) {
    node.children.sort(
      (a, b) => b.proc.cpu - a.proc.cpu || a.proc.pid - b.proc.pid,
    );
  }

  return { byPid, roots, all: [...byPid.values()] };
}

/**
 * The ancestry from the topmost ancestor down to `node` (inclusive).
 * Cycle-safe. Result is ordered root-first, e.g. [launchd, …, node].
 */
export function parentChain(node: ProcessNode): ProcessNode[] {
  const chain: ProcessNode[] = [];
  const seen = new Set<number>();
  let cur: ProcessNode | null = node;
  while (cur && !seen.has(cur.proc.pid)) {
    seen.add(cur.proc.pid);
    chain.push(cur);
    cur = cur.parent;
  }
  return chain.reverse();
}

/** All transitive descendants of `node` (excludes the node itself). */
export function descendants(node: ProcessNode): ProcessNode[] {
  const out: ProcessNode[] = [];
  const seen = new Set<number>();
  const stack = [...node.children];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.proc.pid)) continue;
    seen.add(n.proc.pid);
    out.push(n);
    for (const c of n.children) stack.push(c);
  }
  return out;
}
