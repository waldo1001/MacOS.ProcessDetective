import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attributeOwners } from '../src/enrich/owner.js';
import { parseLsofRows } from '../src/collect/lsof.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'lsof-codehelper.txt'), 'utf8');

function fixturePaths(): string[] {
  return parseLsofRows(FIXTURE).map((r) => r.path);
}

describe('attributeOwners (fixture)', () => {
  it('parses the versioned .vscode extension directory name', () => {
    const result = attributeOwners(fixturePaths())!;
    const claude = result.extensions.find((e) => e.id === 'anthropic.claude-code');
    expect(claude).toBeDefined();
    expect(claude!.version).toBe('2.1.218');
    expect(claude!.builtin).toBe(false);
  });

  it('parses the bundled app/extensions/copilot path as built-in', () => {
    const result = attributeOwners(fixturePaths())!;
    const copilot = result.extensions.find((e) => e.id === 'copilot');
    expect(copilot).toBeDefined();
    expect(copilot!.builtin).toBe(true);
    expect(copilot!.version).toBeNull();
  });

  it('detects VS Code as the host', () => {
    const result = attributeOwners(fixturePaths())!;
    expect(result.host).toBe('VS Code');
  });

  it('marks hasNativeModule true for anthropic.claude-code', () => {
    const result = attributeOwners(fixturePaths())!;
    const claude = result.extensions.find((e) => e.id === 'anthropic.claude-code');
    expect(claude!.hasNativeModule).toBe(true);
  });

  it('collects both native module basenames, sorted and de-duplicated', () => {
    const result = attributeOwners(fixturePaths())!;
    expect(result.nativeModules).toEqual(['audio-capture.node', 'runtime.node']);
  });

  it('a Cursor path yields host: Cursor', () => {
    const result = attributeOwners([
      '/Users/testuser/.cursor/extensions/some.publisher.foo-1.0.0/index.js',
      '/Users/testuser/.cursor/extensions/some.publisher.foo-1.0.0/lib/a.js',
      '/Users/testuser/.cursor/extensions/some.publisher.foo-1.0.0/lib/b.js',
    ])!;
    expect(result.host).toBe('Cursor');
  });

  it('paths with no extension dirs return null', () => {
    const result = attributeOwners([
      '/Users/testuser/Documents/report.pdf',
      '/usr/lib/libSystem.B.dylib',
    ]);
    expect(result).toBeNull();
  });
});

describe('attributeOwners — sort order', () => {
  it('puts a native-module extension ahead of one without', () => {
    const result = attributeOwners([
      '/Users/testuser/.vscode/extensions/pub.no-native-1.0.0/index.js',
      '/Users/testuser/.vscode/extensions/pub.no-native-1.0.0/lib/a.js',
      '/Users/testuser/.vscode/extensions/pub.no-native-1.0.0/lib/b.js',
      '/Users/testuser/.vscode/extensions/pub.no-native-1.0.0/lib/c.js',
      '/Users/testuser/.vscode/extensions/pub.has-native-1.0.0/index.js',
      '/Users/testuser/.vscode/extensions/pub.has-native-1.0.0/native/addon.node',
    ])!;
    expect(result.extensions[0]!.id).toBe('pub.has-native');
    expect(result.extensions[0]!.hasNativeModule).toBe(true);
    expect(result.extensions[1]!.id).toBe('pub.no-native');
    expect(result.extensions[1]!.hasNativeModule).toBe(false);
  });

  // Regression: a bundled extension is present in EVERY VS Code helper process and
  // is almost never the anomaly. It must not outrank the extension the user chose
  // to install — that ordering buried the real culprit on a live process.
  it('puts a user-installed extension ahead of a built-in with more files', () => {
    const result = attributeOwners([
      '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/microsoft-authentication/dist/msal-node-runtime.node',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/microsoft-authentication/dist/main.js',
      '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/microsoft-authentication/dist/extra.js',
      '/Users/testuser/.vscode/extensions/anthropic.claude-code-2.1.218-darwin-arm64/resources/audio-capture.node',
    ])!;
    expect(result.extensions[0]!.id).toBe('anthropic.claude-code');
    expect(result.extensions[0]!.builtin).toBe(false);
    expect(result.extensions[1]!.id).toBe('microsoft-authentication');
    expect(result.extensions[1]!.fileCount).toBeGreaterThan(result.extensions[0]!.fileCount);
  });
});

// ---------------------------------------------------------------------------
// Per-extension native modules — attributing the whole process's native modules
// to every extension is exactly the misleading evidence this section removes.
// ---------------------------------------------------------------------------

describe('attributeOwners — nativeModuleNames are per-extension', () => {
  const PATHS = [
    '/Users/testuser/.vscode/extensions/anthropic.claude-code-2.1.218-darwin-arm64/resources/audio-capture.node',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/copilot/sdk/runtime.node',
    '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/build/vscode_fs.node',
  ];

  it('gives each extension only its own native module', () => {
    const result = attributeOwners(PATHS)!;
    const byId = new Map(result.extensions.map((e) => [e.id, e]));
    expect(byId.get('anthropic.claude-code')!.nativeModuleNames).toEqual(['audio-capture.node']);
    expect(byId.get('copilot')!.nativeModuleNames).toEqual(['runtime.node']);
    expect(byId.get('git')!.nativeModuleNames).toEqual(['vscode_fs.node']);
  });

  it('never leaks another extension\'s module into an extension', () => {
    const result = attributeOwners(PATHS)!;
    for (const ext of result.extensions) {
      expect(ext.nativeModuleNames.length).toBe(1);
    }
    // The process-wide list still holds all three.
    expect(result.nativeModules).toEqual(['audio-capture.node', 'runtime.node', 'vscode_fs.node']);
  });

  it('leaves nativeModuleNames empty for an extension with no native module', () => {
    const result = attributeOwners([
      '/Users/testuser/.vscode/extensions/pub.pure-js-1.0.0/index.js',
    ])!;
    expect(result.extensions[0]!.nativeModuleNames).toEqual([]);
    expect(result.extensions[0]!.hasNativeModule).toBe(false);
  });
});
