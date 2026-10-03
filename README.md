# process-detective

A read-only macOS CPU/process detective. When your fans spin up and Activity
Monitor just says **`node`**, this tells you *who launched it, from which folder,
with which command, and what it actually is* — e.g. "the Vite dev server for
project `customer-x`, started by `npm run dev` under Claude Code".

It never kills or modifies anything. It shells out to `ps` and `lsof` only, and
requires **no sudo**. Anything it can't read (a restricted command line, a cwd it
isn't allowed to see) degrades to `unknown` instead of failing.

## Run as a native Mac app (recommended)

Build a real, double-clickable macOS app — a native window (WKWebView) that
launches the bundled server internally, with its own dock icon. No browser needed.

```bash
npm install
npm run app          # builds ProcessDetective.app in the project root
open ProcessDetective.app
```

**Install it** into your Applications folder (so it lives like a normal app and
shows up in Spotlight/Launchpad):

```bash
npm run deploy               # → ~/Applications  (no admin needed)
npm run deploy -- --system   # → /Applications   (folder must be writable)
open ~/Applications/ProcessDetective.app
```

`npm run deploy` rebuilds, ad-hoc signs, copies the app into the destination,
clears quarantine, and registers it with Launch Services. Re-run it any time to
update. There's also a `/deploy` Claude Code skill (`.claude/skills/deploy/`) that
runs this flow. Launch by path or Finder works immediately; Spotlight /
`open -a "Process Detective"` works once macOS finishes indexing the app.

**Deploy to another Mac over SSH/Tailscale** (e.g. a Mac mini):

```bash
npm run deploy:remote -- waldomacmini1          # remote only
npm run deploy -- --remote=waldomacmini1        # local + remote in one run
```

The remote step rsyncs the bundle, then on the remote re-resolves Node, re-signs
(ad-hoc), clears quarantine, and registers it. Needs passwordless SSH (Remote
Login + `ssh-copy-id`) and a **matching CPU arch** — the Swift launcher is compiled
for the build machine's architecture (both arm64 here).

**App icon:** prebuilt at `icon/AppIcon.icns`, regenerate with `npm run icon`
(rasterizes `icon/icon.html` via headless Chrome → `sips`/`iconutil`).

`npm run app` compiles the TypeScript, bundles it with its runtime deps and a
small Swift launcher into `ProcessDetective.app`, and clears the quarantine flag.
The app starts a localhost-only server on a free port, shows the **Mission
Control** dashboard, and shuts the server down when you quit. Requires Node and
the Xcode Command Line Tools (`xcode-select --install`).

The dashboard ("Mission Control") has a sidebar with eight sections — **Overview,
CPU, Memory, Energy, Disk, Network, Processes,** and a **Process detail** view —
keyboard navigation (`1`–`7`, `g`+letter, `/` to search, `↑/↓`/`Enter`, `Space`
to pause), light/dark, and a **session-scoped live history**. The visual design
comes from a handoff spec; per-core utilization is shown as *estimated* and a few
metrics (fan RPM, per-process disk/network bytes) appear as "requires elevated
access" until a privileged helper is added.

### Docker / OrbStack container awareness

When inspecting OrbStack, Docker Desktop, or similar container-runtime helpers
(`vmgr`, `OrbStack Helper`, `dockerd`, `colima`, …), the detail panel shows a
**Containers** card sourced from `docker ps`:

- Total running containers, grouped by image (top 10 by count)
- **Churn signal**: how many started in the last 30 seconds
- Testcontainers detection (via `org.testcontainers` label)
- Automatic storm annotation when churn ≥ 5 and Testcontainers are active:
  *"High container churn — likely a test/CI run spinning up a container per test."*

An on-demand **⚙ Per-container CPU** button POSTs to `POST /api/docker` (calls
`docker stats --no-stream`, ~1–2 s) and surfaces the top containers by CPU.

Entirely **read-only** — only `docker ps` and `docker stats` are ever called.
No containers are touched. Docker CLI is auto-discovered without requiring `sudo`
(checks OrbStack path `~/.orbstack/bin/docker` and standard fallback paths).

### History persistence

The `serve` command runs a **server-side history collector** that samples system
metrics every 15 seconds, independent of the browser window. Samples are stored
as append-only JSONL files in:

```
~/Library/Application Support/ProcessDetective/history/
```

Files are rotated daily (`history-YYYY-MM-DD.jsonl`) and pruned after 14 days.
Bounded total: ~5760 samples/day × ~120 bytes/line × 14 days ≈ **9 MB max**.

The dashboard gains a **time-range selector** in the header (`15m · 1h · 6h · 24h · 7d`).
At `15m` (default) it uses the live in-memory buffer. Longer ranges fetch
`GET /api/history?range=<r>` from the server and re-poll every 30 seconds.
On page load the buffer is seeded from the server's real history so charts are
populated immediately even after a fresh browser open.

Per-process and per-core history remain **live-only** — they are not persisted.

**Configuration:**

| Option | Env var | Flag | Default |
|--------|---------|------|---------|
| Enable/disable | `PD_HISTORY=0` | `--no-history` | on |
| Data directory | `PD_DATA_DIR` | `--data-dir <path>` | `~/Library/…/ProcessDetective/history` |
| Sample interval | `PD_HISTORY_INTERVAL_MS` | `--history-interval <sec>` | 15 |
| Retention | `PD_HISTORY_RETENTION_DAYS` | `--history-retention <days>` | 14 |

A second instance sharing the same directory runs **read-only** — the lockfile
(`history/.writer.lock`) ensures only one server appends. On disk errors the
server degrades to in-memory only (never crashes).

### Leaving it open 24/7

It's built to run continuously for weeks without leaking or hogging the machine:

- **Collects continuously** while open (it does **not** stop when unfocused), but
  only redraws the DOM when the window is **visible** — so background cost is just
  the data sampling, not rendering.
- **Adaptive cadence:** samples at your chosen interval (1/2/5s) in front,
  and a slower 8s when the window is hidden, to cut subprocess/CPU churn.
- **Bounded memory by construction:** all history lives in fixed-size ring buffers
  (~15 min of system + per-core series, ~90 samples per process) — nothing grows
  unbounded, so the JS heap stays flat.
- **Self-heal:** after 24h of uptime it reloads itself the next time the window is
  hidden (never mid-view), resetting any slow WebView heap creep.
- **Observability:** the Overview meta line shows the monitor's own RSS + uptime,
  so you can watch for creep.
- **Pause** (`Space`) stops collection entirely and breaks the chart with an honest
  gap on resume; real time jumps (sleep) also break the line rather than faking it.

> Caveat: macOS throttles a window's JS timers when it's **minimized/occluded**, so
> for true minimize-proof 24/7 collection, keep the window visible (e.g. on a spare
> display). A fully background-proof mode would move sampling into the Node process —
> see the roadmap.

## Install (CLI / browser)

```bash
npm install
npm run build
npm link        # optional: puts `process-detective` / `pdetective` on your PATH
```

Or run without linking:

```bash
node dist/index.js <command>
# during development, no build step:
npm run dev -- <command>
```

## Commands

| Command | What it does |
|---|---|
| `serve` | **Web UI** — graphical dashboard in your browser (recommended) |
| `ui` | Interactive live view inside the terminal (TUI) |
| `top` | Top CPU processes as a table |
| `tree --hot` | Hot developer processes, each with its parent chain + interpretation |
| `tree --pid <PID>` | The process subtree rooted at a PID |
| `inspect <PID>` | Full detail for one process (chain, children, cwd, ports, scripts) |
| `report <PID>` | Copy-friendly "CPU spike investigation" diagnostic |
| `prompt <PID>` | Print a ready-to-paste investigation prompt for your AI agent |
| `watch --threshold 80` | Live refresh, highlights spikes, keeps recent-spike history |

### `serve` — web UI (recommended)

A graphical dashboard in your browser. Starts a tiny **read-only local web server**
(Node's built-in `http`, zero dependencies, bound to `127.0.0.1`) that reuses the
exact same core and serves a single-page app — no build step, no bundler.

```bash
process-detective serve            # opens http://127.0.0.1:7878 in your browser
process-detective serve -p 9000    # custom port
process-detective serve --no-open  # don't auto-open the browser
```

What you get:

- A **system vitals strip** across the top, refreshing every 2s — all read-only,
  no sudo, and cross-checked against the raw tools:
  - **CPU** — usage %, user/sys split, load average (1/5/15)
  - **Memory** — used/total with a stacked composition bar (wired / compressed /
    active / inactive / free), memory-pressure level, swap, cached files
  - **Network** — live ↓/↑ throughput, established + listening connection counts,
    cumulative bytes transferred
  - **Storage** — volume capacity used/free
  - **Power** — battery %/source (or AC) and thermal state
  - **Host** — chip, core split (P + E cores), process/thread counts, uptime
- Live list of processes with **CPU bars**, auto-refreshing every 2s
- `dev only` toggle and a `hot ≥ %` threshold slider (re-colors instantly)
- Click any process → a detail panel with the **parent chain**, working directory,
  resolved project + npm script, **open ports**, a recommendation, and a one-click
  **Copy report** button

Endpoints (same-origin JSON, if you want to script against it):
`GET /api/processes`, `GET /api/system`, `GET /api/inspect/:pid`,
`POST /api/advice/:pid`, `POST /api/sample/:pid`, and
`POST /api/powermetrics` (optional `?seconds=1`, requires admin unless `PD_NO_ELEVATED=1`).

#### Root-cause investigation

The detail panel now answers **what a process is actually doing and why**, not just
who it is:

**"Sample stack (2s)" button** — calls `POST /api/sample/:pid` on demand (takes ~2s;
never runs on the polled path). Captures a real call-stack snapshot via `sample(1)` and
shows:
- A **verdict** colored by activity: amber "spinning in …" (compute-bound) or muted
  "mostly waiting …" (blocked on I/O or sync — not the culprit).
- The **top frames** walking from the root to the hot leaf.
- A collapsible **raw sample** for deeper inspection.
- After sampling, **Copy report** / **Copy AI prompt** include the stack so your agent
  can conclude instead of asking for more commands.

**Elevated sampling** — when a normal `sample` is refused on a root or hardened process
(e.g. `ReportCrash`, `WindowServer`, `mds`, kernel daemons), the panel shows a
**"🔓 Sample with admin rights"** button. Clicking it runs `sample` as root via macOS's
native admin authorisation dialog (Touch ID / password) — no signed helper, no stored
credential. macOS caches the authorisation for ~5 minutes so repeated elevated samples
won't re-prompt. If you cancel the dialog, the result degrades gracefully with an inline
note. The elevated result flows through the same verdict/frames rendering and is included
in "Copy report" and "Copy AI prompt".

To disable elevated sampling entirely, set `PD_NO_ELEVATED=1` in the server environment.

**Open files** — the detail panel shows the process's interesting open files and
sockets (filtered: noisy system libraries hidden, actual data files / sockets
surfaced). On processes that can't be read (other user, root), degrades silently.

**Recent crashes** — a "Recent crashes (last hour)" card shows which processes have
been crashing, drawn from `~/Library/Logs/DiagnosticReports/`. Crash counting is
now **accurate**: multi-dump files (`chrome_crashpad_handler-…​.000/.0002/.0003.ips`)
that belong to the same crash event are counted as **one** event, not three. Each
group shows the last-seen relative time (e.g. "3m ago"). A red **LOOPING** badge
appears when a process has crashed 3+ times in under 10 minutes. If the selected
process is a crash-handler daemon (e.g. `ReportCrash`, `spindump`), a prominent
callout names the probable culprit (preferring the looping group):
> *ReportCrash is a symptom — the likely cause is **Google Chrome Helper** (7 crashes
> in the last hour — LOOPING)*

**Per-app GPU/CPU attribution** — the **Energy** section has a new
**"PER-APP POWER (admin)"** panel. Click **"⚡ Measure per-app GPU/CPU (admin)"**
to run `powermetrics --samplers tasks,gpu_power` via the macOS admin auth dialog
(Touch ID or password). This takes ~1–2 seconds and shows ranked per-process
CPU ms/s and GPU ms/s tables plus the GPU active residency % and power in mW —
exactly the data that identifies which client is driving WindowServer or burning
the GPU. No sudo is required; macOS's native authorisation dialog handles elevation.
Set `PD_NO_ELEVATED=1` to disable all elevation including this feature.

**Stack sample always in prompt** — the copy-ready report and AI prompt always
include a "Stack sample" section. If a sample hasn't been captured, the section
says *"not captured (run 'Sample stack'; use admin for root processes)"* so the
AI knows the data is obtainable.

**System-process awareness** — known macOS daemons (`kernel_task`, `WindowServer`,
`mds`, `coreaudiod`, `ReportCrash`, `backupd`, etc.) get a "SYSTEM PROCESS" card
explaining what they do and where to look for the real signal, instead of showing
no interpretation.

All features are **read-only** and degrade gracefully: `sample`/`lsof` on processes
owned by another user or root return `available:false` with a clear note — they never
crash the UI or break the layout.

#### AI investigation

The detail panel offers two ways to get an explanation — pick whichever fits.

**1. Copy a prompt for your own agent (no key, no cost).** Click
**📋 Copy prompt for your agent** — it copies a self-contained prompt (the full
diagnostic snapshot + the questions to ask) that you paste into ChatGPT, Claude,
Copilot, or whatever you already use. From the terminal, the same thing:

```bash
process-detective prompt 12345 | pbcopy
```

**2. Get advice in-app (optional, needs your own Anthropic key).** Click
**🤖 Get advice now** and Claude answers right in the panel.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
process-detective serve
```

Without the key, option 1 still works fully; the in-app button just shows a
"set ANTHROPIC_API_KEY" message. Model defaults to `claude-opus-4-8`; override
with `PD_AI_MODEL` (e.g. `PD_AI_MODEL=claude-sonnet-4-6`). Each click of option 2
is one billed API call, and only the selected process's snapshot is sent.

This page is also the intended **Tauri frontend** for the menu-bar app (see roadmap).

### `ui` — interactive live view in the terminal (TUI)

A single full-screen, auto-refreshing panel. Built on raw-mode keypresses + ANSI
only (no TUI framework). Only the **selected** process is enriched (lazily), so
it stays cheap even with hundreds of processes.

```bash
process-detective ui                  # all processes, hot = >= 50% CPU
process-detective ui --dev -t 30      # start filtered to dev tooling
```

```text
 process-detective — live                                          10:51:06 AM
  threshold 50%  ·  dev-only  ·  refresh 2s  ·  91 processes

 ▸  12345  183.2% [████████████████]  node            npm run dev
     7702   78.2% [███████·········]  Claude Helper   Claude
     2325    1.5% [················]  claude          claude
 ────────────────────────────────────────────────────────────────────────────
 node  PID 12345  183.2% CPU  4.5% MEM
 chain    launchd › Claude › zsh › npm run dev › node …/vite
 is       Vite dev server
 project  customer-x
 script   scripts.dev = vite --host 0.0.0.0
 ports    127.0.0.1:5173(LISTEN)
  ↑/↓ select · f dev-filter · +/- threshold · p pause · r report→clipboard · q quit
```

Keys: `↑`/`↓` (or `j`/`k`) select · `f` toggle dev-only · `+`/`-` threshold ·
`p` pause refresh · `r` copy a diagnostic report to the clipboard (also saved to
`process-detective-report-<PID>.txt`) · `q` quit. Falls back to a single static
frame when output isn't a TTY (e.g. piped).

### Examples

```bash
process-detective top                 # top 15 by CPU
process-detective top --dev -t 50     # only dev tooling, highlight >= 50%
process-detective tree --hot          # hot node/npm/vite/eslint/... with chains
process-detective inspect 12345
process-detective report 12345        # paste this into a ticket
process-detective watch --threshold 80 --interval 2
```

### `tree --hot`

```text
Hot processes

node  PID 12345  CPU 183.0%
launchd PID 1 0.3%
   └─ Claude PID 7613 2.8%
      └─ zsh PID 7700 0.0%
         └─ npm run dev PID 8001 5.0%
Likely: Vite dev server
Project: customer-x
Script: package.json → scripts.dev = "vite --host 0.0.0.0"
```

### `report <PID>`

```text
CPU spike investigation

Hot process:
node PID 12345, 183.0% CPU
Command: node ./node_modules/.bin/vite --host 0.0.0.0

Likely root cause:
Claude launched a shell, which ran npm run dev in ~/repos/customer-x.
That script resolved to: vite --host 0.0.0.0

Parent chain:
launchd
    └── Claude
        └── zsh
            └── npm run dev
                └── node …/vite

Working directory:
~/repos/customer-x

Open ports:
TCP 127.0.0.1:5173 (LISTEN)

Recommendation:
This appears to be the Vite dev server for project customer-x.
```

## What it collects

Per process, from two parallel `ps` calls joined on PID:
PID, PPID, name, full command line, CPU%, MEM%, elapsed time, user, and the
executable path. On selection it adds, via `lsof` (best-effort):

- **cwd** — `lsof -a -p <PID> -d cwd`
- **open ports** — `lsof -Pan -p <PID> -i`
- **nearest `package.json`** — walking upward from the cwd
- **script interpretation** — `npm run dev` → `scripts.dev`, and
  `node_modules/.bin/vite|eslint|tsserver|…` → a friendly label

Recognized dev tools include: node, npm, pnpm, yarn, npx, bun, deno, vite,
tsserver, eslint, esbuild, rollup, webpack, next, nuxt, ts-node, tsx, jest,
vitest, nodemon, turbo, claude, code, electron.

## Architecture

The pipeline is deliberately split so it can be reused behind a SwiftUI / Tauri
menu bar app later — only the `render/` and `cli.ts` layers are terminal-specific.

```
src/
  collect/   ps.ts        snapshot + parsing (pure, unit-tested)
             lsof.ts      cwd + ports (lazy, per-PID)
             system.ts    full system vitals (cpu, memory, disk, network, power)
  history/   store.ts     pure JSONL encode/decode, downsample, retention helpers
             collector.ts HistoryStore: timer, lockfile, disk I/O, /api/history
  tree/      build.ts     PID→PPID tree, parentChain, descendants
  enrich/    classify.ts  dev detection + friendly labels
             packageJson.ts  walk-up + script resolution
             interpret.ts    combine into one interpretation
  render/    top.ts tree.ts inspect.ts format.ts   (terminal-only)
  report/    report.ts    plain-text diagnostic (copy/paste safe)
  service.ts              snapshot / enrich / hotProcesses orchestration
  cli.ts  index.ts        commander wiring + bin entry
```

`collect → tree → enrich` is plain data with no I/O beyond the two tools, so it
ports cleanly. Coloring is auto-disabled when output isn't a TTY or `NO_COLOR` is set.

## Tests

```bash
npm test
```

Covers `ps` output parsing (incl. exec paths with spaces and elapsed-time
formats), PID/PPID tree building + parent chains, npm/yarn/pnpm script resolution
from `package.json`, and end-to-end diagnostic report generation.

## Limitations

- CPU% is a `ps` instantaneous sample, not a smoothed average — `watch` is the
  better lens for sustained spikes.
- Some system/kernel processes expose no command line or cwd without elevated
  privileges; these show `unknown`.
- `pstree` is **not** required.

## Roadmap → menu bar app

The collection/enrichment core is UI-agnostic, so a menu bar app can wrap it:

1. **Menu bar CPU indicator** — poll `snapshot()` on a timer; show total CPU and a
   badge when any dev process crosses a threshold.
2. **Visual process tree** — render `ProcessTree` as an expandable outline;
   click a node to run `enrich()` on demand.
3. **Incident history** — persist `watch` spikes (timestamp, PID, name, peak CPU,
   resolved project) to a local store; show a timeline.
4. **"Profile this process for 10 seconds"** — optional advanced action shelling
   out to `xctrace record --template 'Time Profiler' --attach <PID> --time-limit 10s`,
   then summarizing the trace. Gated behind an explicit opt-in (it's heavier and
   may prompt for permissions).

Two packaging options: ship this CLI as a **Tauri sidecar** and call it as a
subprocess (fastest path — reuse as-is), or port `collect/`+`tree/`+`enrich/` to
Swift and keep this repo as the reference implementation + test oracle.
```
