import { describe, expect, it } from "vitest";
import {
  HOME_LIMIT,
  MAX_SELECTION,
  badgeKind,
  errorKeyOf,
  isTemplateStale,
  formatBytes,
  looksLikePdf,
  newDocumentId,
  persistView,
  pruneSelection,
  replaceVerdict,
  sortDocuments,
  suggestedName,
  toggleSelection,
} from "@/app/documents/documentsModel";
import { SIGN_HANDOFF_MAX_DOCUMENTS } from "@/lib/docLibrary/signHandoff";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { LibraryError, FingerprintError, type DocumentEntry, type Fingerprint } from "@/lib/docLibrary/types";

const doc = (id: string, updatedAt: string): DocumentEntry => ({ id, updatedAt }) as DocumentEntry;

describe("selección múltiple", () => {
  it("el tope es el del traspaso a Firmar (10) y la sección de Inicio muestra 4", () => {
    expect(MAX_SELECTION).toBe(SIGN_HANDOFF_MAX_DOCUMENTS);
    expect(MAX_SELECTION).toBe(10);
    expect(HOME_LIMIT).toBe(4);
  });

  it("alterna: añade, quita y no modifica el conjunto original", () => {
    const empty = new Set<string>();
    const one = toggleSelection(empty, "a");
    expect([...one]).toEqual(["a"]);
    expect(empty.size).toBe(0);
    expect([...toggleSelection(one, "a")]).toEqual([]);
  });

  it("no pasa del tope, pero sí permite quitar con la selección llena", () => {
    let selected = new Set<string>();
    for (let i = 0; i < 12; i += 1) selected = toggleSelection(selected, `d${i}`);
    expect(selected.size).toBe(10);
    expect(selected.has("d10")).toBe(false);
    expect(toggleSelection(selected, "d3").size).toBe(9);
    expect(toggleSelection(new Set(["a", "b"]), "c", 2).size).toBe(2);
  });

  it("pruneSelection descarta los ids que ya no existen y respeta el orden de la lista", () => {
    const docs = [doc("c", "3"), doc("a", "2"), doc("b", "1")];
    expect(pruneSelection(new Set(["b", "zzz", "c"]), docs)).toEqual(["c", "b"]);
  });
});

describe("lista", () => {
  it("más reciente primero y, a igual fecha, por id", () => {
    const sorted = sortDocuments([doc("b", "2026-01-01"), doc("c", "2026-02-01"), doc("a", "2026-01-01")]);
    expect(sorted.map((d) => d.id)).toEqual(["c", "a", "b"]);
  });
});

describe("estado de la plantilla", () => {
  it("sin estado conocido es «none»; ready/single se respetan", () => {
    expect(badgeKind(undefined)).toBe("none");
    expect(badgeKind({ state: "ready" })).toBe("ready");
    expect(badgeKind({ state: "single" })).toBe("single");
    expect(badgeKind({ state: "none" })).toBe("none");
  });

  it("desactualizada: gana a «lista» y a «1 firmante»; sin plantilla (✗) no hay nada desactualizado", () => {
    expect(badgeKind({ state: "ready" }, true)).toBe("stale");
    expect(badgeKind({ state: "single" }, true)).toBe("stale");
    expect(badgeKind({ state: "none" }, true)).toBe("none");
    expect(badgeKind(undefined, true)).toBe("none");
    expect(badgeKind({ state: "ready" }, false)).toBe("ready");
  });

  it("isTemplateStale mira el aviso persistido del documento Y que haya plantilla", () => {
    const stale = { templateStale: { since: "2026-05-01T10:00:00.000Z", level: "none" as const, percent: 0, base: {} as never } };
    expect(isTemplateStale(stale, { state: "ready" })).toBe(true);
    expect(isTemplateStale(stale, { state: "none" })).toBe(false);
    expect(isTemplateStale(stale, undefined)).toBe(false);
    expect(isTemplateStale({}, { state: "ready" })).toBe(false);
  });
});

describe("nombre, tipo y archivo", () => {
  it("sugiere el nombre sin .pdf, sin controles y recortado", () => {
    expect(suggestedName("Contrato de servicio.PDF")).toBe("Contrato de servicio");
    expect(suggestedName("  a\tb\u0000c .pdf")).toBe("a b c");
    expect(suggestedName("x".repeat(500) + ".pdf").length).toBe(200);
    expect(suggestedName(".pdf")).toBe("");
  });

  it("reconoce PDF por tipo o por extensión", () => {
    expect(looksLikePdf({ name: "a.pdf" })).toBe(true);
    expect(looksLikePdf({ name: "a.PDF", type: "" })).toBe(true);
    expect(looksLikePdf({ name: "a", type: "application/pdf" })).toBe(true);
    expect(looksLikePdf({ name: "a.docx", type: "application/msword" })).toBe(false);
    expect(looksLikePdf({ name: "a.pdf.exe" })).toBe(false);
  });

  it("los ids nuevos cumplen la expresión de la biblioteca y no se repiten", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newDocumentId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(newDocumentId(() => 0, () => 0)).toBe("d-0-000000000000");
  });
});

describe("formatBytes", () => {
  it("elige unidad y decimales", () => {
    expect(formatBytes(0, "en-GB")).toBe("0 B");
    expect(formatBytes(-5, "en-GB")).toBe("0 B");
    expect(formatBytes(Number.NaN, "en-GB")).toBe("0 B");
    expect(formatBytes(1023, "en-GB")).toBe("1,023 B");
    expect(formatBytes(1536, "en-GB")).toBe("1.5 KB");
    expect(formatBytes(1536, "es-ES")).toBe("1,5 KB");
    expect(formatBytes(5 * 1024 * 1024, "en-GB")).toBe("5 MB");
    expect(formatBytes(400 * 1024 * 1024, "en-GB")).toBe("400 MB");
    expect(formatBytes(3 * 1024 ** 3, "en-GB")).toBe("3 GB");
  });
});

describe("persistencia", () => {
  it("cuatro estados", () => {
    expect(persistView(null)).toBe("unknown");
    expect(persistView({ granted: false, supported: false })).toBe("unsupported");
    expect(persistView({ granted: true, supported: false })).toBe("unsupported");
    expect(persistView({ granted: false, supported: true })).toBe("denied");
    expect(persistView({ granted: true, supported: true })).toBe("granted");
  });
});

describe("replaceVerdict — ¿sigue valiendo la plantilla con el PDF nuevo?", () => {
  const before = sampleFingerprint(3, 1);

  it("sin plantilla no hay nada que avisar", () => {
    expect(replaceVerdict(before, sampleFingerprint(5, 9), false)).toEqual({ kind: "ok" });
  });

  it("mismos bytes o mismo contenido: sigue valiendo", () => {
    expect(replaceVerdict(before, before, true)).toEqual({ kind: "ok" });
    const resaved: Fingerprint = { ...before, exact: "f".repeat(64) };
    expect(replaceVerdict(before, resaved, true)).toEqual({ kind: "ok" });
  });

  it("otro documento: la plantilla ya no coincide", () => {
    expect(replaceVerdict(before, sampleFingerprint(3, 77), true)).toEqual({ kind: "mismatch" });
    expect(replaceVerdict(before, sampleFingerprint(8, 5), true)).toEqual({ kind: "mismatch" });
  });

  it("una página cambiada: hay que revisarla (cuenta las páginas)", () => {
    const six = sampleFingerprint(6, 4);
    const changed: Fingerprint = { ...six, exact: "e".repeat(64), pages: six.pages.map((page, i) => (i === 2 ? sampleFingerprint(1, 99).pages[0] : page)) };
    expect(replaceVerdict(six, changed, true)).toEqual({ kind: "review", pages: 1 });
  });
});

describe("errorKeyOf", () => {
  it("mapea los códigos de la biblioteca y de la huella", () => {
    expect(errorKeyOf(new LibraryError("tooBig"))).toBe("errorTooBig");
    expect(errorKeyOf(new LibraryError("full", "count"))).toBe("errorFull");
    expect(errorKeyOf(new LibraryError("quota"))).toBe("errorQuota");
    expect(errorKeyOf(new LibraryError("unavailable"))).toBe("errorUnavailable");
    expect(errorKeyOf(new LibraryError("conflict"))).toBe("errorConflict");
    expect(errorKeyOf(new LibraryError("notFound"))).toBe("errorNotFound");
    expect(errorKeyOf(new FingerprintError("encrypted"))).toBe("errorEncrypted");
    expect(errorKeyOf(new FingerprintError("corrupt"))).toBe("errorCorrupt");
    expect(errorKeyOf(new FingerprintError("empty"))).toBe("errorCorrupt");
  });

  it("cualquier otra cosa (incluidos nombres heredados de Object) es genérica", () => {
    for (const bad of [new Error("x"), null, undefined, "boom", { code: 7 }, { code: "constructor" }, { code: "__proto__" }, { code: "toString" }]) {
      expect(errorKeyOf(bad)).toBe("errorGeneric");
    }
  });
});
