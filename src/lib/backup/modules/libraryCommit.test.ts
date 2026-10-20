import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDocument, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { sampleFingerprint } from "@/lib/docLibrary/testing/sampleDocs";
import { sampleDraft } from "@/lib/docLibrary/testing/templateSamples";
import { parseTemplate } from "@/lib/docLibrary/templateSchema";
import type { DocTemplate } from "@/lib/docLibrary/templateTypes";
import type { DocumentEntry } from "@/lib/docLibrary/types";
import { commitLibraryImport } from "@/lib/backup/modules/libraryCommit";
import { fakePdf, fingerprintOf, freshLibrary, seedDoc, seedTemplate, snapshotLibrary } from "@/lib/backup/__fixtures__/libraryKit";

/**
 * La escritura atómica DIRECTA (`commitLibraryImport`): los límites finales se comprueban aquí aunque la vista previa ya
 * los haya mirado (otra pestaña puede haber llenado la biblioteca entre medias).
 */

beforeEach(() => {
  freshLibrary();
});

async function documentOp(id: string, seed: number, size = 120): Promise<{ entry: DocumentEntry; pdf: Uint8Array }> {
  const pdf = fakePdf(seed, size);
  const fingerprint = await fingerprintOf(pdf, 2, seed);
  const now = "2026-10-01T10:00:00.000Z";
  return {
    pdf,
    entry: { id, name: id, docType: "x", fileName: `${id}.pdf`, pageCount: 2, pageSizes: fingerprint.pageSizes, fingerprint, createdAt: now, updatedAt: now, templateIds: [], byteLength: pdf.length, rev: 1 },
  };
}

function template(id: string, documentId: string | null): DocTemplate {
  const parsed = parseTemplate({
    ...sampleTemplateJson(id, documentId),
  });
  if (!parsed) throw new Error("plantilla de prueba inválida");
  return parsed;
}

function sampleTemplateJson(id: string, documentId: string | null) {
  const draft = sampleDraft(documentId, { name: `T ${id}` });
  return {
    schemaVersion: 1,
    id,
    documentId,
    name: draft.name,
    roles: [
      { key: "signer1", label: "Asegurado" },
      { key: "signer2", label: "Co-asegurado" },
    ],
    variants: {
      "1": { fields: [], textFields: [] },
      "2": { fields: [], textFields: [] },
    },
    version: 1,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    rev: 1,
  };
}

async function patchRows(store: "documents" | "templates", patch: (row: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("optimuspdf-doc-library", 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const objects = tx.objectStore(store);
    const all = objects.getAll();
    all.onsuccess = () => {
      for (const row of all.result) objects.put(patch(row));
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

describe("commitLibraryImport · límites finales", () => {
  it("más de 50 documentos: limit y nada escrito", async () => {
    for (let i = 0; i < 50; i += 1) await seedDoc(`e${i}`, 100 + i, { size: 80 });
    const before = await snapshotLibrary();
    const op = await documentOp("nuevo", 900);
    expect(await commitLibraryImport([{ kind: "create", ...op, adds: [] }])).toEqual({ ok: false, reason: "limit" });
    expect(await snapshotLibrary()).toEqual(before);
    // Con 49 sí cabe.
    const { deleteDocument } = await import("@/lib/docLibrary/store");
    await deleteDocument("e0");
    expect(await commitLibraryImport([{ kind: "create", ...op, adds: [] }])).toMatchObject({ ok: true, documentsCreated: 1 });
  });

  it("más de 400 MiB en total: limit y nada escrito", async () => {
    for (let i = 0; i < 4; i += 1) await seedDoc(`g${i}`, 300 + i, { size: 80 });
    await patchRows("documents", (row) => ({ ...row, byteLength: 99 * 1024 * 1024 }));
    const before = await snapshotLibrary();
    // 4 × 99 MiB = 396 MiB; otro PDF de 5 MiB pasa de 400.
    const big = await documentOp("grande", 901, 5 * 1024 * 1024);
    expect(await commitLibraryImport([{ kind: "create", ...big, adds: [] }])).toEqual({ ok: false, reason: "limit" });
    expect(await snapshotLibrary()).toEqual(before);
    const small = await documentOp("pequeno", 902, 1024 * 1024);
    expect(await commitLibraryImport([{ kind: "create", ...small, adds: [] }])).toMatchObject({ ok: true });
  });

  it("más de 200 plantillas en total: limit; más de 20 en un documento: limit", async () => {
    for (let i = 0; i < 200; i += 1) await seedTemplate(null, { name: `S${i}` }, `s${i}`);
    expect(await commitLibraryImport([{ kind: "detached", adds: [template("extra", null)], replaces: [] }])).toEqual({ ok: false, reason: "limit" });
    expect((await listTemplates()).templates).toHaveLength(200);

    freshLibrary();
    await seedDoc("d", 1);
    for (let i = 0; i < 20; i += 1) await seedTemplate("d", { name: `D${i}` }, `d${i}`);
    const target = (await getDocument("d"))!;
    expect(await commitLibraryImport([{ kind: "templates", targetId: "d", expectRev: target.rev, adds: [template("d-extra", "d")], replaces: [] }])).toEqual({ ok: false, reason: "limit" });
    expect((await listTemplates()).templates).toHaveLength(20);
  });
});

describe("commitLibraryImport · estado y vínculos", () => {
  it("las plantillas se vinculan a SU documento aunque cambie el id; el vínculo se reconstruye en templateIds", async () => {
    await seedDoc("a", 1);
    const op = await documentOp("a", 777);
    const result = await commitLibraryImport([{ kind: "create", ...op, adds: [template("t-1", "a"), template("t-2", "a")] }]);
    expect(result).toMatchObject({ ok: true, documentsCreated: 1, templatesAdded: 2, reassigned: 1 });
    const docs = (await listDocuments()).documents;
    const copy = docs.find((d) => d.id !== "a")!;
    expect(copy.templateIds.sort()).toEqual(["t-1", "t-2"]);
    const rows = (await listTemplates()).templates;
    expect(rows.map((t) => [t.id, t.documentId])).toEqual(expect.arrayContaining([["t-1", copy.id], ["t-2", copy.id]]));
  });

  it("un destino que ya no existe o con otra rev: changed", async () => {
    await seedDoc("a", 1);
    expect(await commitLibraryImport([{ kind: "templates", targetId: "no-existe", expectRev: 1, adds: [], replaces: [] }])).toEqual({ ok: false, reason: "changed" });
    expect(await commitLibraryImport([{ kind: "templates", targetId: "a", expectRev: 99, adds: [], replaces: [] }])).toEqual({ ok: false, reason: "changed" });
    expect(await commitLibraryImport([{ kind: "detached", adds: [], replaces: [{ template: template("zz", null), targetId: "zz", expectRev: 1 }] }])).toEqual({ ok: false, reason: "changed" });
  });

  it("una plantilla de OTRO documento no se reemplaza desde un documento ajeno: changed", async () => {
    await seedDoc("a", 1);
    await seedDoc("b", 2);
    await seedTemplate("b", {}, "tpl-b");
    const a = (await getDocument("a"))!;
    const tpl = (await listTemplates()).templates.find((t) => t.id === "tpl-b")!;
    expect(
      await commitLibraryImport([{ kind: "templates", targetId: "a", expectRev: a.rev, adds: [], replaces: [{ template: template("tpl-b", "a"), targetId: "tpl-b", expectRev: tpl.rev }] }]),
    ).toEqual({ ok: false, reason: "changed" });
  });

  it("sampleFingerprint de prueba coherente (guarda del propio test)", () => {
    expect(sampleFingerprint(2, 1).pageCount).toBe(2);
  });
});
