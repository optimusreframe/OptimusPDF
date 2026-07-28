import { describe, expect, it } from "vitest";
import { PDFDocument } from "@cantoo/pdf-lib";
import {
  DEFAULT_REDACT_OPTIONS,
  MIN_BOX_SIDE,
  redactPdf,
  sanitizeBox,
  type RedactBox,
} from "@/lib/pdf/redact";
import { PdfError } from "@/lib/pdf/core";

/**
 * LIMITACION DE ENTORNO (leer antes de tocar este archivo):
 *
 * `redactPdf` aplana la pagina censurada rasterizandola con pdf.js
 * (`openPdfDocument` + `renderPageToCanvas`, via `@/lib/pdf/core`), lo que
 * exige `DOMMatrix` y un `document.createElement("canvas")` reales. Este
 * proyecto ejecuta Vitest con `environment: "node"` (ver
 * `vitest.config.ts`) y SIN `jsdom`/`canvas` (paquete npm) instalados.
 *
 * Comprobado en este entorno: al llamar `redactPdf` con cajas validas
 * sobre un PDF valido, la propia apertura de pdf.js lanza
 * `ReferenceError: DOMMatrix is not defined` (capturado y reempaquetado
 * como `PdfError("unknown", ...)` por `toPdfError`). Es decir: NINGUNA
 * llamada a `redactPdf` que llegue a rasterizar una pagina puede
 * ejecutarse aqui, ni en exito ni en fallo con codigo significativo.
 *
 * Por eso esta suite se limita a lo que SI es verificable sin pdf.js/DOM:
 * 1) la funcion pura `sanitizeBox` (exportada), con todos sus casos de
 *    recorte/descarte;
 * 2) las rutas de error de `redactPdf` que ocurren ANTES de tocar pdf.js
 *    (censura vacia, archivo corrupto/vacio) — se verifico con un probe
 *    dedicado que estas rutas en efecto se resuelven sin llegar a
 *    `openPdfDocument`.
 *
 * La propiedad de seguridad central del motor — que el texto/pixeles
 * censurados NO sean recuperables en la pagina de salida, a diferencia de
 * un rectangulo dibujado encima — requiere renderizar la pagina de verdad
 * (pdf.js + canvas 2D) y no se puede comprobar en este entorno sin anadir
 * `jsdom` + el paquete `canvas` (o un shim equivalente) como
 * devDependency, cambio que excede el alcance de "solo anadir archivos de
 * test" de esta tarea. Se reporta como bloqueador en vez de simularlo con
 * mocks de la propia rasterizacion, que darian una falsa sensacion de
 * cobertura de la propiedad de seguridad sin comprobarla de verdad.
 */

async function createDocument(pageCount = 1): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([300, 300]);
  }
  return document;
}

async function toFile(document: PDFDocument, name = "test.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

function box(overrides: Partial<RedactBox> = {}): RedactBox {
  return { id: "b1", pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.2, ...overrides };
}

describe("sanitizeBox — src/lib/pdf/redact.ts", () => {
  it("deja intacta una caja ya normalizada dentro de la pagina", () => {
    const input = box({ x: 0.2, y: 0.3, width: 0.1, height: 0.15 });
    expect(sanitizeBox(input)).toEqual(input);
  });

  it("recorta al limite derecho/inferior de la pagina (0..1) cuando la caja se sale", () => {
    const result = sanitizeBox(box({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }));
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(0.9);
    expect(result!.y).toBeCloseTo(0.9);
    expect(result!.width).toBeCloseTo(0.1);
    expect(result!.height).toBeCloseTo(0.1);
  });

  it("recorta coordenadas negativas a 0", () => {
    const result = sanitizeBox(box({ x: -0.5, y: -0.2, width: 0.3, height: 0.3 }));
    expect(result).not.toBeNull();
    expect(result!.x).toBe(0);
    expect(result!.y).toBe(0);
  });

  it("normaliza ancho/alto negativos (esquina invertida) sin perder el area", () => {
    // x=0.5, width=-0.2 equivale a un rectangulo que va de 0.3 a 0.5.
    const result = sanitizeBox(box({ x: 0.5, y: 0.5, width: -0.2, height: -0.2 }));
    expect(result).not.toBeNull();
    expect(result!.x).toBeCloseTo(0.3);
    expect(result!.y).toBeCloseTo(0.3);
    expect(result!.width).toBeCloseTo(0.2);
    expect(result!.height).toBeCloseTo(0.2);
  });

  it("descarta (null) una caja mas angosta que MIN_BOX_SIDE", () => {
    expect(sanitizeBox(box({ width: MIN_BOX_SIDE / 2 }))).toBeNull();
  });

  it("descarta (null) una caja mas baja que MIN_BOX_SIDE", () => {
    expect(sanitizeBox(box({ height: MIN_BOX_SIDE / 2 }))).toBeNull();
  });

  it("descarta (null) una caja de ancho/alto cero", () => {
    expect(sanitizeBox(box({ width: 0, height: 0 }))).toBeNull();
  });

  it("conserva el pageIndex y el id originales", () => {
    const result = sanitizeBox(box({ id: "custom-id", pageIndex: 7 }));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("custom-id");
    expect(result!.pageIndex).toBe(7);
  });

  it("una caja exactamente del tamano de la pagina completa (0,0,1,1) sobrevive", () => {
    const result = sanitizeBox(box({ x: 0, y: 0, width: 1, height: 1 }));
    expect(result).toEqual({ id: "b1", pageIndex: 0, x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("redactPdf — rutas de error previas a pdf.js — src/lib/pdf/redact.ts", () => {
  it("sin cajas (DEFAULT_REDACT_OPTIONS) lanza PdfError('empty') sin abrir el archivo", async () => {
    const file = await toFile(await createDocument());
    await expect(redactPdf(file, DEFAULT_REDACT_OPTIONS)).rejects.toBeInstanceOf(PdfError);
    await expect(redactPdf(file, DEFAULT_REDACT_OPTIONS)).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("cajas todas degeneradas (recortadas a null por sanitizeBox) equivalen a 'sin cajas' -> 'empty'", async () => {
    const file = await toFile(await createDocument());
    const options = { boxes: [box({ width: 0.0001, height: 0.0001 })] };
    await expect(redactPdf(file, options)).rejects.toMatchObject({ code: "empty" });
  });

  it("archivo vacio (0 bytes) con cajas validas lanza PdfError('corrupt') antes de rasterizar", async () => {
    const empty = new File([], "empty.pdf", { type: "application/pdf" });
    await expect(redactPdf(empty, { boxes: [box()] })).rejects.toMatchObject({
      code: "corrupt",
    });
  });

  it("archivo con bytes invalidos (no-PDF) y cajas validas lanza PdfError('corrupt') antes de rasterizar", async () => {
    const garbage = new File([new Uint8Array([1, 2, 3, 4, 5])], "garbage.pdf", {
      type: "application/pdf",
    });
    await expect(redactPdf(garbage, { boxes: [box()] })).rejects.toMatchObject({
      code: "corrupt",
    });
  });
});
