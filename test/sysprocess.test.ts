import { describe, expect, it } from 'vitest';
import { sysProcessHint } from '../src/enrich/sysprocess.js';

// ---------------------------------------------------------------------------
// fs-symptom daemons
// ---------------------------------------------------------------------------

describe('sysProcessHint — isFsSymptom', () => {
  it('fseventsd returns a hint with isFsSymptom:true', () => {
    const hint = sysProcessHint('fseventsd');
    expect(hint).not.toBeNull();
    expect(hint!.isFsSymptom).toBe(true);
  });

  it('fseventsd label and what mention symptom behaviour', () => {
    const hint = sysProcessHint('fseventsd');
    expect(hint!.label).toMatch(/fsevents|fsevent/i);
    expect(hint!.what.toLowerCase()).toMatch(/symptom|flood|change/);
  });

  it('fseventsd lookWhere mentions Filesystem churn', () => {
    const hint = sysProcessHint('fseventsd');
    expect(hint!.lookWhere).toMatch(/Filesystem churn/);
  });

  it('mds has isFsSymptom:true', () => {
    const hint = sysProcessHint('mds');
    expect(hint).not.toBeNull();
    expect(hint!.isFsSymptom).toBe(true);
  });

  it('mds_stores has isFsSymptom:true', () => {
    const hint = sysProcessHint('mds_stores');
    expect(hint).not.toBeNull();
    expect(hint!.isFsSymptom).toBe(true);
  });

  it('mdworker has isFsSymptom:true', () => {
    const hint = sysProcessHint('mdworker');
    expect(hint).not.toBeNull();
    expect(hint!.isFsSymptom).toBe(true);
  });

  it('mdworker_shared has isFsSymptom:true', () => {
    const hint = sysProcessHint('mdworker_shared');
    expect(hint).not.toBeNull();
    expect(hint!.isFsSymptom).toBe(true);
  });

  it('mdbulkimport has isFsSymptom:true', () => {
    const hint = sysProcessHint('mdbulkimport');
    expect(hint).not.toBeNull();
    expect(hint!.isFsSymptom).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// non-fs-symptom daemons
// ---------------------------------------------------------------------------

describe('sysProcessHint — normal (non-fs-symptom) processes', () => {
  it('WindowServer returns null isFsSymptom', () => {
    const hint = sysProcessHint('WindowServer');
    expect(hint).not.toBeNull();
    expect(hint!.isFsSymptom).toBeUndefined();
  });

  it('kernel_task returns null isFsSymptom', () => {
    const hint = sysProcessHint('kernel_task');
    expect(hint!.isFsSymptom).toBeUndefined();
  });

  it('coreaudiod returns null isFsSymptom', () => {
    const hint = sysProcessHint('coreaudiod');
    expect(hint!.isFsSymptom).toBeUndefined();
  });

  it('launchd returns null isFsSymptom', () => {
    const hint = sysProcessHint('launchd');
    expect(hint!.isFsSymptom).toBeUndefined();
  });

  it('completely unknown process returns null', () => {
    expect(sysProcessHint('my_custom_app')).toBeNull();
  });

  it('unknown process has no isFsSymptom', () => {
    const hint = sysProcessHint('some_random_daemon');
    expect(hint).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// crash handler daemons (isCrashHandler, NOT isFsSymptom)
// ---------------------------------------------------------------------------

describe('sysProcessHint — isCrashHandler', () => {
  it('ReportCrash has isCrashHandler:true', () => {
    const hint = sysProcessHint('ReportCrash');
    expect(hint!.isCrashHandler).toBe(true);
    expect(hint!.isFsSymptom).toBeUndefined();
  });

  it('spindump has isCrashHandler:true', () => {
    const hint = sysProcessHint('spindump');
    expect(hint!.isCrashHandler).toBe(true);
    expect(hint!.isFsSymptom).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// container runtime daemons (isContainerRuntime, NOT isFsSymptom)
// ---------------------------------------------------------------------------

describe('sysProcessHint — container runtime', () => {
  it('orbstack process matches container runtime pattern', () => {
    const hint = sysProcessHint('com.orbstack.helper');
    expect(hint).not.toBeNull();
    expect(hint!.isContainerRuntime).toBe(true);
    expect(hint!.isFsSymptom).toBeUndefined();
  });

  it('dockerd matches container runtime pattern', () => {
    const hint = sysProcessHint('dockerd');
    expect(hint).not.toBeNull();
    expect(hint!.isContainerRuntime).toBe(true);
    expect(hint!.isFsSymptom).toBeUndefined();
  });
});
