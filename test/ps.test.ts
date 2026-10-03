import { describe, expect, it } from 'vitest';
import {
  basename,
  mergeProcesses,
  parseEtime,
  parsePsArgs,
  parsePsComm,
} from '../src/collect/ps.js';

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('/usr/local/bin/node')).toBe('node');
    expect(basename('/Applications/Foo.app/Contents/MacOS/Foo Bar')).toBe('Foo Bar');
    expect(basename('node')).toBe('node');
    expect(basename('/trailing/slash/')).toBe('slash');
    expect(basename(null)).toBeNull();
    expect(basename('')).toBeNull();
  });
});

describe('parseEtime', () => {
  it('parses every ps elapsed format into seconds', () => {
    expect(parseEtime('05')).toBe(5);
    expect(parseEtime('01:30')).toBe(90);
    expect(parseEtime('01:02:03')).toBe(3723);
    expect(parseEtime('15-10:30:45')).toBe(15 * 86400 + 10 * 3600 + 30 * 60 + 45);
    expect(parseEtime('')).toBe(0);
  });
});

describe('parsePsComm', () => {
  it('parses fixed fields and keeps the space-containing exec path intact', () => {
    const stdout = [
      '    1     0   0.3  0.0 03-22:47:34 root             /sbin/launchd',
      '12345     1 183.2  4.5       10:30 waldo            /usr/local/bin/node',
      '23456 12345   0.0  0.1       00:05 waldo            /Applications/Visual Studio Code.app/Contents/MacOS/Code Helper',
    ].join('\n');
    const map = parsePsComm(stdout);

    const node = map.get(12345)!;
    expect(node.ppid).toBe(1);
    expect(node.cpu).toBeCloseTo(183.2);
    expect(node.mem).toBeCloseTo(4.5);
    expect(node.elapsedSeconds).toBe(630);
    expect(node.user).toBe('waldo');
    expect(node.execPath).toBe('/usr/local/bin/node');
    expect(node.name).toBe('node');

    const helper = map.get(23456)!;
    expect(helper.execPath).toBe('/Applications/Visual Studio Code.app/Contents/MacOS/Code Helper');
    expect(helper.name).toBe('Code Helper');
  });

  it('skips blank lines and non-numeric pids', () => {
    expect(parsePsComm('\n   \nHEADER junk\n').size).toBe(0);
  });
});

describe('parsePsArgs', () => {
  it('keeps the full command after the pid', () => {
    const stdout = [
      '    1 /sbin/launchd',
      '12345 node /Users/waldo/repo/node_modules/.bin/vite --host 0.0.0.0',
    ].join('\n');
    const map = parsePsArgs(stdout);
    expect(map.get(1)).toBe('/sbin/launchd');
    expect(map.get(12345)).toBe('node /Users/waldo/repo/node_modules/.bin/vite --host 0.0.0.0');
  });
});

describe('mergeProcesses', () => {
  it('joins comm + args on pid and back-fills the name from argv[0]', () => {
    const comm = parsePsComm('999 1 1.0 0.0 00:01 waldo \n'); // empty comm -> unknown
    const args = parsePsArgs('999 /usr/bin/python3 script.py');
    const merged = mergeProcesses(comm, args);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.command).toBe('/usr/bin/python3 script.py');
    expect(merged[0]!.name).toBe('python3');
  });
});
