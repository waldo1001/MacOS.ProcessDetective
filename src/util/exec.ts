import { execFile } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when the command could not be spawned or exited non-zero. */
  failed: boolean;
}

/**
 * Run an external command and capture stdout/stderr. Never throws — callers get
 * a RunResult and decide how to degrade. This keeps the tool read-only and
 * resilient to missing binaries or permission errors.
 */
export function run(cmd: string, args: string[], timeoutMs = 5000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          failed: Boolean(err),
        });
      },
    );
  });
}
