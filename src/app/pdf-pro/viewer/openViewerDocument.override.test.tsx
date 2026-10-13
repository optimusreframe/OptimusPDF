import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openPdfDocument = vi.fn();
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, openPdfDocument: (...args: unknown[]) => openPdfDocument(...args) };
});

import {
  PRO_VIEWER_RANGE_MIN_STORAGE_KEY,
  VIEWER_RANGE_MIN_BYTES,
  openViewerDocument,
  readViewerRangeMinOverride,
} from "@/app/pdf-pro/viewer/openViewerDocument";

/** Ajuste de diagnostico del umbral de apertura por rangos (`localStorage`), que usan las pruebas E2E del visor. */

beforeEach(() => {
  window.localStorage.clear();
  openPdfDocument.mockReset();
});
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("readViewerRangeMinOverride", () => {
  it("sin valor no hay ajuste", () => {
    expect(readViewerRangeMinOverride()).toBeUndefined();
  });

  it("lee un numero valido (incluido 0) y descarta lo que no lo es", () => {
    window.localStorage.setItem(PRO_VIEWER_RANGE_MIN_STORAGE_KEY, "0");
    expect(readViewerRangeMinOverride()).toBe(0);
    window.localStorage.setItem(PRO_VIEWER_RANGE_MIN_STORAGE_KEY, "1048576");
    expect(readViewerRangeMinOverride()).toBe(1_048_576);
    for (const bad of ["", "abc", "-5", "NaN"]) {
      window.localStorage.setItem(PRO_VIEWER_RANGE_MIN_STORAGE_KEY, bad);
      expect(readViewerRangeMinOverride()).toBeUndefined();
    }
  });

  it("si localStorage lanza (modo privado, bloqueado) no hay ajuste y no se propaga el error", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError");
    });
    expect(readViewerRangeMinOverride()).toBeUndefined();
  });
});

describe("openViewerDocument · umbral", () => {
  it("con el ajuste a 0, hasta un PDF pequeño intenta abrir por rangos (y cae a la apertura normal si falla)", async () => {
    window.localStorage.setItem(PRO_VIEWER_RANGE_MIN_STORAGE_KEY, "0");
    const fake = { numPages: 1 };
    openPdfDocument.mockResolvedValue(fake);
    // Sin pdf.js real (jsdom) la apertura por rangos falla: debe caer a openPdfDocument, no romper. (Con `startxref` al final: sin
    // esa marca ni se intenta.)
    const bytes = new Uint8Array(500);
    bytes.set(new TextEncoder().encode("startxref\n0\n%%EOF\n"), bytes.byteLength - 18);
    await expect(openViewerDocument(bytes)).resolves.toBe(fake);
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
  });

  it("sin ajuste, un PDF por debajo del umbral por defecto va directo a la apertura de siempre", async () => {
    const fake = { numPages: 1 };
    openPdfDocument.mockResolvedValue(fake);
    await openViewerDocument(new Uint8Array(VIEWER_RANGE_MIN_BYTES - 1));
    expect(openPdfDocument).toHaveBeenCalledTimes(1);
  });
});
