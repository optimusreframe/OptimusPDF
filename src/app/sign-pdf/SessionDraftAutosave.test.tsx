import "fake-indexeddb/auto";
import { createRef, type MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import {
  DOCUMENT_UNDO_MS,
  SESSION_DELETE_GRACE_MS,
  SESSION_SAVE_DEBOUNCE_MS,
  SessionDraftAutosave,
  __setSessionDeleteGraceForTests,
} from "@/app/sign-pdf/SessionDraftAutosave";
import { EMPTY_DOC_STATE, docIdOf, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  __resetSignPdfFeatureFlagsCacheForTests,
  setSignPdfFeatureFlag,
} from "@/app/sign-pdf/signFeatureFlags";
import { __resetDraftActivityForTests, hasPendingDraftWrite } from "@/app/sign-pdf/draftActivity";
import type { SessionIdentity } from "@/app/sign-pdf/sessionDraft";
import {
  clearAllDrafts,
  deleteDraft,
  listDrafts,
  listSessionDrafts,
  loadSessionDraft,
  saveDraft,
  wasDraftSavedHere,
  warmDraftsConnection,
  __closeWarmDraftsConnectionForTests,
  __createTabForTests,
  __hasWarmDraftsConnectionForTests,
  __useTabForTests,
} from "@/app/sign-pdf/signDrafts";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * El autoguardado de la sesion (varios documentos): debounce, generacion,
 * borrado cuando no queda progreso y relevo al flujo de un solo documento.
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const MB = 1024 * 1024;

function pdf(name: string, byte = 1): File {
  return new File([new Uint8Array([37, 80, 68, 70, byte])], name, { type: "application/pdf" });
}

function slot(signerId = "sg-1"): SignatureField {
  return {
    id: `fld-${signerId}`,
    signerId,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
  };
}

function sessionOf(files: File[], over: Partial<SignSession> = {}, docOver: Partial<DocState> = {}): SignSession {
  const ids = files.map(docIdOf);
  return {
    ...DEFAULT_SESSION,
    mode: "multi",
    signers: [ANA],
    docOrder: ids,
    activeDocId: ids[0] ?? null,
    docs: Object.fromEntries(ids.map((id) => [id, { ...EMPTY_DOC_STATE, ...docOver }])),
    ...over,
  };
}

type Props = {
  files: File[];
  session: SignSession;
  identityRef: MutableRefObject<SessionIdentity | null>;
  onTooBig: (value: boolean) => void;
};

function mount(initial: Omit<Props, "identityRef" | "onTooBig"> & Partial<Pick<Props, "identityRef" | "onTooBig">>) {
  const identityRef = initial.identityRef ?? (createRef<SessionIdentity | null>() as MutableRefObject<SessionIdentity | null>);
  if (!initial.identityRef) identityRef.current = null;
  const onTooBig = initial.onTooBig ?? vi.fn();
  const view = render(
    <SessionDraftAutosave files={initial.files} session={initial.session} identityRef={identityRef} onTooBig={onTooBig} />,
  );
  return {
    identityRef,
    onTooBig,
    update: (next: Pick<Props, "files" | "session">) =>
      view.rerender(
        <SessionDraftAutosave files={next.files} session={next.session} identityRef={identityRef} onTooBig={onTooBig} />,
      ),
    unmount: view.unmount,
  };
}

/** Olvida lo que esta pestana guardo sin tocar la base (el registro es de modulo: se rehace con un borrado inocuo). */
async function clearAllDraftsMarkOnly() {
  await deleteDraft("huella-vieja-no-existe");
  // `deleteDraft` solo olvida SU id: para olvidar el de verdad se borra y se reescribe desde "otra pestana".
  await deleteDraft("huella-vieja");
  await rawPutV1("huella-vieja");
}

async function rawPutV1(id: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("optimuspdf-sign-drafts");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["draftFiles", "draftMeta"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore("draftFiles").put({ id, bytes: new Uint8Array([1]) });
    tx.objectStore("draftMeta").put({
      id,
      fileName: "a.pdf",
      fileSize: 1,
      savedAt: new Date().toISOString(),
      mode: "multi",
      signers: [],
      fields: [],
      textFields: [],
      textValues: {},
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
  });
  db.close();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  await clearAllDrafts();
  __setSessionDeleteGraceForTests(null);
});

describe("SessionDraftAutosave", () => {
  it("mientras el guardado esta agendado o escribiendo hay una escritura pendiente (lo que decide el aviso al cerrar); al terminar, ninguna", async () => {
    __resetDraftActivityForTests();
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const view = mount({ files, session: sessionOf(files) });
    expect(hasPendingDraftWrite()).toBe(true);
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 50 });
    await waitFor(() => expect(hasPendingDraftWrite()).toBe(false), { timeout: 3000, interval: 50 });
    // Un cambio nuevo la vuelve a abrir.
    view.update({ files, session: sessionOf(files, { signers: [ANA, { id: "sg-2", name: "Luis", color: "#0f9d68" }] }) });
    expect(hasPendingDraftWrite()).toBe(true);
    await waitFor(() => expect(hasPendingDraftWrite()).toBe(false), { timeout: 3000, interval: 50 });
    // Borrar tambien cuenta: quitar el ultimo firmante borra el borrador y mientras tanto esta pendiente.
    view.update({ files, session: sessionOf(files, { signers: [] }) });
    expect(hasPendingDraftWrite()).toBe(true);
    await waitFor(async () => expect(await listSessionDrafts()).toEqual([]), { timeout: 3000, interval: 50 });
    await waitFor(() => expect(hasPendingDraftWrite()).toBe(false), { timeout: 3000, interval: 50 });
    view.unmount();
  });

  it("guarda la sesion pasado el debounce, con todos los documentos y sus bytes", async () => {
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    mount({ files, session: sessionOf(files) });
    expect(await listSessionDrafts()).toEqual([]);
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 100 });
    const [meta] = await listSessionDrafts();
    expect(meta.documents.map((doc) => doc.fileName)).toEqual(["a.pdf", "b.pdf"]);
    const loaded = await loadSessionDraft(meta.id);
    expect(Array.from(loaded!.files[1].bytes)).toEqual([37, 80, 68, 70, 2]);
  });

  it("el turno de la ceremonia se guarda y un cambio de turno vuelve a guardar la sesion (Fase 0 · U0.2)", async () => {
    const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const base = sessionOf(files, { signers: [ANA, LUIS], step: "sign" });
    const view = mount({ files, session: { ...base, ceremony: { signerId: "sg-1", stage: "handoff" } } });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 100 });
    expect((await listSessionDrafts())[0].ceremony).toEqual({ signerId: "sg-1", stage: "handoff" });

    // Solo cambia el turno (nada mas de la sesion): tiene que dispararse un guardado nuevo.
    view.update({ files, session: { ...base, ceremony: { signerId: "sg-2", stage: "capture" } } });
    await waitFor(
      async () => expect((await listSessionDrafts())[0].ceremony).toEqual({ signerId: "sg-2", stage: "capture" }),
      { timeout: 3000, interval: 100 },
    );
  });

  it("no guarda nada si no hay progreso", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    mount({ files, session: sessionOf(files, { signers: [] }) });
    await sleep(1100);
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("al desmontar con un guardado pendiente lo vuelca de inmediato (sin esperar al debounce)", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 700, interval: 25 });
  });

  it("un cambio dentro del debounce reemplaza al anterior: se guarda el estado MAS NUEVO una sola vez", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    view.update({
      files,
      session: sessionOf(files, { signers: [ANA, { id: "sg-2", name: "Luis", color: "#e5484d" }] }),
    });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 100 });
    await sleep(100);
    const [meta] = await listSessionDrafts();
    expect(meta.signers).toHaveLength(2);
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("fija la identidad de la sesion y la marca como guardada", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    expect(view.identityRef.current?.saved).toBe(true);
    expect(view.identityRef.current?.id).toMatch(/^s-/);
    await waitFor(async () => expect((await listSessionDrafts())[0]?.id).toBe(view.identityRef.current?.id), {
      timeout: 3000,
      interval: 100,
    });
  });

  it("con la misma identidad actualiza la MISMA sesion (no duplica) tras desmontar y volver a montar", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const first = mount({ files, session: sessionOf(files) });
    first.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1000, interval: 25 });
    const second = mount({
      files,
      session: sessionOf(files, { step: "document" }),
      identityRef: first.identityRef,
    });
    second.unmount();
    await waitFor(async () => expect((await listSessionDrafts())[0]?.step).toBe("document"), { timeout: 1000, interval: 25 });
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("una ronda NUEVA (otros archivos) no pisa el borrador de la anterior: son dos sesiones", async () => {
    const roundOne = [pdf("a.pdf"), pdf("b.pdf")];
    const roundTwo = [pdf("c.pdf"), pdf("d.pdf")];
    const view = mount({ files: roundOne, session: sessionOf(roundOne) });
    view.update({ files: roundTwo, session: sessionOf(roundTwo) });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 100 });
    // La primera ronda se supero antes de volcarse; ahora la segunda tras un montaje limpio.
    const view2 = mount({ files: roundOne, session: sessionOf(roundOne) });
    view2.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(2), { timeout: 3000, interval: 100 });
    const names = (await listSessionDrafts()).map((meta) => meta.documents.map((doc) => doc.fileName).join(","));
    expect(names.sort()).toEqual(["a.pdf,b.pdf", "c.pdf,d.pdf"]);
  });

  it("si despues no queda progreso, borra el borrador que habia guardado", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1000, interval: 25 });
    const again = mount({
      files,
      session: sessionOf(files, { signers: [] }),
      identityRef: view.identityRef,
    });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(0), { timeout: 3000, interval: 100 });
    again.unmount();
  });

  it("lo borrado no resucita: quitar el progreso y desmontar de inmediato deja la base sin sesion", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    // Cambio inmediato a «sin progreso» y desmontaje: el volcado del estado anterior ya esta superado.
    view.update({ files, session: sessionOf(files, { signers: [] }) });
    view.unmount();
    await sleep(600);
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("la espera del borrado diferido cubre el «Deshacer» de quitar un documento (nunca menos que la ventana)", () => {
    expect(SESSION_DELETE_GRACE_MS).toBeGreaterThan(DOCUMENT_UNDO_MS);
  });

  it("al quedar UN solo documento borra el borrador de sesion y suelta la identidad (relevo al flujo de un documento), pero solo cuando expira el «Deshacer»", async () => {
    __setSessionDeleteGraceForTests(900);
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1000, interval: 25 });
    const onTooBig = vi.fn();
    const single = mount({
      files: [files[0]],
      session: sessionOf([files[0]]),
      identityRef: view.identityRef,
      onTooBig,
    });
    // Durante la ventana el borrador sigue entero y la identidad tambien: nada se borra todavia.
    await sleep(500);
    expect(await listSessionDrafts()).toHaveLength(1);
    expect(view.identityRef.current).not.toBeNull();
    await waitFor(async () => expect(await listSessionDrafts()).toEqual([]), { timeout: 3000, interval: 25 });
    await waitFor(() => expect(view.identityRef.current).toBeNull());
    single.unmount();
  });

  it("«Deshacer» a tiempo (la ronda vuelve a tener dos documentos) cancela el borrado: el borrador y su id se conservan", async () => {
    __setSessionDeleteGraceForTests(600);
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1500, interval: 25 });
    const [saved] = await listSessionDrafts();
    const identity = view.identityRef.current;

    // Se quita un documento...
    view.update({ files: [files[0]], session: sessionOf([files[0]]) });
    await sleep(300);
    expect(await listSessionDrafts()).toHaveLength(1);
    // ...y se deshace antes de que expire la espera.
    view.update({ files, session: sessionOf(files) });
    await sleep(1200);
    const after = await listSessionDrafts();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(saved.id);
    expect(after[0].documents.map((doc) => doc.fileName)).toEqual(["a.pdf", "b.pdf"]);
    expect(view.identityRef.current).toBe(identity);
    expect((await loadSessionDraft(saved.id))!.files).toHaveLength(2);
    view.unmount();
  });

  it("desmontar durante la ventana del «Deshacer» no borra el borrador de la sesion", async () => {
    __setSessionDeleteGraceForTests(400);
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1500, interval: 25 });
    view.update({ files: [files[0]], session: sessionOf([files[0]]) });
    view.unmount();
    await sleep(1000);
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("con un solo documento y sin sesion guardada no toca la base", async () => {
    const files = [pdf("a.pdf")];
    mount({ files, session: sessionOf(files) });
    await sleep(1000);
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("en «Solo yo» no guarda borrador (como el flujo de un documento)", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    mount({ files, session: sessionOf(files, { mode: "single" }) });
    await sleep(1000);
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("una sesion de mas de 150 MB no se guarda y avisa; al bajar del tope vuelve a guardarse y quita el aviso", async () => {
    const big = pdf("grande.pdf");
    Object.defineProperty(big, "size", { value: 151 * MB });
    const small = pdf("pequeno.pdf");
    const onTooBig = vi.fn();
    const view = mount({ files: [big, small], session: sessionOf([big, small]), onTooBig });
    await waitFor(() => expect(onTooBig).toHaveBeenCalledWith(true), { timeout: 3000, interval: 100 });
    expect(await listSessionDrafts()).toEqual([]);

    const other = pdf("otro.pdf");
    view.update({ files: [small, other], session: sessionOf([small, other]) });
    await waitFor(() => expect(onTooBig).toHaveBeenLastCalledWith(false), { timeout: 3000, interval: 100 });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 100 });
  });

  it("no guarda los huecos de un firmante quitado", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({
      files,
      session: sessionOf(files, {}, { fields: [slot("sg-1"), slot("sg-fantasma")] }),
    });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1000, interval: 25 });
    const [meta] = await listSessionDrafts();
    const ids = Object.values(meta.docStates).flatMap((state) => state.fields.map((field) => field.signerId));
    expect(ids).toEqual(["sg-1", "sg-1"]);
  });

  it("un cambio cualquiera entre medias no pierde el borrado pendiente (se vuelve a pedir)", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1000, interval: 25 });
    const empty = sessionOf(files, { signers: [] });
    const again = mount({ files, session: empty, identityRef: view.identityRef });
    // Un cambio no relacionado (otro paso) repite el efecto antes de que dispare el borrado.
    again.update({ files, session: { ...empty, step: "document" } });
    again.update({ files, session: { ...empty, step: "sign" } });
    await waitFor(async () => expect(await listSessionDrafts()).toEqual([]), { timeout: 3000, interval: 100 });
  });

  it("al guardar la sesion retira el borrador v1 de un documento que ESTA pestana habia guardado", async () => {
    const files = [pdf("a.pdf", 11), pdf("b.pdf", 12)];
    await saveDraft({
      id: "huella-a",
      fileBytes: new Uint8Array([1]),
      fileName: "a.pdf",
      manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
    // Otro borrador v1, de otra ronda, que esta pestana NO guardo: se respeta.
    await saveDraft({
      id: "huella-ajena",
      fileBytes: new Uint8Array([2]),
      fileName: "ajeno.pdf",
      manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
    expect(wasDraftSavedHere("huella-a")).toBe(true);
    const ids = files.map(docIdOf);
    const session = sessionOf(files);
    session.docs[ids[0]] = { ...session.docs[ids[0]], sealedKey: "huella-a" };
    const view = mount({ files, session });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1000, interval: 25 });
    await waitFor(async () => expect((await listDrafts()).map((d) => d.id)).toEqual(["huella-ajena"]), {
      timeout: 1000,
      interval: 25,
    });
    expect(wasDraftSavedHere("huella-a")).toBe(false);
  });

  it("no retira un borrador v1 con la misma huella que esta pestana no guardo", async () => {
    const files = [pdf("a.pdf", 21), pdf("b.pdf", 22)];
    await saveDraft({
      id: "huella-vieja",
      fileBytes: new Uint8Array([1]),
      fileName: "a.pdf",
      manifest: { mode: "multi", signers: [], fields: [], textFields: [], textValues: {} },
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
    // Simula otra pestana: aqui no se guardo (limpiar la lista local sin tocar la base).
    await clearAllDraftsMarkOnly();
    const ids = files.map(docIdOf);
    const session = sessionOf(files);
    session.docs[ids[0]] = { ...session.docs[ids[0]], sealedKey: "huella-vieja" };
    const view = mount({ files, session });
    view.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1000, interval: 25 });
    await sleep(100);
    expect((await listDrafts()).map((d) => d.id)).toEqual(["huella-vieja"]);
  });

  it("pagehide vuelca de inmediato (recargar a los 100 ms no pierde lo ultimo)", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    mount({ files, session: sessionOf(files) });
    await sleep(100);
    expect(await listSessionDrafts()).toEqual([]);
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 500, interval: 25 });
  });

  it("visibilitychange a hidden vuelca de inmediato; a visible no", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    mount({ files, session: sessionOf(files) });
    const setVisibility = (value: "hidden" | "visible") =>
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
    try {
      setVisibility("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      await sleep(150);
      expect(await listSessionDrafts()).toEqual([]);
      setVisibility("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 500, interval: 25 });
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });

  it("el volcado al ocultarse respeta la generacion: un estado superado no se escribe", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    // El estado pasa a «sin progreso» (superando al guardado pendiente) y la pagina se oculta.
    view.update({ files, session: sessionOf(files, { signers: [] }) });
    window.dispatchEvent(new Event("pagehide"));
    await sleep(500);
    expect(await listSessionDrafts()).toEqual([]);
  });

  it("tras volcar no se vuelve a volcar al desmontar ni al repetir pagehide (una sola escritura)", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const view = mount({ files, session: sessionOf(files) });
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 500, interval: 25 });
    view.unmount();
    window.dispatchEvent(new Event("pagehide"));
    await sleep(150);
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("con la conexion ya abierta, pagehide CREA la transaccion de escritura en la misma pasada del evento (sin esperar nada)", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    const first = mount({ files, session: sessionOf(files) });
    first.unmount();
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1500, interval: 25 });
    await warmDraftsConnection();
    const again = mount({
      files,
      session: sessionOf(files, { step: "document" }),
      identityRef: first.identityRef,
    });
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction");
    spy.mockClear();
    window.dispatchEvent(new Event("pagehide"));
    // Sincrono: el navegador aun no ha descargado nada y la escritura ya esta lanzada.
    expect(spy).toHaveBeenCalledWith(expect.anything(), "readwrite");
    spy.mockRestore();
    await waitFor(async () => expect((await listSessionDrafts())[0]?.step).toBe("document"), { timeout: 1000, interval: 25 });
    again.unmount();
  });

  it("el debounce de la sesion es corto (<= 400 ms) y lo editado aterriza antes de 700 ms", async () => {
    expect(SESSION_SAVE_DEBOUNCE_MS).toBeLessThanOrEqual(400);
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    mount({ files, session: sessionOf(files) });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 700, interval: 25 });
  });

  it("al montar con varios documentos abre la conexion de vida larga", async () => {
    __closeWarmDraftsConnectionForTests();
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    mount({ files, session: sessionOf(files, { signers: [] }) });
    await waitFor(() => expect(__hasWarmDraftsConnectionForTests()).toBe(true), { timeout: 1000, interval: 25 });
  });

  it("beforeunload vuelca de inmediato (es el evento cuya escritura a IndexedDB sobrevive a una recarga)", async () => {
    const files = [pdf("a.pdf"), pdf("b.pdf")];
    mount({ files, session: sessionOf(files) });
    await sleep(60);
    expect(await listSessionDrafts()).toEqual([]);
    window.dispatchEvent(new Event("beforeunload"));
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 500, interval: 25 });
  });

  it("una vez volcado, ya no queda ningun oyente de beforeunload puesto (no estorba al bfcache)", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      const files = [pdf("a.pdf"), pdf("b.pdf")];
      mount({ files, session: sessionOf(files) });
      const added = add.mock.calls.filter(([type]) => type === "beforeunload").length;
      expect(added).toBeGreaterThan(0);
      await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 1500, interval: 25 });
      const removedCount = remove.mock.calls.filter(([type]) => type === "beforeunload").length;
      expect(removedCount).toBe(added);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });
});

describe("firmas en el borrador (F0 · U0.4)", () => {
  const STROKE = { dataUrl: "data:image/png;base64,TRAZO-SECRETO", ratio: 0.3 };

  /** Una sesion con la firma de Ana ya recogida en un bloque que cubre los dos documentos. */
  function signedSession(files: File[]): SignSession {
    const ids = files.map(docIdOf);
    const block: SignerBlock = {
      id: "bk-1",
      signerId: "sg-1",
      appliesTo: ids,
      signature: STROKE,
      initials: null,
      stamps: Object.fromEntries(ids.map((id) => [id, `huella-${id}`])),
      auto: true,
    };
    return sessionOf(files, { blocks: [block], step: "sign" });
  }

  beforeEach(() => {
    window.localStorage.removeItem(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY);
    __resetSignPdfFeatureFlagsCacheForTests();
  });

  it("con el ajuste encendido (por defecto) la firma recogida viaja en el borrador, con su fecha de caducidad", async () => {
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    mount({ files, session: signedSession(files) });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 50 });
    const [meta] = await listSessionDrafts();
    expect(meta.blocks[0].signature).toEqual(STROKE);
    expect(typeof meta.expiresAt).toBe("string");
    expect(meta.signaturesOmitted).toBeUndefined();
  });

  it("con el ajuste apagado el resto de la sesion se guarda y NINGUN trazo llega a IndexedDB", async () => {
    setSignPdfFeatureFlag("signaturesInDraft", false);
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    mount({ files, session: signedSession(files) });
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 50 });
    const [meta] = await listSessionDrafts();
    expect(JSON.stringify(meta)).not.toContain("TRAZO-SECRETO");
    expect(meta.blocks[0]).toMatchObject({ signerId: "sg-1", signature: null, initials: null, stamps: {} });
    expect(meta.signers.map((signer) => signer.name)).toEqual(["Ana"]);
    expect(meta.documents.map((doc) => doc.fileName)).toEqual(["a.pdf", "b.pdf"]);
    expect(meta.signaturesOmitted).toBe(true);
    expect(meta.expiresAt).toBeUndefined();
  });

  it("apagar el ajuste con la sesion en pantalla vuelve a guardar al instante y quita de la base las firmas ya guardadas", async () => {
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    mount({ files, session: signedSession(files) });
    await waitFor(async () => expect((await listSessionDrafts())[0]?.blocks[0].signature).toEqual(STROKE), {
      timeout: 3000,
      interval: 50,
    });
    act(() => setSignPdfFeatureFlag("signaturesInDraft", false));
    await waitFor(async () => expect((await listSessionDrafts())[0]?.blocks[0].signature).toBeNull(), {
      timeout: 3000,
      interval: 50,
    });
    // Y al reves: volver a encenderlo guarda de nuevo las firmas que siguen en pantalla.
    act(() => setSignPdfFeatureFlag("signaturesInDraft", true));
    await waitFor(async () => expect((await listSessionDrafts())[0]?.blocks[0].signature).toEqual(STROKE), {
      timeout: 3000,
      interval: 50,
    });
  });

  it("abrir la MISMA sesion en otra pestaña y no tocar nada NO reescribe el borrador (F0-fix2, N3); la primera edicion real si", async () => {
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const tabA = __createTabForTests("t-aaaa");
    const tabB = __createTabForTests("t-bbbb");
    const original = __useTabForTests(tabA);
    // Los bloques ya existen (con sus ids), como en una sesion restaurada: `ensureBlocks` no inventa ids nuevos.
    const blocks: SignerBlock[] = [
      { id: "bk-1", signerId: "sg-1", appliesTo: files.map(docIdOf), signature: null, initials: null, stamps: {}, auto: true },
    ];
    const live = (over: Partial<SignSession> = {}) => sessionOf(files, { blocks, ...over });
    try {
      const first = mount({ files, session: live() });
      await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1), { timeout: 3000, interval: 50 });
      const [saved] = await listSessionDrafts();
      expect(saved.rev).toBe(1);
      const identity = first.identityRef.current!;

      // Otra pestaña abre esa sesion: la carga y monta el autoguardado con lo restaurado.
      __useTabForTests(tabB);
      expect(await loadSessionDraft(saved.id)).not.toBeNull();
      const restoredIdentity: SessionIdentity = { id: identity.id, stored: new Map(identity.stored), saved: true };
      const second = mount({ files, session: live(), identityRef: { current: restoredIdentity } });
      await sleep(SESSION_SAVE_DEBOUNCE_MS + 700);
      await waitFor(() => expect(hasPendingDraftWrite()).toBe(false), { timeout: 3000, interval: 50 });
      const [untouched] = await listSessionDrafts();
      expect(untouched.rev).toBe(1);
      expect(untouched.writerId).toBe("t-aaaa");
      expect(untouched.savedAt).toBe(saved.savedAt);

      // La pestaña A, que ya estaba abierta, hace un cambio real: se guarda sin «Copia aparte».
      __useTabForTests(tabA);
      first.update({ files, session: live({ step: "document" }) });
      await waitFor(async () => expect((await listSessionDrafts())[0]?.rev).toBe(2), { timeout: 3000, interval: 50 });
      expect(await listSessionDrafts()).toHaveLength(1);

      // La primera edicion REAL de la pestaña B: va por detras de la rev 2 que no conocia, asi que se guarda aparte (D1), no se pisa.
      __useTabForTests(tabB);
      second.update({ files, session: live({ step: "sign" }) });
      await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(2), { timeout: 3000, interval: 50 });
      second.unmount();
      first.unmount();
    } finally {
      __useTabForTests(original);
    }
  });
});
