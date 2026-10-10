---
name: investigation-review
description: Turn an AI investigation transcript into concrete Process Detective improvements. Use when the user pastes an AI's analysis of a process (findings produced by the app's "investigation prompt") and asks to look into what it did, mine it for gaps, or improve the app for investigation purposes. Answers any live machine question first, extracts what the snapshot lacked, proposes prioritized fixes, and — on approval — hands the build to the spec-and-build skill.
---

# Investigation review → app improvement

Each time the user runs the app's investigation prompt on a process and pastes the
AI's findings, those findings are a free spec for the next improvement: an outside
agent just told you exactly what Process Detective's snapshot was missing. This
skill turns that into shipped features.

The loop: **answer their real question → mine the transcript for gaps → map gaps to
app changes → recommend → (on go-ahead) spec-and-build → verify → deploy.**

## Steps

1. **Answer the live question FIRST.** The user came with a real problem, not a
   feature request. If the findings raise a concrete, checkable question about *this*
   machine — "is X crash-looping?", "is it compute-bound or waiting?", "which client
   is driving it?" — run the read-only commands and answer it now, before pitching
   any app change. Be a detective first.
   - Read-only only; no sudo unless the user authorizes a specific command.
   - Reap anything you spawn; never start a runaway/1s-cadence loop. The monitor must
     not become the spike.

2. **Mine the transcript for gaps.** The AI's own words tell you what to add. Look for:
   - An explicit **"what would sharpen this" / "what's missing"** section.
   - **Follow-up commands it recommended** — every command it told the user to run
     (`sample`, `sudo powermetrics …`, `lsof -p`, `ls ~/Library/Logs/DiagnosticReports`,
     `system_profiler`…) is a signal the app didn't surface that data.
   - **"the snapshot doesn't include X" / "empty section" / "can't tell from this"**.
   - **Inaccuracies it worked around** — e.g. counts the app inflated/missed, missing
     timestamps, an unidentified culprit. Verify these against live data when cheap.

3. **Map each gap to a concrete app change**, then prioritize:
   - **Cheap / no-sudo / high-value first** (e.g. add timestamps, dedup, a new
     enrichment field, a label/hint).
   - **Elevated "cause" signals** behind the existing opt-in admin mechanism
     (`getStackSampleElevated` pattern → `osascript … with administrator privileges`):
     `powermetrics` (per-app GPU / energy / per-core CPU), `fs_usage`, `nettop`. Note
     when one elevated source unlocks several payoffs.
   - Note which changes reuse existing infra: the enrich layer (`src/service.ts`,
     `src/enrich/*`), the report/prompt builders (`src/report/*`), the
     `/api/inspect` + `/api/sample` endpoints, the detail panel in `page.html`.

4. **Dedup against what already exists** before proposing — don't re-pitch shipped
   capability. Already built: stack sample + elevated ("admin rights") sample,
   crash cross-reference (`src/collect/crashes.ts`), open files, system-process hints
   (`src/enrich/sysprocess.ts`), the memory-by-group donut. Grep/read to confirm
   before suggesting.

5. **Recommend a bundle and confirm scope** with the user (cheap fixes vs the bigger
   elevated feature; ship-now-lean vs everything).

6. **On go-ahead, hand to `spec-and-build`** — write the spec to
   `docs/<slug>-spec.md`, launch a background Sonnet agent, independently verify, then
   commit + push (CI green, `ci` skill), release (`ship` skill) and install on both
   Macs (`deploy` skill). Don't collapse
   the model split: spec + verify here, build in Sonnet.

## Notes

- Keep a running sense of the recurring theme: most "what's causing it" answers for
  *symptom* processes (ReportCrash → the crasher, WindowServer → the GUI client) live
  outside the process itself, and often behind elevated access. Those are the highest-
  value targets.
- It's fine to ship a small accuracy fix on its own (e.g. dedup an inflated count)
  even when the user is mainly excited about a bigger feature — correctness first.
