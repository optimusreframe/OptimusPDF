import { describe, expect, it, vi } from "vitest";
import {
  EMPTY_DOC_STATE,
  docIdOf,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import {
  captureStamp,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/captures";
import {
  createSessionIdentity,
  hasSessionProgress,
  identityFor,
  restoreSession,
  snapshotSession,
  storedIdOf,
} from "@/app/sign-pdf/sessionDraft";
import { buildSessionMeta, type SessionDraftMeta } from "@/app/sign-pdf/signDrafts";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#e5484d" };
const SIG = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };
const INI = { dataUrl: "data:image/png;base64,IIII", ratio: 0.5 };

function file(name: string, size = 4): File {
  return new File([new Uint8Array(size)], name, { type: "application/pdf" });
}

function slot(id: string, signerId: string): SignatureField {
  return {
    id,
    signerId,
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  };
}

function docState(over: Partial<DocState> = {}): DocState {
  return { ...EMPTY_DOC_STATE, ...over };
}

function block(over: Partial<SignerBlock> & Pick<SignerBlock, "id" | "signerId">): SignerBlock {
  return {
    appliesTo: [],
    signature: null,
    initials: null,
    stamps: {},
    auto: true,
    ...over,
  };
}

/** Una sesion viva con dos documentos, un firmante y su bloque con trazos. */
function liveSession() {
  const a = file("a.pdf");
  const b = file("b.pdf");
  const idA = docIdOf(a);
  const idB = docIdOf(b);
  const fieldA = slot("fld-a", "sg-1");
  const stampA = captureStamp("key-a", [fieldA], "sg-1");
  const stampB = captureStamp("key-b", [], "sg-1");
  const session: SignSession = {
    ...DEFAULT_SESSION,
    mode: "multi",
    signers: [ANA],
    docs: {
      [idA]: docState({ fields: [fieldA], sealedKey: "key-a", textValues: { t1: "x" } }),
      [idB]: docState({ sealedKey: "key-b", fieldPageIndex: 3 }),
    },
    docOrder: [idA, idB],
    activeDocId: idB,
    step: "document",
    signMode: "same",
    blocks: [
      block({
        id: "bk-9001",
        signerId: "sg-1",
        appliesTo: [idA, idB],
        signature: SIG,
        initials: INI,
        stamps: { [idA]: stampA, [idB]: stampB },
      }),
    ],
  };
  return { a, b, idA, idB, fieldA, stampA, stampB, session };
}

async function snap(session: SignSession, files: File[], identity = createSessionIdentity()) {
  const params = snapshotSession({
    identity,
    session,
    files,
    getBytes: async (f) => new Uint8Array(await f.arrayBuffer()),
  });
  return { params, identity, meta: buildSessionMeta(params, "2026-01-01T00:00:00.000Z") };
}

describe("hasSessionProgress", () => {
  it("sin firmantes ni huecos ni campos ni valores no hay progreso", () => {
    const a = file("a.pdf");
    expect(hasSessionProgress({ signers: [], docs: {} }, [docIdOf(a)])).toBe(false);
  });

  it("un firmante basta", () => {
    expect(hasSessionProgress({ signers: [ANA], docs: {} }, [])).toBe(true);
  });

  it("un hueco, un campo de texto o un valor en CUALQUIER documento cuenta", () => {
    const a = file("a.pdf");
    const b = file("b.pdf");
    const order = [docIdOf(a), docIdOf(b)];
    expect(
      hasSessionProgress({ signers: [], docs: { [order[1]]: docState({ textValues: { t: "x" } }) } }, order),
    ).toBe(true);
    expect(
      hasSessionProgress(
        {
          signers: [],
          docs: {
            [order[0]]: docState({
              textFields: [
                {
                  id: "txt-1",
                  pageIndex: 0,
                  rect: { x: 0, y: 0, width: 0.1, height: 0.1 },
                  source: "manual",
                  confidence: "high",
                },
              ],
            }),
          },
        },
        order,
      ),
    ).toBe(true);
  });

  it("los huecos de un firmante ya quitado no cuentan (el borrado no resucita)", () => {
    const a = file("a.pdf");
    const id = docIdOf(a);
    expect(
      hasSessionProgress(
        { signers: [], docs: { [id]: docState({ fields: [slot("f", "sg-borrado")] }) } },
        [id],
      ),
    ).toBe(false);
  });
});

describe("identidad de la sesion guardada", () => {
  it("storedIdOf es estable y no repite ids dentro de la sesion", () => {
    const identity = createSessionIdentity();
    expect(storedIdOf(identity, "doc-5")).toBe("doc-5");
    expect(storedIdOf(identity, "doc-5")).toBe("doc-5");
    identity.stored.set("doc-1", "doc-9");
    // Un documento nuevo cuyo id vivo coincide con uno YA guardado por otro: se desambigua.
    expect(storedIdOf(identity, "doc-9")).toBe("doc-9-2");
  });

  it("los ids de sesion son distintos entre si", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createSessionIdentity().id));
    expect(ids.size).toBe(50);
  });

  it("identityFor conserva la identidad mientras algun documento siga siendo de la sesion", () => {
    const identity = createSessionIdentity();
    identity.stored.set("doc-1", "doc-1");
    expect(identityFor(identity, ["doc-1", "doc-7"])).toBe(identity);
  });

  it("identityFor da una identidad NUEVA a una ronda con otros archivos: nunca pisa el borrador de la anterior", () => {
    const identity = createSessionIdentity();
    identity.stored.set("doc-1", "doc-1");
    const next = identityFor(identity, ["doc-50", "doc-51"]);
    expect(next).not.toBe(identity);
    expect(next.id).not.toBe(identity.id);
  });

  it("identityFor crea una cuando no hay ninguna", () => {
    expect(identityFor(null, ["doc-1"]).saved).toBe(false);
  });
});

describe("snapshotSession", () => {
  it("guarda los documentos en orden con su estado, el activo y el paso", async () => {
    const { a, b, session } = liveSession();
    const { params } = await snap(session, [a, b]);
    expect(params.documents.map((doc) => doc.fileName)).toEqual(["a.pdf", "b.pdf"]);
    expect(params.documents[0].state.textValues).toEqual({ t1: "x" });
    expect(params.documents[1].state.fieldPageIndex).toBe(3);
    expect(params.step).toBe("document");
    expect(params.mode).toBe("multi");
    expect(params.signMode).toBe("same");
    expect(params.activeDocId).toBe(params.documents[1].id);
  });

  it("los bloques salen con los ids de documento GUARDADOS y conservan trazos y sellos", async () => {
    const { a, b, session, stampA, stampB } = liveSession();
    const { params } = await snap(session, [a, b]);
    const [docA, docB] = params.documents.map((doc) => doc.id);
    expect(params.blocks).toHaveLength(1);
    expect(params.blocks[0].appliesTo).toEqual([docA, docB]);
    expect(params.blocks[0].signature).toEqual(SIG);
    expect(params.blocks[0].initials).toEqual(INI);
    expect(params.blocks[0].stamps).toEqual({ [docA]: stampA, [docB]: stampB });
  });

  it("los huecos de un firmante quitado no se guardan", async () => {
    const { a, b, idA, session, fieldA } = liveSession();
    const withGhost: SignSession = {
      ...session,
      docs: {
        ...session.docs,
        [idA]: docState({ fields: [fieldA, slot("fld-fantasma", "sg-borrado")] }),
      },
    };
    const { params } = await snap(withGhost, [a, b]);
    expect(params.documents[0].state.fields.map((f) => f.id)).toEqual(["fld-a"]);
  });

  it("un documento que sale de la ronda desaparece de la tabla y del alcance de los bloques", async () => {
    const { a, b, session } = liveSession();
    const identity = createSessionIdentity();
    const first = await snap(session, [a, b], identity);
    const [docA] = first.params.documents.map((doc) => doc.id);
    // B se quita: la cola solo tiene A.
    const { params } = await snap(
      { ...session, docOrder: [docIdOf(a)], activeDocId: docIdOf(a) },
      [a],
      identity,
    );
    expect(params.documents.map((doc) => doc.id)).toEqual([docA]);
    expect(params.blocks[0].appliesTo).toEqual([docA]);
    expect(Object.keys(params.blocks[0].stamps)).toEqual([docA]);
    expect(identity.stored.size).toBe(1);
  });

  it("los ids guardados son estables entre guardados (los bytes no se reescriben)", async () => {
    const { a, b, session } = liveSession();
    const identity = createSessionIdentity();
    const first = await snap(session, [a, b], identity);
    const second = await snap({ ...session, step: "sign" }, [a, b], identity);
    expect(second.params.documents.map((d) => d.id)).toEqual(
      first.params.documents.map((d) => d.id),
    );
  });

  it("getBytes se difiere: armar la instantanea no lee ningun archivo", () => {
    const { a, b, session } = liveSession();
    const getBytes = vi.fn(async () => new Uint8Array());
    snapshotSession({ identity: createSessionIdentity(), session, files: [a, b], getBytes });
    expect(getBytes).not.toHaveBeenCalled();
  });

  it("en modo 'distintas' crea los bloques que falten antes de guardar (uno por firmante y documento)", async () => {
    const { a, b, session } = liveSession();
    const { params } = await snap({ ...session, signMode: "independent", blocks: [] }, [a, b]);
    expect(params.blocks).toHaveLength(2);
    expect(params.blocks.every((blk) => blk.appliesTo.length === 1)).toBe(true);
  });
});

describe("restoreSession", () => {
  async function roundTrip(mutate?: (meta: SessionDraftMeta) => void) {
    const live = liveSession();
    const { meta } = await snap(live.session, [live.a, live.b]);
    mutate?.(meta);
    // Pestana nueva: archivos NUEVOS (otros DocId) con los mismos bytes.
    const a2 = file("a.pdf");
    const b2 = file("b.pdf");
    return { live, meta, a2, b2, idA2: docIdOf(a2), idB2: docIdOf(b2) };
  }

  it("recompone los documentos en orden sobre los DocId de los archivos nuevos", async () => {
    const { meta, a2, b2, idA2, idB2 } = await roundTrip();
    const restored = restoreSession(meta, [a2, b2], ["key-a", "key-b"]);
    expect(restored.patch.docOrder).toEqual([idA2, idB2]);
    expect(Object.keys(restored.patch.docs!)).toEqual([idA2, idB2]);
    expect(restored.patch.docs![idA2].textValues).toEqual({ t1: "x" });
    expect(restored.patch.docs![idB2].fieldPageIndex).toBe(3);
  });

  it("restaura firmantes, modo, paso y documento activo", async () => {
    const { meta, a2, b2, idB2 } = await roundTrip();
    const { patch } = restoreSession(meta, [a2, b2], ["key-a", "key-b"]);
    expect(patch.signers).toEqual([ANA]);
    expect(patch.mode).toBe("multi");
    expect(patch.signMode).toBe("same");
    expect(patch.step).toBe("document");
    expect(patch.activeDocId).toBe(idB2);
  });

  it("los bloques vuelven con sus trazos y sus sellos, ya sobre los DocId nuevos", async () => {
    const { live, meta, a2, b2, idA2, idB2 } = await roundTrip();
    const { patch } = restoreSession(meta, [a2, b2], ["key-a", "key-b"]);
    expect(patch.blocks).toHaveLength(1);
    const restored = patch.blocks![0];
    expect(restored.appliesTo).toEqual([idA2, idB2]);
    expect(restored.signature).toEqual(SIG);
    expect(restored.initials).toEqual(INI);
    expect(restored.stamps).toEqual({ [idA2]: live.stampA, [idB2]: live.stampB });
  });

  it("vuelve a sellar con la huella RECALCULADA", async () => {
    const { meta, a2, b2, idA2, idB2 } = await roundTrip();
    const { patch } = restoreSession(meta, [a2, b2], ["key-a", "key-b"]);
    expect(patch.docs![idA2].sealedKey).toBe("key-a");
    expect(patch.docs![idB2].sealedKey).toBe("key-b");
  });

  it("el sello solo vale si coincide con la huella recalculada: sello valido con la huella igual", async () => {
    const { live, meta, a2, b2, idA2 } = await roundTrip();
    const { patch } = restoreSession(meta, [a2, b2], ["key-a", "key-b"]);
    const captures: CaptureMap = {
      "sg-1": {
        signature: patch.blocks![0].signature,
        initials: patch.blocks![0].initials,
        stamp: patch.blocks![0].stamps[idA2],
      },
    };
    expect(validCapture(captures, [live.fieldA], "sg-1", "key-a").stamp).toBe(live.stampA);
  });

  it("si la huella de un documento ya no coincide con la guardada, sus sellos se descartan (y se avisa)", async () => {
    const { meta, a2, b2, idA2, idB2 } = await roundTrip();
    const restored = restoreSession(meta, [a2, b2], ["OTRA-HUELLA", "key-b"]);
    expect(restored.staleDocs).toBe(1);
    const stamps = restored.patch.blocks![0].stamps;
    expect(stamps[idA2]).toBeUndefined();
    expect(stamps[idB2]).toBeTruthy();
    // Sellada con la huella que SI se calculo, y la deteccion de campos vuelve a ser necesaria.
    expect(restored.patch.docs![idA2].sealedKey).toBe("OTRA-HUELLA");
    expect(restored.patch.docs![idA2].textFieldsDetectedFor).toBeNull();
  });

  it("un sello descartado no deja pasar una captura vieja: validCapture la rechaza con la huella nueva", async () => {
    const { live, meta, a2, b2, idA2 } = await roundTrip();
    const { patch } = restoreSession(meta, [a2, b2], ["OTRA-HUELLA", "key-b"]);
    const captures: CaptureMap = {
      "sg-1": {
        signature: SIG,
        initials: INI,
        stamp: patch.blocks![0].stamps[idA2] ?? "",
      },
    };
    expect(validCapture(captures, [live.fieldA], "sg-1", "OTRA-HUELLA").signature).toBeNull();
  });

  it("si la huella no se pudo calcular (null) no se descarta nada y el documento queda por sellar", async () => {
    const { meta, a2, b2, idA2 } = await roundTrip();
    const restored = restoreSession(meta, [a2, b2], [null, null]);
    expect(restored.staleDocs).toBe(0);
    expect(restored.patch.docs![idA2].sealedKey).toBe("");
    expect(Object.keys(restored.patch.blocks![0].stamps)).toHaveLength(2);
  });

  it("migra un paso anterior a W2-A con migrateStep", async () => {
    const { meta, a2, b2 } = await roundTrip((m) => {
      (m as { step: string }).step = "fields";
    });
    expect(restoreSession(meta, [a2, b2], [null, null]).patch.step).toBe("document");
    const { meta: meta2, a2: a3, b2: b3 } = await roundTrip((m) => {
      (m as { step: string }).step = "paso-raro";
    });
    expect(restoreSession(meta2, [a3, b3], [null, null]).patch.step).toBe("signers");
  });

  it("un borrador sin bloques pero con capturas (modelo anterior) se migra con migrateCaptures sobre el primer documento", async () => {
    const { meta, a2, b2, idA2 } = await roundTrip((m) => {
      delete (m as { blocks?: unknown }).blocks;
      (m as unknown as { captures: CaptureMap }).captures = {
        "sg-1": { signature: SIG, initials: INI, stamp: "stamp-viejo" },
      };
    });
    const { patch } = restoreSession(meta, [a2, b2], [null, null]);
    const own = patch.blocks!.filter((blk) => blk.signerId === "sg-1");
    expect(own).toHaveLength(1);
    expect(own[0].signature).toEqual(SIG);
    expect(own[0].appliesTo).toContain(idA2);
    expect(own[0].stamps[idA2]).toBe("stamp-viejo");
  });

  it("un borrador sin bloques ni capturas deja que la sesion cree los suyos vacios", async () => {
    const { meta, a2, b2 } = await roundTrip((m) => {
      delete (m as { blocks?: unknown }).blocks;
    });
    const { patch } = restoreSession(meta, [a2, b2], [null, null]);
    expect(patch.blocks).toHaveLength(1);
    expect(patch.blocks![0].signature).toBeNull();
  });

  it("bloques corruptos que reclaman el mismo documento se normalizan: gana el primero y se avisa", async () => {
    const { meta, a2, b2 } = await roundTrip((m) => {
      const [first] = m.blocks;
      m.blocks = [
        { ...first, id: "bk-1", appliesTo: [m.documents[0].id], stamps: {} },
        { ...first, id: "bk-2", appliesTo: m.documents.map((d) => d.id), stamps: {} },
      ];
    });
    const restored = restoreSession(meta, [a2, b2], [null, null]);
    expect(restored.normalized).toBe(1);
    const claims = restored.patch.blocks!.flatMap((blk) =>
      blk.appliesTo.map((id) => `${blk.signerId}|${id}`),
    );
    expect(new Set(claims).size).toBe(claims.length);
  });

  it("ignora en los bloques los documentos que ya no estan en la sesion guardada", async () => {
    const { meta, a2, b2, idA2, idB2 } = await roundTrip((m) => {
      m.blocks[0].appliesTo = [...m.blocks[0].appliesTo, "doc-fantasma"];
      m.blocks[0].stamps = { ...m.blocks[0].stamps, "doc-fantasma": "x" };
    });
    const { patch } = restoreSession(meta, [a2, b2], [null, null]);
    expect(patch.blocks![0].appliesTo).toEqual([idA2, idB2]);
    expect(Object.keys(patch.blocks![0].stamps)).not.toContain("doc-fantasma");
  });

  it("tolera un estado de documento incompleto o con basura", async () => {
    const { meta, a2, b2, idA2 } = await roundTrip((m) => {
      m.docStates[m.documents[0].id] = { fields: "no-es-lista" } as unknown as DocState;
    });
    const { patch } = restoreSession(meta, [a2, b2], [null, null]);
    expect(patch.docs![idA2].fields).toEqual([]);
    expect(patch.docs![idA2].textValues).toEqual({});
    expect(patch.docs![idA2].pageIndex).toBe(0);
  });

  it("un documento activo desconocido cae en el primero", async () => {
    const { meta, a2, b2, idA2 } = await roundTrip((m) => {
      m.activeDocId = "no-existe";
    });
    expect(restoreSession(meta, [a2, b2], [null, null]).patch.activeDocId).toBe(idA2);
  });

  it("devuelve la identidad para seguir guardando sobre la MISMA sesion sin reescribir los PDF", async () => {
    const { meta, a2, b2, idA2, idB2 } = await roundTrip();
    const { identity } = restoreSession(meta, [a2, b2], [null, null]);
    expect(identity.id).toBe(meta.id);
    expect(identity.saved).toBe(true);
    expect(identity.stored.get(idA2)).toBe(meta.documents[0].id);
    expect(identity.stored.get(idB2)).toBe(meta.documents[1].id);
  });

  it("ida y vuelta completa: guardar tras restaurar produce los mismos ids guardados", async () => {
    const { meta, a2, b2 } = await roundTrip();
    const restored = restoreSession(meta, [a2, b2], ["key-a", "key-b"]);
    const session: SignSession = {
      ...DEFAULT_SESSION,
      ...restored.patch,
    } as SignSession;
    const again = snapshotSession({
      identity: restored.identity,
      session,
      files: [a2, b2],
      getBytes: async () => new Uint8Array(),
    });
    expect(again.documents.map((d) => d.id)).toEqual(meta.documents.map((d) => d.id));
    expect(again.blocks[0].appliesTo).toEqual(meta.blocks[0].appliesTo);
  });

  it("el firmante borrado no resucita: sin sus huecos guardados no hay nada que restaurar de el", async () => {
    const live = liveSession();
    const ghost: SignSession = {
      ...live.session,
      signers: [],
      blocks: [],
      docs: { [live.idA]: docState({ fields: [live.fieldA] }), [live.idB]: docState() },
    };
    const { meta } = await snap(ghost, [live.a, live.b]);
    const a2 = file("a.pdf");
    const b2 = file("b.pdf");
    const { patch } = restoreSession(meta, [a2, b2], [null, null]);
    expect(patch.signers).toEqual([]);
    expect(patch.docs![docIdOf(a2)].fields).toEqual([]);
    expect(patch.blocks).toEqual([]);
  });

  it("conserva firmantes heredados (mas de 2) intactos al restaurar", async () => {
    const live = liveSession();
    const crowd: SignSession = {
      ...live.session,
      signers: [ANA, LUIS, { id: "sg-3", name: "Marta", color: "#10b981" }],
      blocks: [],
    };
    const { meta } = await snap(crowd, [live.a, live.b]);
    const a2 = file("a.pdf");
    const b2 = file("b.pdf");
    const { patch } = restoreSession(meta, [a2, b2], [null, null]);
    expect(patch.signers).toHaveLength(3);
  });
});

describe("turno de la ceremonia en el borrador (Fase 0 · U0.2)", () => {
  const TURN = { signerId: "sg-2", stage: "capture" } as const;
  const TWO: SignSession["signers"] = [ANA, LUIS];

  /** Sesion con dos firmantes y el turno de Luis, en la captura. */
  async function withTurn(ceremony: SignSession["ceremony"]) {
    const live = liveSession();
    const session: SignSession = { ...live.session, signers: TWO, blocks: [], ceremony };
    const { params, meta } = await snap(session, [live.a, live.b]);
    return { live, params, meta };
  }

  it("guardar incluye de quien es el turno y en que etapa", async () => {
    const { params, meta } = await withTurn(TURN);
    expect(params.ceremony).toEqual(TURN);
    expect(meta.ceremony).toEqual(TURN);
  });

  it("sin turno (o con un turno de un firmante que ya no esta) no se guarda ninguno", async () => {
    expect((await withTurn(undefined)).meta.ceremony).toBeUndefined();
    expect((await withTurn(null)).meta.ceremony).toBeUndefined();
    expect("ceremony" in (await withTurn(null)).meta).toBe(false);
    const ghost = { signerId: "sg-77", stage: "handoff" } as const;
    expect((await withTurn(ghost)).meta.ceremony).toBeUndefined();
  });

  it("al restaurar el turno vuelve igual: el mismo firmante y la misma etapa", async () => {
    const { meta } = await withTurn(TURN);
    const { patch } = restoreSession(meta, [file("a.pdf"), file("b.pdf")], ["key-a", "key-b"]);
    expect(patch.ceremony).toEqual(TURN);
  });

  it("a traves de IndexedDB-like JSON (clonado estructurado) el turno sobrevive", async () => {
    const { meta } = await withTurn({ signerId: "sg-1", stage: "review" });
    const cloned = JSON.parse(JSON.stringify(meta)) as SessionDraftMeta;
    const { patch } = restoreSession(cloned, [file("a.pdf"), file("b.pdf")], ["key-a", "key-b"]);
    expect(patch.ceremony).toEqual({ signerId: "sg-1", stage: "review" });
  });

  it("un borrador anterior, sin el campo, restaura sin turno (se deriva de lo que falta)", async () => {
    const { meta } = await withTurn(TURN);
    const old = { ...meta } as Partial<SessionDraftMeta>;
    delete old.ceremony;
    const { patch } = restoreSession(old as SessionDraftMeta, [file("a.pdf"), file("b.pdf")], [null, null]);
    expect(patch.ceremony).toBeUndefined();
    expect("ceremony" in patch).toBe(false);
  });

  it("un turno raro o manipulado en el borrador se descarta sin romper la restauracion", async () => {
    const { meta } = await withTurn(TURN);
    for (const bad of [
      { signerId: "sg-99", stage: "capture" },
      { signerId: "sg-1", stage: "volar" },
      { signerId: 1, stage: "capture" },
      "sg-1",
      42,
      [],
    ]) {
      const hacked = { ...meta, ceremony: bad } as unknown as SessionDraftMeta;
      const { patch } = restoreSession(hacked, [file("a.pdf"), file("b.pdf")], [null, null]);
      expect(patch.ceremony).toBeUndefined();
      expect(patch.signers).toEqual(TWO);
    }
  });

  it("un turno cuyo firmante no esta en el borrador no se restaura", async () => {
    const { meta } = await withTurn(TURN);
    const gone = { ...meta, signers: [ANA] } as SessionDraftMeta;
    const { patch } = restoreSession(gone, [file("a.pdf"), file("b.pdf")], [null, null]);
    expect(patch.ceremony).toBeUndefined();
  });

  it("ida y vuelta: guardar tras restaurar conserva el turno", async () => {
    const { meta } = await withTurn(TURN);
    const a2 = file("a.pdf");
    const b2 = file("b.pdf");
    const restored = restoreSession(meta, [a2, b2], ["key-a", "key-b"]);
    const session: SignSession = { ...DEFAULT_SESSION, ...restored.patch };
    const again = await snap(session, [a2, b2], restored.identity);
    expect(again.meta.ceremony).toEqual(TURN);
  });
});
