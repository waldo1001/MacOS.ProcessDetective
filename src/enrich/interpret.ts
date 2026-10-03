import type { Interpretation, PackageJsonInfo, RawProcess } from '../types.js';
import { detectBin, friendlyLabel, isDevProcess } from './classify.js';
import { resolveScriptName } from './packageJson.js';

/** First token of a script body, reduced to its basename (e.g. "vite"). */
function firstBin(script: string): string | null {
  const first = script.trim().split(/\s+/)[0];
  if (!first) return null;
  return first.split('/').pop() ?? null;
}

/**
 * Combine classification + package.json knowledge into a single human-facing
 * interpretation of what a process actually is and why it might be running hot.
 */
export function interpret(proc: RawProcess, pkg: PackageJsonInfo | null): Interpretation {
  const isDev = isDevProcess(proc);

  let scriptName: string | null = null;
  let resolvedScript: string | null = null;
  if (pkg) {
    scriptName = resolveScriptName(proc.command, pkg.scripts);
    if (scriptName) resolvedScript = pkg.scripts[scriptName] ?? null;
  }

  // Prefer a bin referenced directly in the command; otherwise infer it from the
  // resolved script body (e.g. scripts.dev = "vite --host" -> "vite").
  const bin = detectBin(proc.command) ?? (resolvedScript ? firstBin(resolvedScript) : null);
  const label = friendlyLabel(proc.name, bin);

  const parts: string[] = [];
  if (label) parts.push(label);
  if (scriptName && resolvedScript) parts.push(`npm script "${scriptName}" → ${resolvedScript}`);
  if (pkg?.name) parts.push(`project ${pkg.name}`);
  const summary = parts.length ? parts.join(' — ') : null;

  return { isDev, label, scriptName, resolvedScript, bin, summary };
}
