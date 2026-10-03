import { homedir } from 'node:os';
import type { Enrichment, ProcessNode, ProcessTree } from '../types.js';
import { isDevProcess } from '../enrich/classify.js';
import { parentChain } from '../tree/build.js';
import { friendlyNodeName } from '../render/format.js';
import { generateReport } from '../report/report.js';
import { buildInvestigationPrompt } from '../report/prompt.js';
import { rankOpenFiles } from '../enrich/openfiles.js';
import type { ProcStat } from '../collect/proctop.js';

/** JSON-safe row for the process list. */
export interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  friendly: string;
  command: string | null;
  cpu: number;
  mem: number;
  elapsedSeconds: number;
  user: string;
  isDev: boolean;
  /** Thread count from `top`; null when not in the sampled set. */
  threads: number | null;
  /** Energy impact from `top`; null when not in the sampled set. */
  energy: number | null;
}

/** Serialize a whole snapshot into the list the web UI polls. */
export function processesPayload(tree: ProcessTree, stats?: Map<number, ProcStat>): ProcRow[] {
  return tree.all
    .map((n) => {
      const s = stats?.get(n.proc.pid);
      return {
        pid: n.proc.pid,
        ppid: n.proc.ppid,
        name: n.proc.name,
        friendly: friendlyNodeName(n),
        command: n.proc.command,
        cpu: n.proc.cpu,
        mem: n.proc.mem,
        elapsedSeconds: n.proc.elapsedSeconds,
        user: n.proc.user,
        isDev: isDevProcess(n.proc),
        threads: s ? s.threads : null,
        energy: s ? s.energy : null,
      };
    })
    .sort((a, b) => b.cpu - a.cpu);
}

export interface InspectExtras { threads: number | null; energy: number | null; fdCount: number | null; }

/** Full detail for one selected process, including the copy-ready report text. */
export function inspectPayload(node: ProcessNode, enr: Enrichment, extra?: InspectExtras) {
  return {
    pid: node.proc.pid,
    ppid: node.proc.ppid,
    name: node.proc.name,
    cpu: node.proc.cpu,
    mem: node.proc.mem,
    elapsedSeconds: node.proc.elapsedSeconds,
    user: node.proc.user,
    execPath: node.proc.execPath,
    command: node.proc.command,
    threads: extra?.threads ?? null,
    energy: extra?.energy ?? null,
    fdCount: extra?.fdCount ?? null,
    cwd: enr.cwd,
    chain: parentChain(node).map((n) => ({
      pid: n.proc.pid,
      name: friendlyNodeName(n),
      cpu: n.proc.cpu,
    })),
    children: node.children.map((c) => ({
      pid: c.proc.pid,
      name: friendlyNodeName(c),
      cpu: c.proc.cpu,
      command: c.proc.command,
    })),
    interpretation: enr.interpretation,
    packageJson: enr.packageJson
      ? { name: enr.packageJson.name, path: enr.packageJson.path, scripts: enr.packageJson.scripts }
      : null,
    ports: enr.ports,
    openFiles: enr.openFiles,
    openFilesRanked: rankOpenFiles(
      enr.openFiles,
      homedir(),
      (enr.dirHotspots ?? []).map((h) => h.dir),
    ).map((r) => ({
      path: r.file.path,
      type: r.file.type,
      notable: r.notable,
      cls: r.cls,
    })),
    recentCrashes: enr.recentCrashes,
    sysHint: enr.sysHint,
    stackSample: enr.stackSample ?? null,
    docker: enr.docker ?? null,
    logTail: enr.logTail ?? null,
    fsChurn: enr.fsChurn ?? null,
    dirHotspots: enr.dirHotspots ?? [],
    owners: enr.owners ?? null,
    readActivity: enr.readActivity ?? null,
    report: generateReport(node, enr),
    prompt: buildInvestigationPrompt(node, enr),
  };
}
