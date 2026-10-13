import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { applyPageAssembly, identityPlan, type PageEntry } from "@/lib/pdf/pageAssembly";
import { countSignedSignatures } from "@/lib/pdf/pageAssemblyStructure";
import { splitDocument } from "@/lib/pdf/pageAssemblyExport";
import { mergePdfFilesWithReport } from "@/lib/pdf/merge";
import { organizePdfWithReport } from "@/lib/pdf/organize";
import { removePdfPagesWithReport } from "@/lib/pdf/removePages";
import { inspectPdf, makeRichPdf } from "@/lib/pdf/testing/pageAssemblyFixtures";

/**
 * Firmas digitales: reescribir un PDF las invalida (cubren los bytes exactos del archivo firmado). El motor
 * no puede conservarlas, asi que CUENTA las que siguen en el resultado (`signaturesInvalidated`) y las que no
 * se copian a otro documento: las FIRMAS YA APLICADAS (`signedSignaturesRemoved`) y los campos de firma VACIOS
 * (`signatureFieldsRemoved`), que no son lo mismo. Un campo de firma SIN firmar no invalida nada.
 */

const existing = (sourceIndex: number): PageEntry => ({ kind: "existing", sourceIndex, rotation: 0 });
const external = (sourceId: string, sourceIndex: number): PageEntry => ({
  kind: "external",
  sourceId,
  sourceIndex,
  rotation: 0,
});

function toFile(bytes: Uint8Array, name = "doc.pdf"): File {
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

describe("firmas ya aplicadas en el documento actual", () => {
  it("reordenar un documento firmado avisa de que la firma deja de ser valida (y el campo sigue)", async () => {
    const bytes = await makeRichPdf({ pages: 3, signedSignature: true });
    const result = await applyPageAssembly(bytes, [existing(1), existing(0), existing(2)]);
    expect(result.warnings).toEqual([{ code: "signaturesInvalidated", count: 1 }]);
    expect((await inspectPdf(result.bytes)).fieldNames).toContain("firma");
  });

  it("solo girar una pagina tambien invalida la firma", async () => {
    const result = await applyPageAssembly(
      await makeRichPdf({ pages: 2, signedSignature: true }),
      identityPlan(2).map((entry, index) => (index === 0 ? { ...entry, rotation: 90 } : entry)),
    );
    expect(result.warnings).toContainEqual({ code: "signaturesInvalidated", count: 1 });
  });

  it("si se quita la pagina de la firma, la firma ya no esta y no se avisa de invalidez (si del campo quitado)", async () => {
    const result = await applyPageAssembly(await makeRichPdf({ pages: 3, signedSignature: true }), [existing(1), existing(2)]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("signaturesInvalidated");
    expect(result.warnings).toContainEqual({ code: "formFieldsRemoved", count: 1 });
    expect((await inspectPdf(result.bytes)).fieldNames).not.toContain("firma");
  });

  it("un campo de firma SIN firmar no invalida nada", async () => {
    const result = await applyPageAssembly(await makeRichPdf({ pages: 3, signatureField: true }), [existing(2), existing(0)]);
    expect(result.warnings).toEqual([]);
  });

  it("un documento sin firmas ni campos no avisa de nada", async () => {
    const result = await applyPageAssembly(await makeRichPdf({ pages: 3, form: true }), [existing(2), existing(0)]);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["formFieldsRemoved"]);
  });

  it("dos firmas aplicadas se cuentan las dos; un widget hijo de un campo no cuenta como otra firma", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 3, signedSignature: true }));
    const context = document.context;
    const fields = document.getForm().acroForm.dict.lookup(PDFName.of("Fields"), PDFArray);
    // Segundo campo firmado, con la firma en el campo (padre) y el widget como hijo suyo.
    const sigValue = context.register(context.obj({ Type: "Sig", Filter: "Adobe.PPKLite", Contents: PDFString.of("x") }));
    const parent = context.register(context.obj({ FT: "Sig", T: PDFString.of("firma-2"), V: sigValue }));
    const widget = context.register(
      context.obj({ Type: "Annot", Subtype: "Widget", Rect: [10, 10, 60, 30], F: 4, Parent: parent, P: document.getPage(1).ref }),
    );
    (context.lookup(parent, PDFDict)).set(PDFName.of("Kids"), context.obj([widget]));
    document.getPage(1).node.addAnnot(widget);
    fields.push(parent);
    expect(countSignedSignatures(context, document.catalog)).toBe(2);
    const result = await applyPageAssembly(await document.save(), [existing(1), existing(0)]);
    expect(result.warnings).toContainEqual({ code: "signaturesInvalidated", count: 2 });
  });
});

describe("firmas en las paginas de otro PDF (Unir)", () => {
  it("el campo de firma de un archivo anadido no se copia y se cuenta; el resultado no lo lleva", async () => {
    const other = await makeRichPdf({ pages: 2, form: true, signedSignature: true });
    const result = await applyPageAssembly(await makeRichPdf({ pages: 1 }), [existing(0), external("x", 0)], { x: other });
    // Es una firma YA APLICADA, no un campo vacio.
    expect(result.warnings).toContainEqual({ code: "signedSignaturesRemoved", count: 1 });
    expect(result.warnings.map((warning) => warning.code)).not.toContain("signatureFieldsRemoved");
    expect(result.warnings.map((warning) => warning.code)).not.toContain("signaturesInvalidated");
    expect((await inspectPdf(result.bytes)).fieldNames).not.toContain("firma");
  });

  it("firma en el primer archivo y en el segundo: invalidada la del primero, no copiada la del segundo", async () => {
    const result = await mergePdfFilesWithReport([
      toFile(await makeRichPdf({ pages: 2, signedSignature: true }), "a.pdf"),
      toFile(await makeRichPdf({ pages: 2, signedSignature: true }), "b.pdf"),
    ]);
    expect(result.warnings).toContainEqual({ code: "signaturesInvalidated", count: 1 });
    expect(result.warnings).toContainEqual({ code: "signedSignaturesRemoved", count: 1 });
  });

  it("si la pagina con la firma del segundo archivo no se une, no hay nada que avisar", async () => {
    const files = [
      toFile(await makeRichPdf({ pages: 2 }), "a.pdf"),
      toFile(await makeRichPdf({ pages: 3, signedSignature: true }), "b.pdf"),
    ];
    const pages = [
      { id: "0:0", fileIndex: 0, pageIndex: 0, rotation: 0, selected: true },
      { id: "0:1", fileIndex: 0, pageIndex: 1, rotation: 0, selected: true },
      { id: "1:0", fileIndex: 1, pageIndex: 0, rotation: 0, selected: false },
      { id: "1:1", fileIndex: 1, pageIndex: 1, rotation: 0, selected: true },
    ];
    const result = await mergePdfFilesWithReport(files, { pages });
    expect(result.warnings).toEqual([]);
  });

  it("campo vacio y firma ya aplicada se cuentan POR SEPARADO (D7): cada uno con su codigo", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 2, signedSignature: true }));
    const context = document.context;
    const fields = document.getForm().acroForm.dict.lookup(PDFName.of("Fields"), PDFArray);
    // Un segundo campo de firma, VACIO, en la pagina 2.
    const empty = context.register(
      context.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        T: PDFString.of("firma-vacia"),
        Rect: [10, 10, 60, 30],
        F: 4,
        P: document.getPage(1).ref,
      }),
    );
    document.getPage(1).node.addAnnot(empty);
    fields.push(empty);
    const result = await applyPageAssembly(await makeRichPdf({ pages: 1 }), [existing(0), external("x", 0), external("x", 1)], {
      x: await document.save(),
    });
    expect(result.warnings).toContainEqual({ code: "signedSignaturesRemoved", count: 1 });
    expect(result.warnings).toContainEqual({ code: "signatureFieldsRemoved", count: 1 });
  });

  it("un campo de firma sin firmar de un archivo anadido tambien se cuenta como no copiado", async () => {
    const result = await mergePdfFilesWithReport([
      toFile(await makeRichPdf({ pages: 1 }), "a.pdf"),
      toFile(await makeRichPdf({ pages: 1, signatureField: true }), "b.pdf"),
    ]);
    expect(result.warnings).toEqual([{ code: "signatureFieldsRemoved", count: 1 }]);
  });
});

describe("firmas en las herramientas sueltas", () => {
  it("removePdfPagesWithReport: firma en una pagina que se queda", async () => {
    const result = await removePdfPagesWithReport(toFile(await makeRichPdf({ pages: 4, signedSignature: true })), { remove: [3] });
    expect(result.warnings).toEqual([{ code: "signaturesInvalidated", count: 1 }]);
  });

  it("organizePdfWithReport: firma en una pagina que se queda", async () => {
    const result = await organizePdfWithReport(toFile(await makeRichPdf({ pages: 2, signedSignature: true })), [
      { kind: "existing", page: 2, rotation: 0 },
      { kind: "existing", page: 1, rotation: 0 },
    ]);
    expect(result.warnings).toEqual([{ code: "signaturesInvalidated", count: 1 }]);
  });

  it("dividir en varias partes: el campo de firma no viaja a las partes y se cuenta una vez", async () => {
    const outcome = await splitDocument(await makeRichPdf({ pages: 4, signedSignature: true }), [[0, 1], [2, 3]], "doc");
    expect(outcome.warnings).toContainEqual({ code: "signedSignaturesRemoved", count: 1 });
    expect(outcome.warnings.map((warning) => warning.code)).not.toContain("signatureFieldsRemoved");
    const zip = await JSZip.loadAsync(outcome.bytes);
    for (const name of outcome.names) {
      expect((await inspectPdf(await zip.file(name)!.async("uint8array"))).fieldNames).not.toContain("firma");
    }
  });

  it("el campo de firma de una pagina que NO sale en ninguna parte no se cuenta", async () => {
    const outcome = await splitDocument(await makeRichPdf({ pages: 4, signedSignature: true }), [[1], [2, 3]], "doc");
    expect(outcome.warnings.map((warning) => warning.code)).not.toContain("signedSignaturesRemoved");
    expect(outcome.warnings.map((warning) => warning.code)).not.toContain("signatureFieldsRemoved");
  });

  it("`countSignedSignatures` lee 0 sin formulario y con un campo de firma cuyo valor no es un diccionario", async () => {
    const document = await PDFDocument.load(await makeRichPdf({ pages: 2 }));
    expect(countSignedSignatures(document.context, document.catalog)).toBe(0);
    const dangling = await PDFDocument.load(await makeRichPdf({ pages: 2 }));
    dangling.catalog.set(PDFName.of("AcroForm"), dangling.context.obj({ Fields: [dangling.context.obj({ FT: "Sig", V: 5 })] }));
    expect(countSignedSignatures(dangling.context, dangling.catalog)).toBe(0);
  });
});
