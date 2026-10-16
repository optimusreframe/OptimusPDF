import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBestMatch } from "./match";
import { deserializeLibrary, serializeLibrary, toDocumentInput } from "./persist";
import { parseDocumentEntry, parseTemplateStale } from "./schema";
import {
  __resetLibraryForTests,
  getDocument,
  getDocumentBytes,
  listDocuments,
  markTemplatesCurrent,
  putDocument,
  replaceDocumentBytes,
  updateDocument,
} from "./store";
import { staleVerdict } from "./templateStale";
import { createTemplate, deleteTemplate, findTemplateForFingerprint, templateStatuses } from "./templatesStore";
import { sampleDraft } from "./testing/templateSamples";
import { sampleBytes, sampleFingerprint, sampleInput } from "./testing/sampleDocs";
import { LibraryError, type DocumentEntry, type Fingerprint } from "./types";

/*
 * F2-fix · MAYOR 3: tras «Reemplazar PDF», la plantilla vieja ya no se aplica como si coincidiera. El almacén marca el
 * documento con `templateStale` (campo ADITIVO, sin tocar el esquema de IndexedDB v2) y guarda la huella del PDF sobre el
 * que se configuró la plantilla (`base`) para compararla con el PDF real despues.
 */

const DB_NAME = "optimuspdf-doc-library";
beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  __resetLibraryForTests();
  vi.restoreAllMocks();
});

const hex = (n: number) => n.toString(16).padStart(64, "0");
/** El mismo contrato re-exportado: mismas paginas, otros bytes (distinto `exact`). */
const reexported = (fingerprint: Fingerprint, n: number): Fingerprint => ({ ...fingerprint, exact: hex(n) });
/** Un contrato distinto del mismo tamaño. */
const other = (seed: number, pages = 3) => sampleFingerprint(pages, seed);

async function withTemplate(id: string, fingerprint: Fingerprint, templateIds: string[] = []) {
  await putDocument(sampleInput(id, { fingerprint, pageCount: fingerprint.pageCount, pageSizes: fingerprint.pageSizes, templateIds }), sampleBytes(40));
  if (templateIds.length === 0) await createTemplate(sampleDraft(id), { newId: () => `tpl-${id}` });
}
const replace = (id: string, fingerprint: Fingerprint, options: { now?: () => Date } = {}) =>
  replaceDocumentBytes(id, sampleBytes(60, 3), { fingerprinter: async () => fingerprint, ...options });

describe("staleVerdict", () => {
  const base = sampleFingerprint(3, 5);
  it("el mismo PDF (exacto) y el mismo contrato re-exportado («Coincide» sin paginas por revisar) siguen valiendo", () => {
    expect(staleVerdict(base, base)).toEqual({ stale: false });
    expect(staleVerdict(base, reexported(base, 7))).toEqual({ stale: false });
  });
  it("otro contrato: desactualizada (nivel «none»)", () => {
    expect(staleVerdict(base, other(9))).toMatchObject({ stale: true, level: "none" });
  });
  it("cambian paginas (no todas coinciden) o cambia el nº de paginas: desactualizada", () => {
    const changed: Fingerprint = { ...base, exact: hex(11), pages: [base.pages[0], other(31).pages[1], base.pages[2]] };
    expect(staleVerdict(base, changed)).toMatchObject({ stale: true });
    expect(staleVerdict(base, other(5, 4))).toMatchObject({ stale: true });
  });
  it("sin huella por estructura (demasiadas paginas) no se puede asegurar: desactualizada", () => {
    const partial: Fingerprint = { ...base, exact: hex(13), pageSizes: [], pages: [], partial: "tooManyPages" };
    expect(staleVerdict(base, partial)).toMatchObject({ stale: true, level: "none" });
  });
});

describe("replaceDocumentBytes marca la plantilla como desactualizada", () => {
  it("otro contrato con plantilla: queda `templateStale` con la huella ORIGINAL como base; el documento y la plantilla se conservan", async () => {
    const original = other(5);
    await withTemplate("d1", original);
    const entry = await replace("d1", other(9), { now: () => new Date("2026-05-01T10:00:00.000Z") });
    expect(entry.templateStale).toMatchObject({ since: "2026-05-01T10:00:00.000Z", level: "none", percent: 0 });
    expect(entry.templateStale?.base).toEqual(original);
    expect(entry.fingerprint).toEqual(other(9));
    expect(entry.templateIds).toEqual(["tpl-d1"]);
    // Se guarda de verdad (no solo en lo devuelto).
    expect((await getDocument("d1"))?.templateStale?.base).toEqual(original);
    expect((await listDocuments()).documents[0].templateStale?.level).toBe("none");
    expect((await templateStatuses()).get("d1")?.state).toBe("ready");
  });

  it("mismo contrato re-exportado o mismos bytes: sin aviso", async () => {
    const original = other(5);
    await withTemplate("d1", original);
    expect((await replace("d1", reexported(original, 77))).templateStale).toBeUndefined();
    expect((await replace("d1", original)).templateStale).toBeUndefined();
    expect("templateStale" in ((await getDocument("d1")) as DocumentEntry)).toBe(false);
  });

  it("un documento SIN plantilla nunca queda desactualizado", async () => {
    await putDocument(sampleInput("solo", { fingerprint: other(5) }), sampleBytes(40));
    expect((await replace("solo", other(9))).templateStale).toBeUndefined();
  });

  it("es pegajoso y se compara con el PDF sobre el que se configuro: A→B→C sigue desactualizada con la base A y la fecha de B; volver a A la deja al dia", async () => {
    const a = other(5);
    await withTemplate("d1", a);
    const first = await replace("d1", other(9), { now: () => new Date("2026-05-01T10:00:00.000Z") });
    const second = await replace("d1", other(13), { now: () => new Date("2026-06-01T10:00:00.000Z") });
    expect(second.templateStale?.base).toEqual(a);
    expect(second.templateStale?.since).toBe(first.templateStale?.since);
    // Un reemplazo parecido al ANTERIOR (B') pero distinto de la base A sigue desactualizado.
    expect((await replace("d1", reexported(other(13), 99))).templateStale?.base).toEqual(a);
    // Volver a poner el contrato original la deja al dia.
    const restored = await replace("d1", reexported(a, 123));
    expect(restored.templateStale).toBeUndefined();
    expect((await getDocument("d1"))?.templateStale).toBeUndefined();
  });

  it("si el PDF nuevo falla al calcular su huella no se escribe nada (tampoco el aviso)", async () => {
    await withTemplate("d1", other(5));
    const before = await getDocument("d1");
    await expect(replaceDocumentBytes("d1", sampleBytes(10), { fingerprinter: async () => { throw new LibraryError("invalid"); } })).rejects.toBeInstanceOf(LibraryError);
    expect(await getDocument("d1")).toEqual(before);
  });
});

describe("compatibilidad con la v2 ya publicada (cambio aditivo)", () => {
  /** Una fila TAL COMO la escribia la v2 publicada: sin `templateStale`. */
  async function seedPublishedV2(): Promise<Record<string, unknown>> {
    const input = sampleInput("old-doc", { templateIds: ["tpl-old"] });
    const entry = { ...input, createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z", byteLength: 40, rev: 3 };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        const created = request.result;
        created.createObjectStore("documents", { keyPath: "id" });
        created.createObjectStore("blobs", { keyPath: "documentId" });
        created.createObjectStore("meta", { keyPath: "key" });
        created.createObjectStore("templates", { keyPath: "id" }).createIndex("byDocument", "documentId", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["documents", "blobs"], "readwrite");
      tx.objectStore("documents").put(entry);
      tx.objectStore("blobs").put({ documentId: "old-doc", bytes: sampleBytes(40), byteLength: 40 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return entry;
  }

  it("una entrada de la v2 publicada (sin el campo) se lee igual, sin `templateStale`, y sin migrar nada", async () => {
    const entry = await seedPublishedV2();
    const listed = await listDocuments();
    expect(listed.skipped).toEqual([]);
    expect(listed.documents).toEqual([entry]);
    expect("templateStale" in listed.documents[0]).toBe(false);
    expect(await getDocumentBytes("old-doc")).toEqual(sampleBytes(40));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.version).toBe(2);
    expect([...db.objectStoreNames].sort()).toEqual(["blobs", "documents", "meta", "templates"]);
    db.close();
  });

  it("sobre esa entrada antigua, reemplazar el PDF escribe el campo nuevo y el resto de campos quedan como estaban", async () => {
    const entry = await seedPublishedV2();
    const published = parseDocumentEntry(entry)!;
    const replaced = await replace("old-doc", other(9));
    expect(replaced.templateStale).toMatchObject({ level: "none" });
    expect(replaced.templateStale?.base).toEqual(published.fingerprint);
    expect(replaced).toMatchObject({ id: "old-doc", name: published.name, templateIds: ["tpl-old"], createdAt: published.createdAt, rev: 4 });
  });

  it("un `templateStale` mal formado (de otra version o dañado) NO invalida el documento: se lee como al dia", () => {
    const entry = { ...sampleInput("x"), createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z", byteLength: 40, rev: 3, templateIds: ["t"] };
    for (const broken of [{ since: "ayer", level: "none", percent: 0, base: sampleFingerprint() }, { since: "2026-01-01T00:00:00.000Z", level: "raro", percent: 0, base: sampleFingerprint() }, { since: "2026-01-01T00:00:00.000Z", level: "none", percent: 500, base: sampleFingerprint() }, { since: "2026-01-01T00:00:00.000Z", level: "none", percent: 0, base: { nope: true } }, "texto", 7, null]) {
      const parsed = parseDocumentEntry({ ...entry, templateStale: broken });
      expect(parsed).not.toBeNull();
      expect(parsed && "templateStale" in parsed).toBe(false);
    }
    expect(parseTemplateStale(undefined)).toBeNull();
  });

  it("el campo valido pasa tal cual y no deja pasar campos desconocidos dentro", () => {
    const entry = { ...sampleInput("x"), createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z", byteLength: 40, rev: 3, templateIds: ["t"] };
    const stale = { since: "2026-01-01T00:00:00.000Z", level: "similar", percent: 80, base: sampleFingerprint(), extra: "no" };
    expect(parseDocumentEntry({ ...entry, templateStale: stale })?.templateStale).toEqual({ since: stale.since, level: "similar", percent: 80, base: sampleFingerprint() });
  });
});

describe("quitar el aviso", () => {
  it("markTemplatesCurrent («Esta plantilla sigue valiendo»): quita el aviso, no mueve el documento en la lista y no escribe si no hay aviso", async () => {
    await withTemplate("d1", other(5));
    const staled = await replace("d1", other(9));
    const cleared = await markTemplatesCurrent("d1");
    expect("templateStale" in cleared).toBe(false);
    expect(cleared.updatedAt).toBe(staled.updatedAt);
    expect(cleared.rev).toBe(staled.rev + 1);
    expect((await getDocument("d1"))?.templateStale).toBeUndefined();
    // Ya al dia: no escribe (misma rev).
    expect((await markTemplatesCurrent("d1")).rev).toBe(cleared.rev);
  });

  it("markTemplatesCurrent respeta `expectedRev` y un documento que no existe", async () => {
    await withTemplate("d1", other(5));
    const staled = await replace("d1", other(9));
    await expect(markTemplatesCurrent("d1", { expectedRev: staled.rev - 1 })).rejects.toMatchObject({ code: "conflict" });
    expect((await getDocument("d1"))?.templateStale).toBeDefined();
    await expect(markTemplatesCurrent("nope")).rejects.toMatchObject({ code: "notFound" });
    await expect(markTemplatesCurrent("a/b")).rejects.toMatchObject({ code: "invalid" });
  });

  it("borrar la ultima plantilla del documento tambien quita el aviso (no hay nada que reconfigurar)", async () => {
    await withTemplate("d1", other(5));
    await replace("d1", other(9));
    expect(await deleteTemplate("tpl-d1")).toBe(true);
    const after = await getDocument("d1");
    expect(after?.templateIds).toEqual([]);
    expect(after && "templateStale" in after).toBe(false);
  });

  it("anadir otra plantilla al documento no quita el aviso por si solo", async () => {
    await withTemplate("d1", other(5));
    await replace("d1", other(9));
    await createTemplate(sampleDraft("d1"), { newId: () => "tpl-2" });
    expect((await getDocument("d1"))?.templateStale).toBeDefined();
  });

  it("renombrar o cambiar el tipo no pierde el aviso", async () => {
    await withTemplate("d1", other(5));
    await replace("d1", other(9));
    expect((await updateDocument("d1", { name: "Otro nombre" })).templateStale).toBeDefined();
  });

  it("putDocument sobre un documento existente conserva el aviso", async () => {
    await withTemplate("d1", other(5));
    const staled = await replace("d1", other(9));
    const again = await putDocument(sampleInput("d1", { fingerprint: staled.fingerprint, templateIds: staled.templateIds, expectedRev: staled.rev }));
    expect(again.templateStale).toEqual(staled.templateStale);
  });
});

describe("el reconocimiento por huella usa el PDF sobre el que se configuro", () => {
  it("el contrato ANTERIOR sigue reconociendose; el PDF de reemplazo (otro contrato) ya NO se asocia a la plantilla vieja", async () => {
    const a = other(5);
    const b = other(9);
    await withTemplate("d1", a);
    await replace("d1", b);
    const old = await findTemplateForFingerprint(a);
    expect(old?.template.id).toBe("tpl-d1");
    expect(old?.match.level).toBe("exact");
    expect(await findTemplateForFingerprint(b)).toBeNull();
  });

  it("sin aviso, todo igual que antes: el PDF del documento se reconoce a si mismo", async () => {
    const a = other(5);
    await withTemplate("d1", a);
    expect((await findTemplateForFingerprint(a))?.match.level).toBe("exact");
  });
});

describe("copia de seguridad", () => {
  it("el aviso viaja al exportar y al importar (huella base incluida) y al restaurar el documento", async () => {
    const a = other(5);
    await withTemplate("d1", a);
    const staled = await replace("d1", other(9));
    const json = JSON.parse(JSON.stringify(serializeLibrary([staled])));
    const result = deserializeLibrary(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documents[0].templateStale).toEqual(staled.templateStale);
    const input = toDocumentInput(result.documents[0]);
    expect(input.templateStale).toEqual(staled.templateStale);
    __resetLibraryForTests();
    globalThis.indexedDB = new IDBFactory();
    const restored = await putDocument(input, sampleBytes(20));
    expect(restored.templateStale?.base).toEqual(a);
  });
});

describe("la comparacion con el PDF real (lo que usa «Firmar»)", () => {
  it("findBestMatch del PDF real contra la base: el mismo contrato → aplica; otro → nada", async () => {
    const a = other(5);
    await withTemplate("d1", a);
    const staled = await replace("d1", other(9));
    const base = staled.templateStale!.base;
    const candidate = { id: "tpl-d1", fingerprint: base, updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(findBestMatch(staled.fingerprint, [candidate])).toBeNull();
    expect(findBestMatch(reexported(a, 5), [candidate])?.level).toBe("match");
  });
});
