import type { Enrichment, ProcessNode } from '../types.js';
import { parentChain } from '../tree/build.js';
import { color } from '../util/color.js';
import { fmtElapsed, fmtPct, homePath, shorten } from './format.js';
import { renderChain, renderSubtree } from './tree.js';

function heading(s: string): string {
  return color.bold(color.yellow(s));
}

/** Rich, colorized detail view for a single inspected process. */
export function renderInspect(node: ProcessNode, enr: Enrichment): string {
  const p = node.proc;
  const out: string[] = [];

  out.push(heading(`${p.name}  PID ${p.pid}`));
  out.push(`  ${color.dim('CPU')}      ${color.green(fmtPct(p.cpu))}`);
  out.push(`  ${color.dim('MEM')}      ${fmtPct(p.mem)}`);
  out.push(`  ${color.dim('Elapsed')}  ${fmtElapsed(p.elapsedSeconds)}`);
  out.push(`  ${color.dim('User')}     ${p.user}`);
  out.push(`  ${color.dim('Exec')}     ${homePath(p.execPath) ?? 'unknown'}`);
  out.push(`  ${color.dim('Cwd')}      ${homePath(enr.cwd) ?? 'unknown'}`);
  out.push(`  ${color.dim('Command')}  ${shorten(p.command, 120)}`);
  out.push('');

  if (enr.interpretation.summary) {
    out.push(heading('Interpretation'));
    out.push(`  ${enr.interpretation.summary}`);
    out.push('');
  }

  out.push(heading('Parent chain'));
  out.push(renderChain(parentChain(node)));
  out.push('');

  if (node.children.length) {
    out.push(heading('Children'));
    out.push(renderSubtree(node));
    out.push('');
  }

  if (enr.packageJson) {
    out.push(heading('package.json'));
    out.push(`  ${homePath(enr.packageJson.path)}`);
    const entries = Object.entries(enr.packageJson.scripts);
    if (entries.length) {
      for (const [k, v] of entries) {
        const active = k === enr.interpretation.scriptName;
        const bullet = active ? color.green('▶') : ' ';
        out.push(`  ${bullet} ${color.cyan(k.padEnd(14))} ${color.dim(shorten(v, 80))}`);
      }
    }
    out.push('');
  }

  out.push(heading('Open ports'));
  if (enr.ports.length) {
    for (const port of enr.ports) {
      out.push(`  ${port.protocol} ${port.address}${port.state ? color.dim(` (${port.state})`) : ''}`);
    }
  } else {
    out.push(`  ${color.dim('none detected (or insufficient permissions)')}`);
  }

  return out.join('\n');
}
