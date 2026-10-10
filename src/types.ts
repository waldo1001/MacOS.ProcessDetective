/**
 * Shared data model for the process detective.
 *
 * The pipeline is: RawProcess[]  ->  ProcessTree  ->  (per node) Enrichment.
 * Collection and tree building never touch the disk or `lsof`; enrichment does.
 */

/** A single process as observed in one `ps` snapshot. */
export interface RawProcess {
  pid: number;
  ppid: number;
  /** %CPU as reported by `ps`. Can exceed 100 for multi-threaded processes. */
  cpu: number;
  /** %MEM as reported by `ps`. */
  mem: number;
  /** Elapsed (wall-clock) running time in seconds. */
  elapsedSeconds: number;
  /** Raw elapsed string from `ps` (e.g. "01:02:03", "15-10:30:45"). */
  elapsedRaw: string;
  user: string;
  /** Full executable path (macOS `comm` gives the full path), or null if unavailable. */
  execPath: string | null;
  /** Friendly short name, derived from execPath/command. "unknown" when undetectable. */
  name: string;
  /** Full command line (`ps -o args`), or null if restricted/unavailable. */
  command: string | null;
}

/** An open network endpoint, parsed from `lsof -i`. */
export interface Port {
  /** "TCP" or "UDP". */
  protocol: string;
  /** e.g. "127.0.0.1:5173" or "*:8080". */
  address: string;
  /** "LISTEN", "ESTABLISHED", … or null. */
  state: string | null;
}

/** An open file or socket, parsed from `lsof -p`. */
export interface OpenFile {
  type: 'file' | 'dir' | 'socket';
  path: string;
}

/** Nearest package.json found by walking up from a process's cwd. */
export interface PackageJsonInfo {
  dir: string;
  path: string;
  name: string | null;
  scripts: Record<string, string>;
}

/** Human-facing interpretation of what a process actually is. */
export interface Interpretation {
  /** Is this a developer-tooling process worth investigating? */
  isDev: boolean;
  /** Friendly label, e.g. "Vite dev server", "ESLint". */
  label: string | null;
  /** npm/yarn/pnpm script name the command maps to, e.g. "dev". */
  scriptName: string | null;
  /** The resolved script body, e.g. "vite --host 0.0.0.0". */
  resolvedScript: string | null;
  /** The resolved binary (from node_modules/.bin or the script), e.g. "vite". */
  bin: string | null;
  /** One-line plain-English summary, or null when nothing notable was found. */
  summary: string | null;
}

/** A directory that many of a process's open file descriptors point into. */
export interface DirHotspot {
  /** Absolute directory path. */
  dir: string;
  /** Number of distinct open REG files under this directory (recursively). */
  fdCount: number;
  /** Total size on disk in KB from `du -sk`; null when unavailable or timed out. */
  sizeKb: number | null;
  /** Up to 3 example file basenames under this directory. */
  sampleFiles: string[];
  /** Dominant file extension among the open files (e.g. "jsonl"), or null. */
  dominantExt: string | null;
}

/** Result of two `lsof -o` snapshots taken a short interval apart. */
export interface ReadActivitySnapshot {
  available: boolean;
  /** Actual measured gap in ms between the two snapshots. */
  gapMs: number;
  fdsBefore: number;
  fdsAfter: number;
  /** Descriptors present in the second snapshot but not the first. */
  fdsAdded: number;
  /** Descriptors present in the first snapshot but not the second. */
  fdsRemoved: number;
  /** Descriptors present in both whose file offset changed. */
  offsetsAdvanced: number;
  /** Up to 3 paths of newly-appeared descriptors. */
  sampleAdded: string[];
  /** Deepest shared directory across added + advanced paths, or null. */
  commonDir: string | null;
  /** One-line plain-English conclusion. */
  verdict: string;
  note: string | null;
}

/** One extension identified as running inside a host process. */
export interface OwnerExtension {
  /** e.g. "anthropic.claude-code" or "copilot". */
  id: string;
  /** e.g. "2.1.218"; null for built-ins and when unparseable. */
  version: string | null;
  /** True when it ships inside the app bundle rather than ~/.vscode/extensions. */
  builtin: boolean;
  /** Number of distinct open paths attributed to this extension. */
  fileCount: number;
  /** True when a native .node module of this extension is loaded — strong evidence. */
  hasNativeModule: boolean;
  /** Basenames of THIS extension's own loaded native modules, sorted. */
  nativeModuleNames: string[];
}

/** What is actually running inside a generic host/helper process. */
export interface OwnerAttribution {
  /** "VS Code" | "Cursor" | null. */
  host: string | null;
  /** Sorted strongest-evidence-first. */
  extensions: OwnerExtension[];
  /** Basenames of loaded native modules, e.g. ["audio-capture.node"]. */
  nativeModules: string[];
}

/** A grouped set of recent crash reports. */
export interface CrashGroup {
  process: string;
  count: number;
  firstAt: number;
  lastAt: number;
  /** True when 3+ distinct events occurred within a 10-minute window. */
  looping: boolean;
}

/** Hint about a known macOS system process. */
export interface SysProcessHint {
  label: string;
  what: string;
  lookWhere: string | null;
  isCrashHandler?: boolean;
  /** True for OrbStack/Docker/Colima runtime helpers — triggers docker ps enrichment. */
  isContainerRuntime?: true;
  /** Symptom daemon whose cause is external filesystem churn. */
  isFsSymptom?: true;
}

/** One running container from `docker ps`. */
export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  status: string;
  /** Parsed age in seconds (null if unknown). */
  runningForSec: number | null;
  /** Has an org.testcontainers* label. */
  testcontainers: boolean;
}

/** Snapshot from `docker ps` — the fast, always-on data. */
export interface DockerSnapshot {
  available: boolean;
  dockerPath: string | null;
  totalRunning: number;
  /** Top images by count, descending, capped at 10. */
  byImage: { image: string; count: number }[];
  /** Containers with runningForSec <= 30 (churn signal). */
  recentlyStarted: number;
  /** Count of containers with an org.testcontainers label. */
  testcontainers: number;
  note: string | null;
}

/** Per-container CPU row from `docker stats`. */
export interface ContainerCpu {
  name: string;
  cpuPct: number;
  memUsage: string;
  pids: number;
}

/** Snapshot from `docker stats --no-stream` — the slow, on-demand data. */
export interface DockerStatsSnapshot {
  available: boolean;
  /** Top containers by CPU %, descending, capped at 12. */
  topByCpu: ContainerCpu[];
  note: string | null;
}

/** A single stack frame from `sample` output. */
export interface StackFrame {
  samples: number;
  symbol: string;
  binary: string | null;
}

/** Result of running `sample <pid>`. */
export interface StackSample {
  available: boolean;
  cpuBound: boolean | null;
  verdict: string | null;
  topFrames: StackFrame[];
  threadCount: number;
  note: string | null;
  raw?: string;
}

/** One normalized top-pattern entry from a log tail. */
export interface LogPattern { sample: string; count: number; subsystem: string | null; }
/** Per-subsystem line count entry from a log tail. */
export interface LogSubsystem { subsystem: string; count: number; }
/** Result of running `log show --last <m>m` for a process. */
export interface LogTailSnapshot {
  available: boolean;
  pid: number;
  windowMinutes: number;
  totalLines: number;
  topPatterns: LogPattern[];
  bySubsystem: LogSubsystem[];
  errorCount: number;
  privateRedacted: number;
  note: string | null;
}

/** Everything we can learn about a process beyond the raw snapshot. */
export interface Enrichment {
  cwd: string | null;
  packageJson: PackageJsonInfo | null;
  ports: Port[];
  openFiles: OpenFile[];
  recentCrashes: CrashGroup[];
  sysHint: SysProcessHint | null;
  stackSample?: StackSample;
  /** Docker/OrbStack container snapshot; only present for container-runtime processes. */
  docker?: DockerSnapshot;
  /** Unified log tail; only present when fetched on-demand via POST /api/log/:pid. */
  logTail?: LogTailSnapshot;
  /** Filesystem churn attribution; only present when fetched on-demand via POST /api/fschurn/:pid. */
  fsChurn?: FsChurnSnapshot;
  /** Directories that concentrate this process's open file descriptors. */
  dirHotspots?: DirHotspot[];
  /** Extensions/plugins hosted inside this process; null when nothing identified. */
  owners?: OwnerAttribution | null;
  /** Read-activity delta; only present when fetched on-demand via POST /api/readdelta/:pid. */
  readActivity?: ReadActivitySnapshot;
  interpretation: Interpretation;
}

/** One attributed process entry from fs_usage churn. */
export interface FsChurnProcess {
  process: string;
  count: number;
  samplePaths: string[];
  commonDir: string | null;
}

/** Result of an on-demand fs_usage churn attribution run. */
export interface FsChurnSnapshot {
  available: boolean;
  windowSeconds: number;
  totalEvents: number;
  topProcesses: FsChurnProcess[];
  truncated: boolean;
  note: string | null;
}

/** A node in the parent/child process tree. */
export interface ProcessNode {
  proc: RawProcess;
  parent: ProcessNode | null;
  children: ProcessNode[];
}

/** A fully built snapshot tree. */
export interface ProcessTree {
  byPid: Map<number, ProcessNode>;
  /** Nodes whose parent is not present in this snapshot (typically launchd, pid 1). */
  roots: ProcessNode[];
  /** Every node, in no particular order. */
  all: ProcessNode[];
}

// ── Health ──
export type HealthVerdict = 'healthy' | 'cluttered' | 'degraded' | 'sick';
export type HealthSeverity = 'info' | 'advice' | 'warn' | 'risk';
export type HealthCategory =
  | 'vitals' | 'stability' | 'startup' | 'processes' | 'tooling' | 'updates' | 'backup' | 'clutter';
export type SafetyClass =
  | 'regenerates'   // caches/build output: delete freely, app rebuilds it
  | 'orphan'        // owner app no longer installed / target missing
  | 'ask'           // valuable to some users (VM disks, models, downloads)
  | 'keep'          // in use / owner unknown; listed for transparency only
  | 'manual';       // needs elevated rights, GUI or a restart — print steps, never act

export interface HealthEvidence {
  command: string;          // exactly what was run, copy-pasteable
  excerpt: string;          // trimmed output lines that justify the finding (≤ 12 lines)
}

/** One path a finding is about. These are the rows of the Reclaimable table. */
export interface ClutterItem {
  path: string;                  // absolute
  bytes: number;                 // ON-DISK bytes (du -k × 1024, or lstat blocks × 512)
  lastModified: number | null;   // ms epoch
  safety: SafetyClass;
  note?: string;                 // "iPhone 17 Pro", "3 uncommitted changes", "OrbStack is not running"
  /** Stamped by the engine (never cached): this item may be offered to the clean-up layer. See isActionable(). */
  actionable?: boolean;
}

export interface HealthFinding {
  id: string;               // unique within a report, kebab-case; `<checkId>` or `<checkId>:<slug>`
  checkId: string;
  category: HealthCategory;
  severity: HealthSeverity;
  title: string;            // one line, human
  detail: string;           // 1–3 sentences; say what it means, not just what it is
  evidence: HealthEvidence[];
  items?: ClutterItem[];
  reclaimableBytes?: number;     // sum of items with safety regenerates | orphan | ask
  safety?: SafetyClass;          // default class of the finding
  regenNote?: string;            // what happens after deletion, one sentence
  actionId?: string;             // Phase 2: id of the clean-up action that fixes it
  manualSteps?: string[];        // exact commands / Settings path
  asOf?: number;                 // set by the engine when the finding was served from cache
}

export interface HealthVitals {           // tiles; every field nullable
  memFreePct: number | null; swapUsedBytes: number | null; pressure: string | null;
  loadAvg1: number | null; uptimeSec: number | null; processCount: number | null;
  thermalWarning: boolean | null; batteryCycles: number | null; batteryHealthPct: number | null;
  diskFreeBytes: number | null; diskTotalBytes: number | null; localSnapshots: number | null;
  crashes7d: number | null;
}

export interface HealthReport {
  at: number;
  scope: 'quick' | 'full';
  durationMs: number;
  verdict: HealthVerdict;
  verdictReason: string;
  vitals: HealthVitals;
  findings: HealthFinding[];                                    // sorted, see sortFindings
  reclaimable: { total: number; byClass: Record<SafetyClass, number> };
  skipped: { id: string; reason: string }[];                    // timed out / failed / warming
  fullScan: { at: number | null; stale: boolean };              // stale = older than 24 h
  refreshing: string[];                                         // check ids refreshing in background
  /** Checks that only run when the user asks (they raise a macOS authorization dialog). */
  onDemand: { id: string; category: HealthCategory; label: string; note: string; at: number | null }[];
}

/** The one in-process full-scan job behind POST /api/health/scan. */
export interface HealthScanJob {
  id: string;
  state: 'running' | 'done' | 'failed';
  progress: { done: number; total: number; current: string };
  report?: HealthReport;
  error?: string;
}

// ── Clean-up actions (Phase 2) ──
export type ActionMethod = 'trash' | 'command';
export interface ActionTarget { findingId: string; path: string }
export interface ActionPlan {
  token: string;
  actionId: string;
  method: ActionMethod;
  createdAt: number;
  reportAt: number;                 // `at` of the report the targets were matched against
  targets: { findingId: string; path: string; bytes: number; safety: SafetyClass; note?: string }[];
  refused: { findingId: string; path: string; reason: string }[];
  totalBytes: number;
  command?: string;                 // display string of the fixed command
  explain: string;                  // one sentence: what happens and how to undo it
  needsAck: boolean;                // any `ask` target, or the action itself is flagged
}
export interface ActionResult {
  token: string; actionId: string; method: ActionMethod; at: number;
  result: 'ok' | 'partial' | 'failed';
  targets: { path: string; ok: boolean; trashedTo?: string; error?: string }[];
  bytesPlanned: number; bytesFreed: number;
  output?: string;                  // command actions: last 12 lines
  note: string;
}
export interface AuditEntry {
  at: number; actionId: string; method: ActionMethod; paths: string[];
  bytesPlanned: number; bytesFreed: number; result: 'ok' | 'partial' | 'failed'; note: string;
  trashedTo?: string[];
}
