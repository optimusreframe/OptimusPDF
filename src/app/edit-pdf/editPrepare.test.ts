import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
} from "@cantoo/pdf-lib";
import { countFormFields, inspectStructure, prepareEditDocument } from "@/app/edit-pdf/editPrepare";
import { decryptPdfCopy } from "@/lib/pdf/unlock";

/**
 * Preparacion del documento (W5-U5) con PDFs REALES: cifrado (contrasena de
 * usuario, solo de propietario), firma digital activa, formularios y archivos
 * danados. Nada se simula: se generan con pdf-lib y se pasan como `File`.
 */

async function basePdf(pages = 1): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    doc.addPage([300, 300]).drawText(`Pagina ${i + 1}`, { x: 20, y: 250, size: 14, font });
  }
  return doc;
}

async function toFile(doc: PDFDocument, name = "doc.pdf"): Promise<File> {
  return new File([(await doc.save()) as BlobPart], name, { type: "application/pdf" });
}

async function signedDoc(): Promise<PDFDocument> {
  const doc = await basePdf();
  const ctx = doc.context;
  const sig = PDFDict.withContext(ctx);
  sig.set(PDFName.of("Type"), PDFName.of("Sig"));
  const field = PDFDict.withContext(ctx);
  field.set(PDFName.of("FT"), PDFName.of("Sig"));
  field.set(PDFName.of("V"), ctx.register(sig));
  field.set(PDFName.of("T"), PDFString.of("Firma1"));
  const fields = PDFArray.withContext(ctx);
  fields.push(ctx.register(field));
  const acro = PDFDict.withContext(ctx);
  acro.set(PDFName.of("Fields"), fields);
  acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  doc.catalog.set(PDFName.of("AcroForm"), ctx.register(acro));
  return doc;
}

describe("prepareEditDocument", () => {
  it("un PDF normal queda listo, sin firmas ni formularios, y es el mismo archivo", async () => {
    const file = await toFile(await basePdf());
    const result = await prepareEditDocument(file);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.document.file).toBe(file);
    expect(result.document.wasEncrypted).toBe(false);
    expect(result.document.signatures).toBe("none");
    expect(result.document.formFields).toBe(0);
  });

  it("cifrado SOLO de propietario (se abre con la contrasena vacia): copia de trabajo sin cifrado", async () => {
    const doc = await basePdf(2);
    doc.encrypt({ userPassword: "", ownerPassword: "owner", permissions: { copying: false } });
    const file = await toFile(doc, "protegido.pdf");
    const result = await prepareEditDocument(file);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.document.wasEncrypted).toBe(true);
    expect(result.document.file).not.toBe(file);
    expect(result.document.file.name).toBe("protegido.pdf");
    // La copia se abre SIN contrasena con la carga estricta.
    const reloaded = await PDFDocument.load(new Uint8Array(await result.document.file.arrayBuffer()));
    expect(reloaded.getPageCount()).toBe(2);
  });

  it("contrasena de usuario real: pide contrasena, no abre nada", async () => {
    const doc = await basePdf();
    doc.encrypt({ userPassword: "secreto", ownerPassword: "owner" });
    const result = await prepareEditDocument(await toFile(doc));
    expect(result).toEqual({ status: "password" });
  });

  it("contrasena equivocada: wrongPassword (no es un error generico)", async () => {
    const doc = await basePdf();
    doc.encrypt({ userPassword: "secreto", ownerPassword: "owner" });
    const result = await prepareEditDocument(await toFile(doc), "mala");
    expect(result).toEqual({ status: "wrongPassword" });
  });

  it("contrasena correcta: copia sin cifrado con las paginas del original", async () => {
    const doc = await basePdf(3);
    doc.encrypt({ userPassword: "secreto", ownerPassword: "owner" });
    const result = await prepareEditDocument(await toFile(doc), "secreto");
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.document.wasEncrypted).toBe(true);
    const reloaded = await PDFDocument.load(new Uint8Array(await result.document.file.arrayBuffer()));
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("firma digital activa: signatures = active", async () => {
    const result = await prepareEditDocument(await toFile(await signedDoc()));
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.document.signatures).toBe("active");
  });

  it("formulario: cuenta los campos que NO son de firma", async () => {
    const doc = await basePdf();
    const form = doc.getForm();
    form.createTextField("nombre").addToPage(doc.getPage(0), { x: 20, y: 100, width: 100, height: 20 });
    form.createCheckBox("acepto").addToPage(doc.getPage(0), { x: 20, y: 60, width: 14, height: 14 });
    const result = await prepareEditDocument(await toFile(doc));
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.document.formFields).toBe(2);
  });

  it("un campo de firma no cuenta como campo de formulario", async () => {
    const bytes = new Uint8Array(await (await toFile(await signedDoc())).arrayBuffer());
    expect(await countFormFields(bytes)).toBe(0);
  });

  it("un archivo que no es PDF da un error tipado, no una excepcion", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6])], "roto.pdf", { type: "application/pdf" });
    const result = await prepareEditDocument(file);
    expect(result.status).toBe("error");
  });

  it("un archivo vacio da un error tipado", async () => {
    const result = await prepareEditDocument(new File([], "vacio.pdf"));
    expect(result.status).toBe("error");
  });
});

describe("decryptPdfCopy", () => {
  it("un documento sin cifrar se devuelve igual", async () => {
    const file = await toFile(await basePdf());
    const blob = await decryptPdfCopy(file, "");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });

  it("no toca las firmas: una firma activa sigue ahi tras descifrar", async () => {
    const doc = await signedDoc();
    doc.encrypt({ userPassword: "", ownerPassword: "owner" });
    const file = await toFile(doc);
    const result = await prepareEditDocument(file);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.document.wasEncrypted).toBe(true);
      expect(result.document.signatures).toBe("active");
    }
  });
});

describe("inspectStructure y flattenLoss (W5-U5)", () => {
  it("un PDF con formulario: flattenLoss.forms; sin nada: null", async () => {
    const doc = await basePdf();
    doc.getForm().createTextField("nombre").addToPage(doc.getPage(0), { x: 20, y: 100, width: 100, height: 20 });
    const withForm = await prepareEditDocument(await toFile(doc));
    expect(withForm.status === "ready" && withForm.document.flattenLoss).toEqual({ forms: true, outlines: false });
    const plain = await prepareEditDocument(await toFile(await basePdf()));
    expect(plain.status === "ready" && plain.document.flattenLoss).toBeNull();
  });

  it("marcadores: flattenLoss.outlines", async () => {
    const doc = await basePdf();
    const ctx = doc.context;
    const item = PDFDict.withContext(ctx);
    const itemRef = ctx.register(item);
    const root = PDFDict.withContext(ctx);
    root.set(PDFName.of("First"), itemRef);
    root.set(PDFName.of("Last"), itemRef);
    doc.catalog.set(PDFName.of("Outlines"), ctx.register(root));
    const bytes = new Uint8Array(await (await toFile(doc)).arrayBuffer());
    expect((await inspectStructure(bytes)).flattenLoss).toEqual({ forms: false, outlines: true });
  });

  it("bytes inservibles: ni formularios ni perdidas, sin lanzar", async () => {
    expect(await inspectStructure(new Uint8Array([1, 2, 3]))).toEqual({ formFields: 0, flattenLoss: null });
  });
});
