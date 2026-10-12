import { describe, expect, it } from "vitest";
import {
  PRO_LARGE_DOCUMENT_BYTES,
  PRO_MEMORY_WARN_BYTES,
  PRO_NO_DRAFT_BYTES,
  formatLimitSize,
  limitWarnings,
  unloadGuardNeeded,
} from "@/app/pdf-pro/session/proLimits";
import { MAX_PRO_DRAFT_BYTES } from "@/app/pdf-pro/proDrafts";
import { PRO_MAX_SNAPSHOT_BYTES } from "@/app/pdf-pro/proWorkingDoc";
import type { ProDocument, ProSnapshot } from "@/app/pdf-pro/proTypes";

const MB = 1024 * 1024;

function documentOf(sizes: number[], cursor = sizes.length - 1): ProDocument {
  return {
    id: "d",
    name: "x.pdf",
    snapshots: sizes.map((byteLength, i) => ({ id: `s${i}`, byteLength, label: `L${i}` }) as ProSnapshot),
    cursor,
    savedSnapshotId: null,
    fingerprint: null,
    wasEncrypted: false,
    signatures: "none",
    trimmedCount: 0,
    openedAt: 0,
  };
}

describe("umbrales", () => {
  it("100 MB avisa, 150 MB deja de guardar borrador, y la memoria avisa al 75 % del presupuesto", () => {
    expect(PRO_LARGE_DOCUMENT_BYTES).toBe(100 * MB);
    expect(PRO_NO_DRAFT_BYTES).toBe(MAX_PRO_DRAFT_BYTES);
    expect(PRO_NO_DRAFT_BYTES).toBe(150 * MB);
    expect(PRO_MEMORY_WARN_BYTES).toBe(Math.floor(PRO_MAX_SNAPSHOT_BYTES * 0.75));
  });
});

describe("formatLimitSize", () => {
  it("MB sin decimales y GB con uno", () => {
    expect(formatLimitSize(120 * MB)).toBe("120 MB");
    expect(formatLimitSize(1536 * MB)).toBe("1.5 GB");
    expect(formatLimitSize(0.4 * MB)).toBe("0 MB");
  });
});

describe("limitWarnings", () => {
  it("sin documento no hay avisos", () => {
    expect(limitWarnings(null)).toEqual([]);
  });

  it("un documento pequeno no avisa", () => {
    expect(limitWarnings(documentOf([2 * MB, 2 * MB]))).toEqual([]);
  });

  it("justo por debajo de 100 MB no avisa; con 100 MB si", () => {
    expect(limitWarnings(documentOf([99 * MB]))).toEqual([]);
    expect(limitWarnings(documentOf([100 * MB])).map((w) => w.code)).toEqual(["largeDocument"]);
  });

  it("mas de 150 MB: ademas, sin borrador automatico", () => {
    const codes = limitWarnings(documentOf([151 * MB])).map((w) => w.code);
    expect(codes).toEqual(["largeDocument", "noDraftTooBig"]);
  });

  it("exactamente 150 MB todavia guarda borrador", () => {
    expect(limitWarnings(documentOf([150 * MB])).map((w) => w.code)).toEqual(["largeDocument"]);
  });

  it("el historial que se acerca al presupuesto avisa de memoria", () => {
    const codes = limitWarnings(documentOf([40 * MB, 80 * MB, 80 * MB, 80 * MB, 30 * MB])).map((w) => w.code);
    expect(codes).toEqual(["memoryHigh"]);
  });

  it("el tamaño del aviso se mide en el snapshot ACTUAL (tras deshacer)", () => {
    const warnings = limitWarnings(documentOf([5 * MB, 130 * MB], 0));
    expect(warnings.map((w) => w.code)).toEqual([]);
  });

  it("los avisos llevan el tamaño formateado como parametro", () => {
    expect(limitWarnings(documentOf([120 * MB]))[0].params).toEqual({ size: "120 MB" });
  });
});

describe("unloadGuardNeeded", () => {
  const base = {
    dirty: true,
    autosaveEnabled: true,
    autosaveSupported: true,
    autosaveFailed: false,
    wasEncrypted: false,
    currentBytes: 5 * MB,
  };

  it("sin cambios sin guardar nunca avisa", () => {
    expect(unloadGuardNeeded({ ...base, dirty: false })).toBe(false);
    expect(unloadGuardNeeded({ ...base, dirty: false, autosaveEnabled: false })).toBe(false);
  });

  it("con cambios y el borrador automatico funcionando, no avisa", () => {
    expect(unloadGuardNeeded(base)).toBe(false);
  });

  it("con cambios y el autoguardado apagado, avisa", () => {
    expect(unloadGuardNeeded({ ...base, autosaveEnabled: false })).toBe(true);
  });

  it("con cambios y sin soporte de IndexedDB, avisa", () => {
    expect(unloadGuardNeeded({ ...base, autosaveSupported: false })).toBe(true);
  });

  it("con cambios y el autoguardado fallo, avisa", () => {
    expect(unloadGuardNeeded({ ...base, autosaveFailed: true })).toBe(true);
  });

  it("un PDF cifrado nunca se guarda como borrador: avisa", () => {
    expect(unloadGuardNeeded({ ...base, wasEncrypted: true })).toBe(true);
  });

  it("con el borrador funcionando pero su escritura aun pendiente, avisa (todavia no cubre lo ultimo)", () => {
    expect(unloadGuardNeeded({ ...base, draftWritePending: true })).toBe(true);
  });

  it("la escritura pendiente no avisa si no hay cambios sin guardar", () => {
    expect(unloadGuardNeeded({ ...base, dirty: false, draftWritePending: true })).toBe(false);
  });

  it("ya guardado el borrador (`draftWritePending` false o ausente) deja de avisar", () => {
    expect(unloadGuardNeeded({ ...base, draftWritePending: false })).toBe(false);
    expect(unloadGuardNeeded(base)).toBe(false);
  });

  it("un documento de mas de 150 MB no tiene borrador: avisa", () => {
    expect(unloadGuardNeeded({ ...base, currentBytes: 151 * MB })).toBe(true);
    expect(unloadGuardNeeded({ ...base, currentBytes: 150 * MB })).toBe(false);
  });
});
