import type { ProcessNode } from '../types.js';
import { color } from '../util/color.js';
import { fmtPct, friendlyNodeName, shorten } from './format.js';

function nodeLabel(n: ProcessNode): string {
  return (
    `${color.cyan(friendlyNodeName(n))} ` +
    `${color.gray(`PID ${n.proc.pid}`)} ` +
    `${color.green(fmtPct(n.proc.cpu))}`
  );
}

/**
 * Render a node and its descendants as a box-drawing tree.
 *   node
 *   ├─ child  cmd…
 *   └─ child  cmd…
 */
export function renderSubtree(root: ProcessNode, maxDepth = Infinity): string {
  const lines = [nodeLabel(root)];
  const walk = (n: ProcessNode, prefix: string, depth: number): void => {
    if (depth >= maxDepth) return;
    n.children.forEach((child, i) => {
      const last = i === n.children.length - 1;
      lines.push(
        `${prefix}${last ? '└─ ' : '├─ '}${nodeLabel(child)}  ` +
          color.dim(shorten(child.proc.command, 48)),
      );
      walk(child, prefix + (last ? '   ' : '│  '), depth + 1);
    });
  };
  walk(root, '', 0);
  return lines.join('\n');
}

/**
 * Render an ancestry chain (root-first) as an indented cascade — the shape used
 * in `tree --hot` output.
 */
export function renderChain(chain: ProcessNode[]): string {
  return chain
    .map((n, i) => {
      const indent = '   '.repeat(i);
      const connector = i === 0 ? '' : '└─ ';
      return `${indent}${connector}${nodeLabel(n)}`;
    })
    .join('\n');
}
