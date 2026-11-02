import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_LIMITS } from "@/lib/backup/types";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { applyLibraryBackup, buildLibraryExport, readLibraryBackup, LIBRARY_BACKUP_FILENAME, LIBRARY_SELECTION_FILENAME } from "@/app/documents/backupFlow";
import { defaultLibraryDecisions } from "@/lib/backup/modules/library";
import { exportBlob, freshLibrary, seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { clearLibrary, listDocuments, putDocument } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { hostileCorpus } from "@/lib/backup/__fixtures__/hostileCorpus";

/** Lógica de exportar / importar de Mis documentos (sin React): errores, límites y lectura sin escribir. */

beforeEach(() => {
  freshLibrary();
});

const guardOk = async () => true;

describe("buildLibraryExport", () => {
  it("biblioteca vacía → empty", async () => {
    expect(await buildLibraryExport()).toEqual({ ok: false, reason: "empty" });
  });
  it("sin IndexedDB → unavailable", async () => {
    // @ts-expect-error simula un navegador sin IndexedDB
    delete globalThis.indexedDB;
    expect(await buildLibraryExport()).toEqual({ ok: false, reason: "unavailable" });
  });
  it("con contraseña y sin WebCrypto → encryptionUnavailable (sin leer nada)", async () => {
    await seedDoc("a", 1);
    vi.stubGlobal("crypto", { ...globalThis.crypto, subtle: undefined });
    try {
      expect(await buildLibraryExport({ password: "una-clave-larga" })).toEqual({ ok: false, reason: "encryptionUnavailable" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("más de 250 MB de PDF → tooLarge ANTES de leer los PDF", async () => {
    // Tres filas de 99 MiB: el resumen lee los tamaños de las filas, no los bytes.
    for (const id of ["a", "b", "c"]) await seedDoc(id, id.charCodeAt(0));
    const idb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("optimuspdf-doc-library", 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction("documents", "readwrite");
      const store = tx.objectStore("documents");
      const all = store.getAll();
      all.onsuccess = () => {
        for (const row of all.result) store.put({ ...row, byteLength: 99 * 1024 * 1024 });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    idb.close();
    const refused = await buildLibraryExport();
    expect(refused).toMatchObject({ ok: false, reason: "tooLarge" });
    // H1: también se dice cuánto sobra (2 documentos de 99 MiB = 198 MiB caben; con 3 o más no): aquí el tope es 242 MiB.
    expect((refused as { overBy?: number }).overBy).toBeGreaterThan(0);
    expect(PACKAGE_LIMITS.maxUncompressedBytes).toBe(250 * 1024 * 1024);
  });
  it("solo documentos sin copia → empty", async () => {
    await putDocument({ id: "x", name: "X", docType: "", fileName: "x.pdf", pageCount: 3, pageSizes: sampleFingerprint(3, 1).pageSizes, fingerprint: sampleFingerprint(3, 1), templateIds: [] });
    expect(await buildLibraryExport()).toEqual({ ok: false, reason: "empty" });
  });
  it("todo bien: nombre fijo, cifrado según la contraseña, cuentas del informe", async () => {
    await seedDoc("a", 1);
    await seedDoc("b", 2);
    await seedTemplate("a", {}, "tpl-a");
    const plain = await buildLibraryExport();
    expect(plain).toMatchObject({ ok: true, filename: LIBRARY_BACKUP_FILENAME, documents: 2, templates: 1, encrypted: false });
    expect(LIBRARY_BACKUP_FILENAME).toBe("OptimusPDF-documentos.optimuspdf.zip");
    if (!plain.ok) return;
    expect((await readPackage(plain.blob)).encrypted).toBe(false);
    const sealed = await buildLibraryExport({ password: "una-clave-larga" });
    expect(sealed).toMatchObject({ ok: true, encrypted: true });
    if (!sealed.ok) return;
    await expect(readPackage(sealed.blob)).rejects.toMatchObject({ code: "needsPassword" });
    // Contraseña vacía = sin cifrar.
    expect(await buildLibraryExport({ password: "" })).toMatchObject({ ok: true, encrypted: false });
  });
});

describe("buildLibraryExport · solo los documentos elegidos", () => {
  it("empaqueta el subconjunto con su plantilla, con otro nombre de archivo, y se importa de vuelta", async () => {
    await seedDoc("a", 1);
    await seedDoc("b", 2);
    await seedDoc("c", 3);
    await seedTemplate("a", {}, "tpl-a");
    await seedTemplate("b", {}, "tpl-b");
    const built = await buildLibraryExport({ documentIds: ["b"] });
    expect(built).toMatchObject({ ok: true, filename: LIBRARY_SELECTION_FILENAME, documents: 1, templates: 1, encrypted: false });
    expect(LIBRARY_SELECTION_FILENAME).toBe("OptimusPDF-seleccion.optimuspdf.zip");
    if (!built.ok) return;
    await clearLibrary();
    const read = await readLibraryBackup(built.blob, undefined, { validatePdf: guardOk });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const applied = await applyLibraryBackup(read.plan, defaultLibraryDecisions(read.plan));
    expect(applied).toMatchObject({ ok: true, summary: { documents: 1, templates: 1, skipped: 0 } });
    expect((await listDocuments()).documents.map((doc) => doc.id)).toEqual(["b"]);
    expect((await listTemplates()).templates.map((template) => template.id)).toEqual(["tpl-b"]);
  });
  it("una selección que ya no existe → empty; con contraseña sale cifrado", async () => {
    await seedDoc("a", 1);
    expect(await buildLibraryExport({ documentIds: ["fantasma"] })).toEqual({ ok: false, reason: "empty" });
    expect(await buildLibraryExport({ documentIds: ["a"], password: "una-clave-larga" })).toMatchObject({ ok: true, encrypted: true });
  });
});

describe("readLibraryBackup / applyLibraryBackup", () => {
  it("lee SIN escribir, avisa del progreso por PDF y aplica con las decisiones sugeridas", async () => {
    await seedDoc("a", 1);
    await seedDoc("b", 2);
    const blob = await exportBlob();
    await clearLibrary();
    const progress: Array<[number, number]> = [];
    const read = await readLibraryBackup(blob, undefined, { validatePdf: guardOk, onProgress: (done, total) => progress.push([done, total]) });
    expect(read.ok).toBe(true);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
    expect((await listDocuments()).documents).toHaveLength(0);
    if (!read.ok) return;
    const applied = await applyLibraryBackup(read.plan, defaultLibraryDecisions(read.plan));
    expect(applied).toMatchObject({ ok: true, summary: { documents: 2, templates: 0, skipped: 0 } });
  });

  it("contraseña: needsPassword → wrongPassword → ok", async () => {
    await seedDoc("a", 1);
    const blob = await exportBlob("dorada-2026");
    expect(await readLibraryBackup(blob)).toMatchObject({ ok: false, reason: "needsPassword" });
    expect(await readLibraryBackup(blob, "mala")).toMatchObject({ ok: false, reason: "wrongPassword" });
    expect(await readLibraryBackup(blob, "dorada-2026", { validatePdf: guardOk })).toMatchObject({ ok: true, encrypted: true });
  });

  it("paquete sin biblioteca, de versión más nueva, dañado y sin IndexedDB, cada uno con su motivo", async () => {
    const none = await buildPackage({ modules: [{ name: "signatures", schemaVersion: 1, files: [{ path: "signatures/index.json", data: new Uint8Array([91, 93]), type: "application/json" }] }] });
    expect(await readLibraryBackup(none)).toMatchObject({ ok: false, reason: "noLibrary" });
    await seedDoc("a", 1);
    const good = await exportBlob();
    const { editManifest } = await import("@/lib/backup/__fixtures__/testKit");
    const newer = await editManifest(good, (manifest) => {
      manifest.modules.library.schemaVersion = 9;
    });
    expect(await readLibraryBackup(newer)).toMatchObject({ ok: false, reason: "newer" });
    const damaged = await editManifest(good, (manifest) => {
      for (const file of manifest.files) if (file.path === "documents/index.json") file.sha256 = "0".repeat(64);
    });
    expect(await readLibraryBackup(damaged)).toMatchObject({ ok: false, reason: "damaged" });
    // @ts-expect-error simula un navegador sin IndexedDB
    delete globalThis.indexedDB;
    const { __resetLibraryForTests } = await import("@/lib/docLibrary/store");
    __resetLibraryForTests();
    expect(await readLibraryBackup(good, undefined, { validatePdf: guardOk })).toMatchObject({ ok: false, reason: "storage" });
  });

  it("el corpus hostil del contenedor se traduce a un motivo y no lanza", async () => {
    for (const hostile of hostileCorpus()) {
      const result = await readLibraryBackup(new Blob([hostile.bytes as BlobPart]));
      expect(result.ok, hostile.name).toBe(false);
    }
  });

  it("un archivo que ni es un Blob no lanza", async () => {
    // @ts-expect-error entrada absurda
    expect(await readLibraryBackup(null)).toMatchObject({ ok: false });
  });

  it("aplicar un plan que no es del planificador → invalid", async () => {
    // @ts-expect-error entrada absurda
    expect(await applyLibraryBackup({ state: "ok", items: [] }, {})).toMatchObject({ ok: false, reason: "invalid" });
  });
});
