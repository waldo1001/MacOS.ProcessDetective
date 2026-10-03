/**
 * Tiny zero-dependency ANSI colorizer. Disabled automatically when output is
 * not a TTY or when NO_COLOR is set, so piped/copied output stays clean.
 */
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(open: number, close = 0) {
  return (s: string | number): string =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : String(s);
}

export const color = {
  enabled,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  inverse: wrap(7, 27),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};
