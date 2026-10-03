import type { Enrichment, ProcessNode } from '../types.js';
import { generateReport } from './report.js';

const QUESTIONS = [
  'Please act as a macOS performance and developer-tooling expert and tell me:',
  '1. What this process almost certainly is.',
  '2. The most likely reason it is using this much CPU.',
  '3. Safe, read-only commands I can run to confirm the diagnosis.',
  "4. How to stop it cleanly if it's unwanted (which terminal, IDE, or command owns it).",
  '5. If a stack sample is included, use it to state what the process is executing;',
  '   distinguish compute-bound (spinning) from blocked/waiting (not CPU-bound).',
  '6. If recent crashes are listed, identify the repeat offender and whether it is',
  '   the likely cause of this process\'s high CPU (e.g. ReportCrash symbolicating a crasher).',
  '7. If open files are listed, note anything suspicious (e.g. cache files, unexpected sockets).',
  '8. If container info is included, say whether a container storm / churn is the cause,',
  '   which image dominates, and (for Testcontainers) that a test or mutation run is the',
  '   likely driver.',
  '9. If a process log is included, use the top repeated messages to say what the',
  '   process is actively doing (which workflow/task/subsystem is firing) and whether',
  '   it looks like a tight loop or retry storm.',
  '10. If filesystem-churn attribution is included, name the process generating the',
  '   file-event flood and the directory it is hammering; tie it back to the symptom',
  '   daemon (fseventsd / Spotlight) if relevant.',
  '11. If "Directory hotspots" are listed, treat a directory holding many open file',
  '   descriptors as the prime suspect for the workload — name the directory and say',
  '   what kind of files it holds.',
  '12. If "Hosted extensions" are listed, the process name is a generic host. Attribute',
  '   the CPU to a specific extension and justify which one from the evidence',
  '   (native modules loaded, files being read) — do not guess.',
  '13. If "Read activity" is included, use it to say whether the process is actively',
  '   streaming files or merely holding descriptors open.',
  '14. A "Collection status" block lists what was gathered. Anything marked',
  '   "collected — none …" was checked and was genuinely empty: do NOT ask for it',
  '   again. Only request data marked "not collected".',
  'Never suggest force-killing system or kernel processes. If the evidence is thin,',
  'say what extra information would help.',
].join('\n');

/**
 * A self-contained, copy-paste investigation prompt. Bundles the diagnostic
 * snapshot with the questions, so it can be dropped into any AI agent without
 * needing this tool's own API key.
 */
export function buildInvestigationPrompt(node: ProcessNode, enr: Enrichment): string {
  return [
    "I'm investigating a high-CPU process on my macOS machine. A read-only",
    'diagnostics tool captured the snapshot below.',
    '',
    QUESTIONS,
    '',
    '--- process snapshot ---',
    generateReport(node, enr),
    '--- end snapshot ---',
  ].join('\n');
}
