import Anthropic from '@anthropic-ai/sdk';
import type { Enrichment, ProcessNode } from '../types.js';
import { generateReport } from '../report/report.js';

/** Thrown for expected, user-facing problems (missing key, etc.) — shown verbatim in the UI. */
export class AdviceError extends Error {}

/** Default model. Overridable via PD_AI_MODEL; defaults to the latest Opus. */
const MODEL = process.env.PD_AI_MODEL || 'claude-opus-4-8';

const SYSTEM = [
  'You are a macOS performance and developer-tooling diagnostics assistant.',
  'You are given a read-only snapshot of ONE process: its command, working directory,',
  'parent chain, resolved npm script, open ports, and CPU usage.',
  'Explain, grounded strictly in the evidence provided:',
  '1. What this process almost certainly is (in plain language).',
  '2. The most likely reason it is using CPU.',
  '3. Safe, read-only next steps to confirm the diagnosis.',
  '4. How to stop it cleanly if it is unwanted (which terminal/IDE/command owns it).',
  'Be concise and specific. Never recommend force-killing system or kernel processes.',
  'If the evidence is thin, say so and name what extra information would help.',
  'Format with short markdown sections (### headings) and bullet points.',
].join(' ');

function buildPrompt(node: ProcessNode, enr: Enrichment): string {
  return (
    'Here is a read-only diagnostic snapshot captured by a macOS CPU investigation tool:\n\n' +
    generateReport(node, enr) +
    '\n\nBased only on this evidence, give your assessment and recommendations.'
  );
}

/**
 * Ask Claude to interpret a process snapshot and recommend next steps.
 * Throws AdviceError for expected problems (no API key); other errors propagate.
 */
export async function getAdvice(node: ProcessNode, enr: Enrichment): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AdviceError(
      'No ANTHROPIC_API_KEY found. Export your Anthropic API key and restart `serve` to enable AI advice.',
    );
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1500,
    // Reasoning task → adaptive thinking; low effort keeps the button responsive.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: buildPrompt(node, enr) }],
  });

  let text = '';
  for (const block of response.content) {
    if (block.type === 'text') text += block.text;
  }
  return text.trim() || 'The model returned no advice.';
}
