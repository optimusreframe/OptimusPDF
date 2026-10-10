import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { makeEdit } from "@/app/edit-pdf/editTestUtils";
import {
  isEditOnlyJob,
  prepareDocumentJob,
  runDocumentJob,
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
