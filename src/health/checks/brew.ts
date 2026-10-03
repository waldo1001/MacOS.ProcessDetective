import type { HealthCheck, HealthContext, CheckResult } from '../context.js';
import type { HealthFinding } from '../../types.js';
import { fmtBytes } from '../../render/format.js';
import { evidence } from '../util.js';

/** Names of outdated formulae and casks from `brew outdated --json=v2`; [] on unparseable input. */
export function parseBrewOutdated(json: string): string[] {
  try {
    const data = JSON.parse(json) as { formulae?: { name?: string }[]; casks?: { name?: string }[] };
    return [...(data.formulae ?? []), ...(data.casks ?? [])]
      .map((x) => x.name)
      .filter((n): n is string => typeof n === 'string' && n !== '');
  } catch {
    return [];
  }
}

/** Bytes from `would free approximately 248.6MB`; 0 when the line is absent (nothing to free). */
export function parseBrewCleanup(text: string): number {
  const m = text.match(/would free approximately\s+([\d.]+)\s*([KMGT]?B)/i);
  if (!m) return 0;
  const mult: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(parseFloat(m[1]!) * (mult[m[2]!.toUpperCase()] ?? 1));
}

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];

/** Never let brew touch the network or phone home: these two variables are always set. */
const BREW_ENV = ['HOMEBREW_NO_AUTO_UPDATE=1', 'HOMEBREW_NO_ANALYTICS=1'];

async function run(ctx: HealthContext): Promise<CheckResult> {
  const brew = BREW_PATHS.find((p) => ctx.exists(p));
  if (!brew) return { findings: [] };
  const viaEnv = (args: string[]) => ctx.run('/usr/bin/env', [...BREW_ENV, brew, ...args], 20_000);

  const [out, clean] = await Promise.all([viaEnv(['outdated', '--json=v2']), viaEnv(['cleanup', '-n'])]);
  if (out.failed && !out.stdout.trim()) throw new Error(`brew outdated failed: ${out.stderr.trim().split('\n')[0] || 'timed out'}`);
  if (clean.failed && !clean.stdout.trim() && clean.stderr.trim()) {
    throw new Error(`brew cleanup -n failed: ${clean.stderr.trim().split('\n')[0]}`);
  }

  const outdated = parseBrewOutdated(out.stdout);
  const freeable = parseBrewCleanup(clean.stdout);
  const findings: HealthFinding[] = [];
  const ev = [
    evidence('HOMEBREW_NO_AUTO_UPDATE=1 brew outdated --json=v2', outdated.length ? outdated : ['(nothing outdated)']),
    evidence('HOMEBREW_NO_AUTO_UPDATE=1 brew cleanup -n', clean.stdout.trim() || '(nothing to clean)'),
  ];

  if (process.env['PD_HEALTH_BREW_DOCTOR'] === '1') {
    const doc = await ctx.run('/usr/bin/env', [...BREW_ENV, brew, 'doctor'], 60_000);
    const warnings = (doc.stdout + doc.stderr).split('\n').filter((l) => /^Warning:/.test(l));
    findings.push({
      id: 'brew:doctor',
      checkId: 'brew',
      category: 'tooling',
      severity: 'info',
      title: warnings.length ? `brew doctor: ${warnings.length} warnings` : 'brew doctor: ready to brew',
      detail: warnings.length ? 'brew doctor lists configuration problems; read them before upgrading.' : 'brew doctor found nothing to fix.',
      evidence: [evidence('HOMEBREW_NO_AUTO_UPDATE=1 brew doctor', warnings.length ? warnings : (doc.stdout + doc.stderr))],
    });
  }

  if (outdated.length > 0 || freeable > 0) {
    const parts: string[] = [];
    if (outdated.length) parts.push(`${outdated.length} outdated`);
    if (freeable > 0) parts.push(`\`brew cleanup\` would free ${fmtBytes(freeable)}`);
    findings.push({
      id: 'brew',
      checkId: 'brew',
      category: 'tooling',
      severity: 'advice',
      title: `Homebrew: ${parts.join('; ')}`,
      detail:
        'Outdated packages are not upgraded by this tool. Old downloads and versions that cleanup would remove are also covered by the Homebrew cache entry of the clutter survey.',
      evidence: ev,
      actionId: 'brew-cleanup',
    });
  } else {
    findings.push({
      id: 'brew',
      checkId: 'brew',
      category: 'tooling',
      severity: 'info',
      title: 'Homebrew: up to date, nothing to clean',
      detail: 'No outdated formulae or casks, and `brew cleanup` has nothing to remove.',
      evidence: ev,
    });
  }
  return { findings };
}

export const brewCheck: HealthCheck = {
  id: 'brew',
  category: 'tooling',
  scope: 'quick',
  ttlMs: 60 * 60_000,
  timeoutMs: 90_000,
  run,
};
