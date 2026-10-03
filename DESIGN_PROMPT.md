# Design prompt — Process Detective, a personal Activity Monitor

Hand the brief below to Claude (or any design tool). It describes a navigable,
self-built Activity Monitor with live performance metrics and a session-scoped
history that only records while you're looking at it.

> **Tip — evolve, don't restart.** A working backend already exists (see
> "What already exists" at the bottom). Prepend one line to the prompt:
> *"Here is the current app; redesign and extend it per the brief below,"* and
> attach `src/server/page.html` plus this file.

---

## The prompt

You are a senior product designer and front-end engineer. Design and build
**"Process Detective" — a personal Activity Monitor for macOS**: a read-only,
no-sudo performance dashboard that does what Apple's Activity Monitor does, but
with cleaner navigation, a sharper "why is this process hot" investigation flow,
and a live history of performance while the window is open.

It runs today as a local web app (Node HTTP server + single-page UI) and is the
intended front end for a future SwiftUI/Tauri menu-bar app, so the design must
scale from a full window down to a compact panel.

Audience: developers and power users debugging CPU/memory/fan spikes. They're
comfortable with dense data but want it navigable and fast to scan — not a wall of
numbers, and not a tool that itself hogs resources.

### 1. Navigation & information architecture (this matters — make it good)

Apple's Activity Monitor uses flat tabs and buries the story. Do better. Use a
**persistent left sidebar** (collapsible to icons) with these primary sections:

- **Overview** — the at-a-glance vitals dashboard (all metrics, compact)
- **CPU** — usage, per-core, load, top CPU processes, live timeline
- **Memory** — composition, pressure, swap, top memory processes, timeline
- **Energy** — energy impact ranking, battery/thermal, timeline
- **Disk** — volumes, I/O throughput, top disk processes
- **Network** — throughput, connections, listening-ports map, top talkers
- **Processes** — the full searchable/sortable process table
- **Process detail** — deep dive (pushed when a process is selected from anywhere)

Navigation requirements:
- Each section is **deep-linkable** (hash route), so reload returns to the same place.
- A process is selectable from any section's "top processes" list and opens the
  **detail view**, with a back affordance to where you came from.
- **Global search/filter** (`/` to focus) over processes by name, PID, or command.
- **Keyboard navigation**: number keys or `g`-then-letter to jump sections; `↑/↓`
  to move the selection in any list; `Enter` to open detail; `Esc` to go back.
- A persistent **header bar** with the live clock, a record/pause indicator (see
  §3), and global controls (refresh interval, light/dark).

### 2. Performance parameters to surface

Design for all of these. Use hierarchy — Overview shows the compact version of
each; the dedicated section shows the full version with its timeline.

**CPU** — overall usage %, user/system/idle split, **per-core utilization**
(heatmap or bar strip; on Apple Silicon distinguish performance vs efficiency
cores), load average (1/5/15), total process + thread counts.

**Memory** — used/total with a **stacked composition bar** (wired / compressed /
active / inactive / free), **memory-pressure gauge** (normal/warning/critical),
swap used, cached files, page-in/out rate.

**Energy** — per-process **energy impact** ranking, battery % + time remaining +
charging state + power source, thermal-pressure state, (where available) fan RPM.

**Disk** — per-volume capacity used/free, **read/write throughput**, busiest
processes by disk activity.

**Network** — **live ↓/↑ throughput**, established + listening connection counts,
cumulative bytes transferred, a **listening-ports map** (localhost services like
3000 / 5173 / 5432 with their owning process and an "open in browser" affordance),
top network processes.

**Per-process** — PID, PPID, name, full command, exec path, cwd, user, start time,
elapsed, priority, state, CPU %, memory (RSS / %), thread count, energy impact,
open file-descriptor count, **parent chain up to launchd**, child tree, open files
& sockets, and an interpretation layer (nearest package.json, resolved npm script
like `scripts.dev = "vite --host"`, friendly labels like "Vite dev server").

**Host** — chip, core split, total RAM, model, uptime.

### 3. History — record only while watching (key behavior)

While the app is **open and visible**, keep a rolling, in-memory **time-series
history** of every metric (CPU, memory, network, energy, etc.) — a ring buffer of
roughly the last 10–15 minutes at the 2s sample rate.

- Render history as **live area/line charts** in each section (CPU over time,
  memory over time, network over time) and as **per-row sparklines** in the
  process lists. The selected process accumulates its own mini-history while
  it's in view.
- **Do not sample or record while the app is not being looked at.** When the tab
  is hidden or the window loses focus (`document.visibilitychange` /
  `window.blur`), **stop polling and freeze the buffer**; resume on focus. The
  charts should show this honestly — a subtle "paused — not recording" state and,
  on resume, a visible gap rather than a fabricated straight line.
- History is **session-scoped and in-memory only** — it is not written to disk and
  is intentionally discarded on close/reload. (If persistent logging is ever
  wanted, treat it as a separate, explicit opt-in — not the default.)
- State the rationale in the UI's design: a performance monitor shouldn't burn CPU
  or battery sampling in the background, and shouldn't become the very spike it's
  there to catch.

There is also a manual **pause** control (already present) that freezes the live
view on demand independent of focus.

### 4. Visual direction

Before building, **propose 3–4 distinct visual directions** (palette, typography,
layout, personality) tailored to a developer performance tool — e.g. a calm light
"inspector", a dark "mission control", a terminal-inspired monochrome + single
accent, an editorial data look. For each: background/surface colors, accent +
severity ramp (calm → warning → critical), type choices, one-line rationale. Let me
pick one, then implement it fully.

Avoid generic "AI slop" aesthetics: no Inter-on-white default, no purple-gradient
clichés. Commit to a real identity. Tabular numerics for every metric, consistent
severity coloring, a coherent icon set, and restrained, purposeful motion.

### 5. Interactions

Live refresh with pause; focus-gated recording (§3); click any process to inspect;
threshold slider re-colors severity instantly; sort lists by any metric; filter to
developer tooling; copy a plain-text diagnostic report; copy a ready-to-paste AI
investigation prompt; (advanced) "profile this process for 10s". Keyboard-first
navigation throughout. Charts support hover-scrub to read a value at a point in time.

### 6. Constraints

- **Read-only, no sudo** for the core experience. Metrics that need elevated rights
  (per-core utilization, fan RPM, per-process disk/network bytes) must degrade
  gracefully to a muted "requires elevated access" placeholder, never break layout.
- Stay smooth with **800+ processes** and continuous 2s updates.
- Accessible: legible contrast in light and dark, no font below 11px, visible focus.
- Self-contained single file with realistic **sample data** (including a few minutes
  of pre-seeded history so the charts render) for this deliverable; structured so it
  can wire to the existing JSON API and later be packaged in Tauri.

### 7. Reference — where the data comes from (read-only, macOS)

| Metric group | Source (no sudo unless noted) | Status |
|---|---|---|
| Per-process CPU/mem/etime/user/cmd | `ps -axo …` | ✓ live |
| Parent chain / child tree | PID→PPID from `ps` | ✓ live |
| cwd / open files / sockets / listening ports | `lsof` | ✓ live (cwd+ports) |
| npm script + friendly labels | nearest `package.json` | ✓ live |
| Overall CPU %, user/sys/idle, threads | `top -l1` | ✓ live |
| Load average | `sysctl vm.loadavg` | ✓ live |
| Memory composition | `vm_stat` + `sysctl hw.memsize` | ✓ live |
| Memory pressure | `sysctl kern.memorystatus_vm_pressure_level` | ✓ live |
| Swap | `sysctl vm.swapusage` | ✓ live |
| Cores / chip / model / uptime | `sysctl hw.*`, `kern.boottime` | ✓ live |
| Storage volumes | `df -k` | ✓ live |
| Network throughput (rate via deltas) | `netstat -ib` | ✓ live |
| Connections (established/listen/udp) | `netstat -an` | ✓ live |
| Battery / source | `pmset -g batt` | ✓ live |
| Thermal pressure | `pmset -g therm` | ✓ live |
| Per-process energy impact / #threads / #ports | `top -l1 -stats pid,command,power,th,ports` | available |
| Per-process FD count | `lsof -p <pid> | wc -l` | available |
| Disk I/O throughput | `iostat -d -w1` | available |
| Directory sizes (on demand) | `du -sh <path>/*` | available |
| **Needs sudo / extra tooling** | per-core utilization, fan RPM (SMC), per-process disk/net bytes (`fs_usage`), detailed power (`powermetrics`), `nettop` | future |

Label sudo-gated metrics as "requires elevated access" — they're targets for a
future privileged helper, not omissions.

### 8. Deliverable

1. The 3–4 visual directions (short, with concrete color/type/layout specifics).
2. After I choose: the full single-file Activity Monitor — sidebar navigation, all
   sections, live charts seeded with sample history, the focus-gated recording
   behavior, and the process detail view.
3. A short note mapping each section to its data source and flagging which metrics
   need elevated access.

---

## What already exists (so the builder reuses it)

A working Node backend serves a single-page UI today, verified against a real Mac:

- `GET /api/processes` — full process list (pid, ppid, name, friendly label, cpu,
  mem, elapsed, user, isDev flag), sorted by CPU.
- `GET /api/system` — system vitals: cpu (usage/user/sys/idle, loadAvg, core split),
  memory (segments that tile RAM, pressure, swap, cached), network (rx/tx rate,
  cumulative, connection counts, interfaces), storage volumes, power
  (battery/source/thermal), host (chip/model/uptime), process/thread counts.
- `GET /api/inspect/:pid` — deep detail: identity, parent chain, children, cwd,
  ports, package.json + resolved script, a copy-ready diagnostic `report`, and a
  ready-to-paste AI `prompt`.
- `POST /api/advice/:pid` — optional Claude-generated advice (needs an API key).

The current UI already has a vitals strip, a process list with CPU bars, a process
detail panel, copy-report / copy-prompt / AI-advice actions, and a 2s poll with
manual pause. The job is to grow this into the navigable, history-keeping Activity
Monitor described above.
