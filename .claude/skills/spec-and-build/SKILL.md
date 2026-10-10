---
name: spec-and-build
description: Implement a substantial feature with a deliberate split — write a complete implementation-ready spec in THIS (high-reasoning) session, then delegate the mechanical build to a background Sonnet agent, then independently verify and deploy. Use whenever the user asks to build/implement a non-trivial feature, or says "spec it and build it", "spec in opus build in sonnet", or wants the spec-then-delegate workflow. Args = the feature to build.
---

# Spec-and-build workflow

The principle: **design is expensive thinking, implementation is mechanical.** Do
the architecture/spec here (deep reasoning), delegate the typing to a cheaper
Sonnet agent running in the background, then come back to verify and ship. Never
skip the verify step — a subagent's "all clean" is a claim, not proof.

## Steps

1. **Write a complete spec** to `docs/<slug>-spec.md`. It must be implementation-
   ready so a fresh agent with no context can execute it. Include:
   - **Orientation**: project root, stack/conventions (e.g. ESM `.js` import
     extensions, strict TS, no new deps), and which existing files to read first.
   - **Goal & architecture**, **data model / types**, **files to create/modify**,
     **endpoints**, **UI integration**, **config**.
   - **Tests** to add (with fixtures) and the requirement that existing tests stay green.
     Point the builder at the `tdd` skill: Red → Green → Mutate, sanitized fixtures,
     no dependence on this Mac (`$HOME`, running processes, clock).
   - **Acceptance criteria** as concrete, runnable commands (typecheck, build,
     test, and a manual smoke sequence with expected outputs).
   - **Constraints & non-goals** (read-only, no sudo, graceful degradation, etc.).
   - An explicit **"do NOT commit, push, release or deploy — implement, verify locally, then STOP and report."**
   - **Deliverables to report**: files changed, verification outputs, deviations,
     follow-ups.

2. **Launch a background Sonnet agent** with the Agent tool:
   `subagent_type: general-purpose`, `model: sonnet`, `run_in_background: true`.
   The prompt: read `docs/<slug>-spec.md` in full and implement it exactly; orient
   in the codebase first; match conventions; verify rigorously per the acceptance
   criteria; **do not commit, push, release, deploy or ssh anywhere**; report back files changed +
   verification outputs + deviations + recommended follow-up.

3. **Tell the user it's running and end the turn.** A completion notification
   arrives automatically — don't poll.

4. **On completion, independently verify** — do not trust the summary:
   `npx tsc --noEmit`, `npm run build`, `npm test` (count must include the new
   tests), plus a real smoke test of the new behavior. If anything looks off
   (e.g. an endpoint returns a fallback value), run it down with a controlled
   test rather than hand-waving — past bugs hid behind plausible-looking output.

5. **If clean, ship it:** commit on `main`, push, wait for CI to go green (`ci`
   skill), cut a release (`ship` skill — CI signs and notarizes it), then install it
   on both Macs (`deploy` skill). Deploy installs the *release*, so skipping `ship`
   would reinstall the previous version. If not clean, fix directly or relaunch the
   agent (SendMessage to resume it) with precise corrections.

## Notes

- The spec in `docs/` is the contract and the durable artifact — keep it updated
  if the design changes during the build.
- Keep local smoke tests tame: short-lived servers, no 1-second collector cadences,
  always reap what you spawn (`kill`/`pkill`, verify it died — some servers trap
  SIGTERM). A monitor must never become the spike it's hunting.
- The model split is the point: deep model authors the spec, Sonnet builds, deep
  model verifies. Don't collapse it into one model doing everything.
