# Health checks — reference

What the **Health** section (and `pdetective health`) looks at, the exact command behind each
check, how often it runs, and what makes it raise a finding. The design lives in
[`health-check-and-cleanup-spec.md`](health-check-and-cleanup-spec.md); this file is the durable
per-check reference. Phase 1 is read-only: no elevated rights, no scripting bridge, and the only
file it writes is the health cache.

## How a report is built

- **Fresh checks** run on every `GET /api/health` (target ≤ 5 s).
- **Cached checks** (slow) are served from a per-check cache; when an entry is stale the server
  answers with the stale findings (marked "as of …") and refreshes in the background. `GET
  /api/health` never waits for them. A cold cache answers `skipped: warming`.
- **Full scan** (`POST /api/health/scan`, `pdetective health --full`) runs everything, including
  the disk-clutter survey (bounded `du`, ≤ 90 s), and force-refreshes every cached check.
- A check that throws or times out becomes a **skipped** line in the report. Skipped means *not
  checked* — it is never shown as clean. A cached check that fails keeps its previous entry and is
  not retried on every request: the failure is remembered for as long as the check's own ttl,
  but between 5 and 60 minutes (a full scan, or `--no-cache`, retries immediately).
- Every size is **on-disk** (`du -k` × 1024 or `lstat` blocks × 512) — sparse VM disks are
  measured by what they occupy, never by their apparent size.

The cache file is `<PD_DATA_DIR or ~/Library/Application Support/ProcessDetective>/health-cache.json`
(atomic write, safe to delete; it holds cached findings, the last full-scan time and the last
failure of each cached check).

## The verdict

Vitals decide it; clutter never does.

| Verdict | When |
|---|---|
| `sick` | any `risk` finding in `vitals` or `stability` |
| `degraded` | any `warn` (or `risk`) in `vitals`, `stability`, `processes` or `backup` |
| `cluttered` | otherwise, when `regenerates + orphan` reclaimable ≥ 20 GiB **or** any `warn` in `startup`, `tooling` or `updates` |
| `healthy` | otherwise |

Reclaimable totals count **leaves only**: a folder and the files inside it (for example
`~/Library/Logs/ElgatoStreamDeck` from `user-logs` and its log files from `runaway-logs`) are
counted once, with the more specific item's safety class. `total = regenerates + orphan + ask`;
`keep` and `manual` are listed but never counted.

Safety classes: `regenerates` (caches and build output — the app rebuilds it), `orphan` (the owner
app is gone or the target is missing), `ask` (valuable to some users: VM disks, models, downloads),
`keep` (in use or owner unknown — transparency only), `manual` (needs elevated rights, the GUI or a
restart — printed as steps, never run).

## Fresh checks (`scope: quick`, no cache)

| id | category | command / source | raises |
|---|---|---|---|
| `memory-pressure` | vitals | system snapshot (pressure, swap) + `sysctl -n kern.memorystatus_level` (free %) | `risk`: pressure `critical`, or swap > 4 GiB and free < 10 %. `warn`: pressure `warning`, or swap > 1 GiB and free < 25 %. `advice`: swap > 1 GiB alone. Else `info`. Free % is the kernel level, not `100 − used %` (inactive pages count as used there). |
| `disk-space` | vitals | `/` volume of the system snapshot (`Available` column of `df -k`) | `risk`: free < 5 % or < 10 GiB. `warn`: free < 10 % or < 25 GiB. Else `info`. Free = `Available`, because `total − used` over-reports by the size of the Data volume. |
| `thermal` | vitals | `pmset -g therm` | `risk`: `CPU_Speed_Limit` or `CPU_Scheduler_Limit` below 100, or a recorded "warning level" line that does not start with `Note: No `. `= 100` is normal. Else `info`. |
| `battery` | vitals | `system_profiler SPPowerDataType` | `warn`: condition other than `Normal`, or maximum capacity < 80 %. Else `info`. No `Cycle Count` line (desktop Mac): no finding, vitals stay empty. |
| `uptime-load` | vitals | system snapshot | `advice` when uptime > 30 days. Otherwise only fills the vitals tiles. |
| `crashes-7d` | stability | `~/Library/Logs/DiagnosticReports` and `/Library/Logs/DiagnosticReports`, last 7 days (distinct crash events, not dump files) | per process: `risk` when looping (3+ events within 10 min) and the last crash is < 24 h old; `warn` for 3+ events (including an older loop). One `info` line otherwise. |
| `runaway-logs` | stability | `find ~/Library/Logs -maxdepth 3 -type f -size +200M`, then `tail -n 2000 <file>` per file | per folder: `warn` when the folder holds > 500 MiB or any file is ≥ 80 % one repeated message; `risk` when that holds and the newest file was written < 10 min ago. Items are the files (`regenerates`). |
| `apfs-snapshots` | backup | `tmutil listlocalsnapshots /` | `advice` when ≥ 1 local snapshot exists — deleted files stay allocated until it thins. Manual step `tmutil thinlocalsnapshots / 999999999999 4`. |
| `launch-agents` | startup | `~/Library/LaunchAgents`, `/Library/LaunchAgents`, `/Library/LaunchDaemons`; per plist `plutil -extract Program raw -o - <f>`, else `ProgramArguments.0` | `warn` per plist whose program is an absolute path that does not exist (`orphan`). Relative programs and plists without either key are skipped silently. One `info` listing stray non-`.plist` files in `~/Library/LaunchAgents`. |
| `duplicate-helpers` | processes | process list (never `pgrep -f`) | `advice`: interpreter-hosted helpers (`node`, `python*`, `dotnet`, `deno`, `bun`, `java`, `ruby`) running 3+ identical copies (same normalised command) under 2+ parents, each older than 10 min. `warn` (`duplicate-helpers:orphans`): a member re-parented to launchd while siblings still have a parent. |
| `node-installs` | tooling | the login shell: `$SHELL -lic '/usr/bin/which -a node'`, then `realpath` and `<path> --version` per unique path | `warn` when more than one **origin** (nvm, fnm, volta, asdf, mise, homebrew, pkg, other) is on PATH — several versions under one manager are one origin. Falls back to probing `/opt/homebrew/bin/node` and `/usr/local/bin/node` ("PATH order unknown"). |

## Cached checks (`scope: quick`, with `ttlMs`)

| id | category | ttl | command | raises |
|---|---|---|---|---|
| `software-update` | updates | 6 h | `softwareupdate -l` (60 s) + `sw_vers -productVersion` | `warn` per macOS entry with the same major as the running OS and `Action: restart`; one `advice` listing every other update; `info` when nothing is pending. Never installs anything. |
| `time-machine` | backup | 15 min | `tmutil destinationinfo` (5 s), `tmutil status` (5 s); `tmutil latestbackup` (12 s) **only when the backup volume is already mounted** and no backup is running | a running backup: `info`. Not mounted: `advice` "not verified" — the question is never asked, because it makes macOS mount the destination. Mounted: backup age `info` < 48 h, `advice` 48 h – 7 d, `warn` > 7 d; "requires Full Disk Access", a failure or a timeout is `advice`, never `warn`/`risk`. No destination configured: `advice`. |
| `brew` | tooling | 1 h | `env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ANALYTICS=1 brew outdated --json=v2`, `… brew cleanup -n`, and `… brew doctor` only when `PD_HEALTH_BREW_DOCTOR=1` | one `advice` when anything is outdated or `brew cleanup` would free space; else `info`. No brew installed: no finding. |

## On-demand checks (`optIn`)

These raise a macOS authorization dialog, so they **never run on their own** — not on a quick
request, not in the background, not in a full scan, not from the CLI by default. They run only on
an explicit request (`POST /api/health/check/<id>`, the button in the Health section, or the CLI
flag); the last result is served from the cache with its age, and the report lists them under
`onDemand`.

| id | category | command | raises |
|---|---|---|---|
| `login-items` | startup | `sfltool dumpbtm` (waits up to 60 s for the dialog). CLI: `--login-items`. Disabled by `PD_NO_ELEVATED=1` | `warn` per login item that points into the Trash or at an app that no longer exists; `advice` for a dev build (`node_modules`, `Temp`, `tmp`) registered as a login item; one `info` summary. Login items come from the Background Task Management dump — the same data System Settings shows — not from scripting System Events. macOS requires the `system.privilege.admin` right for **every** read (Touch ID / password; the credential is not shared between runs). |

## Full scan only (`scope: full`)

### `disk-clutter` (category `clutter`)

A survey of a **curated catalog**, not the whole disk: pool of 3 entries, whole survey ≤ 90 s
(entries not started by then are skipped, with the reason). Sizes are on-disk. Items below the
entry's `minBytes` (default 500 MiB) are not listed; for folders the rest is summed into the
finding's detail ("+ 12 smaller, 1.2 GB"). A `du` that times out keeps the lines it printed and
adds a `partial` skip. **A permission error is never shown as "0 B"**: with no size line it is a
skip ("no permission — grant Full Disk Access to include"), with a size line it is a note
("partial: some sub-folders unreadable").

| id | what | safety | base |
|---|---|---|---|
| `xcode-deriveddata` | each project's DerivedData | regenerates | `~/Library/Developer/Xcode/DerivedData` |
| `xcode-devicesupport` | iOS DeviceSupport symbols | regenerates | `~/Library/Developer/Xcode/iOS DeviceSupport` |
| `coresimulator` | simulator devices (named from `device.plist`) | ask | `~/Library/Developer/CoreSimulator/Devices` |
| `android-avd` | Android emulators | ask | `~/.android/avd` |
| `brew-cache` | Homebrew downloads | regenerates | `~/Library/Caches/Homebrew` |
| `user-caches` | app caches (Homebrew excluded) | regenerates | `~/Library/Caches` |
| `user-logs` | app logs | regenerates | `~/Library/Logs` |
| `npm-cache` | npm cache | regenerates | `~/.npm/_cacache` |
| `nuget-cache` | NuGet packages | regenerates | `~/.nuget/packages` |
| `hf-models` | Hugging Face models | ask | `~/.cache/huggingface/hub` |
| `orbstack-disk` | OrbStack disk image (notes whether OrbStack is running) | ask | `~/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw` |
| `docker-desktop` | Docker Desktop VM disk | ask | `~/Library/Containers/com.docker.docker/Data/vms` |
| `claude-vm` | Claude Desktop local-agent VM | ask | `~/Library/Application Support/Claude/vm_bundles` |
| `parallels-vms` | Parallels VMs — transparency only | keep | `~/Parallels` |
| `downloads-installers` | `.dmg .pkg .iso .xip .tar* .tgz .zip` older than 30 days, ≥ 50 MiB | ask | `~/Downloads` |
| `wallpaper-cache` | wallpaper aerials cache | regenerates | `~/Library/Containers/com.apple.wallpaper.agent/Data/Library/Caches` |
| `app-support-orphans` | folders ≥ 1 GiB, classified against the installed apps | orphan / keep per item | `~/Library/Application Support` |
| `claude-worktrees` | `.claude/worktrees/*` found under the dev roots; `git status --porcelain` decides regenerates (clean) or keep (dirty / not a repo) | ask | dev roots |
| `devops-agents` | `_work` folder of every Azure Pipelines agent directly under `~` | ask | `~` |

Notes on specific entries:

- `app-support-orphans`: only folders named in `APP_SUPPORT_OWNERS` (in `src/health/catalog.ts`)
  can ever be an `orphan`; an unknown folder is `keep` with "owner unknown — not classified". A wrong
  `orphan` is the one expensive mistake here (`Code` is VS Code's settings).
- `claude-worktrees`: dev roots are `PD_HEALTH_DEV_ROOTS` (colon-separated) or the existing ones of
  `~/SourceCode ~/Source ~/Developer ~/Projects ~/Code ~/src ~/git ~/repos ~/dev`. `git` runs with
  `--no-optional-locks` so `status` never refreshes (writes) someone's index.
- `devops-agents`: the `.agent` file starts with a UTF-8 BOM; it is stripped before `JSON.parse`.
  The standard macOS folders (`Desktop`, `Documents`, `Downloads`, `Library`, …) are never probed.

## Permission prompts

Nothing here runs with elevated rights, and nothing raises a dialog unless you asked for it.

- **`sfltool dumpbtm`** (`login-items`): macOS asks for Touch ID or your password on every run.
  That is why the check is on demand. An unanswered or cancelled dialog shows the check as
  *skipped*; the previous result, if any, is kept.
- **Other apps' containers** (`orbstack-disk`, `docker-desktop`, `wallpaper-cache`): macOS can ask
  whether Process Detective may access data from other apps. Until answered, the `du` blocks; it is
  stopped after 30 s and the entry is skipped with a reason that names the prompt.
- **`~/Downloads`** (`downloads-installers`): the first listing can trigger the Downloads-folder
  prompt.

Granting Full Disk Access to the app (or to the terminal that runs the CLI) removes the container
and Downloads prompts.

## Environment variables

| Variable | Effect |
|---|---|
| `PD_DATA_DIR` | where `health-cache.json` lives (shared with the history store) |
| `PD_HEALTH_DEV_ROOTS` | colon-separated roots to search for `.claude/worktrees` |
| `PD_HEALTH_BREW_DOCTOR=1` | also run `brew doctor` (up to 60 s) in the cached `brew` check |
| `PD_HEALTH_SKIP` | comma-separated check ids and/or clutter-catalog ids that never run (shown under *Skipped*) |
| `PD_NO_ELEVATED=1` | the on-demand `login-items` check refuses to raise the authorization dialog |
