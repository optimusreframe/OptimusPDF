import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import {
  documentResult,
  isEditOnlyJob,
  prepareDocumentJob,
  runDocumentJob,
  runDocumentJobDetailed,
  signDocumentsBatch,
  type SignToolOptions,
} from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { DEFAULT_SESSION, applyViewPatch, sessionFromView, viewOf, type SignSession } from "@/app/sign-pdf/signSession";
import { captureStamp } from "@/app/sign-pdf/captures";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { docIdOf, ensureBlocks } from "@/app/sign-pdf/docSet";
import { stampKeyOf } from "@/app/sign-pdf/textEdits";
import { signedFilename } from "@/lib/pdf/signOutputNames";
import { deliveryBlockers } from "@/app/sign-pdf/multiDelivery";
import { soloReady } from "@/app/sign-pdf/soloSignature";
import { encodePng } from "@/lib/pdf/testing/signSyntheticPdfs";
import type { TextEdit } from "@/lib/pdf/editTypes";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/**
 * Firmar con texto original editado (W6-A): las ediciones se aplican ANTES de
 * estampar las firmas, cada documento lleva las suyas, y el sellado de las
 * capturas tiene en cuenta el contenido editado sin tocar la huella del archivo.
 */

const strings = SIGN_STRINGS.es;
const CONTEXT = { language: "es" as const, strings, certificateEnabled: false };

const PNG_URL = (() => {
  const bytes = encodePng(8, 4, () => [0, 0, 0, 255]);
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
})();

async function pdfWith(text: string, name = "doc.pdf"): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 300]);
  page.drawText(text, { x: 50, y: 250, size: 12, font });
  return new File([(await doc.save()) as BlobPart], name, { type: "application/pdf" });
}

const REPLACE = (text: string): TextEdit =>
  makeEdit({
    id: `e-${text}`,
    text,
    box: { x: 50, y: 245, width: 250, height: 16 },
    cover: { color: "#ffffff", padding: 1 },
  });

function soloOptions(patch: Partial<SignToolOptions> = {}): SignToolOptions {
  return {
    mode: "single",
    signaturePng: PNG_URL,
    ratio: 0.5,
    pageIndex: 0,
    rect: { x: 0.2, y: 0.6, width: 0.3, height: 0.15 },
    signature: "",
    step: "signers",
    signers: [],
    fields: [],
    captures: {},
    activeSignerId: null,
    fieldPageIndex: 0,
    selectedFieldId: null,
    placementTool: "select",
    textFields: [],
    textValues: {},
    selectedTextFieldId: null,
    editingTextFieldId: null,
    textFieldsDetectedFor: null,
    ...patch,
  };
}

function soloSession(file: File, patch: Partial<SignToolOptions>): SignSession {
  return { ...DEFAULT_SESSION, ...sessionFromView(docIdOf(file), soloOptions(patch)) } as SignSession;
}

async function inspect(blob: Blob) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const text = (await page.getTextContent()).items.map((item) => ("str" in item ? item.str : "")).join(" ");
    const ops = await page.getOperatorList();
    const lastShowText = ops.fnArray.lastIndexOf(pdfjs.OPS.showText);
    const images = ops.fnArray
      .map((fn, index) => (fn === pdfjs.OPS.paintImageXObject ? index : -1))
      .filter((index) => index >= 0);
    return { text, lastShowText, images };
  } finally {
    await task.destroy();
  }
}

describe("runDocumentJob — «Solo yo»", () => {
  it("aplica las ediciones de texto ANTES de estampar la firma: la imagen va despues de todo el texto", async () => {
    const file = await pdfWith("Original");
    const session = soloSession(file, { textEdits: [REPLACE("Texto nuevo")] });
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    expect(job.textEdits).toHaveLength(1);
    const blob = await runDocumentJob(job);
    const result = await inspect(blob);
    expect(result.text).toContain("Texto nuevo");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toBeGreaterThan(result.lastShowText);
  });

  it("solo con ediciones (sin firma colocada ni campos) el PDF editado ES el resultado", async () => {
    const file = await pdfWith("Original");
    const session = soloSession(file, { rect: { x: 0, y: 0, width: 0, height: 0 }, textEdits: [REPLACE("Solo edicion")] });
    expect(soloReady(viewOf(session, docIdOf(file)))).toBe(true);
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    const result = await inspect(await runDocumentJob(job));
    expect(result.text).toContain("Solo edicion");
    expect(result.images).toHaveLength(0);
  });

  it("sin ediciones es exactamente el flujo de siempre (la firma sola)", async () => {
    const file = await pdfWith("Original");
    const session = soloSession(file, {});
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    expect(job.textEdits).toEqual([]);
    const result = await inspect(await runDocumentJob(job));
    expect(result.text).not.toContain("Texto nuevo");
    expect(result.images).toHaveLength(1);
  });

  it("sin firma, sin campos y sin ediciones sigue fallando con «vacio»", async () => {
    const file = await pdfWith("Original");
    const session = soloSession(file, { rect: { x: 0, y: 0, width: 0, height: 0 } });
    await expect(prepareDocumentJob(docIdOf(file), file, session, CONTEXT)).rejects.toMatchObject({ code: "empty" });
  });

  it("informa del progreso hasta el final", async () => {
    const file = await pdfWith("Original");
    const session = soloSession(file, { textEdits: [REPLACE("Progreso")] });
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    const steps: number[] = [];
    await runDocumentJob(job, (value) => steps.push(value));
    expect(steps[steps.length - 1]).toBeCloseTo(1, 5);
    // Monotono: las ediciones ocupan el primer tramo y la firma el resto.
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
  });
});

describe("«Varios firmantes»: el sello incluye las ediciones", () => {
  const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
  const FIELD: SignatureField = {
    id: "f1",
    signerId: "sg-1",
    pageIndex: 0,
    type: "signature",
    rect: { x: 0.1, y: 0.8, width: 0.3, height: 0.1 },
  };
  const DRAFT = { dataUrl: PNG_URL, ratio: 0.5 };

  async function multiSession(file: File, edits: TextEdit[], signedWith: TextEdit[]): Promise<SignSession> {
    const fileKey = await documentContentKey(file);
    const stamp = captureStamp(stampKeyOf(fileKey, signedWith) as string, [FIELD], ANA.id);
    return {
      ...DEFAULT_SESSION,
      ...sessionFromView(docIdOf(file), {
        mode: "multi",
        signers: [ANA],
        fields: [FIELD],
        captures: { [ANA.id]: { signature: DRAFT, initials: null, stamp } },
        signature: fileKey,
        textEdits: edits,
      }),
    } as SignSession;
  }

  it("firmado sobre el documento ya editado: se estampa sobre el PDF editado", async () => {
    const file = await pdfWith("Original");
    const edits = [REPLACE("Clausula nueva")];
    const session = await multiSession(file, edits, edits);
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    const result = await inspect(await runDocumentJob(job));
    expect(result.text).toContain("Clausula nueva");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toBeGreaterThan(result.lastShowText);
  });

  it("editar DESPUES de firmar invalida el trazo: no se estampa una firma que su dueno no vio sobre ese texto", async () => {
    const file = await pdfWith("Original");
    const session = await multiSession(file, [REPLACE("Cambiado tras firmar")], []);
    await expect(prepareDocumentJob(docIdOf(file), file, session, CONTEXT)).rejects.toMatchObject({
      code: "nothingSelected",
    });
  });

  it("deshacer la edicion tras firmar con ella tambien invalida el trazo", async () => {
    const file = await pdfWith("Original");
    const session = await multiSession(file, [], [REPLACE("Firmado con esto")]);
    await expect(prepareDocumentJob(docIdOf(file), file, session, CONTEXT)).rejects.toMatchObject({
      code: "nothingSelected",
    });
  });

  it("sin ediciones el sello es el de siempre (la huella del archivo)", async () => {
    const file = await pdfWith("Original");
    const session = await multiSession(file, [], []);
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    expect(job.params.placements).toHaveLength(1);
  });

  it("un documento solo con ediciones (sin huecos ni campos) ya no es «vacio»", async () => {
    const file = await pdfWith("Original");
    const session: SignSession = {
      ...DEFAULT_SESSION,
      ...sessionFromView(docIdOf(file), { mode: "multi", signature: "k", textEdits: [REPLACE("Algo")] }),
    } as SignSession;
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    const result = await inspect(await runDocumentJob(job));
    expect(result.text).toContain("Algo");
  });
});

describe("varios documentos: cada uno con SUS ediciones", () => {
  it("el estado y la vista de cada documento llevan solo las suyas", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await pdfWith("Dos", "b.pdf");
    const idA = docIdOf(a);
    const idB = docIdOf(b);
    let session: SignSession = { ...DEFAULT_SESSION, docOrder: [idA, idB], activeDocId: idA };
    session = { ...session, ...applyViewPatch(session, idA, { textEdits: [REPLACE("Solo en A")] }, [idA, idB]) };
    session = { ...session, ...applyViewPatch(session, idB, { textEdits: [REPLACE("Solo en B")] }, [idA, idB]) };
    expect(viewOf(session, idA).textEdits?.[0].text).toBe("Solo en A");
    expect(viewOf(session, idB).textEdits?.[0].text).toBe("Solo en B");
    const jobA = await prepareDocumentJob(idA, a, soloSessionOf(session), CONTEXT);
    const jobB = await prepareDocumentJob(idB, b, soloSessionOf(session), CONTEXT);
    expect(jobA.textEdits[0].text).toBe("Solo en A");
    expect(jobB.textEdits[0].text).toBe("Solo en B");
  });

  function soloSessionOf(session: SignSession): SignSession {
    return { ...session, mode: "single", signaturePng: PNG_URL, ratio: 0.5 };
  }

  it("la entrega conjunta aplica las ediciones de cada documento en su propio PDF del ZIP", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await pdfWith("Dos", "b.pdf");
    const idA = docIdOf(a);
    const idB = docIdOf(b);
    const rect = { x: 0.2, y: 0.6, width: 0.3, height: 0.15 };
    let session: SignSession = {
      ...DEFAULT_SESSION,
      mode: "single",
      signaturePng: PNG_URL,
      ratio: 0.5,
      docOrder: [idA, idB],
      activeDocId: idA,
    };
    for (const [id, text] of [[idA, "Edicion A"], [idB, "Edicion B"]] as const) {
      session = { ...session, ...applyViewPatch(session, id, { textEdits: [REPLACE(text)], rect, pageIndex: 0 }, [idA, idB]) };
    }
    const result = await signDocumentsBatch({
      files: [a, b],
      session,
      onProgress: () => {},
      context: CONTEXT,
    });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    const names = Object.keys(zip.files).sort();
    expect(names).toHaveLength(2);
    const texts: string[] = [];
    for (const name of names) {
      const blob = new Blob([(await zip.files[name].async("uint8array")) as BlobPart], { type: "application/pdf" });
      texts.push((await inspect(blob)).text);
    }
    expect(texts[0]).toContain("Edicion A");
    expect(texts[0]).not.toContain("Edicion B");
    expect(texts[1]).toContain("Edicion B");
    expect(texts[1]).not.toContain("Edicion A");
  });

  it("deliveryBlockers: la huella de sellado de cada documento incluye SUS ediciones", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await pdfWith("Dos", "b.pdf");
    const idA = docIdOf(a);
    const idB = docIdOf(b);
    const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
    const fieldIn = (id: string): SignatureField => ({
      id,
      signerId: ANA.id,
      pageIndex: 0,
      type: "signature",
      rect: { x: 0.1, y: 0.8, width: 0.3, height: 0.1 },
    });
    const keyA = await documentContentKey(a);
    const keyB = await documentContentKey(b);
    const editsB = [REPLACE("Solo B")];
    let session: SignSession = { ...DEFAULT_SESSION, mode: "multi", signers: [ANA], docOrder: [idA, idB], activeDocId: idA };
    session.blocks = ensureBlocks([ANA], [idA, idB], "same", []);
    const block = session.blocks[0];
    const stamps = {
      [idA]: captureStamp(stampKeyOf(keyA, undefined) as string, [fieldIn("fa")], ANA.id),
      // La firma de B se hizo ANTES de editar B: el sello no lleva las ediciones.
      [idB]: captureStamp(keyB, [fieldIn("fb")], ANA.id),
    };
    session = {
      ...session,
      blocks: [{ ...block, signature: { dataUrl: PNG_URL, ratio: 0.5 }, stamps }],
    };
    session = { ...session, ...applyViewPatch(session, idA, { fields: [fieldIn("fa")], signature: keyA }, [idA, idB]) };
    session = { ...session, ...applyViewPatch(session, idB, { fields: [fieldIn("fb")], signature: keyB }, [idA, idB]) };
    expect(deliveryBlockers(session, [idA, idB])).toEqual([]);
    // Editar B invalida SOLO el sello de B.
    session = { ...session, ...applyViewPatch(session, idB, { textEdits: editsB }, [idA, idB]) };
    const blockers = deliveryBlockers(session, [idA, idB]);
    expect(blockers.map((blocker) => blocker.kind)).toEqual(["pending"]);
  });
});

describe("nombre del archivo: «-editado» si no se estampo ninguna firma", () => {
  it("signedFilename con `edited` usa el sufijo editado (es/en); sin el, «-firmado»", () => {
    expect(signedFilename({ signerNames: [], documentName: "Contrato.pdf", lang: "es", edited: true })).toBe("Contrato-editado.pdf");
    expect(signedFilename({ signerNames: [], documentName: "Contrato.pdf", lang: "en", edited: true })).toBe("Contrato-edited.pdf");
    expect(signedFilename({ signerNames: [], documentName: "Contrato.pdf", lang: "es" })).toBe("Contrato-firmado.pdf");
    expect(signedFilename({ signerNames: [], documentName: "Contrato.pdf", lang: "en" })).toBe("Contrato-signed.pdf");
  });

  it("isEditOnlyJob: solo ediciones = editado; con una firma (imagen) = firmado; sin ediciones nunca", async () => {
    const file = await pdfWith("Original");
    const soloEdits = await prepareDocumentJob(
      docIdOf(file),
      file,
      soloSession(file, { rect: { x: 0, y: 0, width: 0, height: 0 }, textEdits: [REPLACE("Solo edicion")] }),
      CONTEXT,
    );
    expect(isEditOnlyJob(soloEdits)).toBe(true);
    const signed = await prepareDocumentJob(docIdOf(file), file, soloSession(file, { textEdits: [REPLACE("Con firma")] }), CONTEXT);
    expect(isEditOnlyJob(signed)).toBe(false);
    const plain = await prepareDocumentJob(docIdOf(file), file, soloSession(file, {}), CONTEXT);
    expect(isEditOnlyJob(plain)).toBe(false);
  });

  it("un ZIP con un documento firmado y otro solo editado nombra cada uno como corresponde", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await pdfWith("Dos", "b.pdf");
    const idA = docIdOf(a);
    const idB = docIdOf(b);
    let session: SignSession = { ...DEFAULT_SESSION, mode: "single", signaturePng: PNG_URL, ratio: 0.5, docOrder: [idA, idB], activeDocId: idA };
    session = {
      ...session,
      ...applyViewPatch(session, idA, { textEdits: [REPLACE("Edicion A")], rect: { x: 0.2, y: 0.6, width: 0.3, height: 0.15 }, pageIndex: 0 }, [idA, idB]),
    };
    session = { ...session, ...applyViewPatch(session, idB, { textEdits: [REPLACE("Edicion B")] }, [idA, idB]) };
    const result = await signDocumentsBatch({ files: [a, b], session, onProgress: () => {}, context: CONTEXT });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["a-firmado.pdf", "b-editado.pdf"]);
  });
});

/* ------------------------------------------------------------------ *
 * B1: lo que paso con el texto ORIGINAL llega a la pantalla de resultado
 * ------------------------------------------------------------------ */

/** Reemplazo de un BLOQUE del PDF (no texto propio): el original esta en (50, 250) con cuerpo 12. */
const BLOCK = (text: string, over: Partial<TextEdit> = {}): TextEdit =>
  makeEdit({
    id: `b-${text}`,
    blockId: "p0-b0",
    text,
    box: { x: 48, y: 247, width: 120, height: 16 },
    coverBox: { x: 48, y: 247, width: 120, height: 16 },
    cover: { color: "#ffffff", padding: 1 },
    ...over,
  });

/** Dos paginas que comparten el MISMO Form XObject con el texto: F2 no puede quitarlo (shared-xobject). */
async function sharedXObjectFile(name: string): Promise<File> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const xobject = doc.context.register(
    doc.context.stream("BT /F1 12 Tf 0 0 Td (Original) Tj ET", {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, -10, 300, 30],
      Matrix: [1, 0, 0, 1, 50, 250],
      Resources: { Font: { F1: font.ref } },
    }),
  );
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([400, 300]);
    page.node.setXObject(PDFName.of("Fx"), xobject);
    page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.stream("q /Fx Do Q")));
  }
  return new File([(await doc.save()) as BlobPart], name, { type: "application/pdf" });
}

describe("runDocumentJobDetailed — el informe del texto editado", () => {
  it("un texto quitable: informe con el original eliminado, y el PDF final sin el original ni la firma perdida", async () => {
    const file = await pdfWith("Original");
    const session = soloSession(file, { textEdits: [BLOCK("Cambiado")] });
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    const { blob, edits } = await runDocumentJobDetailed(job);
    expect(edits).toMatchObject({ replaced: 1, removed: 1, remains: [] });
    const result = await inspect(blob);
    expect(result.text).toContain("Cambiado");
    expect(result.text).not.toContain("Original");
    expect(result.images).toHaveLength(1);
  });

  it("un texto que NO se puede quitar: el informe lleva el motivo y el archivo sigue siendo valido", async () => {
    const file = await sharedXObjectFile("compartido.pdf");
    const session = soloSession(file, { textEdits: [BLOCK("Importe nuevo")] });
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    const { blob, edits } = await runDocumentJobDetailed(job);
    expect(edits?.removed).toBe(0);
    expect(edits?.remains).toEqual([
      { editId: "b-Importe nuevo", pageIndex: 0, excerpt: "Importe nuevo", reason: "shared-xobject" },
    ]);
    expect((await inspect(blob)).text).toContain("Importe nuevo");
  });

  it("sin ediciones de texto no hay informe (y runDocumentJob sigue devolviendo solo el Blob)", async () => {
    const file = await pdfWith("Original");
    const job = await prepareDocumentJob(docIdOf(file), file, soloSession(file, {}), CONTEXT);
    expect((await runDocumentJobDetailed(job)).edits).toBeNull();
    expect(await runDocumentJob(job)).toBeInstanceOf(Blob);
  });

  it("solo ediciones (sin firma estampada) tambien lleva informe", async () => {
    const file = await pdfWith("Original");
    const session = soloSession(file, { rect: { x: 0, y: 0, width: 0, height: 0 }, textEdits: [BLOCK("Solo edicion")] });
    const job = await prepareDocumentJob(docIdOf(file), file, session, CONTEXT);
    expect((await runDocumentJobDetailed(job)).edits).toMatchObject({ replaced: 1, removed: 1 });
  });
});

describe("documentResult — la pantalla de resultado de UN documento", () => {
  const blob = new Blob(["x"], { type: "application/pdf" });
  const FILE = new File(["x"], "Contrato.pdf", { type: "application/pdf" });
  const report = (remains: number) => ({
    replaced: 2,
    added: 0,
    removed: 2 - remains,
    remains: Array.from({ length: remains }, (_, index) => ({
      editId: `e${index}`,
      pageIndex: index,
      excerpt: `Texto ${index + 1}`,
      reason: "type3" as const,
    })),
    warnings: {
      fontSubstituted: 0,
      glyphMissing: 0,
      originalRemains: 0,
      originalRemoved: 0,
      backgroundNotUniform: 0,
      overlap: 0,
      mixedStyle: 0,
      coverOverlaps: 0,
      flattenDrops: null,
      skipped: 0,
    },
  });

  it("sin ediciones: el resultado de siempre (nombre y blob; ni resumen ni avisos)", () => {
    const result = documentResult({ blob, edits: null, file: FILE, editedOnly: false, prefix: null, language: "es", strings });
    expect(result).toEqual({ blob, filename: "Contrato-firmado.pdf" });
    expect("summary" in result).toBe(false);
    expect("notices" in result).toBe(false);
  });

  it("todo quitado: resumen «N textos editados: el original se elimino del archivo» y sin avisos", () => {
    const result = documentResult({ blob, edits: report(0), file: FILE, editedOnly: false, prefix: null, language: "es", strings });
    expect(result.summary).toBe("2 textos editados: el original se eliminó del archivo.");
    expect(result.notices).toBeUndefined();
    expect(result.filename).toBe("Contrato-firmado.pdf");
  });

  it("con uno que permanece: aviso por bloque con el motivo y la salida; en ingles tambien", () => {
    const es = documentResult({ blob, edits: report(1), file: FILE, editedOnly: true, prefix: null, language: "es", strings });
    expect(es.filename).toBe("Contrato-editado.pdf");
    expect(es.summary).toBe(
      "2 textos editados: el original se eliminó de 1 y no se pudo quitar de 1 (más abajo, por qué).",
    );
    expect(es.notices?.title).toBe("Sobre el texto editado");
    expect(es.notices?.items[0]).toMatch(/^Página 1, «Texto 1»: el original sigue bajo la edición\. .*Type 3/);
    expect(es.notices?.items[1]).toMatch(/«Aplanar página»/);
    const en = documentResult({ blob, edits: report(1), file: FILE, editedOnly: false, prefix: null, language: "en", strings: SIGN_STRINGS.en });
    expect(en.summary).toMatch(/^2 texts edited: the original was removed from 1/);
    expect(en.notices?.items[0]).toMatch(/^Page 1, “Texto 1”: the original is still under the edit\./);
  });

  it("el prefijo de los firmantes sigue delante del nombre", () => {
    const result = documentResult({ blob, edits: report(0), file: FILE, editedOnly: false, prefix: "Ana", language: "es", strings });
    expect(result.filename).toBe("Ana_Contrato-firmado.pdf");
  });
});

describe("entrega conjunta (ZIP): el resumen cuenta todos los documentos", () => {
  async function sessionFor(files: File[], edits: Record<string, TextEdit[]>): Promise<SignSession> {
    const ids = files.map((file) => docIdOf(file));
    let session: SignSession = { ...DEFAULT_SESSION, mode: "single", signaturePng: PNG_URL, ratio: 0.5, docOrder: ids, activeDocId: ids[0] };
    const rect = { x: 0.2, y: 0.6, width: 0.3, height: 0.15 };
    files.forEach((file, index) => {
      session = {
        ...session,
        ...applyViewPatch(session, ids[index], { textEdits: edits[file.name], rect, pageIndex: 0 }, ids),
      };
    });
    return session;
  }

  it("un documento limpio y otro con el original compartido: «de 1 y no se pudo quitar de 1», con el nombre del documento", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await sharedXObjectFile("b.pdf");
    const session = await sessionFor([a, b], {
      "a.pdf": [BLOCK("Edicion A")],
      "b.pdf": [BLOCK("Edicion B", { id: "b2" })],
    });
    const result = await signDocumentsBatch({ files: [a, b], session, onProgress: () => {}, context: CONTEXT });
    expect(result.summary).toBe(
      "2 textos editados en 2 documentos: el original se eliminó de 1 y no se pudo quitar de 1 (más abajo, por qué).",
    );
    expect(result.notices?.title).toBe("Sobre el texto editado");
    expect(result.notices?.items[0]).toMatch(/^b\.pdf, página 1, «Edicion B»: el original sigue bajo la edición\./);
    expect(result.notices?.items.at(-1)).toMatch(/«Aplanar página»/);
    // El ZIP sigue siendo el de siempre.
    expect(result.report!.ok.map((item) => item.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(result.report!.failed).toEqual([]);
  });

  it("todo quitado en los dos: solo resumen, sin lista de avisos", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await pdfWith("Dos", "b.pdf");
    const session = await sessionFor([a, b], { "a.pdf": [BLOCK("Edicion A")], "b.pdf": [BLOCK("Edicion B")] });
    const result = await signDocumentsBatch({ files: [a, b], session, onProgress: () => {}, context: CONTEXT });
    expect(result.summary).toBe("2 textos editados en 2 documentos: el original se eliminó de los archivos.");
    expect(result.notices).toBeUndefined();
  });

  it("sin ediciones en ningun documento: el resultado de siempre, sin resumen ni avisos", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await pdfWith("Dos", "b.pdf");
    const session = await sessionFor([a, b], { "a.pdf": [], "b.pdf": [] });
    const result = await signDocumentsBatch({ files: [a, b], session, onProgress: () => {}, context: CONTEXT });
    expect("summary" in result).toBe(false);
    expect("notices" in result).toBe(false);
  });

  it("el nombre del documento va aunque solo uno del ZIP traiga ediciones", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const b = await sharedXObjectFile("b.pdf");
    const session = await sessionFor([a, b], { "a.pdf": [], "b.pdf": [BLOCK("Solo B")] });
    const result = await signDocumentsBatch({ files: [a, b], session, onProgress: () => {}, context: CONTEXT });
    expect(result.summary).toBe("1 texto editado: no se pudo quitar el original (más abajo, por qué).");
    expect(result.notices?.items[0]).toMatch(/^b\.pdf, página 1/);
  });

  it("un documento que falla no cuenta en el resumen", async () => {
    const a = await pdfWith("Uno", "a.pdf");
    const broken = new File([new Uint8Array([1, 2, 3])], "roto.pdf", { type: "application/pdf" });
    const session = await sessionFor([a, broken], { "a.pdf": [BLOCK("Edicion A")], "roto.pdf": [BLOCK("Edicion R")] });
    const result = await signDocumentsBatch({ files: [a, broken], session, onProgress: () => {}, context: CONTEXT });
    expect(result.report!.failed.map((item) => item.name)).toEqual(["roto.pdf"]);
    expect(result.summary).toBe("1 texto editado: el original se eliminó del archivo.");
  });
});
