import type {
  ClutterItem, HealthCategory, HealthFinding, HealthReport, HealthSeverity, HealthVerdict, HealthVitals, SafetyClass,
} from '../types.js';
import { fmtBytes } from '../render/format.js';

const GIB = 1024 ** 3;

const CATEGORY_ORDER: HealthCategory[] = [
  'vitals', 'stability', 'startup', 'processes', 'tooling', 'updates', 'backup', 'clutter',
];
const SEVERITY_RANK: Record<HealthSeverity, number> = { risk: 3, warn: 2, advice: 1, info: 0 };

/** Category order, then risk > warn > advice > info, then reclaimable bytes (desc). Does not mutate. */
export function sortFindings(findings: HealthFinding[]): HealthFinding[] {
  return [...findings].sort(
    (a, b) =>
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.reclaimableBytes ?? 0) - (a.reclaimableBytes ?? 0),
  );
}

/**
 * What a Reclaimable row belongs to: the finding title without its aggregate size
 * ("Xcode DerivedData: 113 GB in 14 items" → "Xcode DerivedData"), so a row does not
 * read as if the whole group were its own size.
 */
export function itemLabel(f: HealthFinding): string {
  return f.title.replace(/: [\d.]+ [KMGT]?B(?: in \d+ items)?$/, '');
}

/** One row of the Reclaimable table. `leaf` is false when another row lies inside this item. */
export interface FlatItem {
  item: ClutterItem;
  finding: HealthFinding;
  leaf: boolean;
}

// More conservative class wins when the same path is reported twice.
const CAUTION: Record<SafetyClass, number> = { regenerates: 0, orphan: 1, ask: 2, manual: 3, keep: 4 };

/**
 * Flatten every finding's items. An item is a leaf unless another item's path is
 * inside it, so a folder and the log files inside it are never counted twice.
 * Identical paths collapse to one row (the more conservative class).
 */
export function flattenItems(findings: HealthFinding[]): FlatItem[] {
  const byPath = new Map<string, FlatItem>();
  for (const finding of findings) {
    for (const item of finding.items ?? []) {
      const prev = byPath.get(item.path);
      if (!prev || CAUTION[item.safety] > CAUTION[prev.item.safety]) byPath.set(item.path, { item, finding, leaf: true });
    }
  }
  const rows = [...byPath.values()];
  for (const row of rows) {
    const prefix = `${row.item.path}/`;
    row.leaf = !rows.some((other) => other !== row && other.item.path.startsWith(prefix));
  }
  return rows;
}

/** Totals over leaf items only. `total` = regenerates + orphan + ask. */
export function computeReclaimable(findings: HealthFinding[]): HealthReport['reclaimable'] {
  const byClass: Record<SafetyClass, number> = { regenerates: 0, orphan: 0, ask: 0, keep: 0, manual: 0 };
  for (const row of flattenItems(findings)) if (row.leaf) byClass[row.item.safety] += row.item.bytes;
  return { total: byClass.regenerates + byClass.orphan + byClass.ask, byClass };
}

const titles = (fs: HealthFinding[]): string => fs.slice(0, 3).map((f) => f.title).join('; ');

/**
 * Vitals decide the verdict; clutter never does. Clutter alone can never produce
 * `degraded` or `sick`.
 */
export function computeVerdict(
  findings: HealthFinding[],
  reclaimable: HealthReport['reclaimable'],
  vitals: HealthVitals,
): { verdict: HealthVerdict; reason: string } {
  const inCats = (cats: HealthCategory[], sev: HealthSeverity[]): HealthFinding[] =>
    findings.filter((f) => cats.includes(f.category) && sev.includes(f.severity));

  const sick = inCats(['vitals', 'stability'], ['risk']);
  if (sick.length) return { verdict: 'sick', reason: titles(sick) };

  const degraded = inCats(['vitals', 'stability', 'processes', 'backup'], ['warn', 'risk']);
  if (degraded.length) return { verdict: 'degraded', reason: titles(degraded) };

  const regen = reclaimable.byClass.regenerates + reclaimable.byClass.orphan;
  const warns = inCats(['startup', 'tooling', 'updates'], ['warn', 'risk']);
  if (regen >= 20 * GIB || warns.length) {
    const parts: string[] = [];
    if (regen >= 20 * GIB) parts.push(`${fmtBytes(regen)} reclaimable clutter`);
    if (warns.length) parts.push(`${warns.length} startup/tooling/update ${warns.length === 1 ? 'warning' : 'warnings'}`);
    return { verdict: 'cluttered', reason: `no vitals or stability problem; ${parts.join(' and ')}` };
  }

  const ok: string[] = [];
  if (vitals.pressure === 'normal') ok.push('no memory pressure');
  if (vitals.crashes7d !== null) ok.push('no crash loop');
  if (vitals.diskFreeBytes !== null) ok.push(`${fmtBytes(vitals.diskFreeBytes)} free`);
  return { verdict: 'healthy', reason: ok.length ? ok.join(', ') : 'no problems found' };
}
