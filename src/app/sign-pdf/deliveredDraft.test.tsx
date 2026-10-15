import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DOC_STATE, docIdOf } from "@/app/sign-pdf/docSet";
import { __resetDraftActivityForTests, beginDraftWrite } from "@/app/sign-pdf/draftActivity";
import { HASH, SESSION_ID, seedDocument, seedSession } from "@/app/sign-pdf/draftTestUtils";
import { deleteDeliveredDraft, deliveredDraftOf } from "@/app/sign-pdf/deliveredDraft";
import { clearAllDrafts, deleteSessionDraft, draftExists, listAllDrafts } from "@/app/sign-pdf/signDrafts";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { markDecryptedCopy } from "@/lib/pdf/inputGuard";

/** Que borrador corresponde a la ronda entregada y como se borra (F0 · U0.4). */

vi.mock("@/app/sign-pdf/signDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signDrafts")>();
  return { ...actual, deleteSessionDraft: vi.fn(actual.deleteSessionDraft) };
});

const ANA = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const pdf = (name: string, byte: number) => new File([new Uint8Array([37, 80, 68, 70, byte])], name, { type: "application/pdf" });

function sessionOf(files: File[], overrides: Partial<SignSession> = {}, sealed: string | null = null): SignSession {
  const ids = files.map(docIdOf);
  return {
    ...DEFAULT_SESSION,
    mode: "multi",
    signers: [ANA],
    docOrder: ids,
    activeDocId: ids[0] ?? null,
    docs: Object.fromEntries(ids.map((id) => [id, { ...EMPTY_DOC_STATE, sealedKey: sealed ?? "" }])),
    ...overrides,
  };
}

beforeEach(async () => {
  __resetDraftActivityForTests();
  await clearAllDrafts();
  vi.mocked(deleteSessionDraft).mockClear();
});

describe("deliveredDraftOf", () => {
  const two = [pdf("a.pdf", 1), pdf("b.pdf", 2)];
  const one = [pdf("solo.pdf", 3)];
  const base = { tooBig: false, partial: false };

  it("varios documentos: el borrador de SESION, por el id de la identidad guardada", () => {
    expect(deliveredDraftOf({ ...base, files: two, session: sessionOf(two), sessionId: SESSION_ID("a") })).toEqual({
      kind: "session",
      id: SESSION_ID("a"),
    });
  });

  it("varios documentos sin identidad guardada: nada que borrar", () => {
    expect(deliveredDraftOf({ ...base, files: two, session: sessionOf(two), sessionId: null })).toBeNull();
  });

  it("un documento: el borrador del DOCUMENTO, por su huella", () => {
    expect(deliveredDraftOf({ ...base, files: one, session: sessionOf(one, {}, HASH("c")), sessionId: null })).toEqual({
      kind: "document",
      id: HASH("c"),
    });
  });

  it("un documento cuya huella aun no llego: nada que borrar", () => {
    expect(deliveredDraftOf({ ...base, files: one, session: sessionOf(one), sessionId: null })).toBeNull();
  });

  it("«Solo yo» no guarda borrador: nada que borrar", () => {
    expect(deliveredDraftOf({ ...base, files: two, session: sessionOf(two, { mode: "single" }), sessionId: SESSION_ID("a") })).toBeNull();
    expect(deliveredDraftOf({ ...base, files: one, session: sessionOf(one, { mode: "single" }, HASH("c")), sessionId: null })).toBeNull();
  });

  it("sin progreso (ni firmantes ni nada hecho) no hubo borrador", () => {
    expect(deliveredDraftOf({ ...base, files: two, session: sessionOf(two, { signers: [] }), sessionId: SESSION_ID("a") })).toBeNull();
  });

  it("una ronda demasiado grande para guardarse no tiene borrador que ofrecer borrar", () => {
    expect(deliveredDraftOf({ ...base, tooBig: true, files: two, session: sessionOf(two), sessionId: SESSION_ID("a") })).toBeNull();
  });

  it("con FALLOS PARCIALES no se ofrece borrar: algun documento sigue sin firmar y el borrador es lo unico que lo guarda", () => {
    expect(deliveredDraftOf({ ...base, partial: true, files: two, session: sessionOf(two), sessionId: SESSION_ID("a") })).toBeNull();
  });

  it("una copia abierta con contrasena nunca se guarda, asi que no hay borrador", () => {
    const protectedCopy = pdf("cifrado.pdf", 9);
    markDecryptedCopy(protectedCopy);
    expect(
      deliveredDraftOf({ ...base, files: [protectedCopy], session: sessionOf([protectedCopy], {}, HASH("c")), sessionId: null }),
    ).toBeNull();
  });

  it("sin archivos no hay nada", () => {
    expect(deliveredDraftOf({ ...base, files: [], session: sessionOf([]), sessionId: null })).toBeNull();
  });
});

describe("deleteDeliveredDraft", () => {
  it("borra la sesion con todos sus bytes y confirma que ya no esta", async () => {
    const id = await seedSession();
    expect(await draftExists("session", id)).toBe(true);
    expect(await deleteDeliveredDraft({ kind: "session", id })).toBe(true);
    expect(await draftExists("session", id)).toBe(false);
    expect(await listAllDrafts()).toEqual([]);
  });

  it("borra el borrador de un documento suelto y no toca otros", async () => {
    const mine = await seedDocument({ key: HASH("c") });
    const other = await seedDocument({ key: HASH("d"), name: "Otro.pdf" });
    expect(await deleteDeliveredDraft({ kind: "document", id: mine })).toBe(true);
    expect(await draftExists("document", mine)).toBe(false);
    expect(await draftExists("document", other)).toBe(true);
  });

  it("no toca la sesion de otra ronda", async () => {
    const mine = await seedSession({ id: SESSION_ID("a") });
    const other = await seedSession({ id: SESSION_ID("b"), keys: [HASH("e"), HASH("f")] });
    expect(await deleteDeliveredDraft({ kind: "session", id: mine })).toBe(true);
    expect(await draftExists("session", other)).toBe(true);
  });

  it("si el borrador SIGUE ahi tras intentar borrarlo, dice que no lo logro (no afirma un borrado que no ocurrio)", async () => {
    const id = await seedSession();
    vi.mocked(deleteSessionDraft).mockResolvedValueOnce(undefined);
    expect(await deleteDeliveredDraft({ kind: "session", id })).toBe(false);
    expect(await draftExists("session", id)).toBe(true);
  });

  it("espera a que se asiente el ultimo guardado pendiente antes de borrar (un volcado tardio no lo resucita)", async () => {
    const id = await seedSession();
    const end = beginDraftWrite();
    let finished = false;
    const done = deleteDeliveredDraft({ kind: "session", id }).then((result) => {
      finished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(finished).toBe(false);
    expect(await draftExists("session", id)).toBe(true);
    end();
    expect(await done).toBe(true);
    expect(await draftExists("session", id)).toBe(false);
  });
});
