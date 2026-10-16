import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { captureStamp } from "@/app/sign-pdf/captures";
import { blocksFromMatrix, groupsMatrix, matrixEqual, type AssignmentMatrix } from "@/app/sign-pdf/assignment";
import {
  EMPTY_DOC_STATE,
  docIdOf,
  setDocCopies,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { createSessionIdentity, restoreSession, snapshotSession } from "@/app/sign-pdf/sessionDraft";
import {
  buildSessionMeta,
  clearAllDrafts,
  isSessionDraftMeta,
  loadSessionDraft,
  saveSessionDraft,
  type SessionDraftMeta,
} from "@/app/sign-pdf/signDrafts";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { normalizeRestoredPatch } from "@/app/sign-pdf/__fixtures__/goldenNormalize";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/*
 * Copias y tabla de asignacion en los borradores de sesion (U1.1):
 *  - los borradores ANTERIORES (archivos «dorados» generados con el codigo de antes de U1.1, en `__fixtures__/`) se siguen
 *    restaurando EXACTAMENTE igual y sin `copies`;
 *  - `copies` se guarda y se restaura (solo cuando vale mas de 1) y lo raro se lleva a 1..5;
 *  - los bloques canonicos de una tabla A,A,B,B sobreviven al guardado.
 */

const FIXTURES = path.resolve(__dirname, "__fixtures__");
const golden = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const SIG = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };

function pdf(name: string, tag: string): File {
  return new File([new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n%%EOF\n`)], name, { type: "application/pdf" });
}

function slot(id: string, signerId: string): SignatureField {
  return { id, signerId, pageIndex: 0, type: "signature", rect: { x: 0.1, y: 0.7, width: 0.3, height: 0.08 } };
}

/** Los archivos y las huellas con los que se generaron los dorados (los sellos dependen de ellas). */
const GOLDEN_FILES = {
  "sessionDraft.same-3docs": { names: ["Contrato.pdf", "Anexo.pdf", "Carta.pdf"], keys: ["k-contrato", "k-anexo", "k-carta"] },
  "sessionDraft.ab-4docs": { names: ["Doc1.pdf", "Doc2.pdf", "Doc3.pdf", "Doc4.pdf"], keys: ["k1", "k2", "k3", "k4"] },
  "sessionDraft.legacy-captures": { names: ["Viejo.pdf"], keys: ["k-viejo"] },
} as const;

describe("borradores anteriores a U1.1 (dorados): se restauran igual y sin copias", () => {
  for (const [name, { names, keys }] of Object.entries(GOLDEN_FILES)) {
    it(`${name}.json -> restoreSession da exactamente lo que daba antes`, () => {
      const meta = golden(`${name}.json`) as SessionDraftMeta;
      expect(isSessionDraftMeta(meta)).toBe(true);
      const files = names.map((n, i) => pdf(n, `g${i}`));
      const restored = restoreSession(meta, files, keys);
      const liveIds = files.map(docIdOf);
      // Los borradores sin `blocks` (anteriores al modelo de bloques) acunan ids `bk-N` con un contador de modulo: su
      // numero depende de cuantos se hayan acunado antes en el proceso, asi que solo se compara que lo sean.
      const mask = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/"bk-\d+"/g, '"bk-*"')) as unknown;
      const expected = golden(`${name}.restored.json`);
      const actual = normalizeRestoredPatch(restored.patch, liveIds);
      expect(name.includes("legacy") ? mask(actual) : actual).toEqual(name.includes("legacy") ? mask(expected) : expected);
      for (const state of Object.values(restored.patch.docs ?? {})) {
        expect("copies" in state).toBe(false);
      }
      expect(restored.normalized).toBe(0);
      expect(restored.staleDocs).toBe(0);
    });
  }

  it("volver a guardar lo restaurado no introduce `copies` en ningun documento (ida y vuelta identica)", () => {
    const meta = golden("sessionDraft.ab-4docs.json") as SessionDraftMeta;
    const files = GOLDEN_FILES["sessionDraft.ab-4docs"].names.map((n, i) => pdf(n, `h${i}`));
    const restored = restoreSession(meta, files, [...GOLDEN_FILES["sessionDraft.ab-4docs"].keys]);
    const session: SignSession = { ...DEFAULT_SESSION, ...restored.patch } as SignSession;
    const params = snapshotSession({
      identity: restored.identity,
      session,
      files,
      getBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
    });
    const again = buildSessionMeta({ ...params, id: meta.id }, meta.savedAt);
    expect(again.docStates).toEqual(meta.docStates);
    expect(again.blocks).toEqual(meta.blocks);
    expect(again.signMode).toBe(meta.signMode);
  });

  it("el dorado «distintas» es el caso del usuario: Ana A,A,B,B (2 trazos) y Luis una firma; la tabla sale directa", () => {
    const meta = golden("sessionDraft.ab-4docs.json") as SessionDraftMeta;
    const files = GOLDEN_FILES["sessionDraft.ab-4docs"].names.map((n, i) => pdf(n, `i${i}`));
    const restored = restoreSession(meta, files, [...GOLDEN_FILES["sessionDraft.ab-4docs"].keys]);
    const liveIds = files.map(docIdOf);
    const matrix = groupsMatrix(restored.patch.blocks ?? [], liveIds, [ANA, LUIS]);
    expect(matrix.cells).toEqual([["A", "A"], ["A", "A"], ["B", "A"], ["B", "A"]]);
    const blocks = restored.patch.blocks ?? [];
    expect(blocks.filter((b) => b.signerId === "sg-1").map((b) => b.signature?.dataUrl)).toEqual([
      "data:image/png;base64,AAAA",
      "data:image/png;base64,BBBB",
    ]);
  });
});

/** Una sesion viva de 4 documentos con copias y bloques A,A,B,B para Ana. */
function liveSession(copies: number[]) {
  const files = ["Doc1.pdf", "Doc2.pdf", "Doc3.pdf", "Doc4.pdf"].map((n, i) => pdf(n, `c${i}`));
  const ids = files.map(docIdOf);
  const keys = ["k1", "k2", "k3", "k4"];
  const fields = ids.map((_, i) => [slot(`f${i}`, "sg-1")]);
  let docs: Record<string, DocState> = Object.fromEntries(
    ids.map((id, i) => [id, { ...EMPTY_DOC_STATE, sealedKey: keys[i], fields: fields[i] }]),
  );
  copies.forEach((n, i) => {
    docs = setDocCopies(docs, ids[i], n);
  });
  const matrix: AssignmentMatrix = { docIds: ids, signerIds: ["sg-1"], cells: [["A"], ["A"], ["B"], ["B"]] };
  const blocks: SignerBlock[] = blocksFromMatrix(matrix, [ANA], { mint: (() => { let n = 0; return () => `bk-${(n += 1)}`; })() }).map((b) => ({
    ...b,
    signature: SIG,
    stamps: Object.fromEntries(b.appliesTo.map((id) => [id, captureStamp(keys[ids.indexOf(id)], fields[ids.indexOf(id)], "sg-1")])),
  }));
  const session: SignSession = {
    ...DEFAULT_SESSION, mode: "multi", signers: [ANA], signMode: "independent", blocks, docs,
    docOrder: ids, activeDocId: ids[0], step: "sign",
  };
  return { files, ids, keys, session, matrix };
}

async function roundTrip(session: SignSession, files: File[], keys: string[]) {
  const params = snapshotSession({
    identity: createSessionIdentity(),
    session,
    files,
    getBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
  });
  // Pasa por JSON como lo haria IndexedDB: nada de funciones ni referencias compartidas.
  const meta = JSON.parse(JSON.stringify(buildSessionMeta({ ...params, id: "s-copies-1" }))) as SessionDraftMeta;
  return { meta, restored: restoreSession(meta, files, keys) };
}

describe("copies en el borrador de sesion", () => {
  it("se guardan solo las que valen mas de 1 y se restauran en SU documento", async () => {
    const { files, ids, keys, session } = liveSession([2, 1, 5, 1]);
    const { meta, restored } = await roundTrip(session, files, keys);
    // En el borrador: solo los documentos con copias la llevan.
    expect(Object.values(meta.docStates).map((state) => state.copies)).toEqual([2, undefined, 5, undefined]);
    // Y se restauran en el mismo documento (por posicion, los ids vivos son otros).
    const docs = restored.patch.docs ?? {};
    expect(ids.map((id) => docs[id]?.copies)).toEqual([2, undefined, 5, undefined]);
    expect("copies" in docs[ids[1]]).toBe(false);
  });

  it("la tabla A,A,B,B (los bloques canonicos) sobrevive al guardado: misma tabla y mismos trazos", async () => {
    const { files, ids, keys, session, matrix } = liveSession([2, 2, 2, 2]);
    const { restored } = await roundTrip(session, files, keys);
    const back = groupsMatrix(restored.patch.blocks ?? [], ids, [ANA]);
    expect(matrixEqual(back, matrix)).toBe(true);
    expect((restored.patch.blocks ?? []).map((b) => b.signature)).toEqual([SIG, SIG]);
    expect((restored.patch.blocks ?? []).map((b) => Object.keys(b.stamps).length)).toEqual([2, 2]);
  });

  it("lo manipulado se lleva a 1..5: 99 -> 5, 2.7 -> 2, y 0, -3, 'x', null, NaN se descartan (= 1)", () => {
    const { files, ids, keys, session } = liveSession([1, 1, 1, 1]);
    const params = snapshotSession({
      identity: createSessionIdentity(),
      session,
      files,
      getBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
    });
    const meta = JSON.parse(JSON.stringify(buildSessionMeta({ ...params, id: "s-bad" }))) as SessionDraftMeta;
    const stored = meta.documents.map((d) => d.id);
    const tampered: unknown[] = [99, 2.7, -3, "x"];
    stored.forEach((id, i) => {
      (meta.docStates[id] as unknown as Record<string, unknown>).copies = tampered[i];
    });
    const docs = restoreSession(meta, files, keys).patch.docs ?? {};
    expect(ids.map((id) => docs[id].copies)).toEqual([5, 2, undefined, undefined]);

    const zero: unknown[] = [0, null, Number.NaN, 1];
    stored.forEach((id, i) => {
      (meta.docStates[id] as unknown as Record<string, unknown>).copies = zero[i];
    });
    const docs2 = restoreSession(meta, files, keys).patch.docs ?? {};
    for (const id of ids) expect("copies" in docs2[id]).toBe(false);
  });

  it("las copias sobreviven aunque el documento haya CAMBIADO (huella distinta): no son contenido, son una eleccion de entrega", async () => {
    const { files, ids, session } = liveSession([3, 1, 1, 1]);
    const { meta } = await roundTrip(session, files, ["k1", "k2", "k3", "k4"]);
    const restored = restoreSession(meta, files, ["otra", "k2", "k3", "k4"]);
    expect(restored.staleDocs).toBe(1);
    expect(restored.patch.docs?.[ids[0]].copies).toBe(3);
  });

  it("de ida y vuelta por IndexedDB (saveSessionDraft / loadSessionDraft)", async () => {
    await clearAllDrafts();
    const { files, ids, keys, session } = liveSession([4, 1, 2, 1]);
    const params = snapshotSession({
      identity: createSessionIdentity(),
      session,
      files,
      getBytes: async (file) => new Uint8Array(await file.arrayBuffer()),
    });
    const saved = await saveSessionDraft({ ...params, id: "s-idb-copies" });
    expect(saved.ok).toBe(true);
    const loaded = await loadSessionDraft("s-idb-copies");
    expect(loaded).not.toBeNull();
    const restored = restoreSession(loaded!.meta, files, keys);
    expect(ids.map((id) => restored.patch.docs?.[id].copies)).toEqual([4, undefined, 2, undefined]);
  });
});

beforeEach(async () => {
  await clearAllDrafts();
});

describe("un borrador de otro firmante en la misma tabla", () => {
  it("dos firmantes: LUIS con una sola firma para todos y ANA A,A,B,B, restaurados, dan la tabla del plan", async () => {
    const { files, ids, keys, session } = liveSession([1, 1, 1, 1]);
    const luisBlock: SignerBlock = { id: "bk-9", signerId: "sg-2", appliesTo: ids, signature: null, initials: null, stamps: {}, auto: true };
    const two: SignSession = { ...session, signers: [ANA, LUIS], blocks: [...session.blocks, luisBlock] };
    const { restored } = await roundTrip(two, files, keys);
    const matrix = groupsMatrix(restored.patch.blocks ?? [], ids, [ANA, LUIS]);
    expect(matrix.cells).toEqual([["A", "A"], ["A", "A"], ["B", "A"], ["B", "A"]]);
  });
});
