import "fake-indexeddb/auto";
import { createRef, type MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { SessionDraftAutosave, __setSessionDeleteGraceForTests } from "@/app/sign-pdf/SessionDraftAutosave";
import { EMPTY_DOC_STATE, docIdOf, type DocState } from "@/app/sign-pdf/docSet";
import { __resetDraftActivityForTests } from "@/app/sign-pdf/draftActivity";
import type { DraftWriteReport } from "@/app/sign-pdf/draftWriteReport";
import type { SessionIdentity } from "@/app/sign-pdf/sessionDraft";
import type { SingleDraftIdentity } from "@/app/sign-pdf/singleDraft";
import {
  __closeWarmDraftsConnectionForTests,
  __createTabForTests,
  __useTabForTests,
  clearAllDrafts,
  listDrafts,
  listSessionDrafts,
  loadSessionDraft,
  saveDraft,
  saveSessionDraft,
} from "@/app/sign-pdf/signDrafts";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import type { Signer } from "@/lib/pdf/sign";

/**
 * El autoguardado de la sesion cuenta COMO ACABO cada guardado (F0-fix): un fallo de escritura se dice (D2), una copia aparte
 * porque otra pestana tenia lo nuevo se dice y se sigue sobre ella (D1), y una pestana desactualizada no borra lo de otra.
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const HUELLA = "a".repeat(64);

function pdf(name: string, byte = 1): File {
  return new File([new Uint8Array([37, 80, 68, 70, byte])], name, { type: "application/pdf" });
}

function sessionOf(files: File[], over: Partial<SignSession> = {}): SignSession {
  const ids = files.map(docIdOf);
  return {
    ...DEFAULT_SESSION,
    mode: "multi",
    signers: [ANA],
    docOrder: ids,
    activeDocId: ids[0] ?? null,
    docs: Object.fromEntries(ids.map((id) => [id, { ...EMPTY_DOC_STATE } as DocState])),
    ...over,
  };
}

type Setup = {
  files: File[];
  session: SignSession;
  identityRef?: MutableRefObject<SessionIdentity | null>;
  singleDraftRef?: MutableRefObject<SingleDraftIdentity | null>;
};

function mount(initial: Setup) {
  const identityRef = initial.identityRef ?? (createRef<SessionIdentity | null>() as MutableRefObject<SessionIdentity | null>);
  if (!initial.identityRef) identityRef.current = null;
  const onTooBig = vi.fn();
  const onWrite = vi.fn<(report: DraftWriteReport) => void>();
  const element = (next: Pick<Setup, "files" | "session">) => (
    <SessionDraftAutosave
      files={next.files}
      session={next.session}
      identityRef={identityRef}
      onTooBig={onTooBig}
      onWrite={onWrite}
      singleDraftRef={initial.singleDraftRef}
    />
  );
  const view = render(element(initial));
  return { identityRef, onTooBig, onWrite, update: (next: Pick<Setup, "files" | "session">) => view.rerender(element(next)), unmount: view.unmount };
}

function failPuts(store: string) {
  const original = IDBObjectStore.prototype.put;
  return vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function patched(this: IDBObjectStore, ...args: Parameters<IDBObjectStore["put"]>) {
    if (this.name === store) throw new DOMException("cuota llena (simulada)", "QuotaExceededError");
    return original.apply(this, args);
  });
}

const tabA = __createTabForTests("t-aaaa");
const tabB = __createTabForTests("t-bbbb");
let previousTab = __useTabForTests(tabA);

beforeEach(async () => {
  previousTab = __useTabForTests(tabA);
  __resetDraftActivityForTests();
  __setSessionDeleteGraceForTests(null);
  await clearAllDrafts();
});

afterEach(() => {
  __useTabForTests(previousTab);
  vi.restoreAllMocks();
});

describe("SessionDraftAutosave · como acabo el guardado (D2)", () => {
  it("un guardado correcto se cuenta `saved`", async () => {
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const { onWrite } = mount({ files, session: sessionOf(files) });
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith({ kind: "saved" }), { timeout: 3000, interval: 50 });
  });

  it("con la cuota llena se cuenta `failed` (NO guardado) y el borrador no aparece; el siguiente cambio reintenta y vuelve `saved`", async () => {
    __closeWarmDraftsConnectionForTests();
    const spy = failPuts("sessionMeta");
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const view = mount({ files, session: sessionOf(files) });
    await waitFor(() => expect(view.onWrite).toHaveBeenCalledWith({ kind: "failed" }), { timeout: 3000, interval: 50 });
    expect(view.onWrite).not.toHaveBeenCalledWith({ kind: "saved" });
    expect(await listSessionDrafts()).toEqual([]);
    // Ni «no cabe»: es otro motivo.
    expect(view.onTooBig).not.toHaveBeenCalledWith(true);

    // El navegador vuelve a dejar guardar; el siguiente cambio de la sesion reintenta SOLO.
    spy.mockRestore();
    view.update({ files, session: sessionOf(files, { signers: [ANA, { id: "sg-2", name: "Luis", color: "#0f9d68" }] }) });
    await waitFor(() => expect(view.onWrite).toHaveBeenLastCalledWith({ kind: "saved" }), { timeout: 3000, interval: 50 });
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("con el almacenamiento bloqueado (`indexedDB.open` lanza) tambien se cuenta `failed`", async () => {
    __closeWarmDraftsConnectionForTests();
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("bloqueado (simulado)", "SecurityError");
    });
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const { onWrite } = mount({ files, session: sessionOf(files) });
    await waitFor(() => expect(onWrite).toHaveBeenCalledWith({ kind: "failed" }), { timeout: 5000, interval: 50 });
  });

  it("una sesion que no cabe sigue siendo `tooBig` (su propio aviso), no `failed`", async () => {
    const big = new File([new Uint8Array(1)], "big.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 200 * 1024 * 1024 });
    const small = pdf("small.pdf", 2);
    const files = [big, small];
    const { onWrite, onTooBig } = mount({ files, session: sessionOf(files) });
    await waitFor(() => expect(onTooBig).toHaveBeenCalledWith(true), { timeout: 3000, interval: 50 });
    expect(onWrite).toHaveBeenCalledWith({ kind: "tooBig" });
    expect(onWrite).not.toHaveBeenCalledWith({ kind: "failed" });
  });
});

describe("SessionDraftAutosave · otra pestana tenia una version mas nueva (D1)", () => {
  it("guarda LO SUYO como copia aparte, lo cuenta `forked`, sigue sobre la copia y no toca lo de la otra pestana", async () => {
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const view = mount({ files, session: sessionOf(files) });
    await waitFor(() => expect(view.onWrite).toHaveBeenCalledWith({ kind: "saved" }), { timeout: 3000, interval: 50 });
    const originalId = view.identityRef.current?.id as string;
    expect(originalId).toBeTruthy();

    // La otra pestana retoma la sesion y la modifica.
    __useTabForTests(tabB);
    await loadSessionDraft(originalId);
    const stored = (await listSessionDrafts())[0];
    const ids = stored.documents.map((doc) => doc.id);
    await saveSessionDraft({
      id: originalId,
      mode: "multi",
      signMode: "same",
      signers: [ANA, { id: "sg-9", name: "Maria", color: "#000" }],
      blocks: [],
      documents: ids.map((id) => ({ id, fileName: `${id}.pdf`, size: 1, state: { ...EMPTY_DOC_STATE } as DocState, getBytes: async () => new Uint8Array([1]) })),
      activeDocId: ids[0],
      step: "signers",
    });
    __useTabForTests(tabA);

    // Esta pestana (vieja) hace un cambio trivial.
    view.update({ files, session: sessionOf(files, { activeDocId: docIdOf(files[1]) }) });
    await waitFor(() => expect(view.onWrite).toHaveBeenCalledWith(expect.objectContaining({ kind: "forked" })), { timeout: 3000, interval: 50 });
    const forked = view.onWrite.mock.calls.map(([report]) => report).find((report) => report.kind === "forked") as Extract<DraftWriteReport, { kind: "forked" }>;
    expect(forked.toId).not.toBe(originalId);
    // Desde ahora la identidad apunta a la copia (y se sigue guardando sobre ella).
    expect(view.identityRef.current?.id).toBe(forked.toId);
    const metas = await listSessionDrafts();
    expect(metas.map((meta) => meta.id).sort()).toEqual([originalId, forked.toId].sort());
    expect(metas.find((meta) => meta.id === originalId)?.signers.map((signer) => signer.name)).toEqual(["Ana", "Maria"]);
    expect(metas.find((meta) => meta.id === forked.toId)?.copyOf).toBe(originalId);
    // Y NO vuelve a haber copia por el siguiente cambio.
    view.update({ files, session: sessionOf(files, { activeDocId: docIdOf(files[0]) }) });
    await waitFor(async () => expect((await listSessionDrafts()).find((meta) => meta.id === forked.toId)?.rev).toBe(2), { timeout: 3000, interval: 50 });
    expect(await listSessionDrafts()).toHaveLength(2);
  });

  it("sin progreso, una pestana desactualizada NO borra el borrador de la otra", async () => {
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const view = mount({ files, session: sessionOf(files) });
    await waitFor(() => expect(view.onWrite).toHaveBeenCalledWith({ kind: "saved" }), { timeout: 3000, interval: 50 });
    const id = view.identityRef.current?.id as string;
    // La otra pestana lo actualiza.
    __useTabForTests(tabB);
    await loadSessionDraft(id);
    await saveSessionDraft({
      id,
      mode: "multi",
      signMode: "same",
      signers: [ANA],
      blocks: [],
      documents: [0, 1].map((n) => ({ id: `doc-${n}`, fileName: "x.pdf", size: 1, state: { ...EMPTY_DOC_STATE } as DocState, getBytes: async () => new Uint8Array([1]) })),
      activeDocId: null,
      step: "signers",
    });
    // Ojo: la sesion cambia de forma; da igual, lo que importa es que sea de otra pestana y mas nueva.
    __useTabForTests(tabA);
    // Esta pestana se queda sin firmantes: pediria borrar.
    view.update({ files, session: sessionOf(files, { signers: [] }) });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect((await listSessionDrafts()).map((meta) => meta.id)).toEqual([id]);
  });
});

describe("SessionDraftAutosave · el borrador suelto que la sesion sustituye (D3)", () => {
  async function seedSingle(id: string, fingerprint: string) {
    await saveDraft({
      id,
      fingerprint,
      fileBytes: new Uint8Array([37, 80, 68, 70, 1]),
      fileName: "a.pdf",
      manifest: { mode: "multi", signers: [ANA], fields: [], textFields: [], textValues: {} },
      step: "signers",
      captures: {},
      textFieldsDetectedFor: null,
    });
  }

  it("al guardar la sesion retira SOLO el borrador de esta sesion de trabajo (su id propio), no el de otro cliente con el mismo PDF", async () => {
    const mine = `${HUELLA.slice(0, 32)}${"1".repeat(32)}`;
    const other = `${HUELLA.slice(0, 32)}${"2".repeat(32)}`;
    await seedSingle(mine, HUELLA);
    await seedSingle(other, HUELLA);
    const files = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
    const single = { current: { docId: docIdOf(files[0]), fingerprint: HUELLA, id: mine } as SingleDraftIdentity | null };
    const session = sessionOf(files);
    // El documento 1 lleva la huella del PDF que estaba suelto.
    session.docs[docIdOf(files[0])] = { ...EMPTY_DOC_STATE, sealedKey: HUELLA } as DocState;
    const view = mount({ files, session, singleDraftRef: single });
    await waitFor(() => expect(view.onWrite).toHaveBeenCalledWith({ kind: "saved" }), { timeout: 3000, interval: 50 });
    await waitFor(async () => expect((await listDrafts()).map((meta) => meta.id)).toEqual([other]), { timeout: 3000, interval: 50 });
  });
});
