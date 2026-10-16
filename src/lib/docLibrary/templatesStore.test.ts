import { IDBFactory } from "fake-indexeddb";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLibraryForTests,
  clearLibrary,
  deleteDocument,
  getDocument,
  getDocumentBytes,
  getLibraryMeta,
  listDocuments,
  markBackup,
  putDocument,
  subscribeToLibrary,
} from "./store";
import {
  TEMPLATE_STATUS_TEXT,
  attachTemplate,
  cloneTemplateToDocument,
  createTemplate,
  deleteTemplate,
  findDuplicateTemplates,
  findTemplateForFingerprint,
  getTemplate,
  getTemplateForDocument,
  getTemplateVersions,
  getTemplatesForDocument,
  importTemplates,
  listTemplates,
  renameTemplate,
  restoreVersion,
  saveTemplateVersion,
  statusOfTemplate,
  templateStatus,
  templateStatuses,
} from "./templatesStore";
import { buildContent } from "./templateSchema";
import { R, clock, sampleDraft, signField, variantOf } from "./testing/templateSamples";
import { sampleBytes, sampleFingerprint, sampleInput, samplePage } from "./testing/sampleDocs";
import { TEMPLATE_LIMITS, TEMPLATE_SCHEMA_VERSION, type DocTemplate, type StoredTemplate, type TemplateDraft } from "./templateTypes";
import { LibraryError, type Fingerprint } from "./types";

const DB_NAME = "optimuspdf-doc-library";

beforeEach(() => {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => {
  __resetLibraryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function expectLibraryError(promise: Promise<unknown>, code: string, detail?: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LibraryError);
  expect((error as LibraryError).code).toBe(code);
  if (detail) expect((error as LibraryError).detail).toBe(detail);
}

async function addDoc(id: string, fingerprint?: Fingerprint) {
  return putDocument(sampleInput(id, fingerprint ? { fingerprint, pageCount: fingerprint.pageCount, pageSizes: fingerprint.pageSizes } : {}), sampleBytes(32));
}

let n = 0;
const ids = () => `tpl-${(n += 1)}`;
const make = (documentId: string | null, over: Partial<TemplateDraft> = {}, now = clock()) => createTemplate(sampleDraft(documentId, over), { newId: ids, now });

function rawOpen(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rawGetAll(store: string): Promise<unknown[]> {
  const db = await rawOpen();
  const rows = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return rows;
}

async function rawPut(store: string, value: unknown): Promise<void> {
  const db = await rawOpen();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function storedRow(id: string, documentId: string | null, over: Record<string, unknown> = {}): StoredTemplate {
  const content = buildContent(sampleDraft(documentId))!;
  return { schemaVersion: TEMPLATE_SCHEMA_VERSION, id, documentId, ...content, version: 1, createdAt: "2026-03-01T10:00:00.000Z", updatedAt: "2026-03-01T10:00:00.000Z", rev: 1, history: [], ...over } as StoredTemplate;
}

describe("migración de esquema v1 → v2 (sin perder datos)", () => {
  /** Una base «de antes»: versión 1, sus tres almacenes y datos reales dentro. */
  async function seedV1(): Promise<{ entry: Record<string, unknown> }> {
    const input = sampleInput("old-doc");
    const entry = { ...input, createdAt: "2026-01-02T03:04:05.000Z", updatedAt: "2026-02-03T04:05:06.000Z", byteLength: 40, rev: 3, templateIds: [] };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const created = request.result;
        created.createObjectStore("documents", { keyPath: "id" });
        created.createObjectStore("blobs", { keyPath: "documentId" });
        created.createObjectStore("meta", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["documents", "blobs", "meta"], "readwrite");
      tx.objectStore("documents").put(entry);
      tx.objectStore("blobs").put({ documentId: "old-doc", bytes: sampleBytes(40), byteLength: 40 });
      tx.objectStore("meta").put({ key: "lastBackupAt", value: "2026-02-10T00:00:00.000Z" });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { entry };
  }

  it("abre la base v1, sube a v2 y los documentos, copias y meta siguen idénticos", async () => {
    const { entry } = await seedV1();
    const listed = await listDocuments();
    expect(listed.available).toBe(true);
    expect(listed.skipped).toEqual([]);
    expect(listed.documents).toEqual([entry]);
    expect(await getDocumentBytes("old-doc")).toEqual(sampleBytes(40));
    expect((await getLibraryMeta()).lastBackupAt).toBe("2026-02-10T00:00:00.000Z");
    const db = await rawOpen();
    expect(db.version).toBe(2);
    expect([...db.objectStoreNames].sort()).toEqual(["blobs", "documents", "meta", "templates"]);
    const store = db.transaction("templates", "readonly").objectStore("templates");
    expect(store.keyPath).toBe("id");
    expect([...store.indexNames]).toEqual(["byDocument"]);
    expect(await rawGetAll("templates")).toEqual([]);
    db.close();
  });

  it("después de migrar se pueden crear plantillas para el documento de antes", async () => {
    await seedV1();
    const template = await make("old-doc");
    expect((await getDocument("old-doc"))?.templateIds).toEqual([template.id]);
    expect((await getTemplateForDocument("old-doc"))?.id).toBe(template.id);
  });

  it("una pestaña con la v1 abierta se aparta sola y la migración termina", async () => {
    await seedV1();
    const oldTab = await rawOpen(1);
    oldTab.onversionchange = () => oldTab.close();
    const listed = await listDocuments();
    expect(listed.available).toBe(true);
    expect(listed.documents).toHaveLength(1);
  });

  it("una base ya en v2 no se vuelve a migrar ni pierde plantillas al reabrir", async () => {
    await addDoc("d1");
    const template = await make("d1");
    __resetLibraryForTests();
    expect((await getTemplate(template.id))?.name).toBe("Contrato de servicio");
    expect((await rawOpen()).version).toBe(2);
  });
});

describe("crear y leer", () => {
  it("crea la plantilla (versión 1, rev 1) y la enlaza en templateIds del documento (rev del documento +1)", async () => {
    const doc = await addDoc("d1");
    const created = await make("d1");
    expect(created).toMatchObject({ schemaVersion: 1, documentId: "d1", version: 1, rev: 1, name: "Contrato de servicio" });
    expect(created.createdAt).toBe(created.updatedAt);
    expect("history" in created).toBe(false);
    const after = await getDocument("d1");
    expect(after?.templateIds).toEqual([created.id]);
    expect(after?.rev).toBe(doc.rev + 1);
    expect(after?.updatedAt).toBe(doc.updatedAt);
    expect(await getTemplate(created.id)).toEqual(created);
  });

  it("documento inexistente → notFound y no queda nada; sin documento (null) funciona", async () => {
    await expectLibraryError(make("ghost"), "notFound");
    expect((await listTemplates()).templates).toEqual([]);
    const orphan = await make(null);
    expect(orphan.documentId).toBeNull();
    expect((await listTemplates()).templates).toHaveLength(1);
  });

  it("borradores inválidos → invalid, sin escribir", async () => {
    await addDoc("d1");
    await expectLibraryError(createTemplate({ documentId: "d1", name: "" }), "invalid");
    await expectLibraryError(createTemplate({ documentId: "d 1", name: "x" }), "invalid");
    await expectLibraryError(createTemplate({ documentId: "d1", name: "x", variants: { "1": { fields: [signField({ rect: R(0.9, 0.9, 0.5, 0.5) })] } } }), "invalid");
    await expectLibraryError(createTemplate({ documentId: "d1", name: "x", variants: { "2": { fields: Array.from({ length: 501 }, () => signField()) } } }), "invalid");
    expect((await listTemplates()).templates).toEqual([]);
    expect((await getDocument("d1"))?.templateIds).toEqual([]);
  });

  it("lista: la más reciente primero; getTemplatesForDocument y getTemplateForDocument", async () => {
    await addDoc("d1");
    await addDoc("d2");
    const clk = clock();
    const first = await make("d1", { name: "Primera" }, clk);
    const second = await make("d1", { name: "Segunda" }, clk);
    const other = await make("d2", { name: "Otra" }, clk);
    expect((await listTemplates()).templates.map((template) => template.name)).toEqual(["Otra", "Segunda", "Primera"]);
    expect((await getTemplatesForDocument("d1")).map((template) => template.id)).toEqual([second.id, first.id]);
    expect((await getTemplateForDocument("d1"))?.id).toBe(second.id);
    expect((await getTemplateForDocument("d2"))?.id).toBe(other.id);
    expect(await getTemplateForDocument("nada")).toBeNull();
    expect(await getTemplateForDocument("id raro!")).toBeNull();
    expect(await getTemplate("../x")).toBeNull();
    expect((await getDocument("d1"))?.templateIds).toEqual([first.id, second.id]);
  });

  it("el tope por documento (20) y el total (200)", async () => {
    await addDoc("d1");
    for (let i = 0; i < TEMPLATE_LIMITS.maxPerDocument; i += 1) await make("d1");
    await expectLibraryError(make("d1"), "full", "count");
    expect((await getTemplatesForDocument("d1")).length).toBe(20);
    // Para el total se rellena la base «por debajo» (filas válidas escritas directamente).
    __resetLibraryForTests();
    globalThis.indexedDB = new IDBFactory();
    await listDocuments();
    for (let i = 0; i < TEMPLATE_LIMITS.maxTemplates; i += 1) await rawPut("templates", storedRow(`bulk-${i}`, null));
    await expectLibraryError(make(null), "full", "count");
    expect(await deleteTemplate("bulk-0")).toBe(true);
    await make(null);
  });

  it("dos altas simultáneas con el mismo id: gana una y la otra da conflict", async () => {
    const results = await Promise.allSettled([createTemplate(sampleDraft(null), { newId: () => "same-id" }), createTemplate(sampleDraft(null), { newId: () => "same-id" })]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((failed.reason as LibraryError).code).toBe("conflict");
    expect((await listTemplates()).templates).toHaveLength(1);
  });

  it("origen (clone) y diseño de iniciales se guardan", async () => {
    const created = await createTemplate(sampleDraft(null, { origin: { kind: "clone", fromTemplateId: "t-0", fromDocumentId: null }, layout: { initials: { fromPage: 0, toPage: "all", base: R(0.79, 0.84, 0.11, 0.03), adjust: [] } } }), { newId: ids });
    const back = (await getTemplate(created.id))!;
    expect(back.origin).toEqual({ kind: "clone", fromTemplateId: "t-0", fromDocumentId: null });
    expect(back.layout?.initials?.toPage).toBe("all");
  });
});

describe("versiones: editar, conservar la anterior, restaurar", () => {
  async function edited(template: DocTemplate, name: string, now = clock("2026-04-01T00:00:00.000Z")) {
    const next = structuredClone(template);
    next.name = name;
    next.variants["1"].fields[0].rect = R(0.2, 0.2 + next.version * 0.01, 0.25, 0.05);
    return saveTemplateVersion(next, { now });
  }

  it("editar crea version+1, sube rev, guarda la anterior y deja intacto el documento", async () => {
    await addDoc("d1");
    const v1 = await make("d1");
    const docRev = (await getDocument("d1"))!.rev;
    const v2 = await edited(v1, "Editada");
    expect(v2).toMatchObject({ version: 2, rev: 2, name: "Editada", documentId: "d1", id: v1.id });
    expect(v2.updatedAt > v1.updatedAt).toBe(true);
    expect(v2.createdAt).toBe(v1.createdAt);
    expect((await getDocument("d1"))!.rev).toBe(docRev);
    const versions = await getTemplateVersions(v1.id);
    expect(versions.map((v) => [v.version, v.current, v.name])).toEqual([
      [2, true, "Editada"],
      [1, false, "Contrato de servicio"],
    ]);
    expect(versions[0].fieldCount).toBe(v2.variants["1"].fields.length + v2.variants["1"].textFields.length + v2.variants["2"].fields.length + v2.variants["2"].textFields.length);
  });

  it("guardar sin cambios no escribe nada (misma rev) ni avisa", async () => {
    const created = await make(null);
    const calls: string[] = [];
    const unsubscribe = subscribeToLibrary(() => calls.push("x"));
    const same = await saveTemplateVersion(created);
    unsubscribe();
    expect(same.rev).toBe(1);
    expect(same.version).toBe(1);
    expect(calls).toEqual([]);
    expect((await getTemplateVersions(created.id)).length).toBe(1);
  });

  it("se conservan como mucho 5 versiones (la actual + 4): la más vieja se pierde", async () => {
    let current = await make(null);
    for (let i = 2; i <= 8; i += 1) current = await edited(current, `Versión ${i}`);
    expect(current.version).toBe(8);
    expect(TEMPLATE_LIMITS.maxVersions).toBe(5);
    const versions = await getTemplateVersions(current.id);
    expect(versions.map((v) => v.version)).toEqual([8, 7, 6, 5, 4]);
    expect(versions[2].name).toBe("Versión 6");
    await expectLibraryError(restoreVersion(current.id, 3), "notFound");
  });

  it("restoreVersion copia una versión anterior COMO versión nueva y la que se deja pasa al historial", async () => {
    let current = await make(null, { name: "Original" });
    const originalContent = structuredClone(current.variants);
    current = await edited(current, "Dos");
    current = await edited(current, "Tres");
    const restored = await restoreVersion(current.id, 1, { now: clock("2026-05-01T00:00:00.000Z") });
    expect(restored).toMatchObject({ version: 4, rev: current.rev + 1, name: "Original" });
    expect(restored.variants).toEqual(originalContent);
    const versions = await getTemplateVersions(current.id);
    expect(versions.map((v) => [v.version, v.name])).toEqual([
      [4, "Original"],
      [3, "Tres"],
      [2, "Dos"],
      [1, "Original"],
    ]);
    // Deshacer el deshacer: volver a la 3.
    const again = await restoreVersion(current.id, 3);
    expect(again).toMatchObject({ version: 5, name: "Tres" });
  });

  it("restaurar la actual → invalid; una que no existe → notFound; plantilla ajena → notFound", async () => {
    const t = await make(null);
    await expectLibraryError(restoreVersion(t.id, 1), "invalid");
    await expectLibraryError(restoreVersion(t.id, 9), "notFound");
    await expectLibraryError(restoreVersion("nope", 1), "notFound");
    await expectLibraryError(restoreVersion(t.id, 0), "invalid");
    await expectLibraryError(restoreVersion(t.id, 1.5), "invalid");
  });

  it("restaurar quita el diseño de iniciales si la versión anterior no lo tenía", async () => {
    let current = await make(null);
    const withLayout = structuredClone(current);
    withLayout.layout = { initials: { fromPage: 0, toPage: 2, base: R(0.79, 0.84, 0.11, 0.03), adjust: [{ page: 1, dx: 0.01, dy: 0 }] } };
    current = await saveTemplateVersion(withLayout);
    expect(current.layout?.initials?.toPage).toBe(2);
    const back = await restoreVersion(current.id, 1);
    expect(back.layout).toBeUndefined();
    expect("layout" in (await getTemplate(current.id))!).toBe(false);
  });

  it("trazabilidad: un campo auto que se mueve pasa a manual al guardar", async () => {
    const draft: TemplateDraft = { documentId: null, name: "Auto", variants: { "2": variantOf([signField({ id: "am-0-0", source: "auto", rect: R(0.2, 0.5, 0.25, 0.05) }), signField({ id: "am-0-1", pageIndex: 1, source: "auto" })]) } };
    const created = await createTemplate(draft, { newId: ids });
    const edit = structuredClone(created);
    edit.variants["2"].fields[0].rect = R(0.25, 0.5, 0.25, 0.05);
    const saved = await saveTemplateVersion(edit);
    expect(saved.variants["2"].fields.map((field) => field.source)).toEqual(["manual", "auto"]);
  });

  it("entradas inválidas: sin rev → invalid; plantilla que no existe → notFound; contenido inválido → invalid", async () => {
    const t = await make(null);
    const { rev, ...withoutRev } = t;
    void rev;
    await expectLibraryError(saveTemplateVersion(withoutRev), "invalid");
    await expectLibraryError(saveTemplateVersion({ ...t, rev: 0 }), "invalid");
    await expectLibraryError(saveTemplateVersion({ ...t, id: "ghost" }), "notFound");
    await expectLibraryError(saveTemplateVersion({ ...t, name: "" }), "invalid");
    await expectLibraryError(saveTemplateVersion({ ...t, id: "../x" }), "invalid");
    expect((await getTemplate(t.id))?.version).toBe(1);
  });

  it("no cambia documentId ni origen aunque el objeto editado los traiga distintos", async () => {
    await addDoc("d1");
    const t = await make("d1");
    const edit = { ...structuredClone(t), documentId: "otro", name: "Otra" };
    const saved = await saveTemplateVersion(edit);
    expect(saved.documentId).toBe("d1");
  });
});

describe("concurrencia entre «pestañas» (rev)", () => {
  it("dos pestañas leen la misma rev: la primera guarda, la segunda recibe conflict y no pisa nada", async () => {
    const created = await make(null);
    const tabA = structuredClone(created);
    const tabB = structuredClone(created);
    tabA.name = "Cambio de A";
    tabB.name = "Cambio de B";
    const saved = await saveTemplateVersion(tabA);
    await expectLibraryError(saveTemplateVersion(tabB), "conflict");
    const stored = (await getTemplate(created.id))!;
    expect(stored.name).toBe("Cambio de A");
    expect(stored.rev).toBe(saved.rev);
    expect((await getTemplateVersions(created.id)).length).toBe(2);
    // Con la rev nueva (releída) B sí puede guardar.
    tabB.rev = stored.rev;
    expect((await saveTemplateVersion(tabB)).name).toBe("Cambio de B");
  });

  it("guardados simultáneos con la misma rev: exactamente uno gana", async () => {
    const created = await make(null);
    const edits = ["A", "B", "C", "D"].map((name) => ({ ...structuredClone(created), name }));
    const results = await Promise.allSettled(edits.map((edit) => saveTemplateVersion(edit)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect((result.reason as LibraryError).code).toBe("conflict");
    expect((await getTemplate(created.id))?.version).toBe(2);
    expect((await getTemplateVersions(created.id)).length).toBe(2);
  });

  it("renombrar, restaurar, reasignar y borrar con expectedRev viejo → conflict", async () => {
    await addDoc("d1");
    const t = await make("d1");
    const bumped = await renameTemplate(t.id, "Nuevo nombre");
    await expectLibraryError(renameTemplate(t.id, "Otro", { expectedRev: t.rev }), "conflict");
    await expectLibraryError(attachTemplate(t.id, null, { expectedRev: t.rev }), "conflict");
    await expectLibraryError(deleteTemplate(t.id, { expectedRev: t.rev }), "conflict");
    await expectLibraryError(restoreVersion(t.id, 1, { expectedRev: t.rev }), "conflict");
    expect((await getTemplate(t.id))?.name).toBe("Nuevo nombre");
    expect(await deleteTemplate(t.id, { expectedRev: bumped.rev })).toBe(true);
  });

  it("avisa a los suscritos (esta y otras pestañas por BroadcastChannel) en cada escritura", async () => {
    const calls: string[] = [];
    const unsubscribe = subscribeToLibrary(() => calls.push("cambio"));
    const t = await make(null);
    await renameTemplate(t.id, "x");
    await saveTemplateVersion({ ...structuredClone(await getTemplate(t.id) as DocTemplate), name: "y" });
    await deleteTemplate(t.id);
    unsubscribe();
    expect(calls.length).toBe(4);
  });
});

describe("renombrar, reasignar y borrar", () => {
  it("renombrar no crea versión; recorta espacios y rechaza vacíos o raros", async () => {
    const t = await make(null);
    const renamed = await renameTemplate(t.id, "  Mi contrato  ");
    expect(renamed).toMatchObject({ name: "Mi contrato", version: 1, rev: 2 });
    await expectLibraryError(renameTemplate(t.id, "   "), "invalid");
    await expectLibraryError(renameTemplate(t.id, "a‮b"), "invalid");
    await expectLibraryError(renameTemplate(t.id, "x".repeat(121)), "invalid");
    await expectLibraryError(renameTemplate("ghost", "x"), "notFound");
    await expectLibraryError(renameTemplate("../", "x"), "invalid");
    expect((await getTemplateVersions(t.id)).length).toBe(1);
  });

  it("attachTemplate mueve la plantilla entre documentos y actualiza templateIds de ambos en la misma transacción", async () => {
    await addDoc("d1");
    await addDoc("d2");
    const t = await make("d1");
    const moved = await attachTemplate(t.id, "d2");
    expect(moved).toMatchObject({ documentId: "d2", version: 1, rev: 2 });
    expect((await getDocument("d1"))?.templateIds).toEqual([]);
    expect((await getDocument("d2"))?.templateIds).toEqual([t.id]);
    const detached = await attachTemplate(t.id, null);
    expect(detached.documentId).toBeNull();
    expect((await getDocument("d2"))?.templateIds).toEqual([]);
    expect((await attachTemplate(t.id, null)).rev).toBe(detached.rev); // sin cambio: no escribe
    await expectLibraryError(attachTemplate(t.id, "ghost"), "notFound");
    expect((await getTemplate(t.id))?.documentId).toBeNull();
    await expectLibraryError(attachTemplate(t.id, "a b"), "invalid");
  });

  it("reasignar respeta el tope de 20 por documento", async () => {
    await addDoc("d1");
    for (let i = 0; i < 20; i += 1) await make("d1");
    const loose = await make(null);
    await expectLibraryError(attachTemplate(loose.id, "d1"), "full", "count");
  });

  it("templateIds es robusto ante estados a medias: sin duplicados al crear y sin escribir al borrar lo que no estaba", async () => {
    // El documento ya dice que tiene la plantilla «tpl-x», pero la fila no existe (p. ej. una escritura anterior a medias).
    const doc = await addDoc("d1");
    await rawPut("documents", { ...doc, templateIds: ["tpl-x"], rev: doc.rev + 1 });
    await createTemplate(sampleDraft("d1"), { newId: () => "tpl-x" });
    expect((await getDocument("d1"))?.templateIds).toEqual(["tpl-x"]);
    expect((await getDocument("d1"))?.rev).toBe(doc.rev + 1); // no se reescribió: ya estaba enlazada
    // Al revés: una plantilla de d1 que d1 no conoce; borrarla no toca el documento.
    await rawPut("templates", storedRow("tpl-y", "d1"));
    const before = await getDocument("d1");
    expect(await deleteTemplate("tpl-y")).toBe(true);
    expect(await getDocument("d1")).toEqual(before);
  });

  it("deleteTemplate quita la plantilla (con su historial) y su id del documento; devuelve si existía", async () => {
    await addDoc("d1");
    const t = await make("d1");
    expect(await deleteTemplate(t.id)).toBe(true);
    expect(await deleteTemplate(t.id)).toBe(false);
    expect(await getTemplate(t.id)).toBeNull();
    expect((await getDocument("d1"))?.templateIds).toEqual([]);
    expect(await rawGetAll("templates")).toEqual([]);
    await expectLibraryError(deleteTemplate("a b"), "invalid");
  });

  it("borrar un documento NO borra sus plantillas: quedan «sin documento» y se pueden reasignar", async () => {
    await addDoc("d1");
    await addDoc("d2");
    const a = await make("d1");
    const b = await make("d2");
    await deleteDocument("d1");
    expect(await getDocument("d1")).toBeNull();
    const kept = (await getTemplate(a.id))!;
    expect(kept.documentId).toBeNull();
    expect(kept.rev).toBe(a.rev + 1);
    expect((await getTemplate(b.id))?.documentId).toBe("d2");
    await addDoc("d3");
    expect((await attachTemplate(a.id, "d3")).documentId).toBe("d3");
  });

  it("clearLibrary borra también las plantillas; markBackup y meta siguen funcionando", async () => {
    await addDoc("d1");
    await make("d1");
    await markBackup(new Date("2026-06-01T00:00:00.000Z"));
    await clearLibrary();
    expect((await listTemplates()).templates).toEqual([]);
    expect((await listDocuments()).documents).toEqual([]);
    expect((await getLibraryMeta()).lastBackupAt).toBe("2026-06-01T00:00:00.000Z");
  });
});

describe("atomicidad y fallos", () => {
  it("si falla la escritura de la plantilla (cuota), el documento tampoco cambia", async () => {
    const doc = await addDoc("d1");
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "templates") throw new DOMException("sin espacio", "QuotaExceededError");
      return original.apply(this, args);
    });
    await expectLibraryError(make("d1"), "quota");
    vi.restoreAllMocks();
    expect(await getDocument("d1")).toEqual(doc);
    expect((await listTemplates()).templates).toEqual([]);
  });

  it("si falla el enlace del documento, la plantilla tampoco queda", async () => {
    await addDoc("d1");
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
      if (this.name === "documents") throw new DOMException("sin espacio", "QuotaExceededError");
      return original.apply(this, args);
    });
    await expectLibraryError(make("d1"), "quota");
    vi.restoreAllMocks();
    expect((await listTemplates()).templates).toEqual([]);
    expect((await getDocument("d1"))?.templateIds).toEqual([]);
  });

  it("una fila dañada se ignora (skipped) sin tumbar la lista; no se puede editar", async () => {
    const good = await make(null);
    await rawPut("templates", { ...storedRow("bad-1", null), name: "" });
    await rawPut("templates", { ...storedRow("bad-2", null), version: 2, history: [{ nope: 1 }] });
    await rawPut("templates", { ...storedRow("bad-3", null), schemaVersion: 99 });
    await rawPut("templates", { id: 5 });
    const listed = await listTemplates();
    expect(listed.templates.map((template) => template.id)).toEqual([good.id]);
    expect(listed.skipped.map((entry) => entry.id).sort()).toEqual(["?", "bad-1", "bad-2", "bad-3"]);
    expect(await getTemplate("bad-1")).toBeNull();
    await expectLibraryError(saveTemplateVersion({ ...good, id: "bad-1", rev: 1 }), "invalid");
    await expectLibraryError(renameTemplate("bad-1", "x"), "invalid");
    expect(await deleteTemplate("bad-1")).toBe(true);
  });

  it("sin IndexedDB: lecturas vacías (available:false) y escrituras `unavailable`, sin lanzar al leer", async () => {
    vi.stubGlobal("indexedDB", undefined);
    __resetLibraryForTests();
    expect(await listTemplates()).toEqual({ available: false, templates: [], skipped: [] });
    expect(await getTemplate("x")).toBeNull();
    expect(await getTemplateForDocument("d1")).toBeNull();
    expect(await getTemplateVersions("x")).toEqual([]);
    expect(await templateStatus("d1")).toMatchObject({ state: "none" });
    expect((await templateStatuses()).size).toBe(0);
    expect(await findDuplicateTemplates()).toEqual([]);
    expect(await findTemplateForFingerprint(sampleFingerprint(3, 1))).toBeNull();
    await expectLibraryError(make(null), "unavailable");
    const { history, ...portable } = storedRow("x", null);
    void history;
    await expectLibraryError(importTemplates([portable]), "unavailable");
    await expectLibraryError(renameTemplate("x", "y"), "unavailable");
    await expectLibraryError(deleteTemplate("x"), "unavailable");
  });
});

describe("estado para «Mis documentos»", () => {
  const draftOf = (one: boolean, two: boolean, roleOnlyOne = false): TemplateDraft => ({
    documentId: null,
    name: "S",
    variants: {
      ...(one ? { "1": variantOf([signField()]) } : {}),
      ...(two ? { "2": variantOf(roleOnlyOne ? [signField({ roleIndex: 1 })] : [signField(), signField({ roleIndex: 1 })]) } : {}),
    },
  });
  const status = async (draft: TemplateDraft) => statusOfTemplate(await createTemplate(draft, { newId: ids }));

  it("ready (✓ 1 y 2 firmantes): variante 2 con firmas y forma de firmar con uno", async () => {
    expect(await status(draftOf(true, true))).toMatchObject({ state: "ready", usesFallbackForOne: false, variants: { "1": true, "2": true } });
    expect(await status(draftOf(false, true))).toMatchObject({ state: "ready", usesFallbackForOne: true, variants: { "1": false, "2": true } });
  });

  it("single (solo 1 firmante): solo la variante 1", async () => {
    expect(await status(draftOf(true, false))).toMatchObject({ state: "single", variants: { "1": true, "2": false } });
  });

  it("none: sin firmas, o variante 2 sin firmante 1 y sin variante 1; y sin plantilla", async () => {
    expect(await status(draftOf(false, false))).toMatchObject({ state: "none" });
    expect(await status(draftOf(false, true, true))).toMatchObject({ state: "none" });
    expect(statusOfTemplate(null)).toEqual({ state: "none", templateId: null, variants: { "1": false, "2": false }, usesFallbackForOne: false });
    expect(statusOfTemplate(undefined).state).toBe("none");
  });

  it("texto de la interfaz en español e inglés", () => {
    expect(TEMPLATE_STATUS_TEXT.ready.es).toBe("✓ Plantilla lista (1 y 2 firmantes)");
    expect(TEMPLATE_STATUS_TEXT.single.es).toBe("Solo 1 firmante");
    expect(TEMPLATE_STATUS_TEXT.none.es).toBe("Sin plantilla");
    expect(TEMPLATE_STATUS_TEXT.ready.en).toContain("ready");
  });

  it("templateStatus(documentId) y templateStatuses(): cuentan la plantilla más reciente de cada documento", async () => {
    await addDoc("d1");
    await addDoc("d2");
    await addDoc("d3");
    const clk = clock();
    await createTemplate(draftOf(true, true), { newId: ids, now: clk }).then(() => undefined);
    await attachTemplate((await listTemplates()).templates[0].id, "d1");
    const only1 = await createTemplate({ ...draftOf(true, false), documentId: "d2" }, { newId: ids, now: clk });
    expect((await templateStatus("d1")).state).toBe("ready");
    expect((await templateStatus("d2")).state).toBe("single");
    expect((await templateStatus("d3")).state).toBe("none");
    // Una plantilla más reciente en d2 manda.
    await createTemplate({ ...draftOf(true, true), documentId: "d2" }, { newId: ids, now: clk });
    expect((await templateStatus("d2")).state).toBe("ready");
    const all = await templateStatuses();
    expect([...all.keys()].sort()).toEqual(["d1", "d2"]);
    expect(all.get("d2")?.templateId).not.toBe(only1.id);
    // Sin documento no cuenta para nadie.
    await createTemplate(draftOf(true, true), { newId: ids });
    expect((await templateStatuses()).size).toBe(2);
  });
});

describe("plantillas duplicadas para la misma huella", () => {
  it("un documento con varias plantillas: grupo `sameDocument`, la más reciente se queda", async () => {
    await addDoc("d1");
    const clk = clock();
    const a = await make("d1", {}, clk);
    const b = await make("d1", {}, clk);
    const groups = await findDuplicateTemplates();
    expect(groups).toEqual([{ kind: "sameDocument", documentIds: ["d1"], templateIds: [b.id, a.id], keepId: b.id }]);
  });

  it("documentos distintos con la MISMA huella (idéntica o «Coincide») con plantilla cada uno: `sameFingerprint`", async () => {
    const fp = sampleFingerprint(3, 5);
    const reexported = { ...fp, exact: "ab".repeat(32) };
    await addDoc("d1", fp);
    await addDoc("d2", reexported);
    await addDoc("d3", sampleFingerprint(3, 9));
    const clk = clock();
    const a = await make("d1", {}, clk);
    const b = await make("d2", {}, clk);
    await make("d3", {}, clk);
    const groups = await findDuplicateTemplates();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ kind: "sameFingerprint", documentIds: ["d1", "d2"], templateIds: [b.id, a.id], keepId: b.id });
  });

  it("sin duplicados: lista vacía; los documentos sin plantilla y las plantillas sin documento no cuentan", async () => {
    const fp = sampleFingerprint(3, 5);
    await addDoc("d1", fp);
    await addDoc("d2", { ...fp, exact: "cd".repeat(32) });
    await make("d1");
    await make(null);
    await make(null);
    expect(await findDuplicateTemplates()).toEqual([]);
  });
});

describe("reconocer un PDF cargado: findTemplateForFingerprint", () => {
  it("el mismo archivo → exact; el reexportado (otros bytes) → match; uno distinto → null", async () => {
    const fp = sampleFingerprint(4, 3);
    await addDoc("d1", fp);
    const t = await make("d1");
    const exact = (await findTemplateForFingerprint(fp))!;
    expect(exact.match.level).toBe("exact");
    expect(exact.template.id).toBe(t.id);
    expect(exact.document.id).toBe("d1");
    expect(exact.duplicates).toEqual([]);
    const reexport = (await findTemplateForFingerprint({ ...fp, exact: "ee".repeat(32) }))!;
    expect(reexport.match.level).toBe("match");
    expect(reexport.match.mappedPages).toEqual([0, 1, 2, 3]);
    expect(await findTemplateForFingerprint(sampleFingerprint(4, 99))).toBeNull();
  });

  it("documentos sin plantilla no cuentan, aunque su huella coincida", async () => {
    const fp = sampleFingerprint(3, 3);
    await addDoc("d1", fp);
    expect(await findTemplateForFingerprint(fp)).toBeNull();
    await make(null);
    expect(await findTemplateForFingerprint(fp)).toBeNull();
  });

  it("varias plantillas con la misma huella: la más reciente, y las otras en `duplicates` (aviso)", async () => {
    const fp = sampleFingerprint(3, 3);
    await addDoc("d1", fp);
    await addDoc("d2", { ...fp, exact: "ab".repeat(32) });
    const clk = clock();
    const old = await make("d1", {}, clk);
    const sameDoc = await make("d1", {}, clk);
    const newest = await make("d2", {}, clk);
    const found = (await findTemplateForFingerprint(fp))!;
    expect(found.match.level).toBe("match"); // contra el documento elegido (d2, reexportado)
    // d1 (exacto) y d2 (reexportado, «Coincide») tienen la MISMA huella: manda la plantilla más reciente de todas y las demás van como aviso.
    expect(found.template.id).toBe(newest.id);
    expect(found.document.id).toBe("d2");
    expect(found.match.ambiguous).toBe(true);
    expect(found.duplicates.map((template) => template.id)).toEqual([sameDoc.id, old.id]);
  });

  it("ofrece los campos de mapeo para aplicarla (páginas que cambiaron → reviewPages)", async () => {
    const fp = sampleFingerprint(4, 3);
    await addDoc("d1", fp);
    await make("d1");
    const changed: Fingerprint = { ...fp, exact: "ff".repeat(32), pages: fp.pages.map((page, index) => (index === 2 ? samplePage(777) : page)) };
    const found = (await findTemplateForFingerprint(changed))!;
    expect(found.match.level).toBe("similar");
    expect(found.match.reviewPages).toContain(2);
    expect(found.match.mappedPages[2]).toBeNull();
  });
});

describe("cloneTemplateToDocument («Usar esta plantilla en otro documento»)", () => {
  /** Mismas páginas salvo las indicadas, cambiadas del todo. */
  function variantOfDoc(fp: Fingerprint, changed: number[], seed = 500): Fingerprint {
    return { ...fp, exact: "dd".repeat(32), pages: fp.pages.map((page, index) => (changed.includes(index) ? samplePage(seed + index) : page)) };
  }

  it("copia a un documento casi igual: recoloca páginas, descarta las que no existen y deja la original intacta", async () => {
    const fp = sampleFingerprint(4, 3);
    await addDoc("src", fp);
    await addDoc("dst", variantOfDoc(fp, [3]));
    const source = await make("src");
    const out = await cloneTemplateToDocument(source.id, "dst", { newId: ids });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.match.level).toBe("similar");
    expect(out.droppedPages).toEqual([3]);
    expect(out.template).toMatchObject({ documentId: "dst", version: 1, name: "Contrato de servicio (copia)", origin: { kind: "clone", fromTemplateId: source.id, fromDocumentId: "src" } });
    const pages = new Set([...out.template.variants["2"].fields, ...out.template.variants["2"].textFields].map((field) => field.pageIndex));
    expect(pages.has(3)).toBe(false);
    expect((await getDocument("dst"))?.templateIds).toEqual([out.template.id]);
    expect(await getTemplate(source.id)).toEqual(source);
  });

  it("documento idéntico en estructura: copia todo sin descartar", async () => {
    const fp = sampleFingerprint(4, 3);
    await addDoc("src", fp);
    await addDoc("dst", { ...fp, exact: "ab".repeat(32) });
    const source = await make("src");
    const out = await cloneTemplateToDocument(source.id, "dst", { name: "Mía", newId: ids });
    expect(out.ok && out.dropped).toBe(0);
    expect(out.ok && out.template.name).toBe("Mía");
  });

  it("páginas «parecidas» (0,7-0,9) se copian marcadas para revisar", async () => {
    const fp = sampleFingerprint(4, 3);
    const similarPage = (page: (typeof fp.pages)[number]) => ({ ...page, textHash: "9".repeat(64), minhash: page.minhash.map((value, index) => (index < 100 ? value : (value + 1) >>> 0)) });
    await addDoc("src", fp);
    await addDoc("dst", { ...fp, exact: "ab".repeat(32), pages: fp.pages.map((page, index) => (index === 0 ? similarPage(page) : page)) });
    const source = await make("src");
    const out = await cloneTemplateToDocument(source.id, "dst", { newId: ids });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.flagged).toBeGreaterThan(0);
    const flaggedPages = [...out.template.variants["1"].fields, ...out.template.variants["2"].fields].filter((field) => field.needsReview).map((field) => field.pageIndex);
    expect(new Set(flaggedPages)).toEqual(new Set([0]));
  });

  it("razones de fallo: sin parecido, plantilla o documentos inexistentes, plantilla sin documento", async () => {
    await addDoc("src", sampleFingerprint(4, 3));
    await addDoc("far", sampleFingerprint(4, 40));
    const source = await make("src");
    expect(await cloneTemplateToDocument(source.id, "far")).toEqual({ ok: false, reason: "noMatch" });
    expect(await cloneTemplateToDocument(source.id, "ghost")).toEqual({ ok: false, reason: "noTargetDocument" });
    expect(await cloneTemplateToDocument("ghost", "far")).toEqual({ ok: false, reason: "notFound" });
    const loose = await make(null);
    expect(await cloneTemplateToDocument(loose.id, "far")).toEqual({ ok: false, reason: "noSourceDocument" });
    expect((await listTemplates()).templates).toHaveLength(2);
  });
});

describe("importTemplates", () => {
  async function portable(count: number): Promise<DocTemplate[]> {
    const out: DocTemplate[] = [];
    for (let i = 0; i < count; i += 1) out.push(await make(null, { name: `P${i}` }));
    return out;
  }

  it("guarda en una sola transacción conservando id, versión y fechas, con rev 1", async () => {
    await addDoc("d1");
    const source = await make("d1");
    await clearLibrary();
    await addDoc("d1");
    const out = await importTemplates([source], { now: clock("2027-01-01T00:00:00.000Z") });
    expect(out).toEqual({ imported: [source.id], skipped: [], replaced: [], detached: [] });
    const back = (await getTemplate(source.id))!;
    expect(back).toEqual({ ...source, rev: 1 });
    expect((await getDocument("d1"))?.templateIds).toEqual([source.id]);
  });

  it("si el documento no está en la biblioteca, queda «sin documento»", async () => {
    const [t] = await portable(1);
    const withDoc = { ...t, id: "imp-1", documentId: "no-existe" };
    const out = await importTemplates([withDoc]);
    expect(out.detached).toEqual(["imp-1"]);
    expect((await getTemplate("imp-1"))?.documentId).toBeNull();
  });

  it("conflicto de id: skip (por defecto), copy (id nuevo) o replace (versión nueva de la existente)", async () => {
    const [existing] = await portable(1);
    const incoming = { ...existing, name: "Importada", version: 7 };
    expect(await importTemplates([incoming])).toMatchObject({ skipped: [existing.id], imported: [] });
    expect((await getTemplate(existing.id))?.name).toBe("P0");

    const copy = await importTemplates([incoming], { onConflict: "copy", newId: () => "copy-1" });
    expect(copy.imported).toEqual(["copy-1"]);
    expect((await getTemplate("copy-1"))?.name).toBe("Importada");

    const replaced = await importTemplates([incoming], { onConflict: "replace" });
    expect(replaced.replaced).toEqual([existing.id]);
    const now = (await getTemplate(existing.id))!;
    expect(now).toMatchObject({ name: "Importada", version: 2, rev: 2 });
    expect((await getTemplateVersions(existing.id)).map((v) => v.name)).toEqual(["Importada", "P0"]);
  });

  it("todo o nada: una plantilla inválida lanza `invalid` y no entra ninguna", async () => {
    const [a, b] = await portable(2);
    await clearLibrary();
    const broken = { ...b, name: "" } as DocTemplate;
    await expectLibraryError(importTemplates([a, broken]), "invalid");
    expect((await listTemplates()).templates).toEqual([]);
  });

  it("respeta el tope total de plantillas (todo o nada)", async () => {
    await listDocuments(); // crea la base
    for (let i = 0; i < TEMPLATE_LIMITS.maxTemplates - 1; i += 1) await rawPut("templates", storedRow(`bulk-${i}`, null));
    const a = storedRow("imp-a", null);
    const b = storedRow("imp-b", null);
    await expectLibraryError(importTemplates([a, b] as unknown as DocTemplate[]), "full", "count");
    expect((await listTemplates()).templates).toHaveLength(TEMPLATE_LIMITS.maxTemplates - 1);
  });

  it("lista vacía no hace nada ni avisa", async () => {
    const calls: string[] = [];
    const unsubscribe = subscribeToLibrary(() => calls.push("x"));
    expect(await importTemplates([])).toEqual({ imported: [], skipped: [], replaced: [], detached: [] });
    unsubscribe();
    expect(calls).toEqual([]);
  });
});
