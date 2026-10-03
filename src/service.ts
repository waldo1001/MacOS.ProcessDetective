import { homedir } from 'node:os';
import { collectProcesses } from './collect/ps.js';
import { getCwd, getOpenFileIntel, getPorts } from './collect/lsof.js';
import { getRecentCrashes } from './collect/crashes.js';
import { isDevProcess } from './enrich/classify.js';
import { interpret } from './enrich/interpret.js';
import { findNearestPackageJson } from './enrich/packageJson.js';
import { sysProcessHint } from './enrich/sysprocess.js';
import { dockerPs } from './collect/docker.js';
import { buildTree } from './tree/build.js';
import type { Enrichment, ProcessNode, ProcessTree } from './types.js';

/** Take a process snapshot and build the parent/child tree. */
export async function snapshot(): Promise<ProcessTree> {
  return buildTree(await collectProcesses());
}

/**
 * Enrich a single node with cwd, open ports, open files, crash reports,
 * system-process hint, nearest package.json and a derived interpretation.
 * Each step degrades gracefully to null/empty.
 */
export async function enrich(node: ProcessNode): Promise<Enrichment> {
  const [cwd, ports, openFileIntel, recentCrashes] = await Promise.all([
    getCwd(node.proc.pid),
    getPorts(node.proc.pid),
    getOpenFileIntel(node.proc.pid, homedir()),
    getRecentCrashes(),
  ]);
  const { files: openFiles, hotspots: dirHotspots, owners } = openFileIntel;
  const packageJson = findNearestPackageJson(cwd);
  const interpretation = interpret(node.proc, packageJson);
  const sysHint = sysProcessHint(node.proc.name);

  const enr: Enrichment = {
    cwd,
    packageJson,
    ports,
    openFiles,
    recentCrashes,
    sysHint,
    interpretation,
    dirHotspots,
    owners,
  };

  // Only run docker ps for container-runtime processes (gated by isContainerRuntime).
  // dockerPs is fast (~100-300ms). dockerStats is NEVER run here (on-demand only).
  if (sysHint?.isContainerRuntime) {
    enr.docker = await dockerPs();
  }

  return enr;
}

/** Hot processes above a CPU threshold, optionally limited to dev tooling. */
export function hotProcesses(
  tree: ProcessTree,
  threshold: number,
  devOnly = false,
): ProcessNode[] {
  return tree.all
    .filter((n) => n.proc.cpu >= threshold && (!devOnly || isDevProcess(n.proc)))
    .sort((a, b) => b.proc.cpu - a.proc.cpu);
}
