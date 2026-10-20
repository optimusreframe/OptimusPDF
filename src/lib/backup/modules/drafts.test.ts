import "fake-indexeddb/auto";
import { PDFDocument, PDFName, PDFRawStream } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildUnfinishedItems } from "@/app/recent/unfinishedWork";
import { restoreSession } from "@/app/sign-pdf/sessionDraft";
import {
  listAllDrafts,
  listDrafts,
  listSessionDrafts,
  loadDraft,
  loadSessionDraft,
  peekDocumentDraft,
  saveSessionDraft,
} from "@/app/sign-pdf/signDrafts";
import { setSignPdfFeatureFlag, __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { listEditDrafts, loadEditDraft } from "@/app/edit-pdf/editDrafts";
import { listProDrafts, loadProDraft } from "@/app/pdf-pro/proDrafts";
import { signPdfMulti } from "@/lib/pdf/sign";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  applyDraftsImport,
  checkDraftsLimits,
  defaultDraftDecisions,
  exportDrafts,
  exportDraftsDetailed,
  planDraftsImport,
  summarizeDrafts,
  looksLikePdf,
  __setDraftsPackageBudgetForTests,
} from "@/lib/backup/modules/drafts";
import { pngBytesFromDataUrl } from "@/lib/backup/modules/draftsPng";
import {
  ANA,
  clearAllLocalDrafts,
  realPdf,
  seedEditDraft,
  seedProDraft,
  seedSignDocument,
  seedSignSession,
  stroke,
} from "@/lib/backup/__fixtures__/draftsKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";

/**
 * Modulo «Borradores» sobre IndexedDB falso: ida y vuelta (exportar -> borrar -> importar -> retomar), resumen previo,
 * trazos y caducidad, fusion (nuevo / identico / distinto), limites y atomicidad. Los borradores se guardan con las
 * funciones REALES de cada almacen.
 */

beforeEach(async () => {
  localStorage_clear();
  __resetSignPdfFeatureFlagsCacheForTests();
  await clearAllLocalDrafts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function localStorage_clear(): void {
  // Entorno node: no hay `window`; el ajuste «guardar las firmas» vale su valor por defecto (encendido).
  (globalThis as { window?: unknown }).window = undefined;
}

async function roundTrip(password?: string) {
  const { module, report } = await exportDraftsDetailed();
  const blob = await buildPackage({ modules: [module], password });
  const read = await readPackage(asFile(blob), password);
  return { module, report, read };
}

describe("resumen previo (summarizeDrafts)", () => {
  it("sin borradores: todo a cero y nada que cifrar", async () => {
    const summary = await summarizeDrafts();
    expect(summary).toMatchObject({
      ok: true,
      total: { count: 0, bytes: 0 },
      withSignatureStrokes: 0,
      includesSignatureStrokes: false,
      containsClientData: false,
      encryptionRecommended: false,
      fitsInPackage: true,
    });
  });

  it("cuenta borradores de Firmar (documento y sesion), Editar y PDF Pro, con bytes y trazos", async () => {
    const doc = await seedSignDocument({ strokes: true });
    const session = await seedSignSession({ strokes: true });
    const edit = await seedEditDraft();
    const pro = await seedProDraft();
    const summary = await summarizeDrafts();
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.sign).toMatchObject({ documents: 1, sessions: 1, count: 2 });
    expect(summary.edit.count).toBe(1);
    expect(summary.pro.count).toBe(1);
    expect(summary.total.count).toBe(4);
    expect(summary.sign.bytes).toBe(doc.bytes.byteLength + session.pdfs[0].byteLength + session.pdfs[1].byteLength);
    expect(summary.total.bytes).toBe(summary.sign.bytes + edit.bytes.byteLength + pro.bytes.byteLength);
    expect(summary.withSignatureStrokes).toBe(2);
    expect(summary.includesSignatureStrokes).toBe(true);
    expect(summary.strokesHeldBack).toBe(false);
    expect(summary.containsClientData).toBe(true);
    expect(summary.encryptionRecommended).toBe(true);
  });
});

describe("exportar", () => {
  it("lleva el PDF, los datos y los trazos como archivos PNG; el indice cita rutas derivadas", async () => {
    const doc = await seedSignDocument({ strokes: true });
    const { module, report } = await exportDraftsDetailed();
    expect(report).toMatchObject({ signDocuments: 1, signSessions: 0, edit: 0, pro: 0, includesStrokes: true, skipped: 0 });
    const paths = module.files.map((f) => f.path).sort();
    expect(paths).toEqual(["drafts/d1-k0.png", "drafts/d1-k1.png", "drafts/d1.pdf", "drafts/index.json"]);
    const pdf = module.files.find((f) => f.path === "drafts/d1.pdf")!;
    expect(await sha256Hex(pdf.data)).toBe(doc.fingerprint);
    expect(module.meta).toMatchObject({ signDocuments: 1, includesStrokes: true });
  });

  it("no exporta borradores caducados (firmas guardadas hace mas de 7 dias)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    await seedSignDocument({ strokes: true, label: "Vieja" });
    await seedSignSession({ strokes: true, tag: "v" });
    vi.setSystemTime(new Date("2026-10-07T10:00:00Z"));
    await seedSignDocument({ strokes: true, label: "Reciente" });
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    const { module, report } = await exportDraftsDetailed();
    expect(report).toMatchObject({ signDocuments: 1, signSessions: 0, expired: 2 });
    const index = JSON.parse(new TextDecoder().decode(module.files[0].data));
    expect(index.sign.documents).toHaveLength(1);
    expect(index.sign.documents[0].fileName).toBe("Reciente.pdf");
  });

  it("un borrador SIN trazos no caduca y viaja aunque sea viejo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    await seedSignDocument({ strokes: false });
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    expect((await exportDraftsDetailed()).report.signDocuments).toBe(1);
  });

  it("con el ajuste «guardar las firmas» apagado los trazos NO viajan (signaturesOmitted) aunque el borrador los tenga", async () => {
    await seedSignDocument({ strokes: true });
    await seedSignSession({ strokes: true, ceremony: true });
    const window = new MemoryWindow();
    (globalThis as { window?: unknown }).window = window;
    __resetSignPdfFeatureFlagsCacheForTests();
    setSignPdfFeatureFlag("signaturesInDraft", false);
    const summary = await summarizeDrafts();
    expect(summary.ok && summary.strokesHeldBack).toBe(true);
    expect(summary.ok && summary.includesSignatureStrokes).toBe(false);
    expect(summary.ok && summary.withSignatureStrokes).toBe(2);
    const { module, report } = await exportDraftsDetailed({ includeStrokes: true });
    expect(report.includesStrokes).toBe(false);
    expect(module.files.some((f) => f.path.endsWith(".png"))).toBe(false);
    const index = JSON.parse(new TextDecoder().decode(module.files[0].data));
    expect(index.sign.documents[0].signaturesOmitted).toBe(true);
    expect(index.sign.documents[0].expiresAt).toBeUndefined();
    expect(index.sign.sessions[0].signaturesOmitted).toBe(true);
    expect(index.sign.sessions[0].ceremony).toBeUndefined();
    expect(JSON.stringify(index)).not.toContain("dataUrl");
  });

  it("includeStrokes: false quita los trazos aunque el ajuste este encendido", async () => {
    await seedSignDocument({ strokes: true });
    const { report } = await exportDraftsDetailed({ includeStrokes: false });
    expect(report.includesStrokes).toBe(false);
  });

  it("pasados los ~246 MiB del paquete, `tooLarge` (el resumen ya lo dice) y se puede elegir que tipos llevar", async () => {
    const doc = await seedSignDocument({ label: "Grande" });
    await seedEditDraft({ label: "Otro" });
    try {
      __setDraftsPackageBudgetForTests(doc.bytes.byteLength + 10);
      const summary = await summarizeDrafts();
      expect(summary.ok && summary.fitsInPackage).toBe(false);
      await expect(exportDraftsDetailed()).rejects.toMatchObject({ code: "tooLarge" });
      // eligiendo solo Firmar cabe
      expect((await exportDraftsDetailed({ kinds: { sign: true, edit: false, pro: false } })).report).toMatchObject({ signDocuments: 1, edit: 0 });
    } finally {
      __setDraftsPackageBudgetForTests();
    }
    const summary = await summarizeDrafts();
    expect(summary.ok && summary.fitsInPackage).toBe(true);
  });

  it("kinds deja fuera lo que no se pide", async () => {
    await seedSignDocument();
    await seedEditDraft();
    await seedProDraft();
    const only = await exportDraftsDetailed({ kinds: { sign: false, edit: true, pro: false } });
    expect(only.report).toMatchObject({ signDocuments: 0, edit: 1, pro: 0 });
  });

  it("leer para exportar no cambia nada guardado (ni rev, ni fecha, ni borra)", async () => {
    await seedSignDocument({ strokes: true });
    await seedSignSession({ strokes: true });
    const before = JSON.stringify([await listDrafts(), await listSessionDrafts()]);
    await exportDrafts();
    expect(JSON.stringify([await listDrafts(), await listSessionDrafts()])).toBe(before);
  });
});

describe("ida y vuelta: exportar -> borrar -> importar -> retomar", () => {
  it("restaura los cuatro tipos de borrador, idénticos, con el mismo id", async () => {
    const doc = await seedSignDocument({ strokes: true });
    const session = await seedSignSession({ strokes: true, ceremony: true });
    const edit = await seedEditDraft({ withImage: true });
    const pro = await seedProDraft();
    const beforeDocs = await listDrafts();
    const beforeSessions = await listSessionDrafts();
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    expect(await listAllDrafts()).toHaveLength(0);

    const plan = await planDraftsImport(read);
    expect(plan.state).toBe("ok");
    expect(plan.counts).toEqual({ new: 4, identical: 0, different: 0, invalid: 0 });
    expect(plan.includesStrokes).toBe(true);
    const result = await applyDraftsImport(plan, defaultDraftDecisions(plan));
    expect(result).toMatchObject({ ok: true, written: 4, replaced: 0, keptBoth: 0, skipped: 0 });

    const docs = await listDrafts();
    expect(docs.map((d) => [d.id, d.fingerprint, d.fileName, d.savedAt, d.rev, d.expiresAt])).toEqual(
      beforeDocs.map((d) => [d.id, d.fingerprint, d.fileName, d.savedAt, 1, d.expiresAt]),
    );
    const restoredDoc = await loadDraft(doc.id);
    expect(restoredDoc?.bytes).toEqual(doc.bytes);
    expect(restoredDoc?.meta.captures[ANA.id].signature).toEqual(beforeDocs[0].captures[ANA.id].signature);
    expect(restoredDoc?.meta.textValues).toEqual({ nombre: "Ana Perez" });

    const sessions = await listSessionDrafts();
    expect(sessions[0]).toMatchObject({ id: session.id, savedAt: beforeSessions[0].savedAt, rev: 1 });
    expect(sessions[0].blocks).toEqual(beforeSessions[0].blocks);
    expect(sessions[0].ceremony).toEqual(beforeSessions[0].ceremony);
    expect(sessions[0].docStates).toEqual(beforeSessions[0].docStates);
    const loadedSession = await loadSessionDraft(session.id);
    expect(loadedSession?.files.map((f) => f.bytes)).toEqual(session.pdfs);

    const editBack = await loadEditDraft(edit.id);
    expect(editBack.ok && editBack.draft.bytes).toEqual(edit.bytes);
    expect(editBack.ok && editBack.draft.session.items.map((i) => i.kind).sort()).toEqual(["image", "text"]);
    const proBack = await loadProDraft(pro.id);
    expect(proBack.ok && proBack.draft.bytes).toEqual(pro.bytes);
    expect(proBack.ok && proBack.draft.history.map((h) => h.label)).toEqual(["Original", "Rotar todas las páginas 90°"]);
  });

  it("lo importado se ofrece en «Recientes -> Continuar» y se puede retomar: la sesion restaura bloques y el PDF final lleva los trazos", async () => {
    const session = await seedSignSession({ strokes: true });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read);
    expect((await applyDraftsImport(plan, defaultDraftDecisions(plan))).ok).toBe(true);

    // Recientes
    const unfinished = buildUnfinishedItems({ sign: await listAllDrafts(), edit: await listEditDrafts(), pro: await listProDrafts() });
    expect(unfinished).toHaveLength(1);
    expect(unfinished[0]).toMatchObject({ key: `session:${session.id}`, documents: 2, href: `/sign-pdf?resume=session:${session.id}` });

    // Continuar: lo mismo que hace la herramienta al restaurar
    const loaded = await loadSessionDraft(session.id);
    expect(loaded).not.toBeNull();
    const files = loaded!.files.map((f) => new File([f.bytes as unknown as BlobPart], f.fileName, { type: "application/pdf" }));
    const restored = restoreSession(loaded!.meta, files, session.keys);
    expect(restored.staleDocs).toBe(0);
    expect(restored.normalized).toBe(0);
    const block = restored.patch.blocks!.find((b) => b.signerId === ANA.id)!;
    expect(block.signature?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(Object.keys(block.stamps)).toHaveLength(2); // los sellos siguen valiendo: la firma de Ana no se vuelve a pedir

    // El PDF final se genera con los trazos
    const png = pngBytesFromDataUrl(block.signature!.dataUrl)!;
    const signed = await signPdfMulti(files[0], {
      placements: [{ kind: "image", png, pageIndex: 0, rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 } }],
    });
    const out = await PDFDocument.load(new Uint8Array(await signed.arrayBuffer()));
    const xobjects = out.getPages()[0].node.Resources()?.lookup(PDFName.of("XObject"));
    expect(xobjects).toBeDefined();
    const images = [...(xobjects as unknown as { dict: Map<unknown, unknown> }).dict.values()]
      .map((ref) => out.context.lookup(ref as never))
      .filter((obj) => obj instanceof PDFRawStream);
    expect(images.length).toBeGreaterThanOrEqual(1);
  });

  it("con contraseña: el paquete cifrado se lee con ella y no sin ella", async () => {
    await seedSignDocument();
    const { module } = await exportDraftsDetailed();
    const blob = await buildPackage({ modules: [module], password: "clave-segura-1" });
    await expect(readPackage(asFile(blob))).rejects.toMatchObject({ code: "needsPassword" });
    const read = await readPackage(asFile(blob), "clave-segura-1");
    expect(read.encrypted).toBe(true);
    expect((await planDraftsImport(read)).counts.identical).toBe(1);
  });
});

describe("fusion: nuevo / idéntico / distinto", () => {
  it("importar lo mismo dos veces no duplica: todo es «Ya lo tienes (idéntico)»", async () => {
    await seedSignDocument({ strokes: true });
    await seedSignSession({ strokes: true });
    await seedEditDraft();
    await seedProDraft();
    const { read } = await roundTrip();
    const plan = await planDraftsImport(read);
    expect(plan.counts).toEqual({ new: 0, identical: 4, different: 0, invalid: 0 });
    expect(defaultDraftDecisions(plan)).toEqual(Object.fromEntries(plan.items.map((i) => [i.key, "omit"])));
    const result = await applyDraftsImport(plan, defaultDraftDecisions(plan));
    expect(result).toMatchObject({ ok: true, written: 0, skipped: 4 });
    expect(await listAllDrafts()).toHaveLength(2);
  });

  it("el mismo contenido bajo OTRO id local (un «conservar ambos» anterior) tampoco se duplica", async () => {
    const doc = await seedSignDocument({ strokes: true });
    const { read } = await roundTrip();
    // el borrador local pasa a otro id manteniendo el contenido
    const loaded = (await peekDocumentDraft(doc.id))!;
    await clearAllLocalDrafts();
    const { saveDraft } = await import("@/app/sign-pdf/signDrafts");
    await saveDraft({
      id: `${doc.fingerprint.slice(0, 32)}${"cd".repeat(16)}`,
      fingerprint: doc.fingerprint,
      fileBytes: loaded.bytes,
      fileName: loaded.meta.fileName,
      manifest: { mode: loaded.meta.mode, signers: loaded.meta.signers, fields: loaded.meta.fields, textFields: loaded.meta.textFields, textValues: loaded.meta.textValues },
      step: "sign",
      captures: loaded.meta.captures,
      textFieldsDetectedFor: loaded.meta.textFieldsDetectedFor,
    });
    const plan = await planDraftsImport(read);
    expect(plan.counts.identical).toBe(1);
    expect(plan.items[0].conflictWith?.id).toBe(`${doc.fingerprint.slice(0, 32)}${"cd".repeat(16)}`);
  });

  it("mismo id y otro contenido = «Distinto»; Reemplazar sustituye y sube la rev; el local mas nuevo no se pisa por defecto", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const first = await seedSignSession({ strokes: false, tag: "z" });
    const { read: oldPackage } = await roundTrip();
    // el local evoluciona (mas nuevo): otra revision de la misma sesion
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    const names: [string, string] = ["Contrato A.pdf", "Anexo B.pdf"];
    await saveSessionDraft({
      id: first.id,
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [],
      documents: first.pdfs.map((pdf, i) => ({
        id: `doc-${i + 1}`,
        fileName: names[i],
        size: pdf.byteLength,
        state: { fields: [], textFields: [], textValues: { nuevo: "x" }, textFieldsDetectedFor: null, rect: { x: 0, y: 0, width: 0, height: 0 }, pageIndex: 0, fieldPageIndex: 0, sealedKey: first.keys[i] },
        getBytes: async () => pdf,
      })),
      activeDocId: "doc-1",
      step: "document",
    });
    const local = (await listSessionDrafts())[0];
    const plan = await planDraftsImport(oldPackage);
    expect(plan.counts.different).toBe(1);
    const item = plan.items[0];
    expect(item.status).toBe("different");
    expect(item.conflictWith).toMatchObject({ id: first.id, newer: true });
    // por defecto NO se pisa el local mas nuevo: se conserva ambos
    expect(defaultDraftDecisions(plan)[item.key]).toBe("keepBoth");
    // decision explicita: reemplazar
    const result = await applyDraftsImport(plan, { [item.key]: "replace" });
    expect(result).toMatchObject({ ok: true, written: 1, replaced: 1 });
    const after = (await listSessionDrafts())[0];
    expect(after.id).toBe(first.id);
    expect(after.step).toBe("sign");
    expect(after.rev).toBe((local.rev ?? 0) + 1);
    expect(after.savedAt).toBe("2026-10-10T10:00:00.000Z");
  });

  it("«Conservar ambos» crea un borrador nuevo con id nuevo (nonce) y copyOf; vuelve a ser «idéntico» al reimportar", async () => {
    const doc = await seedSignDocument({ strokes: false });
    const { read } = await roundTrip();
    // cambia el local (mismo id, otro contenido)
    const loaded = (await peekDocumentDraft(doc.id))!;
    const { saveDraft } = await import("@/app/sign-pdf/signDrafts");
    await saveDraft({
      id: doc.id,
      fingerprint: doc.fingerprint,
      fileBytes: loaded.bytes,
      fileName: loaded.meta.fileName,
      manifest: { mode: "multi", signers: loaded.meta.signers, fields: loaded.meta.fields, textFields: [], textValues: { nombre: "Otro" } },
      step: "sign",
      captures: {},
      textFieldsDetectedFor: null,
    });
    const plan = await planDraftsImport(read);
    expect(plan.counts.different).toBe(1);
    const result = await applyDraftsImport(plan, { [plan.items[0].key]: "keepBoth" });
    expect(result).toMatchObject({ ok: true, written: 1, keptBoth: 1 });
    const drafts = await listDrafts();
    expect(drafts).toHaveLength(2);
    const copy = drafts.find((d) => d.id !== doc.id)!;
    expect(copy.id).toMatch(/^[0-9a-f]{64}$/);
    expect(copy.id.slice(0, 32)).toBe(doc.fingerprint.slice(0, 32));
    expect(copy.fingerprint).toBe(doc.fingerprint);
    expect(copy.copyOf).toBe(doc.id);
    // reimportar el mismo paquete: ahora el contenido ya esta (en la copia)
    expect((await planDraftsImport(read)).counts).toMatchObject({ identical: 1, different: 0 });
  });

  it("editar y PDF Pro: distinto -> solo Reemplazar u Omitir (no hay conservar ambos); keepBoth no se acepta", async () => {
    const edit = await seedEditDraft({ text: "Version A" });
    const pro = await seedProDraft();
    const { read } = await roundTrip();
    await seedEditDraft({ text: "Version B" }); // mismo PDF -> mismo id, otra sesion
    const plan = await planDraftsImport(read);
    const editItem = plan.items.find((i) => i.kind === "edit")!;
    expect(editItem.status).toBe("different");
    expect(editItem.canKeepBoth).toBe(false);
    expect(plan.items.find((i) => i.kind === "pro")!.status).toBe("identical");
    const none = await applyDraftsImport(plan, { [editItem.key]: "keepBoth" });
    expect(none).toMatchObject({ ok: true, written: 0 });
    const replaced = await applyDraftsImport(plan, { [editItem.key]: "replace" });
    expect(replaced).toMatchObject({ ok: true, written: 1, replaced: 1 });
    const back = await loadEditDraft(edit.id);
    expect(back.ok && back.draft.session.items.map((i) => (i.kind === "text" ? i.edit.text : "?"))).toEqual(["Version A"]);
    void pro;
  });
});

describe("limites: nunca se expulsa un borrador local para hacer sitio", () => {
  it("con 10 borradores de Firmar ya guardados, importar uno nuevo da `limit` y no escribe ni borra nada", async () => {
    const extra = await seedSignDocument({ label: "Extra", strokes: false });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    for (let n = 0; n < 10; n += 1) await seedSignDocument({ label: `Local ${n}` });
    const before = JSON.stringify((await listDrafts()).map((d) => [d.id, d.savedAt, d.rev]));
    const plan = await planDraftsImport(read);
    expect(plan.items[0].status).toBe("new");
    expect(plan.local.sign.count).toBe(10);
    const decisions = defaultDraftDecisions(plan);
    const check = checkDraftsLimits(plan, decisions);
    expect(check).toMatchObject({ ok: false, wanted: 1, sign: { count: 11, maxCount: 10, ok: false } });
    // el informe de limites (cuantos habria por almacen) viaja con el rechazo: lo pinta la interfaz
    expect(await applyDraftsImport(plan, decisions)).toMatchObject({ ok: false, reason: "limit", limits: { ok: false, sign: { count: 11, maxCount: 10 } } });
    expect(JSON.stringify((await listDrafts()).map((d) => [d.id, d.savedAt, d.rev]))).toBe(before);
    expect(await loadDraft(extra.id)).toBeNull();
  });

  it("la propia escritura vuelve a comprobar el limite dentro de la transaccion (el plan puede estar viejo)", async () => {
    await seedSignDocument({ label: "Extra" });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read); // 0 locales: cabe
    for (let n = 0; n < 10; n += 1) await seedSignDocument({ label: `Local ${n}` }); // otra pestana llena el almacen despues
    expect(checkDraftsLimits(plan, defaultDraftDecisions(plan)).ok).toBe(true);
    expect(await applyDraftsImport(plan, defaultDraftDecisions(plan))).toMatchObject({ ok: false, reason: "limit" });
    expect(await listDrafts()).toHaveLength(10);
  });

  it("reemplazar un borrador con el almacen lleno SI cabe (no suma)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const target = await seedSignSession({ tag: "r" });
    const { read } = await roundTrip();
    for (let n = 0; n < 9; n += 1) await seedSignDocument({ label: `Local ${n}` });
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    await seedSignSession({ tag: "r", names: ["Contrato A.pdf", "Cambiado.pdf"] });
    const plan = await planDraftsImport(read);
    const item = plan.items[0];
    expect(item).toMatchObject({ status: "different", id: target.id });
    expect(checkDraftsLimits(plan, { [item.key]: "replace" }).ok).toBe(true);
    expect(await applyDraftsImport(plan, { [item.key]: "replace" })).toMatchObject({ ok: true, replaced: 1 });
    expect(await listSessionDrafts()).toHaveLength(1);
    expect(await listDrafts()).toHaveLength(9);
  });

  it("los limites se cuentan por almacen (Firmar, Editar y PDF Pro son independientes)", async () => {
    await seedEditDraft({ label: "E1" });
    await seedProDraft({ label: "P1", tag: "p1" });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    for (let n = 0; n < 10; n += 1) await seedSignDocument({ label: `Local ${n}` });
    const plan = await planDraftsImport(read);
    expect(checkDraftsLimits(plan, defaultDraftDecisions(plan))).toMatchObject({ ok: true, sign: { count: 10 }, edit: { count: 1 }, pro: { count: 1 } });
    expect(await applyDraftsImport(plan, defaultDraftDecisions(plan))).toMatchObject({ ok: true, written: 2 });
  });
});

describe("atomicidad entre almacenes: si uno falla, los anteriores se deshacen", () => {
  it("un fallo al escribir PDF Pro deja Firmar y Editar como estaban (lo creado se borra)", async () => {
    await seedSignDocument({ strokes: true });
    await seedEditDraft();
    await seedProDraft();
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read);
    const result = await applyDraftsImport(plan, defaultDraftDecisions(plan), {
      beforeCommit: (store) => {
        if (store === "pro") throw new Error("disco lleno");
      },
    });
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result.ok === false && result.partial).toBeUndefined();
    expect(await listDrafts()).toHaveLength(0);
    expect(await listEditDrafts()).toHaveLength(0);
    expect(await listProDrafts()).toHaveLength(0);
    // y despues, sin el fallo, entra todo
    expect(await applyDraftsImport(plan, defaultDraftDecisions(plan))).toMatchObject({ ok: true, written: 3 });
  });

  it("lo SUSTITUIDO se restaura tal cual (contenido, fecha y version) si un almacen posterior falla", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const session = await seedSignSession({ tag: "u" });
    const edit = await seedEditDraft({ text: "Version A" });
    const { read } = await roundTrip();
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    await seedSignSession({ tag: "u", names: ["Contrato A.pdf", "Otro.pdf"] });
    await seedEditDraft({ text: "Version B" });
    const beforeSession = (await listSessionDrafts())[0];
    const beforeEdit = await loadEditDraft(edit.id);
    const plan = await planDraftsImport(read);
    const decisions = Object.fromEntries(plan.items.map((i) => [i.key, "replace" as const]));
    const result = await applyDraftsImport(plan, decisions, {
      beforeCommit: (store) => {
        if (store === "edit") throw new Error("fallo");
      },
    });
    expect(result).toMatchObject({ ok: false });
    const afterSession = (await listSessionDrafts())[0];
    expect(afterSession).toEqual(beforeSession);
    expect((await loadSessionDraft(session.id))?.files.map((f) => f.fileName)).toEqual(["Contrato A.pdf", "Otro.pdf"]);
    const afterEdit = await loadEditDraft(edit.id);
    expect(afterEdit.ok && afterEdit.draft.session.items.map((i) => (i.kind === "text" ? i.edit.text : "?"))).toEqual(
      beforeEdit.ok ? beforeEdit.draft.session.items.map((i) => (i.kind === "text" ? i.edit.text : "?")) : [],
    );
  });

  it("si lo que se iba a sustituir cambio entre la vista previa y aplicar: `changed`, sin escribir y sin tocar otros almacenes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    await seedSignSession({ tag: "c" });
    await seedEditDraft({ text: "A" });
    const { read } = await roundTrip();
    vi.setSystemTime(new Date("2026-10-10T11:00:00Z"));
    await seedSignSession({ tag: "c", names: ["Contrato A.pdf", "Cambiado.pdf"] });
    await seedEditDraft({ text: "B" });
    const plan = await planDraftsImport(read);
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    await seedSignSession({ tag: "c", names: ["Contrato A.pdf", "Cambiado otra vez.pdf"] }); // otra pestana, despues de la vista previa
    const decisions = Object.fromEntries(plan.items.map((i) => [i.key, "replace" as const]));
    expect(await applyDraftsImport(plan, decisions)).toMatchObject({ ok: false, reason: "changed" });
    expect((await listSessionDrafts())[0].documents[1].fileName).toBe("Cambiado otra vez.pdf");
    const edit = await listEditDrafts();
    expect(edit).toHaveLength(1);
  });
});

describe("Editar y PDF Pro: choque y limite al aplicar", () => {
  it("Editar: si el local cambio tras la vista previa, `changed` y no se escribe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const edit = await seedEditDraft({ text: "A" });
    const { read } = await roundTrip();
    vi.setSystemTime(new Date("2026-10-10T11:00:00Z"));
    await seedEditDraft({ text: "B" });
    const plan = await planDraftsImport(read);
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    await seedEditDraft({ text: "C" });
    expect(await applyDraftsImport(plan, { [plan.items[0].key]: "replace" })).toMatchObject({ ok: false, reason: "changed" });
    const back = await loadEditDraft(edit.id);
    expect(back.ok && back.draft.session.items.map((i) => (i.kind === "text" ? i.edit.text : "?"))).toEqual(["C"]);
  });

  it("Editar y PDF Pro: con 10 locales, uno mas es `limit` y no se pierde ninguno", async () => {
    await seedEditDraft({ label: "Extra" });
    await seedProDraft({ tag: "extra", label: "ProExtra" });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    for (let n = 0; n < 10; n += 1) await seedEditDraft({ label: `E${n}` });
    const plan = await planDraftsImport(read);
    expect(checkDraftsLimits(plan, defaultDraftDecisions(plan))).toMatchObject({ ok: false, edit: { count: 11, ok: false }, pro: { count: 1, ok: true } });
    expect(await applyDraftsImport(plan, defaultDraftDecisions(plan))).toMatchObject({ ok: false, reason: "limit" });
    expect(await listEditDrafts()).toHaveLength(10);
    expect(await listProDrafts()).toHaveLength(0);
    // el almacen que SI tiene sitio no se descarta aparte: se elige que importar
    const proOnly = Object.fromEntries(plan.items.map((i) => [i.key, i.kind === "pro" ? ("import" as const) : ("omit" as const)]));
    expect(await applyDraftsImport(plan, proOnly)).toMatchObject({ ok: true, written: 1 });
    expect(await listProDrafts()).toHaveLength(1);
  });

  it("PDF Pro: distinto -> Reemplazar sustituye el snapshot y la historia; si el local es mas nuevo la sugerida es Omitir", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const first = await seedProDraft({ tag: "k", label: "Antes" });
    const { read } = await roundTrip();
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    const { saveProDraft } = await import("@/app/pdf-pro/proDrafts");
    const changed = await realPdf("Despues", 4);
    await saveProDraft({ id: first.id, fileName: "Despues.pdf", bytes: changed, snapshotId: "s2", history: [{ label: "Original", createdAt: 1, source: "open" }] });
    const plan = await planDraftsImport(read);
    expect(plan.items[0]).toMatchObject({ status: "different", conflictWith: { newer: true } });
    expect(defaultDraftDecisions(plan)[plan.items[0].key]).toBe("omit");
    expect(await applyDraftsImport(plan, { [plan.items[0].key]: "replace" })).toMatchObject({ ok: true, replaced: 1 });
    const back = await loadProDraft(first.id);
    expect(back.ok && back.draft.bytes).toEqual(first.bytes);
    // conserva la fecha del PAQUETE (la de guardado de Pro es monotona por modulo: no se fija con un literal)
    expect(back.ok && back.draft.meta.savedAt).toBe(plan.items[0].savedAt);
    expect(plan.items[0].savedAt < plan.items[0].conflictWith!.savedAt).toBe(true);
  });
});

describe("version (rev) y pestanas", () => {
  it("un borrador nuevo entra con rev 1 y el writerId de esta pestana; esta pestana lo sigue guardando sin hacer copia aparte", async () => {
    const { tabWriterId, knownDraftRev } = await import("@/app/sign-pdf/signDrafts");
    const session = await seedSignSession({ tag: "w" });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read);
    await applyDraftsImport(plan, defaultDraftDecisions(plan));
    const stored = (await listSessionDrafts())[0];
    expect(stored).toMatchObject({ id: session.id, rev: 1, writerId: tabWriterId() });
    expect(knownDraftRev(session.id)).toBe(1);
    const again = await saveSessionDraft({
      id: session.id,
      mode: "multi",
      signMode: "same",
      signers: stored.signers,
      blocks: [],
      documents: session.pdfs.map((pdf, i) => ({ id: `doc-${i + 1}`, fileName: `n${i}.pdf`, size: pdf.byteLength, state: stored.docStates[`doc-${i + 1}`], getBytes: async () => pdf })),
      activeDocId: "doc-1",
      step: "sign",
    });
    expect(again).toEqual({ ok: true });
    expect((await listSessionDrafts())[0].rev).toBe(2);
  });

  it("otra pestana que NO conocia la version importada guarda aparte en vez de pisarla (D1)", async () => {
    const { __createTabForTests, __useTabForTests } = await import("@/app/sign-pdf/signDrafts");
    const session = await seedSignSession({ tag: "x" });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const other = __createTabForTests("t-otra");
    const plan = await planDraftsImport(read);
    await applyDraftsImport(plan, defaultDraftDecisions(plan));
    const previous = __useTabForTests(other);
    try {
      const stored = (await listSessionDrafts())[0];
      const result = await saveSessionDraft({
        id: session.id,
        mode: "multi",
        signMode: "same",
        signers: stored.signers,
        blocks: [],
        documents: session.pdfs.map((pdf, i) => ({ id: `doc-${i + 1}`, fileName: `n${i}.pdf`, size: pdf.byteLength, state: stored.docStates[`doc-${i + 1}`], getBytes: async () => pdf })),
        activeDocId: "doc-1",
        step: "sign",
      });
      expect(result).toMatchObject({ ok: true, forkedTo: expect.stringMatching(/^s-/) });
    } finally {
      __useTabForTests(previous);
    }
    expect(await listSessionDrafts()).toHaveLength(2);
  });

  it("reemplazar sube la rev por encima de la del local", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    await seedSignSession({ tag: "q" });
    const { read } = await roundTrip();
    for (let n = 0; n < 3; n += 1) {
      vi.setSystemTime(new Date(`2026-10-10T1${n + 1}:00:00Z`));
      await seedSignSession({ tag: "q", names: ["Contrato A.pdf", `Rev ${n}.pdf`] });
    }
    const local = (await listSessionDrafts())[0];
    expect(local.rev).toBeGreaterThanOrEqual(3);
    const plan = await planDraftsImport(read);
    await applyDraftsImport(plan, { [plan.items[0].key]: "replace" });
    expect((await listSessionDrafts())[0].rev).toBe((local.rev ?? 0) + 1);
  });

  it("sustituir una sesion borra los archivos de documentos que ya no tiene (sin huerfanos)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T10:00:00Z"));
    const first = await seedSignSession({ tag: "o" });
    const { read } = await roundTrip();
    vi.setSystemTime(new Date("2026-10-10T12:00:00Z"));
    // el local tiene un tercer documento
    const extra = await realPdf("tercero");
    const loaded = (await loadSessionDraft(first.id))!;
    await saveSessionDraft({
      id: first.id,
      mode: "multi",
      signMode: "same",
      signers: loaded.meta.signers,
      blocks: [],
      documents: [...loaded.files.map((f) => ({ id: f.id, fileName: f.fileName, size: f.bytes.byteLength, state: loaded.meta.docStates[f.id], getBytes: async () => f.bytes })), { id: "doc-3", fileName: "Tercero.pdf", size: extra.byteLength, state: loaded.meta.docStates["doc-1"], getBytes: async () => extra }],
      activeDocId: "doc-1",
      step: "sign",
    });
    const plan = await planDraftsImport(read);
    await applyDraftsImport(plan, { [plan.items[0].key]: "replace" });
    expect(await rawKeys()).toEqual([`${first.id}/doc-1`, `${first.id}/doc-2`]);
  });
});

describe("trazos: la politica de «guardar las firmas» y la caducidad al importar", () => {
  it("con el ajuste apagado en ESTE navegador, los trazos del paquete se descartan al importar (signaturesOmitted, sin caducidad ni turno)", async () => {
    const doc = await seedSignDocument({ strokes: true });
    const session = await seedSignSession({ strokes: true, ceremony: true });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read, { keepStrokes: false });
    expect(plan.keepStrokes).toBe(false);
    expect(plan.items.every((i) => i.hasStrokes && i.strokesDropped)).toBe(true);
    const result = await applyDraftsImport(plan, defaultDraftDecisions(plan), { keepStrokes: false });
    expect(result).toMatchObject({ ok: true, written: 2, strokesDropped: 2 });
    const storedDoc = (await listDrafts())[0];
    expect(storedDoc.id).toBe(doc.id);
    expect(storedDoc.captures).toEqual({});
    expect(storedDoc.signaturesOmitted).toBe(true);
    expect(storedDoc.expiresAt).toBeUndefined();
    const storedSession = (await listSessionDrafts())[0];
    expect(storedSession.id).toBe(session.id);
    expect(storedSession.blocks.every((b) => b.signature === null && b.initials === null && Object.keys(b.stamps).length === 0)).toBe(true);
    expect(storedSession.signaturesOmitted).toBe(true);
    expect(storedSession.expiresAt).toBeUndefined();
    expect(storedSession.ceremony).toBeUndefined();
  });

  it("la politica se vuelve a leer al aplicar: si se apago entre la vista previa y aplicar, tambien se descartan", async () => {
    await seedSignDocument({ strokes: true });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read, { keepStrokes: true });
    expect(plan.items[0].strokesDropped).toBe(false);
    expect(await applyDraftsImport(plan, defaultDraftDecisions(plan), { keepStrokes: false })).toMatchObject({ ok: true, strokesDropped: 1 });
    expect((await listDrafts())[0].captures).toEqual({});
  });

  it("con trazos conserva la caducidad del paquete (no se renueva 7 dias) y un paquete con trazos ya caducados se rechaza", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T10:00:00Z"));
    await seedSignDocument({ strokes: true });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
    const ok = await planDraftsImport(read);
    await applyDraftsImport(ok, defaultDraftDecisions(ok));
    expect((await listDrafts())[0].expiresAt).toBe("2026-10-08T10:00:00.000Z");
    await clearAllLocalDrafts();
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    const late = await planDraftsImport(read);
    expect(late.items[0]).toMatchObject({ status: "invalid", reason: "expired" });
    expect(await applyDraftsImport(late, { [late.items[0].key]: "import" })).toMatchObject({ ok: true, written: 0 });
    expect(await listDrafts()).toHaveLength(0);
  });

  it("un borrador sin trazos no caduca al importar aunque el paquete sea viejo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    await seedSignDocument({ strokes: false });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    const plan = await planDraftsImport(read);
    expect(plan.items[0].status).toBe("new");
  });

  it("una fecha de guardado en el futuro lejano se recorta a ahora (no queda siempre como «el mas nuevo»)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T10:00:00Z"));
    await seedSignDocument({ strokes: false });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    vi.setSystemTime(new Date("2026-10-09T10:00:00Z"));
    const plan = await planDraftsImport(read);
    expect(plan.items[0].savedAt).toBe("2026-10-09T10:00:00.000Z");
  });
});

describe("validadores externos (inputGuard y PNG)", () => {
  it("validatePdf = false rechaza el PDF; validateImage = false rechaza el trazo", async () => {
    await seedSignDocument({ strokes: true });
    await seedEditDraft({ withImage: true });
    const { read } = await roundTrip();
    const noPdf = await planDraftsImport(read, { validatePdf: async () => false });
    expect(noPdf.items.map((i) => i.reason)).toEqual(["invalidPdf", "invalidPdf"]);
    const noImage = await planDraftsImport(read, { validateImage: async () => false });
    expect(noImage.items.map((i) => i.reason)).toEqual(["invalidImage", "invalidImage"]);
    const calls: string[] = [];
    await planDraftsImport(read, { validatePdf: async (_b, name) => (calls.push(name), true) });
    expect(calls).toEqual(["Poliza.pdf", "Informe.pdf"]);
  });
});

describe("Editar: imagenes y elementos descartados", () => {
  it("las imagenes viajan como archivos y vuelven; un elemento invalido se descarta y se cuenta", async () => {
    const edit = await seedEditDraft({ withImage: true });
    const { module } = await exportDraftsDetailed();
    expect(module.files.map((f) => f.path).sort()).toEqual(["drafts/e1-a0.png", "drafts/e1-session.json", "drafts/e1.pdf", "drafts/index.json"]);
    const blob = await buildPackage({ modules: [module] });
    const read = await readPackage(asFile(blob));
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read);
    expect(plan.items[0]).toMatchObject({ status: "new", kind: "edit", discarded: 0, canKeepBoth: false });
    await applyDraftsImport(plan, defaultDraftDecisions(plan));
    const back = await loadEditDraft(edit.id);
    expect(back.ok && Object.keys(back.draft.session.assets)).toEqual(["im1"]);
  });
});

describe("borradores de documento suelto anteriores (id = huella, sin campo fingerprint)", () => {
  it("se exportan con su huella y se importan como los de ahora", async () => {
    const { saveDraft } = await import("@/app/sign-pdf/signDrafts");
    const bytes = await realPdf("Antiguo");
    const fingerprint = await sha256Hex(bytes);
    await saveDraft({
      id: fingerprint,
      fileBytes: bytes,
      fileName: "Antiguo.pdf",
      manifest: { mode: "multi", signers: [ANA], fields: [], textFields: [], textValues: {} },
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
    const { read } = await roundTrip();
    await clearAllLocalDrafts();
    const plan = await planDraftsImport(read);
    expect(plan.items[0]).toMatchObject({ status: "new", id: fingerprint });
    await applyDraftsImport(plan, defaultDraftDecisions(plan));
    expect((await listDrafts())[0]).toMatchObject({ id: fingerprint, fingerprint, fileName: "Antiguo.pdf" });
  });
});

function rawKeys(): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("optimuspdf-sign-drafts");
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("draftFiles", "readonly").objectStore("draftFiles").getAllKeys();
      request.onsuccess = () => {
        db.close();
        resolve(request.result.sort());
      };
      request.onerror = () => reject(request.error);
    };
    open.onerror = () => reject(open.error);
  });
}

class MemoryWindow {
  private store = new Map<string, string>();
  localStorage = {
    getItem: (key: string) => (this.store.has(key) ? (this.store.get(key) as string) : null),
    setItem: (key: string, value: string) => void this.store.set(key, String(value)),
    removeItem: (key: string) => void this.store.delete(key),
    clear: () => this.store.clear(),
    key: (index: number) => Array.from(this.store.keys())[index] ?? null,
    get length() {
      return 0;
    },
  };
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
  sessionStorage = this.localStorage;
}

void looksLikePdf;
void checkDraftsLimits;
void realPdf;
void stroke;
