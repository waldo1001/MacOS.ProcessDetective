import type { HealthCategory, HealthFinding, HealthReport, HealthSeverity, SafetyClass } from '../types.js';
import { fmtBytes, homePath } from '../render/format.js';
import { flattenItems, itemLabel } from '../health/verdict.js';

const CATEGORY_ORDER: HealthCategory[] = [
  'vitals', 'stability', 'startup', 'processes', 'tooling', 'updates', 'backup', 'clutter',
];
const CATEGORY_LABEL: Record<HealthCategory, string> = {
  vitals: 'Vitals', stability: 'Stability', startup: 'Startup', processes: 'Processes',
  tooling: 'Tooling', updates: 'Updates', backup: 'Backup', clutter: 'Clutter',
};
const SEVERITY_TAG: Record<HealthSeverity, string> = { info: 'INFO', advice: 'ADVICE', warn: 'WARN', risk: 'RISK' };
const SEVERITY_RANK: Record<HealthSeverity, number> = { risk: 3, warn: 2, advice: 1, info: 0 };
const SAFETY_ORDER: SafetyClass[] = ['regenerates', 'orphan', 'ask', 'keep', 'manual'];

/** "3 s", "12 min", "2 h", "5 d" — coarse relative age. */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s} s ago`;
  const min = Math.round(s / 60);
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function dateOf(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${dateOf(ts)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const dash = (v: string | null): string => v ?? '—';

/** Vitals as label/value pairs for the 2-column block. */
function vitalsPairs(r: HealthReport): [string, string][] {
  const v = r.vitals;
  const up = v.uptimeSec;
  return [
    ['Memory free', v.memFreePct === null ? '—' : `${v.memFreePct} %`],
    ['Swap used', v.swapUsedBytes === null ? '—' : fmtBytes(v.swapUsedBytes)],
    ['Memory pressure', dash(v.pressure)],
    ['Load (1 min)', v.loadAvg1 === null ? '—' : v.loadAvg1.toFixed(2)],
    ['Uptime', up === null ? '—' : up >= 86_400 ? `${Math.floor(up / 86_400)} d ${Math.floor((up % 86_400) / 3600)} h` : `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min`],
    ['Processes', v.processCount === null ? '—' : String(v.processCount)],
    ['Thermal', v.thermalWarning === null ? '—' : v.thermalWarning ? 'WARNING' : 'nominal'],
    ['Battery', v.batteryCycles === null ? '—' : `${v.batteryCycles} cycles · ${v.batteryHealthPct ?? '?'} % health`],
    ['Disk free', v.diskFreeBytes === null ? '—' : `${fmtBytes(v.diskFreeBytes)} of ${v.diskTotalBytes === null ? '?' : fmtBytes(v.diskTotalBytes)}`],
    ['Local snapshots', v.localSnapshots === null ? '—' : String(v.localSnapshots)],
    ['Crashes (7 d)', v.crashes7d === null ? '—' : String(v.crashes7d)],
  ];
}

function scanLine(r: HealthReport, now: number): string {
  const full = r.fullScan.at === null ? 'never' : `${ago(r.fullScan.at, now)}${r.fullScan.stale ? ' (stale)' : ''}`;
  return `${r.scope === 'full' ? 'Full scan' : 'Quick check'} · ${(r.durationMs / 1000).toFixed(1)} s · last full scan: ${full}`;
}

/** Plain-text report, same voice as `generateReport`: verdict first, no color. */
export function buildHealthReport(r: HealthReport, now = Date.now()): string {
  const out: string[] = [];
  out.push(`Mac health check — ${clock(r.at)}`, '');
  out.push(`Verdict: ${r.verdict.toUpperCase()} — ${r.verdictReason}`);
  out.push(scanLine(r, now), '');

  out.push('Vitals:');
  const pairs = vitalsPairs(r);
  for (let i = 0; i < pairs.length; i += 2) {
    const a = pairs[i]!;
    const b = pairs[i + 1];
    out.push(`  ${a[0].padEnd(16)}${a[1].padEnd(30)}${b ? `${b[0].padEnd(16)}${b[1]}` : ''}`.trimEnd());
  }
  out.push('');

  for (const cat of CATEGORY_ORDER) {
    if (cat === 'clutter') continue; // clutter is reported in the reclaimable table
    const list = r.findings.filter((f) => f.category === cat);
    if (!list.length) continue;
    out.push(`Findings — ${CATEGORY_LABEL[cat]}:`);
    for (const f of list) {
      out.push(`  [${SEVERITY_TAG[f.severity]}] ${f.title}${f.asOf ? ` (as of ${ago(f.asOf, now)})` : ''}`);
      out.push(`      ${f.detail}`);
      for (const ev of f.evidence) {
        out.push(`      $ ${ev.command}`);
        for (const line of ev.excerpt.split('\n')) if (line) out.push(`        ${line}`);
      }
    }
    out.push('');
  }

  out.push('Reclaimable (each path counted once):');
  const rows = flattenItems(r.findings).sort((a, b) => b.item.bytes - a.item.bytes);
  if (rows.length === 0) {
    out.push(
      r.fullScan.at === null
        ? '  not surveyed yet — run a full scan (`pdetective health --full`, read-only, about a minute)'
        : '  nothing found above the size thresholds',
    );
  } else {
    const byClass = SAFETY_ORDER.filter((c) => r.reclaimable.byClass[c] > 0)
      .map((c) => `${c} ${fmtBytes(r.reclaimable.byClass[c])}`)
      .join(' · ');
    out.push(`  Total ${fmtBytes(r.reclaimable.total)} (regenerates + orphan + ask)${byClass ? ` — ${byClass}` : ''}`);
    for (const { item, finding, leaf } of rows) {
      const what = item.note ? `${itemLabel(finding)} — ${item.note}` : itemLabel(finding);
      const mod = item.lastModified ? `  modified ${dateOf(item.lastModified)}` : '';
      out.push(
        `  ${fmtBytes(item.bytes).padStart(9)}  ${item.safety.padEnd(11)} ${homePath(item.path)}  [${what}]${mod}${leaf ? '' : '  (contains rows below, not counted twice)'}`,
      );
    }
  }
  out.push('');

  out.push('Skipped (NOT checked — do not read these as clean):');
  if (r.skipped.length === 0) out.push('  nothing');
  for (const s of r.skipped) out.push(`  ${s.id}: ${s.reason}`);
  if (r.refreshing.length) out.push(`  still refreshing in the background: ${r.refreshing.join(', ')}`);
  out.push('');

  out.push('Manual steps:');
  const manual = r.findings.filter((f) => f.manualSteps?.length);
  if (manual.length === 0) out.push('  none');
  for (const f of manual) {
    out.push(`  ${f.title}`);
    for (const step of f.manualSteps!) out.push(`    ${step}`);
  }
  return out.join('\n');
}

const QUESTIONS = [
  'Please act as a macOS performance and maintenance expert and tell me:',
  '1. Is anything here a real health problem, or is it all clutter?',
  '2. Which three items would you act on first, and why?',
  '3. Which findings need more evidence before acting?',
  '4. Say explicitly which items need sudo or a restart.',
  "Anything under 'Skipped' was NOT checked — do not treat it as clean.",
].join('\n');

/**
 * A self-contained, copy-paste prompt: the health snapshot plus the questions, for
 * any AI agent (no API key needed here).
 */
export function buildHealthPrompt(r: HealthReport, now = Date.now()): string {
  return [
    "I'm checking the health of my Mac. A read-only diagnostics tool captured the snapshot below.",
    '',
    QUESTIONS,
    '',
    '--- health snapshot ---',
    buildHealthReport(r, now),
    '--- end snapshot ---',
  ].join('\n');
}

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** The findings file written by hand today: verdict table, what to fix, clutter table, commands used. */
export function buildHealthMarkdown(r: HealthReport, now = Date.now()): string {
  const out: string[] = [];
  out.push(`# Mac health check — ${dateOf(r.at)}`, '');
  out.push(`**Verdict: ${r.verdict}** — ${r.verdictReason}`, '');
  out.push(`_${scanLine(r, now)}_`, '');

  out.push('| Area | State | Evidence |', '|---|---|---|');
  for (const cat of CATEGORY_ORDER) {
    const list = r.findings.filter((f) => f.category === cat);
    if (cat === 'clutter') {
      const n = flattenItems(r.findings).filter((x) => x.leaf && x.item.safety !== 'keep').length;
      if (r.fullScan.at !== null || n) {
        out.push(`| Clutter | ${fmtBytes(r.reclaimable.total)} reclaimable | ${n} items — see the table below |`);
      }
      continue;
    }
    if (!list.length) continue;
    const worst = list.reduce((a, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[a.severity] ? f : a));
    const state = worst.severity === 'info' ? 'ok' : worst.severity;
    const top = [...list].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]).slice(0, 2);
    out.push(`| ${CATEGORY_LABEL[cat]} | ${state} | ${esc(top.map((f) => f.title).join('; '))} |`);
  }
  out.push('');

  out.push('## What is worth fixing', '');
  const fix = r.findings.filter((f) => f.category !== 'clutter' && f.severity !== 'info');
  if (fix.length === 0) out.push('Nothing — no warnings or advice.', '');
  for (const f of fix) {
    out.push(`### [${SEVERITY_TAG[f.severity]}] ${f.title}${f.asOf ? ` (as of ${ago(f.asOf, now)})` : ''}`, '', f.detail, '');
    if (f.manualSteps?.length) out.push('```', ...f.manualSteps, '```', '');
  }

  out.push('## Clutter (reclaimable space)', '');
  const rows = flattenItems(r.findings).sort((a, b) => b.item.bytes - a.item.bytes);
  if (rows.length === 0) {
    out.push(r.fullScan.at === null ? 'Not surveyed yet — run a full scan.' : 'Nothing found above the size thresholds.', '');
  } else {
    out.push('| Size | Where | What | Safe? |', '|---|---|---|---|');
    for (const { item, finding, leaf } of rows) {
      const what = item.note ? `${itemLabel(finding)} — ${item.note}` : itemLabel(finding);
      out.push(`| ${fmtBytes(item.bytes)} | \`${homePath(item.path)}\` | ${esc(what)}${leaf ? '' : ' (contains rows below)'} | ${item.safety} |`);
    }
    out.push('', `Total reclaimable (regenerates + orphan + ask, each path once): **${fmtBytes(r.reclaimable.total)}**.`, '');
  }

  const commands = [...new Set(r.findings.flatMap((f) => f.evidence.map((e) => e.command)))];
  out.push('## Commands used', '');
  if (commands.length) out.push('```', ...commands, '```', '');
  else out.push('none', '');

  if (r.skipped.length) {
    out.push('## Skipped (not checked)', '', ...r.skipped.map((s) => `- ${s.id}: ${s.reason}`), '');
  }
  out.push('## Clean-ups executed', '', 'none — Phase 1 is read-only', '');
  return out.join('\n');
}
