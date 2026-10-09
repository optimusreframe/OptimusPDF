import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import {
  prepareDocumentJob,
  signDocumentsBatch,
  type DocumentJobContext,
} from "@/app/sign-pdf/SignToolClient";
import { captureForBlock } from "@/app/sign-pdf/blockModel";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import {
  EMPTY_DOC_STATE,
  docIdOf,
  type DocState,
  type SignerBlock,
} from "@/app/sign-pdf/docSet";
import { deliveryBlockers, signersForDoc } from "@/app/sign-pdf/multiDelivery";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { PdfError } from "@/lib/pdf/core";
import { signPdfMulti, type SignMultiOptions, type SignatureField, type Signer } from "@/lib/pdf/sign";
import type { SignatureDraft } from "@/app/sign-pdf/SignatureComposer";

/*
 * Entrega de VARIOS documentos con el motor real: `signBatch` +
 * `prepareDocumentJob` + `signPdfMulti` sobre PDF de verdad (tamanos de pagina
 * distintos, asi no hay huellas identicas) y el ZIP leido con jszip.
 */

const signSpy = vi.hoisted(() => ({ calls: [] as { name: string; params: unknown }[] }));
vi.mock("@/lib/pdf/sign", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/sign")>();
  return {
    ...actual,
    signPdfMulti: vi.fn(async (file: File, params: SignMultiOptions, onProgress?: (n: number) => void) => {
      signSpy.calls.push({ name: file.name, params });
      return actual.signPdfMulti(file, params, onProgress);
    }),
  };
});

const strings = SIGN_STRINGS.es;
const CONTEXT: DocumentJobContext = { language: "es", strings, certificateEnabled: true };

/** PNG real de 1x1 pixel transparente (el que acepta `embedPng`). */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const DRAFT: SignatureDraft = { dataUrl: PNG, ratio: 1 };

const ANA: Signer = { id: "sg-1", name: "Ana Pérez", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

async function makePdf(name: string, size: number, pages = 1): Promise<File> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([size, size]);
  const bytes = await doc.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

let FILE_A: File;
let FILE_B: File;
let FILE_C: File;
let A: string;
let B: string;
const KEYS: Record<string, string> = {};

beforeAll(async () => {
  FILE_A = await makePdf("Contrato A.pdf", 300);
  FILE_B = await makePdf("Anexo.pdf", 310, 2);
  FILE_C = await makePdf("Acta.pdf", 320);
  [A, B] = [FILE_A, FILE_B].map(docIdOf);
  for (const file of [FILE_A, FILE_B, FILE_C]) KEYS[docIdOf(file)] = await documentContentKey(file);
  // Tamanos distintos => contenidos (y huellas) distintos.
  expect(new Set(Object.values(KEYS)).size).toBe(3);
});

beforeEach(() => {
  signSpy.calls.length = 0;
});

function slot(id: string, signerId: string, x = 0.1, pageIndex = 0): SignatureField {
  return {
    id,
    signerId,
    pageIndex,
    type: "signature",
    rect: { x, y: 0.1, width: 0.3, height: 0.1 },
  };
}

function docState(docId: string, fields: SignatureField[], extra: Partial<DocState> = {}): DocState {
  return { ...EMPTY_DOC_STATE, fields, sealedKey: KEYS[docId], ...extra };
}

function block(
  id: string,
  signerId: string,
  appliesTo: string[],
  extra: Partial<SignerBlock> = {},
): SignerBlock {
  return {
    id,
    signerId,
    appliesTo,
    signature: null,
    initials: null,
    stamps: {},
    auto: false,
    ...extra,
  };
}

/** Sesion «Varios» ya firmada con sellos reales. */
function signedSession(
  docs: Record<string, DocState>,
  blocks: SignerBlock[],
  signers: Signer[] = [ANA, LUIS],
  keys: Record<string, string> = KEYS,
): SignSession {
  const ctx = { signers, docs, keys };
  let stamped = blocks;
  for (const item of blocks) {
    stamped = captureForBlock(stamped, item.id, { signature: DRAFT }, ctx);
  }
  return {
    ...DEFAULT_SESSION,
    mode: "multi",
    step: "sign",
    signers,
    docs,
    docOrder: Object.keys(docs),
    activeDocId: Object.keys(docs)[0],
    blocks: stamped,
  };
}

/** Ana firma A y B; Luis solo A. */
function mixedSession(): SignSession {
  return signedSession(
    {
      [A]: docState(A, [slot("a1", ANA.id), slot("a2", LUIS.id, 0.5)]),
      [B]: docState(B, [slot("b1", ANA.id)]),
    },
    [block("bk-1", ANA.id, [A, B], { auto: true }), block("bk-2", LUIS.id, [A, B], { auto: true })],
  );
}

async function run(
  files: File[],
  session: SignSession,
  options: { signal?: AbortSignal; context?: DocumentJobContext; onProgress?: (n: number) => void } = {},
) {
  return signDocumentsBatch({
    files,
    session,
    onProgress: options.onProgress ?? (() => {}),
    signal: options.signal,
    context: options.context ?? CONTEXT,
  });
}

async function unzip(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

async function imageCount(zip: JSZip, entry: string, pageIndex = 0): Promise<number> {
  const bytes = await zip.file(entry)!.async("uint8array");
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const xObjects = pdf.getPages()[pageIndex].node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  return xObjects?.keys().length ?? 0;
}

describe("signDocumentsBatch — varios firmantes, un PDF por documento", () => {
  it("entrega un ZIP con un PDF por documento, nombrado «<firmantes que aplican> - <documento>-firmado.pdf»", async () => {
    const result = await run([FILE_A, FILE_B], mixedSession());
    expect(result.filename).toBe("Firmados - 2 documentos.zip");
    const zip = await unzip(result.blob);
    expect(Object.keys(zip.files).sort()).toEqual([
      "Ana Pérez - Anexo-firmado.pdf",
      "Ana Pérez y Luis - Contrato A-firmado.pdf",
    ]);
    expect(result.report?.ok.map((item) => item.filename)).toEqual([
      "Ana Pérez y Luis - Contrato A-firmado.pdf",
      "Ana Pérez - Anexo-firmado.pdf",
    ]);
    expect(result.report?.failed).toEqual([]);
  });

  it("un firmante que solo aplica a un documento NO aparece en el nombre del otro", async () => {
    const result = await run([FILE_A, FILE_B], mixedSession());
    const names = Object.keys((await unzip(result.blob)).files);
    expect(names.filter((name) => name.includes("Luis"))).toEqual([
      "Ana Pérez y Luis - Contrato A-firmado.pdf",
    ]);
  });

  it("las imagenes de firma estan embebidas en CADA PDF", async () => {
    const result = await run([FILE_A, FILE_B], mixedSession());
    const zip = await unzip(result.blob);
    expect(await imageCount(zip, "Ana Pérez y Luis - Contrato A-firmado.pdf")).toBeGreaterThanOrEqual(1);
    expect(await imageCount(zip, "Ana Pérez - Anexo-firmado.pdf")).toBeGreaterThanOrEqual(1);
  });

  it("cada PDF conserva el tamano de pagina y el numero de paginas de su original, mas la pagina del certificado", async () => {
    const result = await run([FILE_A, FILE_B], mixedSession());
    const zip = await unzip(result.blob);
    const a = await PDFDocument.load(await zip.file("Ana Pérez y Luis - Contrato A-firmado.pdf")!.async("uint8array"), {
      updateMetadata: false,
    });
    const b = await PDFDocument.load(await zip.file("Ana Pérez - Anexo-firmado.pdf")!.async("uint8array"), {
      updateMetadata: false,
    });
    expect(a.getPageCount()).toBe(2);
    expect(b.getPageCount()).toBe(3);
    expect(a.getPages()[0].getSize()).toEqual({ width: 300, height: 300 });
    expect(b.getPages()[0].getSize()).toEqual({ width: 310, height: 310 });
  });

  it("el certificado de cada documento lleva EXACTAMENTE la misma lista de firmantes que su nombre", async () => {
    const session = mixedSession();
    await run([FILE_A, FILE_B], session);
    const certificates = Object.fromEntries(
      signSpy.calls.map((call) => [
        call.name,
        (call.params as SignMultiOptions).certificate?.signerNames,
      ]),
    );
    expect(certificates).toEqual({
      "Contrato A.pdf": ["Ana Pérez", "Luis"],
      "Anexo.pdf": ["Ana Pérez"],
    });
    expect(signersForDoc(session, A).map((s) => s.name)).toEqual(certificates["Contrato A.pdf"]);
    expect(signersForDoc(session, B).map((s) => s.name)).toEqual(certificates["Anexo.pdf"]);
  });

  it("sin certificado activado, no se pasa certificado a ningun documento", async () => {
    await run([FILE_A, FILE_B], mixedSession(), { context: { ...CONTEXT, certificateEnabled: false } });
    expect(signSpy.calls.every((call) => (call.params as SignMultiOptions).certificate === undefined)).toBe(true);
  });

  it("modo «distintas»: cada documento con SU firmante y nombres propios", async () => {
    const session = signedSession(
      {
        [A]: docState(A, [slot("a1", ANA.id)]),
        [B]: docState(B, [slot("b1", LUIS.id)]),
      },
      [block("bk-1", ANA.id, [A]), block("bk-2", LUIS.id, [B])],
    );
    const result = await run([FILE_A, FILE_B], session);
    expect(Object.keys((await unzip(result.blob)).files).sort()).toEqual([
      "Ana Pérez - Contrato A-firmado.pdf",
      "Luis - Anexo-firmado.pdf",
    ]);
  });

  it("el trazo de un bloque se coloca en los huecos de SU firmante en cada documento del alcance", async () => {
    await run([FILE_A, FILE_B], mixedSession());
    const placements = signSpy.calls.map((call) => ({
      name: call.name,
      count: (call.params as SignMultiOptions).placements.length,
    }));
    expect(placements).toEqual([
      { name: "Contrato A.pdf", count: 2 },
      { name: "Anexo.pdf", count: 1 },
    ]);
  });

  it("un firmante sin nombre no aparece en el nombre del archivo", async () => {
    const anonimo: Signer = { id: "sg-9", name: "  ", color: "#e11d48" };
    const session = signedSession(
      {
        [A]: docState(A, [slot("a1", anonimo.id)]),
        [B]: docState(B, [slot("b1", ANA.id)]),
      },
      [block("bk-1", anonimo.id, [A]), block("bk-2", ANA.id, [B])],
      [anonimo, ANA],
    );
    const result = await run([FILE_A, FILE_B], session);
    expect(Object.keys((await unzip(result.blob)).files).sort()).toEqual([
      "Ana Pérez - Anexo-firmado.pdf",
      "Contrato A-firmado.pdf",
    ]);
  });

  it("los nombres salen en ingles con el idioma activo", async () => {
    const result = await run([FILE_A, FILE_B], mixedSession(), {
      context: { language: "en", strings: SIGN_STRINGS.en, certificateEnabled: false },
    });
    expect(result.filename).toBe("Signed - 2 documents.zip");
    expect(Object.keys((await unzip(result.blob)).files).sort()).toEqual([
      "Ana Pérez - Anexo-signed.pdf",
      "Ana Pérez and Luis - Contrato A-signed.pdf",
    ]);
  });

  it("tres documentos: orden de la cola y colisiones de nombre desambiguadas", async () => {
    const other = await makePdf("Anexo.pdf", 330);
    const otherId = docIdOf(other);
    KEYS[otherId] = await documentContentKey(other);
    const session = signedSession(
      {
        [A]: docState(A, [slot("a1", ANA.id)]),
        [B]: docState(B, [slot("b1", ANA.id)]),
        [otherId]: docState(otherId, [slot("o1", ANA.id)]),
      },
      [block("bk-1", ANA.id, [A, B, otherId], { auto: true })],
      [ANA],
    );
    const result = await run([FILE_A, FILE_B, other], session);
    expect(result.filename).toBe("Firmados - 3 documentos.zip");
    expect(Object.keys((await unzip(result.blob)).files).sort()).toEqual([
      "Ana Pérez - Anexo-firmado (2).pdf",
      "Ana Pérez - Anexo-firmado.pdf",
      "Ana Pérez - Contrato A-firmado.pdf",
    ]);
  });
});

describe("signDocumentsBatch — fallo parcial, cancelacion y limites", () => {
  it("un documento cuyo trazo se sello sobre OTRO contenido falla; el bueno va en el ZIP y el informe lo dice", async () => {
    // La huella de B en el sello no es la del archivo real: «huella recalculada justo antes de firmar».
    const wrongKeys = { ...KEYS, [B]: "huella-de-otro-archivo" };
    const session = signedSession(
      {
        [A]: docState(A, [slot("a1", ANA.id)]),
        [B]: docState(B, [slot("b1", ANA.id)]),
      },
      [block("bk-1", ANA.id, [A, B], { auto: true })],
      [ANA],
      wrongKeys,
    );
    const result = await run([FILE_A, FILE_B], session);
    expect(result.filename).toBe("Firmados - 1 documento.zip");
    expect(Object.keys((await unzip(result.blob)).files)).toEqual(["Ana Pérez - Contrato A-firmado.pdf"]);
    expect(result.report?.ok).toHaveLength(1);
    expect(result.report?.failed).toEqual([{ id: B, name: "Anexo.pdf", code: "nothingSelected" }]);
  });

  it("si TODOS fallan se rechaza con el error del primero", async () => {
    const wrongKeys = { [A]: "x", [B]: "y" };
    const session = signedSession(
      {
        [A]: docState(A, [slot("a1", ANA.id)]),
        [B]: docState(B, [slot("b1", ANA.id)]),
      },
      [block("bk-1", ANA.id, [A, B], { auto: true })],
      [ANA],
      wrongKeys,
    );
    await expect(run([FILE_A, FILE_B], session)).rejects.toMatchObject({ code: "nothingSelected" });
  });

  it("un documento sin huecos ni campos falla (informe) sin impedir los demas", async () => {
    const session = signedSession(
      {
        [A]: docState(A, [slot("a1", ANA.id)]),
        [B]: docState(B, []),
      },
      [block("bk-1", ANA.id, [A, B], { auto: true })],
      [ANA],
    );
    const result = await run([FILE_A, FILE_B], session);
    expect(result.report?.failed.map((item) => item.name)).toEqual(["Anexo.pdf"]);
    expect(result.report?.ok).toHaveLength(1);
  });

  it("cancelar entre documentos aborta todo y no firma los siguientes", async () => {
    const controller = new AbortController();
    const promise = run([FILE_A, FILE_B], mixedSession(), {
      signal: controller.signal,
      onProgress: (value) => {
        // Termino el primer documento (95 % / 2): se cancela antes del segundo.
        if (value >= 0.45) controller.abort();
      },
    });
    await expect(promise).rejects.toBeInstanceOf(PdfError);
    await expect(promise).rejects.toMatchObject({ code: "cancelled" });
    expect(signSpy.calls.map((call) => call.name)).toEqual(["Contrato A.pdf"]);
  });

  it("ya cancelado antes de empezar: no firma nada", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(run([FILE_A, FILE_B], mixedSession(), { signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(signSpy.calls).toEqual([]);
  });

  it("el progreso nunca retrocede y termina en 1", async () => {
    const seen: number[] = [];
    await run([FILE_A, FILE_B], mixedSession(), { onProgress: (value) => seen.push(value) });
    expect(seen.length).toBeGreaterThan(2);
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]);
    }
    expect(seen.at(-1)).toBe(1);
  });

  it("mas de 10 documentos: se rechaza antes de firmar ninguno", async () => {
    const files = Array.from(
      { length: 11 },
      (_, index) => new File([FILE_A], `d${index}.pdf`, { type: "application/pdf" }),
    );
    await expect(run(files, mixedSession())).rejects.toMatchObject({ code: "tooLarge" });
    expect(signSpy.calls).toEqual([]);
  });
});

describe("signDocumentsBatch — «Solo yo» con varios documentos", () => {
  function soloSession(placeB: boolean): SignSession {
    return {
      ...DEFAULT_SESSION,
      mode: "single",
      signaturePng: PNG,
      ratio: 1,
      docs: {
        [A]: docState(A, [], { rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 }, pageIndex: 0 }),
        [B]: docState(B, [], {
          rect: placeB ? { x: 0.5, y: 0.5, width: 0.3, height: 0.1 } : { x: 0, y: 0, width: 0, height: 0 },
          pageIndex: 1,
        }),
      },
      docOrder: [A, B],
      activeDocId: A,
    };
  }

  it("cada documento lleva la firma en SU rectangulo y pagina, y se llama `<documento>-firmado.pdf` (sin firmantes ni certificado)", async () => {
    const result = await run([FILE_A, FILE_B], soloSession(true));
    const zip = await unzip(result.blob);
    expect(Object.keys(zip.files).sort()).toEqual(["Anexo-firmado.pdf", "Contrato A-firmado.pdf"]);
    const [callA, callB] = signSpy.calls.map((call) => call.params as SignMultiOptions);
    expect(callA.certificate).toBeUndefined();
    expect(callA.placements[0]).toMatchObject({ pageIndex: 0, rect: { x: 0.1, y: 0.1 } });
    expect(callB.placements[0]).toMatchObject({ pageIndex: 1, rect: { x: 0.5, y: 0.5 } });
    // B tiene 2 paginas: la firma esta en la segunda.
    expect(await imageCount(zip, "Anexo-firmado.pdf", 1)).toBeGreaterThanOrEqual(1);
    expect(await imageCount(zip, "Anexo-firmado.pdf", 0)).toBe(0);
  });

  it("un documento sin la firma colocada bloquea la entrega con un mensaje claro", () => {
    const blockers = deliveryBlockers(soloSession(false), [A, B]);
    expect(blockers).toEqual([{ kind: "soloUnplaced", docId: B }]);
  });

  it("(control) con todas colocadas no hay bloqueos", () => {
    expect(deliveryBlockers(soloSession(true), [A, B])).toEqual([]);
  });
});

describe("prepareDocumentJob — firmantes del certificado por documento", () => {
  it("usa `signerNames` cuando se le dan y todos los de la sesion cuando no", async () => {
    const session = mixedSession();
    const scoped = await prepareDocumentJob(B, FILE_B, session, { ...CONTEXT, signerNames: ["Ana Pérez"] });
    expect(scoped.params.certificate?.signerNames).toEqual(["Ana Pérez"]);
    const all = await prepareDocumentJob(B, FILE_B, session, CONTEXT);
    expect(all.params.certificate?.signerNames).toEqual(["Ana Pérez", "Luis"]);
  });

  it("recalcula la huella del archivo: un archivo distinto del que vieron los firmantes se rechaza", async () => {
    const session = mixedSession();
    // El documento B de la sesion no es este archivo.
    await expect(prepareDocumentJob(B, FILE_C, session, CONTEXT)).rejects.toMatchObject({
      code: "nothingSelected",
    });
  });

  it("sigue siendo la misma funcion de `signPdfMulti` real (el espia delega)", async () => {
    expect(vi.isMockFunction(signPdfMulti)).toBe(true);
  });
});
