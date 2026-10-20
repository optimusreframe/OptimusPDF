import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { commitEditDraftImport, listEditDrafts, loadEditDraft, type EditDraftMeta } from "@/app/edit-pdf/editDrafts";
import { __setProDraftsLimitsForTests, commitProDraftImport, listProDrafts, loadProDraft, saveProDraft } from "@/app/pdf-pro/proDrafts";
import {
  commitDraftImport,
  listDrafts,
  listSessionDrafts,
  loadDraft,
  loadSessionDraft,
  type DraftImportDocument,
  type DraftImportSession,
} from "@/app/sign-pdf/signDrafts";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { exportDraftsDetailed, planDraftsImport, type DraftsImportPlan } from "@/lib/backup/modules/drafts";
import { clearAllLocalDrafts, realPdf, seedEditDraft, seedProDraft, seedSignDocument, seedSignSession } from "@/lib/backup/__fixtures__/draftsKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";

/**
 * Las tres escrituras atomicas del respaldo (`commitDraftImport`, `commitEditDraftImport`, `commitProDraftImport`) por separado:
 * entrada invalida, choque, limites, versionado y `undo`.
 */

beforeEach(async () => {
  __setProDraftsLimitsForTests();
  await clearAllLocalDrafts();
});

async function planFromLocal(): Promise<DraftsImportPlan> {
  const { module } = await exportDraftsDetailed();
  const read = await readPackage(asFile(await buildPackage({ modules: [module] })));
  await clearAllLocalDrafts();
  return planDraftsImport(read);
}

const documentsOf = (plan: DraftsImportPlan): DraftImportDocument[] =>
  plan.items.flatMap((i) => (i.payload?.kind === "sign-document" ? [{ meta: i.payload.meta, bytes: i.payload.bytes }] : []));
const sessionsOf = (plan: DraftsImportPlan): DraftImportSession[] =>
  plan.items.flatMap((i) => (i.payload?.kind === "sign-session" ? [{ meta: i.payload.meta, files: i.payload.files }] : []));
const editsOf = (plan: DraftsImportPlan) =>
  plan.items.flatMap((i) => (i.payload?.kind === "edit" ? [{ meta: i.payload.meta, files: i.payload.files }] : []));
const prosOf = (plan: DraftsImportPlan) =>
  plan.items.flatMap((i) => (i.payload?.kind === "pro" ? [{ meta: i.payload.meta, bytes: i.payload.bytes }] : []));

describe("commitDraftImport (Firmar)", () => {
  it("escribe documentos y sesiones en una transaccion, con rev 1 y sin tocar la fecha del paquete", async () => {
    await seedSignDocument({ strokes: true });
    await seedSignSession({ strokes: true });
    const plan = await planFromLocal();
    const result = await commitDraftImport({ documents: documentsOf(plan), sessions: sessionsOf(plan), replace: [] });
    expect(result).toMatchObject({ ok: true, written: 2, replaced: 0 });
    expect((await listDrafts())[0].rev).toBe(1);
    expect((await listSessionDrafts())[0].rev).toBe(1);
  });

  it("entrada invalida: ni listas, ni ids repetidos, ni sesion sin sus archivos, ni bytes que no son bytes", async () => {
    await seedSignSession({});
    await seedSignDocument({});
    const plan = await planFromLocal();
    const doc = documentsOf(plan)[0];
    const session = sessionsOf(plan)[0];
    expect(await commitDraftImport({ documents: "x", sessions: [], replace: [] } as never)).toEqual({ ok: false, reason: "invalid" });
    expect(await commitDraftImport({ documents: [doc, doc], sessions: [], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitDraftImport({ documents: [], sessions: [{ ...session, files: session.files.slice(1) }], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitDraftImport({ documents: [{ ...doc, bytes: "x" as never }], sessions: [], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitDraftImport({ documents: [], sessions: [{ ...session, meta: { ...session.meta, kind: "otro" } as never }], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await listDrafts()).toHaveLength(0);
    expect(await commitDraftImport({ documents: [], sessions: [], replace: [] })).toMatchObject({ ok: true, written: 0 });
  });

  it("un id ocupado que no se declara como sustitucion es un choque (`changed`): no se pisa", async () => {
    await seedSignDocument({});
    const plan = await planFromLocal();
    await seedSignDocument({}); // el mismo documento vuelve a existir
    const before = (await listDrafts())[0];
    expect(await commitDraftImport({ documents: documentsOf(plan), sessions: [], replace: [] })).toEqual({ ok: false, reason: "changed" });
    expect((await listDrafts())[0]).toEqual(before);
  });

  it("sustituir exige que fecha y version sean las de la vista previa", async () => {
    await seedSignDocument({});
    const plan = await planFromLocal();
    const seeded = await seedSignDocument({});
    const local = (await listDrafts())[0];
    const stale = { kind: "document" as const, id: local.id, savedAt: "2020-01-01T00:00:00.000Z", rev: local.rev ?? 0 };
    expect(await commitDraftImport({ documents: documentsOf(plan), sessions: [], replace: [stale] })).toEqual({ ok: false, reason: "changed" });
    const wrongRev = { kind: "document" as const, id: local.id, savedAt: local.savedAt, rev: (local.rev ?? 0) + 5 };
    expect(await commitDraftImport({ documents: documentsOf(plan), sessions: [], replace: [wrongRev] })).toEqual({ ok: false, reason: "changed" });
    const ok = { kind: "document" as const, id: local.id, savedAt: local.savedAt, rev: local.rev ?? 0 };
    const result = await commitDraftImport({ documents: documentsOf(plan), sessions: [], replace: [ok] });
    expect(result).toMatchObject({ ok: true, replaced: 1 });
    expect((await listDrafts())[0].rev).toBe((local.rev ?? 0) + 1);
    void seeded;
  });

  it("undo borra lo creado y devuelve lo sustituido TAL CUAL (meta, fecha, version y bytes)", async () => {
    const created = await seedSignDocument({ label: "Nuevo" });
    const replaced = await seedSignSession({ tag: "u", strokes: true });
    const plan = await planFromLocal();
    // estado previo: una version distinta del documento (se sustituye) y nada mas
    await seedSignSession({ tag: "u", names: ["Contrato A.pdf", "Local.pdf"] });
    const local = (await listSessionDrafts())[0];
    const localFiles = (await loadSessionDraft(local.id))!.files.map((f) => f.bytes);
    const result = await commitDraftImport({
      documents: documentsOf(plan),
      sessions: sessionsOf(plan),
      replace: [{ kind: "session", id: local.id, savedAt: local.savedAt, rev: local.rev ?? 0 }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await loadDraft(created.id)).not.toBeNull();
    await result.undo();
    expect(await listDrafts()).toHaveLength(0);
    expect((await listSessionDrafts())[0]).toEqual(local);
    expect((await loadSessionDraft(replaced.id))!.files.map((f) => f.bytes)).toEqual(localFiles);
  });

  it("limite de la sesion (150 MiB) y del almacen: `limit` sin escribir", async () => {
    await seedSignSession({});
    const plan = await planFromLocal();
    const session = sessionsOf(plan)[0];
    const big = new Uint8Array(151 * 1024 * 1024);
    big.set(session.files[0].bytes);
    expect(await commitDraftImport({ documents: [], sessions: [{ ...session, files: [{ id: session.files[0].id, bytes: big }, session.files[1]] }], replace: [] })).toEqual({ ok: false, reason: "limit" });
    expect(await listSessionDrafts()).toHaveLength(0);
  });
});

describe("commitEditDraftImport (Editar)", () => {
  it("escribe, detecta choques, sustituye con la fecha vista y deshace", async () => {
    const first = await seedEditDraft({ text: "Version A", withImage: true });
    const plan = await planFromLocal();
    const puts = editsOf(plan);
    expect(puts[0].files.map((f) => f.key).sort()).toEqual([first.id, `${first.id}/im1`].sort());
    const created = await commitEditDraftImport({ puts, replace: [] });
    expect(created).toMatchObject({ ok: true, written: 1, replaced: 0 });
    expect((await listEditDrafts())[0].savedAt).toBe(puts[0].meta.savedAt);
    // ya existe: sin declarar la sustitucion es un choque
    expect(await commitEditDraftImport({ puts, replace: [] })).toEqual({ ok: false, reason: "changed" });
    const local = (await listEditDrafts())[0];
    expect(await commitEditDraftImport({ puts, replace: [{ id: local.id, savedAt: "1999-01-01T00:00:00.000Z" }] })).toEqual({ ok: false, reason: "changed" });
    // sustituir y deshacer devuelve la imagen y la sesion locales
    const newer = { ...puts[0], meta: { ...puts[0].meta, pendingCount: 7 } as EditDraftMeta };
    const replaced = await commitEditDraftImport({ puts: [newer], replace: [{ id: local.id, savedAt: local.savedAt }] });
    expect(replaced).toMatchObject({ ok: true, replaced: 1 });
    if (!replaced.ok) return;
    expect((await listEditDrafts())[0].pendingCount).toBe(7);
    await replaced.undo();
    const back = await loadEditDraft(first.id);
    expect(back.ok && back.draft.meta.pendingCount).toBe(local.pendingCount);
    expect(back.ok && Object.keys(back.draft.session.assets)).toEqual(["im1"]);
    if (created.ok) await created.undo();
    expect(await listEditDrafts()).toHaveLength(0);
    expect(await loadEditDraft(first.id)).toMatchObject({ ok: false, reason: "notFound" });
  });

  it("entrada invalida (faltan el PDF o una imagen, meta que no es de Editar) y limite de 10", async () => {
    await seedEditDraft({ text: "A", withImage: true });
    const plan = await planFromLocal();
    const put = editsOf(plan)[0];
    expect(await commitEditDraftImport({ puts: [{ ...put, files: put.files.slice(1) }], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitEditDraftImport({ puts: [{ ...put, files: put.files.slice(0, 1) }], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitEditDraftImport({ puts: [{ meta: { id: "x" } as never, files: [] }], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    expect(await commitEditDraftImport({ puts: "x" as never, replace: [] })).toEqual({ ok: false, reason: "invalid" });
    for (let n = 0; n < 10; n += 1) await seedEditDraft({ label: `L${n}` });
    expect(await commitEditDraftImport({ puts: [put], replace: [] })).toEqual({ ok: false, reason: "limit" });
    expect(await listEditDrafts()).toHaveLength(10);
  });
});

describe("commitProDraftImport (PDF Pro)", () => {
  it("escribe una fila entera, detecta choques, respeta el limite y deshace", async () => {
    const first = await seedProDraft({ tag: "a" });
    const plan = await planFromLocal();
    const puts = prosOf(plan);
    const created = await commitProDraftImport({ puts, replace: [] });
    expect(created).toMatchObject({ ok: true, written: 1 });
    expect((await listProDrafts())[0].savedAt).toBe(puts[0].meta.savedAt);
    expect(await commitProDraftImport({ puts, replace: [] })).toEqual({ ok: false, reason: "changed" });
    expect(await commitProDraftImport({ puts, replace: [{ id: puts[0].meta.id, savedAt: "1999-01-01T00:00:00.000Z" }] })).toEqual({ ok: false, reason: "changed" });
    expect(await commitProDraftImport({ puts: [{ ...puts[0], bytes: new Uint8Array() }], replace: [] })).toEqual({ ok: false, reason: "invalid" });
    if (created.ok) await created.undo();
    expect(await listProDrafts()).toHaveLength(0);
    expect(await rawProKeys(), "ni la fila de bytes queda").toEqual([]);
    for (let n = 0; n < 10; n += 1) await seedProDraft({ tag: `t${n}`, label: `P${n}` });
    expect(await commitProDraftImport({ puts, replace: [] })).toEqual({ ok: false, reason: "limit" });
    void first;
  });

  it("sustituir un borrador TROCEADO: el manifiesto sale, los trozos esperan a `finalize` (y `undo` lo restaura entero)", async () => {
    __setProDraftsLimitsForTests({ chunkMinBytes: 1000 });
    const bytes = await realPdf("Troceado", 40);
    const id = "9".repeat(64);
    await saveProDraft({ id, fileName: "t.pdf", bytes, snapshotId: "s1", history: [{ label: "Original", createdAt: 1, source: "open" }] });
    expect((await rawProKeys()).some((key) => String(key).startsWith("~m:"))).toBe(true);
    const chunkRows = (await rawProKeys()).filter((key) => String(key).startsWith("~c:")).length;
    expect(chunkRows).toBeGreaterThan(0);
    const local = (await listProDrafts())[0];
    const other = await realPdf("Reemplazo");
    const put = { meta: { ...(await loadProMeta(id)), fileSize: other.byteLength, savedAt: "2026-10-01T10:00:00.000Z" }, bytes: other };

    // undo ANTES de finalizar: el borrador troceado original vuelve entero
    const first = await commitProDraftImport({ puts: [put], replace: [{ id, savedAt: local.savedAt }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect((await rawProKeys()).some((key) => String(key).startsWith("~m:"))).toBe(false);
    expect((await rawProKeys()).filter((key) => String(key).startsWith("~c:")).length).toBe(chunkRows); // los trozos siguen ahi
    const loaded = await loadProDraft(id);
    expect(loaded.ok && loaded.draft.bytes).toEqual(other);
    await first.undo();
    const restored = await loadProDraft(id);
    expect(restored.ok && restored.draft.bytes).toEqual(bytes);

    // y finalizar barre los trozos que ya no nombra nadie
    const second = await commitProDraftImport({ puts: [put], replace: [{ id, savedAt: local.savedAt }] });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await second.finalize();
    expect((await rawProKeys()).filter((key) => String(key).startsWith("~c:")).length).toBe(0);
    const final = await loadProDraft(id);
    expect(final.ok && final.draft.bytes).toEqual(other);
    __setProDraftsLimitsForTests();
  });
});

function rawProKeys(): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("optimuspdf-pro-drafts");
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("draftFiles", "readonly").objectStore("draftFiles").getAllKeys();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

async function loadProMeta(id: string) {
  const loaded = await loadProDraft(id);
  if (!loaded.ok) throw new Error("sin borrador");
  return { ...loaded.draft.meta, history: loaded.draft.history };
}
