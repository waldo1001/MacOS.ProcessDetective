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

const HINTS: Record<string, SysProcessHint> = {
  ReportCrash: {
    label: 'macOS Crash Reporter',
    what: 'Processes crashed apps and writes reports. High CPU here means another process is crashing repeatedly.',
    lookWhere: '~/Library/Logs/DiagnosticReports — see Recent crashes for the actual culprit',
    isCrashHandler: true,
  },
  spindump: {
    label: 'Spindump (hang reporter)',
    what: 'Captures call-stack snapshots of hung processes. High CPU means an app hung and macOS is collecting diagnostics.',
    lookWhere: '~/Library/Logs/DiagnosticReports for .spindump files',
    isCrashHandler: true,
  },
  fseventsd: {
    label: 'FSEvents daemon',
    what: 'Fans out filesystem-change notifications to Spotlight, Time Machine, sync clients and file watchers. High CPU means another process is generating a flood of file changes — it is the symptom, not the cause.',
    lookWhere: 'Run "Filesystem churn" to name the process driving the change storm',
    isFsSymptom: true,
  },
  mds: {
    label: 'Spotlight indexer (mds)',
    what: 'Metadata server — orchestrates Spotlight indexing of your files.',
    lookWhere: 'Run "Filesystem churn" to name the process generating the file-event flood',
    isFsSymptom: true,
  },
  mds_stores: {
    label: 'Spotlight metadata store',
    what: 'Maintains the Spotlight database. High CPU/disk = active indexing.',
    lookWhere: 'Run "Filesystem churn" to name the process generating the file-event flood',
    isFsSymptom: true,
  },
  mdworker: {
    label: 'Spotlight worker',
    what: 'Worker process that reads and indexes individual files for Spotlight.',
    lookWhere: 'Run "Filesystem churn" to name the process generating the file-event flood',
    isFsSymptom: true,
  },
  mdworker_shared: {
    label: 'Spotlight shared worker',
    what: 'Shared Spotlight indexing worker.',
    lookWhere: 'Run "Filesystem churn" to name the process generating the file-event flood',
    isFsSymptom: true,
  },
  mdbulkimport: {
    label: 'Spotlight bulk importer',
    what: 'Bulk-imports metadata into Spotlight. High CPU = large batch of files being indexed.',
    lookWhere: 'Run "Filesystem churn" to name the process generating the file-event flood',
    isFsSymptom: true,
  },
  WindowServer: {
    label: 'WindowServer (display compositor)',
    what: 'Renders all windows and manages the display. High CPU here means heavy GPU/display work, usually from a misbehaving app.',
    lookWhere: null,
  },
  kernel_task: {
    label: 'kernel_task (macOS kernel)',
    what: 'Kernel process. High CPU often indicates thermal throttling — the kernel inflates its own CPU% to limit other processes when the chip is hot.',
    lookWhere: null,
  },
  coreaudiod: {
    label: 'Core Audio daemon',
    what: 'Manages audio I/O for all apps. High CPU = intensive audio processing.',
    lookWhere: null,
  },
  bluetoothd: {
    label: 'Bluetooth daemon',
    what: 'Manages Bluetooth connections and data transfer.',
    lookWhere: null,
  },
  cloudd: {
    label: 'iCloud daemon (cloudd)',
    what: 'Syncs data with iCloud. High CPU/network = active sync.',
    lookWhere: null,
  },
  bird: {
    label: 'iCloud Drive daemon (bird)',
    what: 'Handles iCloud Drive file upload/download.',
    lookWhere: null,
  },
  photoanalysisd: {
    label: 'Photos analysis daemon',
    what: 'Performs ML analysis of photos (face detection, scene recognition). Runs in background and is CPU-intensive.',
    lookWhere: null,
  },
  mediaanalysisd: {
    label: 'Media analysis daemon',
    what: 'Analyses media files for indexing and smart features.',
    lookWhere: null,
  },
  backupd: {
    label: 'Time Machine daemon (backupd)',
    what: 'Performs Time Machine backups. High CPU/disk = backup in progress.',
    lookWhere: null,
  },
  syspolicyd: {
    label: 'System policy daemon',
    what: 'Enforces Gatekeeper and notarization policies for app launches.',
    lookWhere: null,
  },
  trustd: {
    label: 'Trust evaluation daemon (trustd)',
    what: 'Evaluates certificate trust and handles OCSP/CRL checks.',
    lookWhere: null,
  },
  launchd: {
    label: 'launchd (system/user init)',
    what: 'The first process (PID 1). Starts and manages all other system and user services.',
    lookWhere: null,
  },
};

/** Container-runtime names that warrant docker enrichment (case-insensitive substring match). */
const CONTAINER_RUNTIME_PATTERNS = ['orbstack', 'vmgr', 'com.docker', 'dockerd', 'colima'];

const CONTAINER_RUNTIME_HINT: SysProcessHint = {
  label: 'Container runtime (OrbStack/Docker)',
  what:
    'Runs Linux VMs/containers and brokers their networking. High CPU here is almost always a busy or rapidly-churning container, not the helper itself.',
  lookWhere: 'see Containers below — docker ps / docker stats name the culprit',
  isContainerRuntime: true,
};

/**
 * Return a hint for a known macOS daemon/system process, or null if unknown.
 * Exact-match hints are checked first (case-sensitive), then container-runtime
 * patterns are checked case-insensitively.
 */
export function sysProcessHint(name: string): SysProcessHint | null {
  const exact = HINTS[name];
  if (exact) return exact;

  // Container-runtime detection: case-insensitive substring match
  const lower = name.toLowerCase();
  if (CONTAINER_RUNTIME_PATTERNS.some((p) => lower.includes(p))) {
    return CONTAINER_RUNTIME_HINT;
  }

  return null;
}
