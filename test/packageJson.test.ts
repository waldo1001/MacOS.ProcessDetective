import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findNearestPackageJson,
  parsePackageJson,
  resolveScriptName,
} from '../src/enrich/packageJson.js';

const SAMPLE = JSON.stringify({
  name: 'customer-x',
  scripts: {
    dev: 'vite --host 0.0.0.0',
    build: 'tsc && vite build',
    lint: 'eslint .',
  },
});

describe('parsePackageJson', () => {
  it('extracts name + string scripts only', () => {
    const info = parsePackageJson(SAMPLE, '/repo/package.json')!;
    expect(info.name).toBe('customer-x');
    expect(info.dir).toBe('/repo');
    expect(info.scripts.dev).toBe('vite --host 0.0.0.0');
  });

  it('returns null on invalid JSON', () => {
    expect(parsePackageJson('{ not json', '/x/package.json')).toBeNull();
  });
});

describe('resolveScriptName', () => {
  const scripts = parsePackageJson(SAMPLE, '/repo/package.json')!.scripts;

  it('resolves "npm run dev"', () => {
    expect(resolveScriptName('npm run dev', scripts)).toBe('dev');
  });
  it('resolves "npm run-script build"', () => {
    expect(resolveScriptName('npm run-script build', scripts)).toBe('build');
  });
  it('resolves pnpm/yarn/bun shorthand only when the script exists', () => {
    expect(resolveScriptName('pnpm dev', scripts)).toBe('dev');
    expect(resolveScriptName('yarn lint', scripts)).toBe('lint');
    expect(resolveScriptName('pnpm nonexistent', scripts)).toBeNull();
  });
  it('does not treat "npm dev" (no run) as a script', () => {
    expect(resolveScriptName('npm dev', scripts)).toBeNull();
  });
  it('handles a full path to the package manager', () => {
    expect(resolveScriptName('/opt/homebrew/bin/npm run dev', scripts)).toBe('dev');
  });
  it('returns null for non-package-manager commands', () => {
    expect(resolveScriptName('node server.js', scripts)).toBeNull();
  });
});

describe('findNearestPackageJson', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-test-'));
  const nested = join(root, 'apps', 'web', 'src');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, 'package.json'), SAMPLE);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('walks upward to the nearest package.json', () => {
    const info = findNearestPackageJson(nested);
    expect(info?.name).toBe('customer-x');
    expect(info?.dir).toBe(root);
  });

  it('returns null for a null cwd', () => {
    expect(findNearestPackageJson(null)).toBeNull();
  });
});
