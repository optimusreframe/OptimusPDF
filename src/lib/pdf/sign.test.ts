import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName } from "@cantoo/pdf-lib";
import { sha256Hex } from "@/lib/pdf/core";
import {
  buildSignerFilenamePrefix,
  dataUrlToBytes,
  normalizeFieldLabel,
  signPdf,
  signPdfMulti,
  signerDisplayName,
  type SignOptions,
} from "@/lib/pdf/sign";

/**
 * `dataUrlToBytes` usa `window.atob` (ver `sign.ts:42`). El entorno de
 * Vitest de este proyecto es `"node"` (sin DOM), asi que no existe
 * `window` de forma global. Este es el unico punto de `sign.ts` que toca
 * un global de navegador; se resuelve aqui, en el test, con un polyfill
 * minimo (`globalThis.window = globalThis`, que expone el `atob` global
 * que Node si trae) en vez de tocar el archivo fuente.
 */
(globalThis as unknown as { window: unknown }).window ??= globalThis;

/** PNG real de 1x1 pixel transparente, el fixture minimo que acepta `embedPng`. */
const MINIMAL_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function createDocument(pageCount = 1): Promise<PDFDocument> {
  const document = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) document.addPage([300, 300]);
  return document;
}

async function toFile(document: PDFDocument, name = "documento.pdf"): Promise<File> {
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

function basePlacement(pageIndex = 0) {
  return {
    pageIndex,
    rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 },
  };
}

describe("dataUrlToBytes — src/lib/pdf/sign.ts", () => {
  it("decodifica un data URL base64 a los bytes originales", () => {
    // "hola" en base64 es "aG9sYQ=="
    const bytes = dataUrlToBytes("data:text/plain;base64,aG9sYQ==");
    expect(Buffer.from(bytes).toString("utf-8")).toBe("hola");
  });

  it("lanza PdfError('invalidType') si no hay coma", () => {
    try {
      dataUrlToBytes("data:text/plain;base64");
      expect.unreachable("deberia haber lanzado");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("invalidType");
    }
  });

  it("lanza PdfError('invalidType') si no empieza por 'data:'", () => {
    try {
      dataUrlToBytes("not-a-data-url,aG9sYQ==");
      expect.unreachable("deberia haber lanzado");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("invalidType");
    }
  });
});

describe("signerDisplayName — src/lib/pdf/sign.ts", () => {
  const defaultName = (position: number) => `Firmante ${position}`;

  it("devuelve el nombre real cuando hay uno", () => {
    expect(signerDisplayName("Ana Perez", 0, defaultName)).toBe("Ana Perez");
  });

  it("devuelve el generico numerado cuando el nombre esta vacio", () => {
    expect(signerDisplayName("", 2, defaultName)).toBe("Firmante 3");
  });

  it("trata un nombre de solo espacios como vacio", () => {
    expect(signerDisplayName("   ", 0, defaultName)).toBe("Firmante 1");
  });

  it("recorta espacios sobrantes de un nombre real", () => {
    expect(signerDisplayName("  Ana  ", 0, defaultName)).toBe("Ana");
  });
});

describe("buildSignerFilenamePrefix — src/lib/pdf/sign.ts", () => {
  it("un solo nombre: el slug tal cual", () => {
    expect(buildSignerFilenamePrefix(["Ana Perez"])).toBe("ana-perez");
  });

  it("dos nombres: unidos con '_and_'", () => {
    expect(buildSignerFilenamePrefix(["Ana Perez", "Luis Gomez"])).toBe(
      "ana-perez_and_luis-gomez",
    );
  });

  it("tres o mas nombres: todos menos el ultimo unidos por '_', el ultimo con '_and_'", () => {
    expect(
      buildSignerFilenamePrefix(["Ana", "Luis", "Marta"]),
    ).toBe("ana_luis_and_marta");
  });

  it("quita acentos y caracteres especiales via slugify", () => {
    expect(buildSignerFilenamePrefix(["José Núñez"])).toBe("jose-nunez");
  });

  it("omite nombres vacios o solo espacios en vez de rellenarlos con un generico", () => {
    expect(buildSignerFilenamePrefix(["Ana", "", "  ", "Luis"])).toBe(
      "ana_and_luis",
    );
  });

  it("array vacio o solo nombres vacios: null (no ofrecer el prompt)", () => {
    expect(buildSignerFilenamePrefix([])).toBeNull();
    expect(buildSignerFilenamePrefix(["", "   "])).toBeNull();
  });
});

describe("normalizeFieldLabel — src/lib/pdf/sign.ts", () => {
  it("minusculas, sin acentos, puntuacion colapsada a un espacio", () => {
    expect(normalizeFieldLabel("Cliente/Asegurado:")).toBe("cliente asegurado");
  });

  it("dos etiquetas equivalentes normalizan a la misma clave", () => {
    expect(normalizeFieldLabel("Número de Póliza")).toBe(
      normalizeFieldLabel("numero de poliza"),
    );
  });

  it("recorta espacios sobrantes en los bordes", () => {
    expect(normalizeFieldLabel("  Nombre  ")).toBe("nombre");
  });
});

describe("signPdf — src/lib/pdf/sign.ts", () => {
  it("empotra la firma como imagen en la pagina indicada (aparece un XObject de imagen que antes no existia)", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    const options: SignOptions = { signaturePng: MINIMAL_PNG_DATA_URL, placement: basePlacement(0) };
    const blob = await signPdf(file, options);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });

    // No anade ni quita paginas: es una anotacion visual, no un documento nuevo.
    expect(signed.getPageCount()).toBe(1);

    const page = signed.getPages()[0];
    const resources = page.node.Resources();
    expect(resources).toBeDefined();
    const xObjects = resources?.lookup(PDFName.of("XObject"), PDFDict);
    expect(xObjects).toBeDefined();
    expect(xObjects!.keys().length).toBeGreaterThan(0);
  });

  it("reporta progreso creciente hasta 1", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);
    const progress: number[] = [];

    await signPdf(
      file,
      { signaturePng: MINIMAL_PNG_DATA_URL, placement: basePlacement(0) },
      (value) => progress.push(value),
    );

    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    }
  });

  it("un pageIndex fuera de rango (demasiado alto) se recorta a la ultima pagina, sin lanzar", async () => {
    const document = await createDocument(2);
    const file = await toFile(document);

    const blob = await signPdf(file, {
      signaturePng: MINIMAL_PNG_DATA_URL,
      placement: basePlacement(99),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });
    const lastPage = signed.getPages()[1];
    const xObjects = lastPage.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
    expect(xObjects?.keys().length ?? 0).toBeGreaterThan(0);
  });

  it("un pageIndex negativo se recorta a la primera pagina, sin lanzar", async () => {
    const document = await createDocument(2);
    const file = await toFile(document);

    const blob = await signPdf(file, {
      signaturePng: MINIMAL_PNG_DATA_URL,
      placement: basePlacement(-5),
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });
    const firstPage = signed.getPages()[0];
    const xObjects = firstPage.node.Resources()?.lookup(PDFName.of("XObject"), PDFDict);
    expect(xObjects?.keys().length ?? 0).toBeGreaterThan(0);
  });

  it("signaturePng vacio -> PdfError('empty')", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    await expect(
      signPdf(file, { signaturePng: "", placement: basePlacement(0) }),
    ).rejects.toMatchObject({ code: "empty" });
  });

  it("data URL invalido (sin cabecera 'data:') se traduce en PdfError('invalidType')", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    await expect(
      signPdf(file, { signaturePng: "no-es-un-data-url", placement: basePlacement(0) }),
    ).rejects.toMatchObject({ code: "invalidType" });
  });

  it("archivo vacio (0 bytes) -> PdfError('corrupt')", async () => {
    const empty = new File([], "vacio.pdf", { type: "application/pdf" });

    await expect(
      signPdf(empty, { signaturePng: MINIMAL_PNG_DATA_URL, placement: basePlacement(0) }),
    ).rejects.toMatchObject({ code: "corrupt" });
  });

  it("PDF cifrado sin contrasena -> PdfError('encrypted') (signPdf no descifra por si solo)", async () => {
    const document = await createDocument(1);
    document.encrypt({ userPassword: "clave1234", ownerPassword: "clave1234" });
    const file = await toFile(document, "cifrado.pdf");

    await expect(
      signPdf(file, { signaturePng: MINIMAL_PNG_DATA_URL, placement: basePlacement(0) }),
    ).rejects.toMatchObject({ code: "encrypted" });
  });
});

describe("signPdfMulti — placements de texto (Recomendacion #5: tipos de campo)", () => {
  it("empotra un placement de texto (aparece un recurso de fuente que antes no existia)", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [{ kind: "text", value: "Ana Perez", ...basePlacement(0) }],
    });

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });
    const page = signed.getPages()[0];
    const fonts = page.node.Resources()?.lookup(PDFName.of("Font"), PDFDict);
    expect(fonts).toBeDefined();
    expect(fonts!.keys().length).toBeGreaterThan(0);
  });

  it("un placement centrado (casilla marcada, \"X\") no revienta y empotra igual", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [
        { kind: "text", value: "X", align: "center", ...basePlacement(0) },
      ],
    });

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(signed.getPageCount()).toBe(1);
    const fonts = signed
      .getPages()[0]
      .node.Resources()
      ?.lookup(PDFName.of("Font"), PDFDict);
    expect(fonts!.keys().length).toBeGreaterThan(0);
  });

  it("un placement de texto vacio no empotra nada, sin lanzar", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [{ kind: "text", value: "   ", ...basePlacement(0) }],
    });

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(signed.getPageCount()).toBe(1);
  });
});

/**
 * Extrae el texto de una pagina ya generada, para comprobar de verdad
 * lo que se leeria en el certificado (no solo que "algun recurso de
 * fuente" aparecio). Misma tecnica que `detectFields.test.ts`: el build
 * legacy de pdf.js analiza sin DOM en Node.
 */
async function extractPageText(bytes: Uint8Array, pageNumber: number): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: bytes }).promise;
  const page = await document.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ");
}

const CERTIFICATE_LABELS = {
  title: "Certificado de finalización",
  hashLabel: "Hash SHA-256 del documento firmado",
  timestampLabel: "Fecha y hora",
  signersLabel: "Firmantes",
  noSignerName: "Sin nombre",
  disclaimer:
    "Esta página es solo trazabilidad informal: el hash permite comprobar que el documento no cambió después de firmarse. No es una firma electrónica cualificada ni certificada.",
};

describe("signPdfMulti — certificado de finalizacion (Recomendacion #6)", () => {
  it("sin `certificate`, el documento no gana ninguna pagina extra", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [{ kind: "text", value: "Ana Perez", ...basePlacement(0) }],
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(signed.getPageCount()).toBe(1);
  });

  it("con `certificate`, anade exactamente una pagina al final", async () => {
    const document = await createDocument(2);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [{ kind: "text", value: "Ana Perez", ...basePlacement(0) }],
      certificate: { signerNames: ["Ana Perez"], labels: CERTIFICATE_LABELS },
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const signed = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(signed.getPageCount()).toBe(3);
  });

  it("la pagina de certificado incluye el titulo, los firmantes y el aviso legal", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [{ kind: "text", value: "Ana Perez", ...basePlacement(0) }],
      certificate: {
        signerNames: ["Ana Perez", "Roberto Diaz"],
        labels: CERTIFICATE_LABELS,
      },
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = await extractPageText(bytes, 2);

    expect(text).toContain("Certificado de finalización");
    expect(text).toContain("Ana Perez");
    expect(text).toContain("Roberto Diaz");
    expect(text).toContain("trazabilidad informal");
  });

  it("sin firmantes con nombre, usa el texto de respaldo en vez de una linea vacia", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);

    const blob = await signPdfMulti(file, {
      placements: [{ kind: "text", value: "Ana Perez", ...basePlacement(0) }],
      certificate: { signerNames: [], labels: CERTIFICATE_LABELS },
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const text = await extractPageText(bytes, 2);

    expect(text).toContain("Sin nombre");
  });

  it("el hash que aparece en el certificado es el SHA-256 real del documento YA firmado (sin la propia pagina de certificado)", async () => {
    const document = await createDocument(1);
    const file = await toFile(document);
    const placements = [
      { kind: "text" as const, value: "Ana Perez", ...basePlacement(0) },
    ];

    // Genera el mismo documento firmado SIN certificado, para saber el
    // hash que el certificado deberia citar.
    const signedOnly = await signPdfMulti(file, { placements });
    const expectedHash = await sha256Hex(
      new Uint8Array(await signedOnly.arrayBuffer()),
    );

    const withCertificate = await signPdfMulti(file, {
      placements,
      certificate: { signerNames: ["Ana Perez"], labels: CERTIFICATE_LABELS },
    });
    const text = await extractPageText(
      new Uint8Array(await withCertificate.arrayBuffer()),
      2,
    );

    // El hash se parte en varias lineas de texto (linea de ~60 caracteres
    // hex): se comprueba que sus primeros caracteres aparecen literalmente.
    expect(text.replace(/\s+/g, "")).toContain(expectedHash.slice(0, 20));
  });
});
