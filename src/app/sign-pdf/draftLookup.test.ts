import { describe, expect, it } from "vitest";
import { captureStamp } from "@/app/sign-pdf/captures";
import { EMPTY_DOC_STATE, type DocState, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  draftDocumentKeys,
  findDraftForUpload,
  findDraftsForUpload,
  formatSavedAgo,
  recoverableDrafts,
  summarizeDraft,
  uploadSetKey,
} from "@/app/sign-pdf/draftLookup";
import type { DraftEntry, DraftMeta, SessionDraftMeta } from "@/app/sign-pdf/signDrafts";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * Resumen y busqueda de borradores de Firmar (U0.3): «Ana ✓, Luis pendiente», y encontrar el borrador de ESTOS PDF por
 * huella (conjunto exacto, sin importar el orden).
 */

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };
const STROKE = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };
const HASH = (letter: string) => letter.repeat(64);
const SESSION_ID = (tag: string) => `s-mgl1${tag}-1k3v9x2a`;

function slot(signerId: string, id = `fld-${signerId}`): SignatureField {
  return { id, signerId, pageIndex: 0, type: "signature", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } };
}

type DocSpec = { id: string; name: string; key: string; fields: SignatureField[] };

function sessionEntry(args: {
  id?: string;
  savedAt?: string;
  docs: DocSpec[];
  signers: Signer[];
  signed?: string[];
}): DraftEntry {
  const { docs, signers, signed = [] } = args;
  const docStates: Record<string, DocState> = {};
  for (const doc of docs) docStates[doc.id] = { ...EMPTY_DOC_STATE, fields: doc.fields, sealedKey: doc.key };
  const blocks: SignerBlock[] = signers.map((signer, index) => {
    const done = signed.includes(signer.id);
    const stamps: Record<string, string> = {};
    if (done) {
      for (const doc of docs) stamps[doc.id] = captureStamp(doc.key, doc.fields, signer.id);
    }
    return {
      id: `bk-${index + 1}`,
      signerId: signer.id,
      appliesTo: docs.map((doc) => doc.id),
      signature: done ? STROKE : null,
      initials: null,
      stamps,
      auto: true,
    };
  });
  const meta: SessionDraftMeta = {
    kind: "session",
    id: args.id ?? SESSION_ID("a"),
    savedAt: args.savedAt ?? "2026-10-14T10:00:00.000Z",
    mode: "multi",
    signMode: "same",
    signers,
    blocks,
    documents: docs.map((doc) => ({ id: doc.id, fileName: doc.name, fileSize: 10 })),
    docStates,
    activeDocId: docs[0]?.id ?? null,
    step: "sign",
    fileSize: 10 * docs.length,
    fileName: docs[0]?.name ?? "",
    documentCount: docs.length,
  };
  return { kind: "session", meta };
}

const TWO_DOCS: DocSpec[] = [
  { id: "d1", name: "Contrato A.pdf", key: HASH("a"), fields: [slot("sg-1", "f1"), slot("sg-2", "f2")] },
  { id: "d2", name: "Anexo B.pdf", key: HASH("b"), fields: [slot("sg-1", "f3"), slot("sg-2", "f4")] },
];

function documentEntry(over: Partial<DraftMeta> = {}): DraftEntry {
  return {
    kind: "document",
    meta: {
      id: HASH("c"),
      fileName: "Poliza.pdf",
      fileSize: 10,
      savedAt: "2026-10-14T10:00:00.000Z",
      mode: "multi",
      signers: [ANA],
      fields: [slot("sg-1", "f9")],
      textFields: [],
      textValues: {},
      step: "sign",
      captures: {},
      textFieldsDetectedFor: null,
      ...over,
    },
  };
}

describe("summarizeDraft: quien ya firmo", () => {
  it("con varios documentos cuenta a cada firmante con huecos como recogido o pendiente", () => {
    const summary = summarizeDraft(sessionEntry({ docs: TWO_DOCS, signers: [ANA, LUIS], signed: ["sg-1"] }));
    expect(summary.documents).toEqual(["Contrato A.pdf", "Anexo B.pdf"]);
    expect(summary.signers.map((s) => s.name)).toEqual(["Ana", "Luis"]);
    expect(summary.collection.map((s) => [s.name, s.collected])).toEqual([
      ["Ana", true],
      ["Luis", false],
    ]);
    expect(summary.key).toBe(`session:${SESSION_ID("a")}`);
  });

  it("los dos firmantes con sus trazos vigentes salen recogidos", () => {
    const summary = summarizeDraft(sessionEntry({ docs: TWO_DOCS, signers: [ANA, LUIS], signed: ["sg-1", "sg-2"] }));
    expect(summary.collection.every((s) => s.collected)).toBe(true);
  });

  it("un trazo cuyo sello ya no vale (el documento cambio) cuenta como PENDIENTE, no como recogido", () => {
    const entry = sessionEntry({ docs: TWO_DOCS, signers: [ANA], signed: ["sg-1"] });
    if (entry.kind !== "session") throw new Error("session");
    entry.meta.docStates.d1 = { ...entry.meta.docStates.d1, sealedKey: HASH("z") };
    expect(summarizeDraft(entry).collection.map((s) => s.collected)).toEqual([false]);
  });

  it("un firmante sin huecos no entra en «firmas recogidas» pero si en «firmantes»", () => {
    const docs: DocSpec[] = [{ id: "d1", name: "A.pdf", key: HASH("a"), fields: [slot("sg-1", "f1")] }, { id: "d2", name: "B.pdf", key: HASH("b"), fields: [] }];
    const summary = summarizeDraft(sessionEntry({ docs, signers: [ANA, LUIS] }));
    expect(summary.signers.map((s) => s.name)).toEqual(["Ana", "Luis"]);
    expect(summary.collection.map((s) => s.name)).toEqual(["Ana"]);
  });

  it("sin huecos todavia: hay firmantes pero ninguna «firma recogida» que contar", () => {
    const docs: DocSpec[] = [{ id: "d1", name: "A.pdf", key: HASH("a"), fields: [] }, { id: "d2", name: "B.pdf", key: HASH("b"), fields: [] }];
    expect(summarizeDraft(sessionEntry({ docs, signers: [ANA] })).collection).toEqual([]);
  });

  it("un firmante sin nombre sale con nombre vacio (quien pinta pone «Firmante N»)", () => {
    const summary = summarizeDraft(sessionEntry({ docs: TWO_DOCS, signers: [{ ...ANA, name: "  " }] }));
    expect(summary.signers[0]).toMatchObject({ index: 0, name: "" });
  });

  it("un documento suelto cuenta con sus capturas y la huella del PDF", () => {
    const key = HASH("c");
    const field = slot("sg-1", "f9");
    const withCapture = documentEntry({
      captures: { "sg-1": { signature: STROKE, initials: null, stamp: captureStamp(key, [field], "sg-1") } },
    });
    expect(summarizeDraft(withCapture).collection.map((s) => [s.name, s.collected])).toEqual([["Ana", true]]);
    expect(summarizeDraft(documentEntry()).collection.map((s) => [s.name, s.collected])).toEqual([["Ana", false]]);
    expect(summarizeDraft(withCapture).documents).toEqual(["Poliza.pdf"]);
    expect(summarizeDraft(withCapture).key).toBe(`sign:${key}`);
  });

  it("un borrador roto (sin firmantes ni bloques) no lanza", () => {
    const entry = sessionEntry({ docs: TWO_DOCS, signers: [ANA] });
    if (entry.kind !== "session") throw new Error("session");
    const broken = { ...entry, meta: { ...entry.meta, signers: undefined, blocks: undefined, docStates: undefined } } as unknown as DraftEntry;
    expect(() => summarizeDraft(broken)).not.toThrow();
    expect(summarizeDraft(broken).signers).toEqual([]);
  });
});

describe("draftDocumentKeys / findDraftForUpload: ¿son ESTOS los PDF?", () => {
  const a = sessionEntry({ id: SESSION_ID("a"), docs: TWO_DOCS, signers: [ANA], savedAt: "2026-10-14T10:00:00.000Z" });

  it("las huellas de una sesion salen de sus documentos, en orden de cola; de un documento suelto, su id", () => {
    expect(draftDocumentKeys(a)).toEqual([HASH("a"), HASH("b")]);
    expect(draftDocumentKeys(documentEntry())).toEqual([HASH("c")]);
  });

  it("una sesion con un documento cuya huella no llego a sellarse no se puede afirmar: sin huellas", () => {
    const entry = sessionEntry({ docs: TWO_DOCS, signers: [ANA] });
    if (entry.kind !== "session") throw new Error("session");
    entry.meta.docStates.d2 = { ...entry.meta.docStates.d2, sealedKey: "" };
    expect(draftDocumentKeys(entry)).toBeNull();
    expect(findDraftForUpload([entry], [HASH("a"), HASH("b")])).toBeNull();
  });

  it("el MISMO conjunto de PDF encuentra su borrador, aunque se suban en otro orden", () => {
    expect(findDraftForUpload([a], [HASH("a"), HASH("b")])).toBe(a);
    expect(findDraftForUpload([a], [HASH("b"), HASH("a")])).toBe(a);
  });

  it("un subconjunto o un superconjunto NO encuentra nada (seria mezclar trabajos)", () => {
    expect(findDraftForUpload([a], [HASH("a")])).toBeNull();
    expect(findDraftForUpload([a], [HASH("a"), HASH("b"), HASH("c")])).toBeNull();
  });

  it("otro PDF distinto con el mismo numero de archivos NO encuentra el borrador (huella, no nombre ni cantidad)", () => {
    expect(findDraftForUpload([a], [HASH("a"), HASH("x")])).toBeNull();
    expect(findDraftForUpload([a], [HASH("x"), HASH("y")])).toBeNull();
  });

  it("dos copias identicas se cuentan dos veces: una sola copia no es el mismo trabajo", () => {
    const twins = sessionEntry({
      docs: [
        { id: "d1", name: "A.pdf", key: HASH("a"), fields: [] },
        { id: "d2", name: "A (copia).pdf", key: HASH("a"), fields: [] },
      ],
      signers: [ANA],
    });
    expect(findDraftForUpload([twins], [HASH("a"), HASH("a")])).toBe(twins);
    expect(findDraftForUpload([twins], [HASH("a"), HASH("b")])).toBeNull();
  });

  it("un documento suelto solo encuentra su borrador con UN archivo", () => {
    const single = documentEntry();
    expect(findDraftForUpload([single], [HASH("c")])).toBe(single);
    expect(findDraftForUpload([single], [HASH("c"), HASH("a")])).toBeNull();
  });

  it("con varios borradores iguales gana el primero de la lista (el mas reciente) y se elige el correcto entre otros", () => {
    const newer = sessionEntry({ id: SESSION_ID("n"), docs: TWO_DOCS, signers: [ANA], savedAt: "2026-10-14T12:00:00.000Z" });
    const unrelated = documentEntry();
    expect(findDraftForUpload([newer, unrelated, a], [HASH("a"), HASH("b")])).toBe(newer);
    expect(findDraftForUpload([unrelated, a], [HASH("c")])).toBe(unrelated);
  });

  it("sin archivos o con una huella pendiente no hay respuesta", () => {
    expect(findDraftForUpload([a], [])).toBeNull();
    expect(findDraftForUpload([a], [HASH("a"), null])).toBeNull();
    expect(findDraftForUpload([a], [HASH("a"), ""])).toBeNull();
  });

  it("uploadSetKey no depende del orden y distingue conjuntos", () => {
    expect(uploadSetKey(["b", "a"])).toBe(uploadSetKey(["a", "b"]));
    expect(uploadSetKey(["a", "b"])).not.toBe(uploadSetKey(["a", "c"]));
    expect(uploadSetKey(["a", null])).not.toBe(uploadSetKey(["a", "b"]));
  });
});

describe("recoverableDrafts", () => {
  it("descarta ids que la herramienta no sabria restaurar y sesiones sin documentos", () => {
    const good = sessionEntry({ docs: TWO_DOCS, signers: [ANA] });
    const badId = sessionEntry({ id: "s-<script>", docs: TWO_DOCS, signers: [ANA] });
    const empty = sessionEntry({ id: SESSION_ID("e"), docs: [], signers: [ANA] });
    const badDoc = documentEntry({ id: "no-es-una-huella" });
    const okDoc = documentEntry();
    expect(recoverableDrafts([good, badId, empty, badDoc, okDoc])).toEqual([good, okDoc]);
  });
});

describe("formatSavedAgo", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("menos de un minuto es «ahora mismo» (en el idioma de quien llama)", () => {
    expect(formatSavedAgo(at(5_000), "es-ES", "ahora mismo", now)).toBe("ahora mismo");
    expect(formatSavedAgo(at(59_999), "en-US", "just now", now)).toBe("just now");
  });

  it("minutos, horas y dias en lenguaje llano, en espanol y en ingles", () => {
    expect(formatSavedAgo(at(5 * 60_000), "es-ES", "ahora mismo", now)).toBe("hace 5 minutos");
    expect(formatSavedAgo(at(3 * 3_600_000), "es-ES", "ahora mismo", now)).toBe("hace 3 horas");
    expect(formatSavedAgo(at(2 * 86_400_000), "es-ES", "ahora mismo", now)).toBe("hace 2 días");
    expect(formatSavedAgo(at(5 * 60_000), "en-US", "just now", now)).toBe("5 minutes ago");
  });

  it("una fecha ilegible o futura no lanza", () => {
    expect(formatSavedAgo("no-es-fecha", "es-ES", "ahora mismo", now)).toBe("");
    expect(formatSavedAgo(at(-5_000), "es-ES", "ahora mismo", now)).toBe("ahora mismo");
  });
});

describe("summarizeDraft: borrador guardado SIN las firmas (F0 · U0.4)", () => {
  it("una sesion con `signaturesOmitted` pide las firmas de nuevo; sin la marca, no", () => {
    const entry = sessionEntry({ docs: TWO_DOCS, signers: [ANA, LUIS] });
    expect(summarizeDraft(entry).signaturesAsked).toBe(false);
    if (entry.kind !== "session") throw new Error("session");
    entry.meta.signaturesOmitted = true;
    expect(summarizeDraft(entry).signaturesAsked).toBe(true);
    // Lo demas del resumen no cambia: quienes firman siguen listados.
    expect(summarizeDraft(entry).collection.map((s) => s.name)).toEqual(["Ana", "Luis"]);
  });

  it("un documento suelto igual", () => {
    expect(summarizeDraft(documentEntry()).signaturesAsked).toBe(false);
    expect(summarizeDraft(documentEntry({ signaturesOmitted: true })).signaturesAsked).toBe(true);
  });

  it("solo la marca exacta `true` cuenta (un valor raro en IndexedDB no activa el aviso)", () => {
    const entry = documentEntry({ signaturesOmitted: "si" as unknown as true });
    expect(summarizeDraft(entry).signaturesAsked).toBe(false);
  });
});

describe("F0-fix D3: el id del borrador de un documento suelto ya NO es la huella del PDF", () => {
  const OWN_A = "1".repeat(64);
  const OWN_B = "2".repeat(64);
  const withPrint = (id: string, savedAt: string, name = "Ana") =>
    documentEntry({ id, fingerprint: HASH("c"), savedAt, signers: [{ ...ANA, name }] });

  it("las huellas de un documento salen del campo `fingerprint` (no de su id); un borrador anterior sin el, de su id", () => {
    expect(draftDocumentKeys(withPrint(OWN_A, "2026-10-14T10:00:00.000Z"))).toEqual([HASH("c")]);
    expect(draftDocumentKeys(documentEntry())).toEqual([HASH("c")]);
  });

  it("se encuentra por huella aunque el id sea otro; el id de un borrador NO se confunde con una huella", () => {
    const entry = withPrint(OWN_A, "2026-10-14T10:00:00.000Z");
    expect(findDraftForUpload([entry], [HASH("c")])).toBe(entry);
    expect(findDraftForUpload([entry], [OWN_A])).toBeNull();
  });

  it("DOS borradores del mismo PDF (la misma plantilla para dos clientes): se ofrece el mas reciente y `findDraftsForUpload` da los dos, el mas reciente primero", () => {
    const newer = withPrint(OWN_B, "2026-10-14T12:00:00.000Z", "Maria");
    const older = withPrint(OWN_A, "2026-10-14T10:00:00.000Z", "Ana");
    expect(findDraftForUpload([newer, older], [HASH("c")])).toBe(newer);
    expect(findDraftsForUpload([newer, older], [HASH("c")])).toEqual([newer, older]);
    expect(findDraftsForUpload([newer, older], [HASH("x")])).toEqual([]);
    expect(findDraftsForUpload([newer, older], [])).toEqual([]);
    expect(findDraftsForUpload([newer, older], [HASH("c"), null])).toEqual([]);
  });

  it("el resumen sella con la huella del PDF, no con el id: una firma recogida sigue contando como recogida", () => {
    const field = slot("sg-1", "f9");
    const entry = documentEntry({
      id: OWN_A,
      fingerprint: HASH("c"),
      captures: { "sg-1": { signature: STROKE, initials: null, stamp: captureStamp(HASH("c"), [field], "sg-1") } },
    });
    expect(summarizeDraft(entry).collection.map((s) => [s.name, s.collected])).toEqual([["Ana", true]]);
    // La clave del resumen es la del id (para listas), distinta de la huella.
    expect(summarizeDraft(entry).key).toBe(`sign:${OWN_A}`);
  });
});
