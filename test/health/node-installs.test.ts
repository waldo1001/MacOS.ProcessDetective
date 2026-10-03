import { describe, expect, it } from 'vitest';
import {
  checkNodeInstalls, classifyNodeInstalls, classifyNodeOrigin, parseWhichNode, type NodeInstall,
} from '../../src/health/checks/node-installs.js';
import { fakeContext, fakeFs, fixture, ok, scriptedRun } from './helpers.js';

describe('parseWhichNode + classifyNodeOrigin', () => {
  const paths = parseWhichNode(fixture('which-node.txt'));

  it('keeps 5 unique paths in order; the first is the winner', () => {
    expect(paths).toHaveLength(5);
    expect(paths[0]).toBe('/Users/waldo/.nvm/versions/node/v20.20.2/bin/node');
  });

  it('ignores rc-file noise', () => {
    expect(parseWhichNode('Welcome back!\n/opt/homebrew/bin/node\nnode not found\n')).toEqual(['/opt/homebrew/bin/node']);
  });

  it('finds 3 origins', () => {
    const origins = new Set(paths.map(classifyNodeOrigin));
    expect([...origins].sort()).toEqual(['homebrew', 'nvm', 'pkg']);
  });

  it('classifies every manager', () => {
    expect(classifyNodeOrigin('/Users/x/.fnm/node-versions/v20/installation/bin/node')).toBe('fnm');
    expect(classifyNodeOrigin('/Users/x/Library/Caches/fnm_multishells/1/bin/node')).toBe('fnm');
    expect(classifyNodeOrigin('/Users/x/.volta/tools/image/node/20/bin/node')).toBe('volta');
    expect(classifyNodeOrigin('/Users/x/.asdf/installs/nodejs/20/bin/node')).toBe('asdf');
    expect(classifyNodeOrigin('/Users/x/.local/share/mise/installs/node/20/bin/node')).toBe('mise');
    expect(classifyNodeOrigin('/usr/local/Cellar/node/20/bin/node')).toBe('homebrew');
    expect(classifyNodeOrigin('/opt/homebrew/Cellar/node/26/bin/node')).toBe('homebrew');
    expect(classifyNodeOrigin('/usr/local/bin/node')).toBe('pkg');
    expect(classifyNodeOrigin('/somewhere/else/bin/node')).toBe('other');
  });
});

const inst = (path: string, version: string): NodeInstall => ({ path, realPath: path, version });

describe('classifyNodeInstalls', () => {
  it('warns when more than one origin is on PATH and names the winner', () => {
    const f = classifyNodeInstalls(
      [
        inst('/Users/waldo/.nvm/versions/node/v20.20.2/bin/node', 'v20.20.2'),
        inst('/opt/homebrew/bin/node', 'v26.10.0'),
        inst('/usr/local/bin/node', 'v24.14.0'),
      ],
      true,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.title).toBe('3 Node.js installs on PATH (nvm wins: v20.20.2)');
    expect(f[0]!.safety).toBe('manual');
    expect(f[0]!.manualSteps!.join('\n')).toContain('/usr/local/bin/node'); // pkg origin present
  });

  it('three nvm versions alone are ONE origin: info, no warn', () => {
    const f = classifyNodeInstalls(
      [
        inst('/Users/w/.nvm/versions/node/v20.20.2/bin/node', 'v20.20.2'),
        inst('/Users/w/.nvm/versions/node/v22.22.3/bin/node', 'v22.22.3'),
        inst('/Users/w/.nvm/versions/node/v22.23.1/bin/node', 'v22.23.1'),
      ],
      true,
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('info');
    expect(f[0]!.manualSteps).toBeUndefined();
  });

  it('without a pkg origin there are no /usr/local removal steps; unknown PATH order is said so', () => {
    const f = classifyNodeInstalls([inst('/Users/w/.nvm/versions/node/v20/bin/node', 'v20'), inst('/opt/homebrew/bin/node', 'v26')], false);
    expect(f[0]!.severity).toBe('warn');
    expect(f[0]!.manualSteps).toBeUndefined();
    expect(f[0]!.title).toContain('PATH order unknown');
  });
});

describe('checkNodeInstalls', () => {
  it('asks the login shell, resolves symlinks and versions each path', async () => {
    const run = scriptedRun([
      ['-lic /usr/bin/which -a node', ok(fixture('which-node.txt'))],
      [/--version/, (cmd) => ok(`v-of-${cmd.split('/').slice(-3, -2)[0] ?? 'x'}\n`)],
    ]);
    const fs = fakeFs({});
    fs.realpath = async (p) => (p === '/opt/homebrew/bin/node' ? '/opt/homebrew/Cellar/node/26.10.0/bin/node' : p);
    const r = await checkNodeInstalls(fakeContext({ run }), fs);
    expect(r.findings[0]!.severity).toBe('warn');
    expect(r.findings[0]!.title).toContain('3 Node.js installs on PATH');
    expect(run.calls.filter((c) => c.includes('--version'))).toHaveLength(5);
  });

  it('falls back to probing the standard locations when the login shell yields nothing', async () => {
    const run = scriptedRun([[/--version/, ok('v1.0.0\n')]]);
    const r = await checkNodeInstalls(fakeContext({ run, exists: (p) => p === '/opt/homebrew/bin/node' || p === '/usr/local/bin/node' }), fakeFs({}));
    expect(r.findings[0]!.title).toContain('PATH order unknown');
  });
});
