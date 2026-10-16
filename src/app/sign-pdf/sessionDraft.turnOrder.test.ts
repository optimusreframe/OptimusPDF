import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { groupsMatrix } from "@/app/sign-pdf/assignment";
import { EMPTY_DOC_STATE, docIdOf } from "@/app/sign-pdf/docSet";
import { createSessionIdentity, restoreSession, snapshotSession } from "@/app/sign-pdf/sessionDraft";
import { buildSessionMeta, clearAllDrafts, loadSessionDraft, saveSessionDraft, type SessionDraftMeta } from "@/app/sign-pdf/signDrafts";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import type { Signer } from "@/lib/pdf/sign";

/*
 * Orden de los turnos (U1.3) en los borradores de sesion: se guarda, se restaura, lo raro se descarta y los borradores
 * ANTERIORES (sin orden) y los de «Mismas/Distintas» siguen restaurandose, con la tabla equivalente.
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const pdf = (name: string, tag: string) => new File([new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n%%EOF\n`)], name, { type: "application/pdf" });
const read = (file: File) => file.arrayBuffer().then((buffer) => new Uint8Array(buffer));

function live(turnOrder?: string[] | null) {
  const files = [pdf("A.pdf", "t1"), pdf("B.pdf", "t2")];
  const ids = files.map(docIdOf);
  const session: SignSession = {
    ...DEFAULT_SESSION,
    mode: "multi",
    signers: [ANA, LUIS],
    docs: Object.fromEntries(ids.map((id) => [id, { ...EMPTY_DOC_STATE, sealedKey: `k-${id}` }])),
    docOrder: ids,
    activeDocId: ids[0],
    step: "sign",
    turnOrder,
  };
  return { files, ids, session };
}

const toMeta = (session: SignSession, files: File[], id = "s-turn") => {
  const params = snapshotSession({ identity: createSessionIdentity(), session, files, getBytes: read });
  return JSON.parse(JSON.stringify(buildSessionMeta({ ...params, id }))) as SessionDraftMeta;
};

beforeEach(async () => {
  await clearAllDrafts();
});

describe("turnOrder en el borrador de sesion", () => {
  it("se guarda el orden elegido y se restaura tal cual", () => {
    const { files, session } = live(["sg-2", "sg-1"]);
    const meta = toMeta(session, files);
    expect(meta.turnOrder).toEqual(["sg-2", "sg-1"]);
    const restored = restoreSession(meta, files, ["k1", "k2"]);
    expect(restored.patch.turnOrder).toEqual(["sg-2", "sg-1"]);
  });

  it("pasa por IndexedDB (guardar y volver a cargar)", async () => {
    const { files, session } = live(["sg-2", "sg-1"]);
    const params = snapshotSession({ identity: createSessionIdentity(), session, files, getBytes: read });
    expect((await saveSessionDraft({ ...params, id: "s-idb" })).ok).toBe(true);
    const loaded = await loadSessionDraft("s-idb");
    expect(loaded?.meta.turnOrder).toEqual(["sg-2", "sg-1"]);
  });

  it("sin orden elegido (null, ausente o vacio) no se escribe nada: el borrador tiene la forma de siempre", () => {
    for (const order of [undefined, null, []] as const) {
      const { files, session } = live(order as string[] | null | undefined);
      expect("turnOrder" in toMeta(session, files)).toBe(false);
    }
  });

  it("un firmante que ya no esta en la sesion se quita del orden al guardar, y lo raro al leer se descarta", () => {
    const { files, session } = live(["sg-9", "sg-2", "sg-2"]);
    const meta = toMeta(session, files);
    expect(meta.turnOrder).toEqual(["sg-2"]);
    (meta as unknown as Record<string, unknown>).turnOrder = ["sg-1", 7, null, "fantasma", "sg-1"];
    expect(restoreSession(meta, files, ["k1", "k2"]).patch.turnOrder).toEqual(["sg-1"]);
    (meta as unknown as Record<string, unknown>).turnOrder = "sg-1";
    expect(restoreSession(meta, files, ["k1", "k2"]).patch.turnOrder).toBeUndefined();
    (meta as unknown as Record<string, unknown>).turnOrder = ["fantasma"];
    expect("turnOrder" in restoreSession(meta, files, ["k1", "k2"]).patch).toBe(false);
  });

  it("un borrador anterior (sin orden) se restaura sin `turnOrder`", () => {
    const { files, session } = live();
    const meta = toMeta(session, files);
    expect("turnOrder" in restoreSession(meta, files, ["k1", "k2"]).patch).toBe(false);
  });
});

describe("borradores «Mismas / Distintas» anteriores: la tabla equivalente", () => {
  const golden = (name: string) => JSON.parse(readFileSync(path.resolve(__dirname, "__fixtures__", name), "utf8")) as SessionDraftMeta;

  it("«Mismas» (3 documentos) -> todo «Firma A» para cada firmante", () => {
    const meta = golden("sessionDraft.same-3docs.json");
    const files = ["Contrato.pdf", "Anexo.pdf", "Carta.pdf"].map((n, i) => pdf(n, `m${i}`));
    const restored = restoreSession(meta, files, ["k-contrato", "k-anexo", "k-carta"]);
    const matrix = groupsMatrix(restored.patch.blocks ?? [], files.map(docIdOf), meta.signers);
    for (const column of matrix.signerIds.keys()) {
      expect(matrix.cells.map((row) => row[column])).toEqual(["A", "A", "A"]);
    }
    expect(restored.patch.signMode).toBe(meta.signMode);
  });

  it("«Distintas» (4 documentos) -> la tabla del caso del usuario y el modo guardado", () => {
    const meta = golden("sessionDraft.ab-4docs.json");
    const files = ["Doc1.pdf", "Doc2.pdf", "Doc3.pdf", "Doc4.pdf"].map((n, i) => pdf(n, `d${i}`));
    const restored = restoreSession(meta, files, ["k1", "k2", "k3", "k4"]);
    const matrix = groupsMatrix(restored.patch.blocks ?? [], files.map(docIdOf), meta.signers);
    expect(matrix.cells).toEqual([["A", "A"], ["A", "A"], ["B", "A"], ["B", "A"]]);
    expect(restored.patch.signMode).toBe(meta.signMode);
    expect("turnOrder" in restored.patch).toBe(false);
  });
});
