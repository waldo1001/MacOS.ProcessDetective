import { run } from '../util/exec.js';

export interface ElevatedResult {
  ok: boolean;
  stdout: string;
  note: string | null;
}

/**
 * Run an arbitrary inner command as root via the macOS admin auth dialog.
 *
 * Honors PD_NO_ELEVATED=1 as a kill-switch (no dialog, immediate return).
 * Returns ok:false with a descriptive note on cancel, disable, or any failure.
 * Never throws.
 *
 * Security: the caller is responsible for ensuring `innerCmd` is injection-safe
 * (e.g. built from sanitized integers only). This function performs AppleScript
 * string escaping (\, ") defensively.
 */
export async function runElevated(innerCmd: string, timeoutMs: number): Promise<ElevatedResult> {
  if (process.env['PD_NO_ELEVATED'] === '1') {
    return {
      ok: false,
      stdout: '',
      note: 'elevated execution disabled (PD_NO_ELEVATED=1)',
    };
  }

  // Escape the inner command for embedding in an AppleScript string literal.
  // Since callers build commands from sanitized integers/paths only, the only
  // characters that need escaping are " and \. Escape defensively for correctness.
  const escaped = innerCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const appleScript = `do shell script "${escaped}" with administrator privileges`;

  const res = await run('osascript', ['-e', appleScript], timeoutMs);

  const combined = res.stderr + res.stdout;

  // User cancelled the auth dialog (osascript exit code 1, error -128).
  if (combined.includes('User canceled') || combined.includes('-128')) {
    return {
      ok: false,
      stdout: '',
      note: 'admin authentication cancelled',
    };
  }

  if (!res.failed) {
    return {
      ok: true,
      // `do shell script` returns output with classic Mac CR line endings (\r),
      // not \n — normalize so downstream line-based parsers work.
      stdout: res.stdout.replace(/\r\n?/g, '\n'),
      note: null,
    };
  }

  // Any other failure. Empty output usually means the auth dialog was never
  // approved (timed out / dismissed) — give an actionable message instead of
  // "unknown error".
  const reason = (res.stderr || res.stdout).slice(0, 120).trim();
  return {
    ok: false,
    stdout: '',
    note: reason
      ? `elevated execution failed: ${reason}`
      : 'no response — approve the macOS password prompt and try again',
  };
}
