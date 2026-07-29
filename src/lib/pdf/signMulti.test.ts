import { describe, expect, it } from "vitest";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
  degrees,
  type PDFPage,
} from "@cantoo/pdf-lib";
import { signPdfMulti, type SignPlacement } from "@/lib/pdf/sign";

/**
 * `signPdfMulti` no toca ningun global del navegador (recibe los PNG ya
 * decodificados), asi que se ejercita entero en el entorno "node" de
 * Vitest. Los casos mono-firma de `signPdf` siguen viviendo en
 * `sign.test.ts`.
 */

/** PNG real de 1x1 pixel transparente, el fixture minimo que acepta `embedPng`. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function png(): Uint8Array {
  return new Uint8Array(PNG_1X1);
}

async function toFile(
  document: PDFDocument,
  name = "documento.pdf",
): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, {
    type: "application/pdf",
  });
}

async function reload(blob: Blob): Promise<PDFDocument> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return PDFDocument.load(bytes, { updateMetadata: false });
}

function imageCount(page: PDFPage): number {
  const xObjects = page.node.Resources()?.lookup(PDFName.of("XObject"));
  return xObjects instanceof PDFDict ? xObjects.keys().length : 0;
}

/** Texto de los flujos de contenido de la pagina, ya descomprimidos. */
function contentStreamText(page: PDFPage): string {
  const contents = page.node.lookup(PDFName.of("Contents"));
  const parts =
    contents instanceof PDFArray
      ? contents.asArray().map((ref) => page.node.context.lookup(ref))
      : [contents];
  return parts
    .map((part) =>
      part instanceof PDFRawStream
        ? Buffer.from(decodePDFRawStream(part).decode()).toString("latin1")
        : "",
    )
    .join("\n");
}

type Matrix = [number, number, number, number, number, number];
type Point = { x: number; y: number };

function matrices(text: string): Matrix[] {
  const found: Matrix[] = [];
  const pattern =
    /(-?[\d.e-]+)\s+(-?[\d.e-]+)\s+(-?[\d.e-]+)\s+(-?[\d.e-]+)\s+(-?[\d.e-]+)\s+(-?[\d.e-]+)\s+cm/g;
  for (const match of text.matchAll(pattern)) {
    found.push(match.slice(1, 7).map(Number) as Matrix);
  }
  return found;
}

function applyMatrix(matrix: Matrix, point: Point): Point {
  const [a, b, c, d, e, f] = matrix;
  return {
    x: a * point.x + c * point.y + e,
    y: b * point.x + d * point.y + f,
  };
}

/**
 * Punto del espacio de la imagen (cuadrado unidad) llevado al espacio de
 * usuario de la pagina. En PDF cada `cm` premultiplica la CTM, asi que
 * las matrices se aplican de la ultima a la primera.
 */
function toUserSpace(list: Matrix[], point: Point): Point {
  let current = point;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    current = applyMatrix(list[index], current);
  }
  return current;
}

function placement(overrides: Partial<SignPlacement> = {}): SignPlacement {
  return {
    png: png(),
    pageIndex: 0,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
    ...overrides,
  };
}

describe("signPdfMulti — src/lib/pdf/sign.ts", () => {
  it("empotra varios campos en la misma pagina (un XObject y un `Do` por campo)", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [
        placement({ rect: { x: 0.05, y: 0.05, width: 0.3, height: 0.1 } }),
        placement({ rect: { x: 0.05, y: 0.4, width: 0.3, height: 0.1 } }),
        placement({ rect: { x: 0.5, y: 0.8, width: 0.2, height: 0.1 } }),
      ],
    });

    const signed = await reload(blob);
    const page = signed.getPages()[0];
    expect(signed.getPageCount()).toBe(1);
    expect(imageCount(page)).toBe(3);
    expect(contentStreamText(page).match(/\bDo\b/g)?.length).toBe(3);
  });

  it("reparte los campos por la pagina que indica cada uno, sin tocar las demas", async () => {
    const document = await PDFDocument.create();
    for (let index = 0; index < 3; index += 1) document.addPage([300, 400]);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [
        placement({ pageIndex: 0 }),
        placement({ pageIndex: 2 }),
        placement({ pageIndex: 2 }),
      ],
    });

    const pages = (await reload(blob)).getPages();
    expect(imageCount(pages[0])).toBe(1);
    expect(imageCount(pages[1])).toBe(0);
    expect(imageCount(pages[2])).toBe(2);
  });

  it("un pageIndex fuera de rango se recorta a una pagina real, sin lanzar", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]);
    document.addPage([300, 400]);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [placement({ pageIndex: 99 }), placement({ pageIndex: -5 })],
    });

    const pages = (await reload(blob)).getPages();
    expect(imageCount(pages[0])).toBe(1);
    expect(imageCount(pages[1])).toBe(1);
  });

  it("con /Rotate 90 la geometria compartida deja la firma recta y dentro de la pagina", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]).setRotation(degrees(90));
    const file = await toFile(document);

    // Vista girada: 400 de ancho x 300 de alto. El hueco mide 120x60 pt y
    // el PNG es cuadrado, asi que la firma encajada mide 60x60.
    const blob = await signPdfMulti(file, {
      placements: [
        placement({ rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 } }),
      ],
    });

    const page = (await reload(blob)).getPages()[0];
    const list = matrices(contentStreamText(page));
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ].map((corner) => toUserSpace(list, corner));

    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);

    // La caja envolvente cae entera dentro del MediaBox de 300x400.
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(300);
    expect(Math.max(...ys)).toBeLessThanOrEqual(400);

    // Cuadrada de 60 pt tras deshacer el giro: el /Rotate se compenso.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(60, 4);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(60, 4);

    // Centro esperado: el rectangulo de vista (0.25, 0.2 desde arriba)
    // deshecho el giro de 90 grados sobre una caja de 300x400.
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    expect(centerX).toBeCloseTo(60, 4);
    expect(centerY).toBeCloseTo(100, 4);
  });

  it("encaja el PNG dentro del hueco sin deformarlo cuando las proporciones no coinciden", async () => {
    const document = await PDFDocument.create();
    document.addPage([400, 400]);
    const file = await toFile(document);

    // Hueco de 200x40 pt para un PNG cuadrado: debe quedar 40x40.
    const blob = await signPdfMulti(file, {
      placements: [
        placement({ rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 } }),
      ],
    });

    const page = (await reload(blob)).getPages()[0];
    const corners = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ].map((corner) => toUserSpace(matrices(contentStreamText(page)), corner));

    expect(Math.abs(corners[1].x - corners[0].x)).toBeCloseTo(40, 4);
    expect(Math.abs(corners[1].y - corners[0].y)).toBeCloseTo(40, 4);
  });

  it("sin ningun campo -> PdfError('empty')", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]);
    const file = await toFile(document);

    await expect(
      signPdfMulti(file, { placements: [] }),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("reporta progreso monotono hasta 1 con varios campos", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]);
    document.addPage([300, 400]);
    const file = await toFile(document);
    const progress: number[] = [];

    await signPdfMulti(
      file,
      {
        placements: [
          placement({ pageIndex: 0 }),
          placement({ pageIndex: 1 }),
          placement({ pageIndex: 1 }),
        ],
      },
      (value) => progress.push(value),
    );

    expect(progress.length).toBeGreaterThan(3);
    expect(progress[progress.length - 1]).toBe(1);
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]);
    }
  });

  it("archivo vacio -> PdfError('corrupt')", async () => {
    const empty = new File([], "vacio.pdf", { type: "application/pdf" });

    await expect(
      signPdfMulti(empty, { placements: [placement()] }),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("PDF cifrado sin contrasena -> PdfError('encrypted')", async () => {
    const document = await PDFDocument.create();
    document.addPage([300, 400]);
    document.encrypt({ userPassword: "clave1234", ownerPassword: "clave1234" });
    const file = await toFile(document, "cifrado.pdf");

    await expect(
      signPdfMulti(file, { placements: [placement()] }),
    ).rejects.toMatchObject({ code: "encrypted" });
  });
});
