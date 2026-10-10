import type { SafetyClass } from '../types.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

export type ClutterKind = 'path' | 'children' | 'files' | 'worktrees' | 'devops-agents';

/** One place the clutter survey looks at. The survey walks this catalog — never the whole disk. */
export interface ClutterEntry {
  id: string;
  title: string;
  kind: ClutterKind;
  base: string;                  // '~/…', expanded with ctx.home ('' for the two discovery kinds)
  match?: RegExp;                // children/files: basename must match
  exclude?: RegExp;              // children: basename must not match
  olderThanDays?: number;        // files: mtime filter
  safety: SafetyClass;
  regenNote: string;
  actionId?: string;             // Phase 2: a fixed command action offered on this entry's finding
  /** Phase 2: items of this entry are never moved to the Trash (the owner app keeps its own books). */
  noTrash?: boolean;
  minBytes?: number;             // per item; default 500 MiB
  ownerCheck?: boolean;          // classify each child with classifyAppSupport
  runningHint?: { name: RegExp; label: string };   // note "OrbStack is not running" from ctx.processes
  nameFromPlist?: string;        // children: `plutil -extract name raw -o - <child>/<file>` → item.note
}

export const DEFAULT_MIN_BYTES = 500 * MIB;

export const CLUTTER_CATALOG: ClutterEntry[] = [
  {
    id: 'xcode-deriveddata', title: 'Xcode DerivedData', kind: 'children',
    base: '~/Library/Developer/Xcode/DerivedData',
    safety: 'regenerates', regenNote: 'Xcode rebuilds on the next build (minutes)',
  },
  {
    id: 'xcode-devicesupport', title: 'Xcode iOS DeviceSupport', kind: 'children',
    base: '~/Library/Developer/Xcode/iOS DeviceSupport',
    safety: 'regenerates', regenNote: 're-fetched when the device is plugged in',
  },
  {
    id: 'coresimulator', title: 'iOS Simulator devices', kind: 'children',
    base: '~/Library/Developer/CoreSimulator/Devices', nameFromPlist: 'device.plist',
    noTrash: true, actionId: 'simctl-delete-unavailable',
    safety: 'ask', regenNote: '`xcrun simctl delete unavailable` is always safe; named devices lose their state',
  },
  {
    id: 'android-avd', title: 'Android emulators', kind: 'children',
    base: '~/.android/avd', match: /\.avd$/,
    safety: 'ask', regenNote: 'emulator recreated in Android Studio (~2 min); snapshots lost',
  },
  {
    id: 'brew-cache', title: 'Homebrew cache', kind: 'path',
    base: '~/Library/Caches/Homebrew',
    safety: 'regenerates', regenNote: '`brew cleanup`',
  },
  {
    id: 'user-caches', title: 'App caches', kind: 'children',
    base: '~/Library/Caches', exclude: /^Homebrew$/,
    safety: 'regenerates', regenNote: 'apps rebuild caches; browsers re-download',
  },
  {
    id: 'user-logs', title: 'App logs', kind: 'children',
    base: '~/Library/Logs',
    safety: 'regenerates', regenNote: 'logs; see `runaway-logs` for the pathological ones',
  },
  {
    id: 'npm-cache', title: 'npm cache', kind: 'path',
    base: '~/.npm/_cacache',
    safety: 'regenerates', regenNote: '`npm cache clean --force`',
  },
  {
    id: 'nuget-cache', title: 'NuGet packages', kind: 'path',
    base: '~/.nuget/packages',
    safety: 'regenerates', regenNote: 'restored on the next `dotnet restore`',
  },
  {
    id: 'hf-models', title: 'Hugging Face models', kind: 'children',
    base: '~/.cache/huggingface/hub', match: /^models--/,
    safety: 'ask', regenNote: 'model re-downloaded on next use (GBs)',
  },
  {
    id: 'orbstack-disk', title: 'OrbStack disk image', kind: 'path',
    base: '~/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw',
    runningHint: { name: /orbstack/i, label: 'OrbStack' },
    safety: 'ask', regenNote: 'ALL Docker images, containers and Linux VMs in it',
  },
  {
    id: 'docker-desktop', title: 'Docker Desktop disk', kind: 'path',
    base: '~/Library/Containers/com.docker.docker/Data/vms',
    runningHint: { name: /^(Docker( Desktop)?|com\.docker\.(backend|virtualization|vmnetd))$/i, label: 'Docker' },
    safety: 'ask', regenNote: 'all Docker Desktop images/containers',
  },
  {
    id: 'claude-vm', title: 'Claude Desktop VM', kind: 'path',
    base: '~/Library/Application Support/Claude/vm_bundles',
    safety: 'ask', regenNote: 'Claude Desktop local-agent VM; regenerates, VM-local session data lost',
  },
  {
    id: 'parallels-vms', title: 'Parallels VMs', kind: 'children',
    base: '~/Parallels', match: /\.pvm$/, minBytes: 0, noTrash: true,
    safety: 'keep', regenNote: 'listed for transparency only',
  },
  {
    id: 'downloads-installers', title: 'Old installers in Downloads', kind: 'files',
    base: '~/Downloads', match: /\.(dmg|pkg|iso|xip|tar|tar\.gz|tgz|zip)$/i, olderThanDays: 30, minBytes: 50 * MIB,
    safety: 'ask', regenNote: 'installers are re-downloadable; zips may be data — never auto-select',
  },
  {
    id: 'wallpaper-cache', title: 'Wallpaper cache', kind: 'path',
    base: '~/Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches',
    safety: 'regenerates', regenNote: 'aerials re-download',
  },
  {
    id: 'app-support-orphans', title: 'Application Support leftovers', kind: 'children',
    base: '~/Library/Application Support', ownerCheck: true, minBytes: GIB,
    safety: 'keep', regenNote: 'leftover data of an app that is no longer installed',
  },
  {
    id: 'claude-worktrees', title: 'Claude Code worktrees', kind: 'worktrees',
    base: '', minBytes: 50 * MIB,
    safety: 'ask', regenNote: 'clean worktree — the branch is kept',
  },
  {
    id: 'devops-agents', title: 'Azure Pipelines agent work folders', kind: 'devops-agents',
    base: '', minBytes: 100 * MIB,
    safety: 'ask', regenNote: 'build output of a self-hosted Azure Pipelines agent',
  },
];

/**
 * Folder name under ~/Library/Application Support → pattern an INSTALLED app name
 * must match for the folder to be in use. Only exact folder names listed here are
 * ever called orphans: a wrong "orphan" is the one expensive mistake (`Code` is
 * VS Code's settings), so everything else is `keep`.
 */
export const APP_SUPPORT_OWNERS: Record<string, RegExp> = {
  Autodesk: /^(Autodesk|Fusion)/i,
  'dev.warp.Warp-Stable': /^Warp/i,
  Spotify: /^Spotify/i,
  Slack: /^Slack/i,
  discord: /^Discord/i,
  'zoom.us': /^zoom/i,
  'Docker Desktop': /^Docker/i,
  Cursor: /^Cursor/i,
  'UniFi OS Server': /^UniFi/i,
  'com.elgato.StreamDeck': /Stream Deck/i,
  Steam: /^Steam/i,
  'obs-studio': /^OBS/i,
};

/**
 * Classify one Application Support folder against the installed apps (pure).
 * `installedApps` are bundle names without `.app`.
 */
export function classifyAppSupport(
  folder: string,
  installedApps: string[],
): { safety: SafetyClass; note: string } {
  const owner = Object.prototype.hasOwnProperty.call(APP_SUPPORT_OWNERS, folder) ? APP_SUPPORT_OWNERS[folder] : undefined;
  if (!owner) return { safety: 'keep', note: 'owner unknown — not classified' };
  const app = installedApps.find((a) => owner.test(a));
  if (app) return { safety: 'keep', note: `in use by ${app}` };
  return { safety: 'orphan', note: 'owner app is no longer installed' };
}
