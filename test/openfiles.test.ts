import { describe, expect, it } from 'vitest';
import { classifyOpenFile, rankOpenFiles } from '../src/enrich/openfiles.js';
import type { OpenFile } from '../src/types.js';

const HOME = '/Users/testuser';

// ---------------------------------------------------------------------------
// classifyOpenFile
// ---------------------------------------------------------------------------

describe('classifyOpenFile — SIGNAL by data extension', () => {
  it('classifies a .sqlite file as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Shortcuts/ToolKit/Tools-prod.v67.sqlite', HOME)).toBe('signal');
  });

  it('classifies a .sqlite3 file as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Application Support/app.sqlite3', HOME)).toBe('signal');
  });

  it('classifies a .sqlite-wal file as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Shortcuts/Tools-prod.v67.sqlite-wal', HOME)).toBe('signal');
  });

  it('classifies a .sqlite-shm file as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Shortcuts/Tools-prod.v67.sqlite-shm', HOME)).toBe('signal');
  });

  it('classifies a .db file as signal', () => {
    expect(classifyOpenFile('/var/folders/tmp/cache.db', HOME)).toBe('signal');
  });

  it('classifies a .realm file as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Documents/MyApp.realm', HOME)).toBe('signal');
  });

  it('.sqlite under /Caches/ is SIGNAL (data-extension wins over cache noise path)', () => {
    // Per spec: data-extension SIGNAL wins even under Caches
    expect(classifyOpenFile('/Users/testuser/Library/Caches/data.sqlite', HOME)).toBe('signal');
  });
});

describe('classifyOpenFile — NOISE by extension', () => {
  it('classifies a .loctable file as noise', () => {
    expect(classifyOpenFile('/System/Library/CoreServices/en.loctable', HOME)).toBe('noise');
  });

  it('classifies a .plist-cache file as noise', () => {
    expect(classifyOpenFile('/var/folders/abc/xyz/com.apple.something.plist-cache', HOME)).toBe('noise');
  });

  it('classifies an atomic-write .plist-cache temp (random suffix) as noise', () => {
    expect(classifyOpenFile('/Library/Preferences/Logging/.plist-cache.aVgDOXsB', HOME)).toBe('noise');
  });

  it('classifies a .dylib file as noise', () => {
    expect(classifyOpenFile('/usr/lib/libz.dylib', HOME)).toBe('noise');
  });

  it('classifies a .ttf file as noise', () => {
    expect(classifyOpenFile('/Library/Fonts/Helvetica.ttf', HOME)).toBe('noise');
  });

  it('classifies a .strings file as noise', () => {
    expect(classifyOpenFile('/System/Library/CoreServices/Localizable.strings', HOME)).toBe('noise');
  });

  it('classifies a .nib file as noise', () => {
    expect(classifyOpenFile('/Applications/MyApp.app/Resources/MainMenu.nib', HOME)).toBe('noise');
  });
});

describe('classifyOpenFile — NOISE by path', () => {
  it('classifies a linkd path as noise', () => {
    expect(classifyOpenFile('/private/var/db/linkd/store', HOME)).toBe('noise');
  });

  it('classifies a metadatastore path as noise', () => {
    expect(classifyOpenFile('/private/var/db/metadatastore/db', HOME)).toBe('noise');
  });

  it('classifies a /Caches/ path (non-sqlite) as noise', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Caches/com.apple.metadata', HOME)).toBe('noise');
  });

  it('classifies a /var/folders/ path (non-sqlite) as noise', () => {
    expect(classifyOpenFile('/var/folders/abc/xyz/T/tempfile.tmp', HOME)).toBe('noise');
  });

  it('classifies a /System/ path as noise', () => {
    expect(classifyOpenFile('/System/Library/PrivateFrameworks/SomeFramework.framework/SomeFramework', HOME)).toBe('noise');
  });

  it('classifies a .framework/ path as noise', () => {
    expect(classifyOpenFile('/Library/Frameworks/Python.framework/Headers/Python.h', HOME)).toBe('noise');
  });
});

describe('classifyOpenFile — SIGNAL by path', () => {
  it('classifies Shortcuts library path as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Shortcuts/ToolKit/Tools-prod.v67.bundle', HOME)).toBe('signal');
  });

  it('classifies Application Support path as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Application Support/MyApp/data.json', HOME)).toBe('signal');
  });

  it('classifies Documents path as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Documents/report.pdf', HOME)).toBe('signal');
  });

  it('classifies ~/src/ path as signal', () => {
    expect(classifyOpenFile('/Users/testuser/src/myproject/index.ts', HOME)).toBe('signal');
  });

  it('classifies ~/SourceCode/ path as signal', () => {
    expect(classifyOpenFile('/Users/testuser/SourceCode/Community/MyApp/main.swift', HOME)).toBe('signal');
  });

  it('classifies ~/Developer/ path as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Developer/Xcode/DerivedData/info.plist', HOME)).toBe('signal');
  });

  it('classifies a user .log file under home as signal', () => {
    expect(classifyOpenFile('/Users/testuser/Library/Logs/MyApp.log', HOME)).toBe('signal');
  });
});

describe('classifyOpenFile — neutral', () => {
  it('classifies a plain text file outside of home as neutral', () => {
    expect(classifyOpenFile('/tmp/output.txt', HOME)).toBe('neutral');
  });

  it('classifies a socket as neutral', () => {
    expect(classifyOpenFile('/tmp/com.apple.app.socket', HOME)).toBe('neutral');
  });

  it('classifies /usr/bin/env as neutral (not /usr/lib)', () => {
    expect(classifyOpenFile('/usr/bin/env', HOME)).toBe('neutral');
  });

  it('classifies a .log file outside home as neutral (not signal)', () => {
    // /var/log is outside home, no SIGNAL extension, no noise path match
    const result = classifyOpenFile('/var/log/system.log', HOME);
    // /var/log is not in a noise path and not under home, so neutral
    expect(result).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// rankOpenFiles
// ---------------------------------------------------------------------------

function makeFile(path: string, type: OpenFile['type'] = 'file'): OpenFile {
  return { path, type };
}

describe('rankOpenFiles', () => {
  it('returns the same number of entries as input', () => {
    const files: OpenFile[] = [
      makeFile('/Users/testuser/Library/Shortcuts/Tools.sqlite'),
      makeFile('/var/folders/tmp/cache', 'dir'),
      makeFile('/tmp/socket', 'socket'),
    ];
    const ranked = rankOpenFiles(files, HOME);
    expect(ranked).toHaveLength(3);
  });

  it('signal files rank above noise files', () => {
    const files: OpenFile[] = [
      makeFile('/var/folders/abc/cache.plist-cache'),              // noise
      makeFile('/Users/testuser/Library/Shortcuts/Tools.sqlite'),  // signal (data ext)
    ];
    const ranked = rankOpenFiles(files, HOME);
    expect(ranked[0]!.cls).toBe('signal');
    expect(ranked[1]!.cls).toBe('noise');
  });

  it('marks exactly one notable file when a signal exists', () => {
    const files: OpenFile[] = [
      makeFile('/Users/testuser/Library/Shortcuts/Tools.sqlite'),  // signal
      makeFile('/Users/testuser/Documents/report.pdf'),            // signal
      makeFile('/var/folders/tmp/cache.plist-cache'),              // noise
    ];
    const ranked = rankOpenFiles(files, HOME);
    const notables = ranked.filter((r) => r.notable);
    expect(notables).toHaveLength(1);
    expect(notables[0]!.cls).toBe('signal');
  });

  it('marks no file as notable when no signal exists', () => {
    const files: OpenFile[] = [
      makeFile('/var/folders/abc/cache'),   // noise path
      makeFile('/tmp/socket', 'socket'),    // neutral
    ];
    const ranked = rankOpenFiles(files, HOME);
    expect(ranked.filter((r) => r.notable)).toHaveLength(0);
  });

  it('the notable file is the highest-scored signal', () => {
    const files: OpenFile[] = [
      makeFile('/var/folders/abc/noise.loctable'),                   // noise ext
      makeFile('/Users/testuser/Documents/second.pdf'),              // signal by path
      makeFile('/Users/testuser/Library/Shortcuts/first.sqlite'),    // signal by data ext
    ];
    const ranked = rankOpenFiles(files, HOME);
    // Both signals have score 2; the first in ranked order should be notable
    const notable = ranked.find((r) => r.notable);
    expect(notable).toBeDefined();
    expect(notable!.cls).toBe('signal');
  });

  it('directories get a small penalty below regular signal files', () => {
    const files: OpenFile[] = [
      makeFile('/Users/testuser/Library/Shortcuts/', 'dir'),        // signal dir (lower score)
      makeFile('/Users/testuser/Library/Shortcuts/Tools.sqlite'),   // signal file
    ];
    const ranked = rankOpenFiles(files, HOME);
    // The file should rank above or equal to the dir
    const fileRank = ranked.findIndex((r) => r.file.type === 'file');
    const dirRank = ranked.findIndex((r) => r.file.type === 'dir');
    expect(fileRank).toBeLessThan(dirRank);
  });

  it('preserves stable order for equal-scored files', () => {
    const files: OpenFile[] = [
      makeFile('/tmp/a.txt'),  // neutral
      makeFile('/tmp/b.txt'),  // neutral
      makeFile('/tmp/c.txt'),  // neutral
    ];
    const ranked = rankOpenFiles(files, HOME);
    expect(ranked[0]!.file.path).toBe('/tmp/a.txt');
    expect(ranked[1]!.file.path).toBe('/tmp/b.txt');
    expect(ranked[2]!.file.path).toBe('/tmp/c.txt');
  });

  it('returns empty array for empty input', () => {
    expect(rankOpenFiles([], HOME)).toHaveLength(0);
  });

  it('real Shortcuts sqlite-shm is signal and becomes notable', () => {
    const files: OpenFile[] = [
      makeFile('/Users/testuser/Library/com.apple.linkd/metadatastore'),          // noise
      makeFile('/System/Library/CoreServices/foo.loctable'),                      // noise
      makeFile('/Users/testuser/Library/Shortcuts/ToolKit/Tools-prod.v67.sqlite-shm'), // SIGNAL
    ];
    const ranked = rankOpenFiles(files, HOME);
    const notable = ranked.find((r) => r.notable);
    expect(notable).toBeDefined();
    expect(notable!.file.path).toContain('sqlite-shm');
  });
});

// ---------------------------------------------------------------------------
// rankOpenFiles — hotspotDirs (regression test for the misdiagnosis this tool
// once caused: a hotspot file must outrank an unrelated signal file)
// ---------------------------------------------------------------------------

describe('rankOpenFiles — hotspotDirs', () => {
  it('a neutral file under a hotspot dir (score 3) outranks a signal file that is not (score 2)', () => {
    const hotspotDir = '/Users/testuser/.claude/projects/-Users-testuser-SourceCode-Demo';
    const files: OpenFile[] = [
      makeFile('/Users/testuser/Library/Application Support/Code/User/globalStorage/github.copilot-chat/session-store.db'), // signal, +2
      makeFile(`${hotspotDir}/aaa.jsonl`), // neutral, but +3 for hotspot = 3
    ];
    const ranked = rankOpenFiles(files, HOME, [hotspotDir]);
    expect(ranked[0]!.file.path).toContain('aaa.jsonl');
    expect(ranked[0]!.score).toBe(3);
    expect(ranked[1]!.score).toBe(2);
  });

  it('omitting hotspotDirs reproduces today\'s ordering exactly', () => {
    const files: OpenFile[] = [
      makeFile('/var/folders/abc/cache.plist-cache'),              // noise
      makeFile('/Users/testuser/Library/Shortcuts/Tools.sqlite'),  // signal (data ext)
    ];
    const withDefault = rankOpenFiles(files, HOME);
    const withEmpty = rankOpenFiles(files, HOME, []);
    expect(withDefault.map((r) => r.score)).toEqual(withEmpty.map((r) => r.score));
    expect(withDefault.map((r) => r.file.path)).toEqual(withEmpty.map((r) => r.file.path));
  });

  it('a hotspot dir prefix must match on a / boundary — /a/bc is not under /a/b', () => {
    const files: OpenFile[] = [makeFile('/a/bc/file.txt')];
    const ranked = rankOpenFiles(files, HOME, ['/a/b']);
    expect(ranked[0]!.score).toBe(0); // neutral, no hotspot bonus applied
  });

  it('a hotspot dir prefix does match on a real / boundary', () => {
    const files: OpenFile[] = [makeFile('/a/b/file.txt')];
    const ranked = rankOpenFiles(files, HOME, ['/a/b']);
    expect(ranked[0]!.score).toBe(3);
  });
});
