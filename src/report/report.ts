import { homedir } from 'node:os';
import type { CrashGroup, Enrichment, ProcessNode } from '../types.js';
import { parentChain } from '../tree/build.js';
import { fmtPct, friendlyNodeName, homePath } from '../render/format.js';
import { rankOpenFiles } from '../enrich/openfiles.js';

/** Format a timestamp as a relative "Xm ago" / "Xh ago" string. */
function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  return `${diffH}h ago`;
}

/** Ancestors we treat as "launchers" worth naming in the root-cause sentence. */
const LAUNCHER_HINTS = [
  'claude', 'code', 'cursor', 'iterm', 'terminal', 'warp', 'ghostty',
  'alacritty', 'kitty', 'wezterm', 'electron', 'tmux',
];

function isLauncher(node: ProcessNode): boolean {
  const n = node.proc.name.toLowerCase();
  if (LAUNCHER_HINTS.some((h) => n.includes(h))) return true;
  return /\/[^/]+\.app\//.test(node.proc.execPath ?? '');
}

/** Plain-text (no ANSI) ancestry cascade for copy/paste reports. */
function plainChain(chain: ProcessNode[]): string {
  return chain
    .map((n, i) => `${'    '.repeat(i)}${i === 0 ? '' : '└── '}${friendlyNodeName(n)}`)
    .join('\n');
}

/** Build the "Likely root cause" narrative from the chain + enrichment. */
function rootCause(chain: ProcessNode[], enr: Enrichment): string {
  const ancestors = chain.slice(0, -1); // everything above the hot process
  const launcher = [...ancestors].reverse().find(isLauncher);
  const runNode = ancestors.find((n) => /\b(?:run|run-script)\s+/.test(n.proc.command ?? ''));
  const cwd = homePath(enr.cwd);
  const { scriptName, resolvedScript, label } = enr.interpretation;

  const sentences: string[] = [];
  const lead = launcher ? friendlyNodeName(launcher) : 'A process';
  if (runNode) {
    const where = cwd ? ` in ${cwd}` : '';
    sentences.push(`${lead} launched a shell, which ran ${friendlyNodeName(runNode)}${where}.`);
  } else if (scriptName) {
    const where = cwd ? ` in ${cwd}` : '';
    sentences.push(`${lead} started npm script "${scriptName}"${where}.`);
  } else {
    const what = label ?? 'this process';
    sentences.push(`${lead} appears to be responsible for ${what}.`);
  }
  if (resolvedScript) sentences.push(`That script resolved to: ${resolvedScript}`);
  return sentences.join('\n');
}

/** Format a `sizeKb` value as a human MB/GB clause, or null when unavailable. */
function fmtHotspotSize(sizeKb: number | null): string | null {
  if (sizeKb === null) return null;
  if (sizeKb >= 1024 * 1024) return `${(sizeKb / (1024 * 1024)).toFixed(1)} GB`;
  return `${(sizeKb / 1024).toFixed(1)} MB`;
}

/** Status of one on-demand collection source (all share the same shape). */
function onDemandStatus(
  field: { available: boolean; note: string | null } | undefined | null,
  button: string,
): string {
  if (field == null) return `not collected (click "${button}")`;
  if (field.available) return 'collected';
  return field.note ? `attempted — unavailable (${field.note})` : 'attempted — unavailable';
}

/**
 * Body lines for the "Collection status" report block (without the heading and
 * without the trailing → advisory). PURE, unit-tested directly.
 */
export function collectionStatus(enr: Enrichment): string[] {
  const crashCount = enr.recentCrashes.length;
  const ownerCount = enr.owners?.extensions.length ?? 0;
  const hotspotCount = enr.dirHotspots?.length ?? 0;

  return [
    `open files: ${enr.openFiles.length ? `collected — ${enr.openFiles.length} entries` : 'collected — none detected'}`,
    `open ports: ${enr.ports.length ? `collected — ${enr.ports.length} open` : 'collected — none detected'}`,
    `crashes: ${crashCount ? `collected — ${crashCount} group${crashCount === 1 ? '' : 's'}` : 'collected — none in the last hour'}`,
    `hosted extensions: ${ownerCount ? `collected — ${ownerCount} identified` : 'collected — none identified'}`,
    `directory hotspots: ${hotspotCount ? `collected — ${hotspotCount} found` : 'collected — none found'}`,
    `stack sample: ${onDemandStatus(enr.stackSample, 'Sample stack')}`,
    `read activity: ${onDemandStatus(enr.readActivity, 'Read activity')}`,
    `process log: ${onDemandStatus(enr.logTail, 'Process log')}`,
    `filesystem churn: ${onDemandStatus(enr.fsChurn, 'Filesystem churn (admin)')}`,
    `containers: ${
      enr.docker == null
        ? 'not collected (only gathered for container-runtime processes)'
        : enr.docker.available
          ? 'collected'
          : enr.docker.note
            ? `attempted — unavailable (${enr.docker.note})`
            : 'attempted — unavailable'
    }`,
  ];
}

/** A short, actionable recommendation line. */
function recommendation(enr: Enrichment): string {
  const { label, resolvedScript } = enr.interpretation;
  const project = enr.packageJson?.name;
  if (label && project) {
    return `This appears to be the ${label} for project ${project}. Stop it from that project's terminal/IDE if the spike is unexpected.`;
  }
  if (label) return `This appears to be ${label}. Stop it from its owning terminal/IDE if unexpected.`;
  if (resolvedScript) return `Running: ${resolvedScript}. Trace it to the owning terminal before stopping.`;
  return 'Could not classify this process. Inspect the parent chain and working directory above to find its owner.';
}

/**
 * Produce the full copy-friendly "CPU spike investigation" report for a node.
 * Pure text (no color) so it pastes cleanly into tickets/chat.
 */
export function generateReport(node: ProcessNode, enr: Enrichment): string {
  const chain = parentChain(node);
  const p = node.proc;
  const out: string[] = [];

  out.push('CPU spike investigation', '');
  out.push('Hot process:');
  out.push(`${p.name} PID ${p.pid}, ${fmtPct(p.cpu)} CPU`);
  if (p.command) out.push(`Command: ${p.command}`);
  out.push('');

  out.push('Likely root cause:');
  out.push(rootCause(chain, enr));
  out.push('');

  out.push('Parent chain:');
  out.push(plainChain(chain));
  out.push('');

  out.push('Working directory:');
  out.push(homePath(enr.cwd) ?? 'unknown');
  out.push('');

  if (enr.packageJson) {
    const pj = enr.packageJson;
    out.push('Package:');
    out.push(`${pj.name ?? '(unnamed)'} — ${homePath(pj.path)}`);
    if (enr.interpretation.scriptName && enr.interpretation.resolvedScript) {
      out.push(
        `scripts.${enr.interpretation.scriptName} = "${enr.interpretation.resolvedScript}"`,
      );
    }
    out.push('');
  }

  out.push('Open ports:');
  if (enr.ports.length) {
    for (const port of enr.ports) {
      out.push(`${port.protocol} ${port.address}${port.state ? ` (${port.state})` : ''}`);
    }
  } else {
    out.push('none detected');
  }
  out.push('');

  // System process hint
  if (enr.sysHint) {
    out.push('System process:');
    out.push(`${enr.sysHint.label} — ${enr.sysHint.what}`);
    if (enr.sysHint.lookWhere) out.push(`Look in: ${enr.sysHint.lookWhere}`);
    out.push('');
  }

  // Hosted extensions — names what actually runs inside a generic helper process
  if (enr.owners?.extensions.length) {
    const owners = enr.owners;
    out.push(`Hosted extensions (${owners.host}):`);
    for (const ext of owners.extensions) {
      const version = ext.version ? ` ${ext.version}` : '';
      const builtinMark = ext.builtin ? ' (built-in)' : '';
      const nativeMark = ext.nativeModuleNames.length
        ? `   ← native module loaded (${ext.nativeModuleNames.slice(0, 2).join(', ')})`
        : '';
      out.push(`  ${ext.id}${version}${builtinMark}${nativeMark}`);
    }
    out.push(
      '  → This is a generic helper process; the extensions above are what run inside it.',
    );
    out.push('    Attribute the CPU to one of them, not to the helper\'s own name.');
    out.push('');
  }

  // Directory hotspots — surfaced above the individual-file list so a concentrated
  // workload is never lost to the 6-line cut below.
  if (enr.dirHotspots?.length) {
    out.push('Directory hotspots:');
    for (const h of enr.dirHotspots) {
      const sizeClause = fmtHotspotSize(h.sizeKb);
      const extClause = h.dominantExt !== null ? `mostly .${h.dominantExt}` : null;
      const parenParts = [sizeClause, extClause].filter((p): p is string => p !== null);
      const paren = parenParts.length ? `  (${parenParts.join(', ')})` : '';
      out.push(`  ${h.fdCount} open files under ${homePath(h.dir)}${paren}`);
      if (h.sampleFiles.length) {
        out.push(`    e.g. ${h.sampleFiles.join(', ')}`);
      }
    }
    out.push(
      '  → Many descriptors concentrated in one directory tree usually IS the workload.',
    );
    out.push('');
  }

  // Open files — ranked by signal/noise
  if (enr.openFiles.length) {
    out.push('Open files (notable):');
    const ranked = rankOpenFiles(enr.openFiles, homedir(), (enr.dirHotspots ?? []).map((h) => h.dir));
    for (const r of ranked.slice(0, 6)) {
      const notableMark = r.notable ? '   ← likely the workload' : '';
      out.push(`[${r.file.type}] ${r.file.path}${notableMark}`);
    }
    out.push('');
  }

  // Recent crashes
  if (enr.recentCrashes.length) {
    out.push('Recent crashes (last hour):');
    // If this is a crash handler, prefer a looping group as the probable culprit
    if (enr.sysHint?.isCrashHandler && enr.recentCrashes.length > 0) {
      const culprit: CrashGroup =
        enr.recentCrashes.find((c) => c.looping) ?? enr.recentCrashes[0]!;
      out.push(
        `→ Probable culprit: ${culprit.process} (${culprit.count} crash${culprit.count > 1 ? 'es' : ''} in the last hour${culprit.looping ? ' — LOOPING' : ''})`,
      );
    }
    for (const c of enr.recentCrashes.slice(0, 5)) {
      const loopMark = c.looping ? ' — LOOPING' : '';
      out.push(
        `  ${c.process}: ${c.count} crash${c.count > 1 ? 'es' : ''}, last ${relativeTime(c.lastAt)}${loopMark}`,
      );
    }
    out.push('');
  }

  // Filesystem churn attribution — only present when fetched on-demand
  if (enr.fsChurn?.available) {
    const fc = enr.fsChurn;
    out.push(`Filesystem churn (system-wide, ${fc.windowSeconds}s):`);
    out.push(`  ${fc.totalEvents} fs events`);
    for (const proc of fc.topProcesses) {
      out.push(`  ${proc.process} ×${proc.count}${proc.commonDir ? `  under ${proc.commonDir}` : ''}`);
      if (proc.samplePaths.length) {
        out.push(`    e.g. ${proc.samplePaths[0]}`);
      }
    }
    if (fc.note) out.push(`  ${fc.note}`);
    if (fc.truncated) out.push('  (truncated)');
    if (enr.sysHint?.isFsSymptom) {
      out.push(
        '  → This daemon is a symptom; the process above is generating the file-event flood.',
      );
    }
    out.push('');
  }

  // Read-activity delta — only present when fetched on-demand
  if (enr.readActivity?.available) {
    const ra = enr.readActivity;
    out.push(`Read activity (2 lsof snapshots, ${ra.gapMs}ms apart):`);
    out.push(`  Verdict: ${ra.verdict}`);
    out.push(
      `  fds: ${ra.fdsBefore} → ${ra.fdsAfter}   (+${ra.fdsAdded} new, -${ra.fdsRemoved} closed, ${ra.offsetsAdvanced} offsets advanced)`,
    );
    if (ra.commonDir) out.push(`  Active under: ${homePath(ra.commonDir)}`);
    if (ra.sampleAdded.length) out.push(`    e.g. ${ra.sampleAdded[0]}`);
    out.push('');
  }

  // Docker / container snapshot
  if (enr.docker?.available) {
    const d = enr.docker;
    out.push('Containers (OrbStack/Docker):');
    out.push(`  total running: ${d.totalRunning}`);
    if (d.byImage.length) {
      const imageList = d.byImage.map((b) => `${b.image} ×${b.count}`).join(', ');
      out.push(`  by image: ${imageList}`);
    }
    out.push(`  recently started (<30s): ${d.recentlyStarted}   ← churn`);
    out.push(`  Testcontainers-managed: ${d.testcontainers}`);
    if (d.recentlyStarted >= 5 && d.testcontainers > 0) {
      out.push(
        '  → High container churn — likely a test/CI run spinning up a container per test.',
      );
    }
    out.push('');
  }

  // Process log tail — only when fetched on-demand
  if (enr.logTail?.available) {
    const lt = enr.logTail;
    out.push(`Process log (last ${lt.windowMinutes}m):`);
    out.push(`  ${lt.totalLines} entries, ${lt.errorCount} error/fault`);
    if (lt.topPatterns.length) {
      out.push('  Top repeated messages:');
      for (const p of lt.topPatterns) {
        const sys = p.subsystem ? `[${p.subsystem}] ` : '';
        out.push(`    ${p.count}x ${sys}${p.sample}`);
      }
    }
    if (lt.note) out.push(`  (${lt.note})`);
    out.push('');
  }

  // Stack sample — always emitted (present or placeholder)
  out.push('Stack sample:');
  if (enr.stackSample?.available) {
    const ss = enr.stackSample;
    out.push(`Verdict: ${ss.verdict}`);
    out.push(`CPU-bound: ${ss.cpuBound ? 'yes' : 'no'}`);
    if (ss.threadCount) out.push(`Threads sampled: ${ss.threadCount}`);
    if (ss.topFrames.length) {
      out.push('Top frames (deepest first):');
      for (const f of ss.topFrames) {
        out.push(`  ${f.samples}x ${f.symbol}${f.binary ? ` (${f.binary})` : ''}`);
      }
    }
  } else {
    out.push(
      'not captured (run "Sample stack"; use admin for root processes)',
    );
  }
  out.push('');

  out.push('Collection status:');
  for (const line of collectionStatus(enr)) out.push(`  ${line}`);
  out.push(
    '  → "collected — none …" means it was checked and was genuinely empty. Do not ask for it again.',
  );
  out.push('');

  out.push('Recommendation:');
  out.push(recommendation(enr));

  return out.join('\n');
}
