import { describe, expect, it } from "vitest";
import {
  EncryptedPDFError,
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
} from "@cantoo/pdf-lib";
import {
  INK_COLORS,
  MAX_SAFE_FILE_SIZE,
  PDF_FONT_FAMILIES,
  PdfError,
  classifyOcrError,
  classifyWebLlmError,
  formatFileSize,
  getPageGeometry,
  hexToPdfColor,
  isPdfFile,
  loadPdf,
  matchesAccept,
  normalizedRectToUserBox,
  originForCenter,
  readFileBytes,
  rotatedBounds,
  savePdfToBlob,
  scaleProgress,
  slugify,
  standardFontFor,
  throwIfAborted,
  toPdfError,
  toWinAnsiSafe,
  viewPointToUser,
  withSuffix,
} from "@/lib/pdf/core";

/**
 * `core.ts` es infraestructura compartida por todos los motores de
 * `src/lib/pdf/`: aqui se prueban sus utilidades directamente (no solo
 * de forma indirecta a traves de otro motor).
 *
 * IMPORTANTE (limitacion de entorno, ver README/limitaciones en el
 * reporte de esta suite): Vitest corre estos tests con `environment:
 * "node"`, sin `window`/`document`/`DOMMatrix`. Eso deja fuera de esta
 * suite, por construccion, a:
 *   - `downloadBlob` (usa `document.createElement("a")`, `URL.createObjectURL`, `window.setTimeout`)
 *   - `renderPageToCanvas` / `renderPageToDataUrl` (usan `document.createElement("canvas")`)
 *   - `getPdfJs` / `openPdfDocument` / `closePdfDocument` (pdf.js: se
 *     confirmo por experimentacion que su build por defecto revienta en
 *     Node con `ReferenceError: DOMMatrix is not defined`, y que incluso
 *     poniendo un shim de `DOMMatrix` el propio pdf.js avisa "Please use
 *     the `legacy` build in Node.js environments" y luego falla al
 *     resolver `PDF_WORKER_SRC` ("/pdf.worker.min.mjs") como ruta de
 *     modulo de Node en vez de URL servida por el navegador). Ninguna de
 *     las dos son cosas que un test pueda arreglar sin tocar `core.ts` o
 *     anadir dependencias nuevas (jsdom + `canvas`, o importar el build
 *     "legacy" de pdfjs-dist), asi que quedan fuera de alcance de esta
 *     tarea (solo tests, sin cambios de fuente ni dependencias nuevas).
 */

async function createDocument(pageSize: [number, number] = [300, 300]) {
  const document = await PDFDocument.create();
  document.addPage(pageSize);
  return document;
}

describe("PdfError / toPdfError — src/lib/pdf/core.ts", () => {
  it("toPdfError devuelve la misma instancia si ya es un PdfError", () => {
    const original = new PdfError("corrupt", "ya tipado");
    expect(toPdfError(original)).toBe(original);
  });

  it("toPdfError mapea EncryptedPDFError a code 'encrypted'", () => {
    const result = toPdfError(new EncryptedPDFError());
    expect(result).toBeInstanceOf(PdfError);
    expect(result.code).toBe("encrypted");
  });

  it("toPdfError detecta 'password'/'encrypt' en el mensaje -> 'encrypted'", () => {
    expect(toPdfError(new Error("Invalid password supplied")).code).toBe("encrypted");
    expect(toPdfError(new Error("document is Encrypted")).code).toBe("encrypted");
  });

  it("toPdfError detecta cabeceras/parseo invalido -> 'corrupt'", () => {
    expect(toPdfError(new Error("Invalid PDF structure")).code).toBe("corrupt");
    expect(toPdfError(new Error("No PDF header found")).code).toBe("corrupt");
    expect(toPdfError(new Error("Failed to parse PDF")).code).toBe("corrupt");
  });

  it("toPdfError cae a 'unknown' para cualquier otro Error", () => {
    expect(toPdfError(new Error("algo inesperado")).code).toBe("unknown");
  });

  it("toPdfError cae a 'unknown' para valores que no son Error", () => {
    expect(toPdfError("un string cualquiera").code).toBe("unknown");
    expect(toPdfError(undefined).code).toBe("unknown");
  });
});

describe("classifyOcrError — src/lib/pdf/core.ts", () => {
  it("devuelve el code de un PdfError ya tipado, sin reclasificar", () => {
    expect(classifyOcrError(new PdfError("cancelled"))).toBe("cancelled");
  });

  it("clasifica fallos de red (fetch de los activos de tesseract.js) como 'ocrNetworkFailure'", () => {
    expect(classifyOcrError(new TypeError("Failed to fetch"))).toBe(
      "ocrNetworkFailure",
    );
    expect(classifyOcrError(new Error("NetworkError when attempting to fetch resource"))).toBe(
      "ocrNetworkFailure",
    );
    expect(
      classifyOcrError(
        new Error("could not load worker from cdn.jsdelivr.net"),
      ),
    ).toBe("ocrNetworkFailure");
  });

  it("clasifica cualquier otro fallo como 'ocrEngineFailure' (nunca 'unknown')", () => {
    expect(classifyOcrError(new Error("RuntimeError: memory access out of bounds"))).toBe(
      "ocrEngineFailure",
    );
    expect(classifyOcrError("un string cualquiera")).toBe("ocrEngineFailure");
    expect(classifyOcrError(undefined)).toBe("ocrEngineFailure");
  });
});

describe("classifyWebLlmError — src/lib/pdf/core.ts", () => {
  it("devuelve el code de un PdfError ya tipado, sin reclasificar", () => {
    expect(classifyWebLlmError(new PdfError("empty"))).toBe("empty");
  });

  it("clasifica un AbortError (propio o de interruptGenerate) como 'cancelled'", () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    expect(classifyWebLlmError(abortError)).toBe("cancelled");
    expect(classifyWebLlmError(new Error("generation was aborted by user"))).toBe(
      "cancelled",
    );
  });

  it("clasifica perdida de dispositivo / falta de VRAM como 'deviceLost'", () => {
    expect(classifyWebLlmError(new Error("GPUDevice was lost: reason=unknown"))).toBe(
      "deviceLost",
    );
    expect(classifyWebLlmError(new Error("Out of memory allocating buffer"))).toBe(
      "deviceLost",
    );
  });

  it("clasifica un fallo de red descargando el modelo como 'modelDownloadFailure'", () => {
    expect(classifyWebLlmError(new TypeError("Failed to fetch"))).toBe(
      "modelDownloadFailure",
    );
    expect(
      classifyWebLlmError(
        new Error("fetch from huggingface.co timed out"),
      ),
    ).toBe("modelDownloadFailure");
  });

  it("deja cualquier otro fallo como 'unknown' (la interfaz muestra el texto tecnico real)", () => {
    expect(classifyWebLlmError(new Error("model returned empty summaries"))).toBe(
      "unknown",
    );
    expect(classifyWebLlmError("un string cualquiera")).toBe("unknown");
  });
});

describe("throwIfAborted — src/lib/pdf/core.ts", () => {
  it("no lanza si la senal no esta abortada", () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it("no lanza si no se pasa senal", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
  });

  it("lanza PdfError('cancelled') si la senal esta abortada", () => {
    const controller = new AbortController();
    controller.abort();
    try {
      throwIfAborted(controller.signal);
      expect.unreachable("deberia haber lanzado");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfError);
      expect((error as PdfError).code).toBe("cancelled");
    }
  });
});

describe("readFileBytes / isPdfFile / matchesAccept — src/lib/pdf/core.ts", () => {
  it("readFileBytes devuelve los bytes exactos de un Blob", async () => {
    const bytes = await readFileBytes(new Blob([new Uint8Array([1, 2, 3, 4])]));
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it("isPdfFile: true por mime type application/pdf", () => {
    const file = new File([new Uint8Array([1])], "cualquiera.bin", {
      type: "application/pdf",
    });
    expect(isPdfFile(file)).toBe(true);
  });

  it("isPdfFile: true por extension .pdf aunque el mime este vacio", () => {
    const file = new File([new Uint8Array([1])], "informe.PDF", { type: "" });
    expect(isPdfFile(file)).toBe(true);
  });

  it("isPdfFile: false para otros tipos/extensiones", () => {
    const file = new File([new Uint8Array([1])], "imagen.png", {
      type: "image/png",
    });
    expect(isPdfFile(file)).toBe(false);
  });

  it("matchesAccept: accept vacio siempre acepta", () => {
    const file = new File([new Uint8Array([1])], "x.txt", { type: "text/plain" });
    expect(matchesAccept(file, [], [])).toBe(true);
  });

  it("matchesAccept: acepta por mime type exacto", () => {
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" });
    expect(matchesAccept(file, ["image/png"], [".png"])).toBe(true);
  });

  it("matchesAccept: acepta por extension cuando el mime no coincide", () => {
    const file = new File([new Uint8Array([1])], "x.jpg", { type: "" });
    expect(matchesAccept(file, ["image/jpeg"], [".jpg", ".jpeg"])).toBe(true);
  });

  it("matchesAccept: rechaza cuando ni mime ni extension coinciden", () => {
    const file = new File([new Uint8Array([1])], "x.gif", { type: "image/gif" });
    expect(matchesAccept(file, ["image/png"], [".png"])).toBe(false);
  });
});

describe("loadPdf / savePdfToBlob — src/lib/pdf/core.ts", () => {
  it("carga un PDF valido desde File, ArrayBuffer y Uint8Array por igual", async () => {
    const document = await createDocument();
    const bytes = await document.save({ useObjectStreams: true });
    const file = new File([bytes as unknown as BlobPart], "x.pdf", {
      type: "application/pdf",
    });

    const fromFile = await loadPdf(file);
    const fromArrayBuffer = await loadPdf(bytes.buffer as ArrayBuffer);
    const fromUint8Array = await loadPdf(bytes);

    expect(fromFile.getPageCount()).toBe(1);
    expect(fromArrayBuffer.getPageCount()).toBe(1);
    expect(fromUint8Array.getPageCount()).toBe(1);
  });

  it("bytes vacios -> PdfError('corrupt')", async () => {
    await expect(loadPdf(new Uint8Array(0))).rejects.toMatchObject({ code: "corrupt" });
  });

  it("PDF cifrado sin contrasena -> PdfError('encrypted')", async () => {
    const document = await createDocument();
    document.encrypt({ userPassword: "secreta123", ownerPassword: "secreta123" });
    const bytes = await document.save({ useObjectStreams: true });

    await expect(loadPdf(bytes)).rejects.toMatchObject({ code: "encrypted" });
  });

  it("PDF cifrado con la contrasena correcta se abre normalmente", async () => {
    const document = await createDocument();
    document.encrypt({ userPassword: "secreta123", ownerPassword: "secreta123" });
    const bytes = await document.save({ useObjectStreams: true });

    const reopened = await loadPdf(bytes, { password: "secreta123" });
    expect(reopened.getPageCount()).toBe(1);
  });

  it("savePdfToBlob produce un Blob application/pdf que vuelve a cargar con el mismo numero de paginas", async () => {
    const document = await createDocument();
    document.addPage([300, 300]);
    const blob = await savePdfToBlob(document);

    expect(blob.type).toBe("application/pdf");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    expect(reloaded.getPageCount()).toBe(2);
  });
});

describe("getPageGeometry / viewPointToUser / normalizedRectToUserBox — src/lib/pdf/core.ts", () => {
  it("sin rotacion: box == cropbox, viewWidth/viewHeight == width/height", async () => {
    const document = await createDocument([100, 200]);
    const page = document.getPages()[0];
    const geometry = getPageGeometry(page);

    expect(geometry.rotation).toBe(0);
    expect(geometry.box).toMatchObject({ x: 0, y: 0, width: 100, height: 200 });
    expect(geometry.viewWidth).toBe(100);
    expect(geometry.viewHeight).toBe(200);
  });

  it("con rotacion 90/270 se intercambian viewWidth y viewHeight", async () => {
    const document = await createDocument([100, 200]);
    const page = document.getPages()[0];
    page.setRotation(degrees(90));

    const geometry = getPageGeometry(page);
    expect(geometry.rotation).toBe(90);
    expect(geometry.viewWidth).toBe(200);
    expect(geometry.viewHeight).toBe(100);
  });

  it("viewPointToUser: rotation 0 es identidad relativa al origen de la caja", () => {
    const geometry = {
      box: { x: 10, y: 20, width: 100, height: 200 },
      rotation: 0,
      viewWidth: 100,
      viewHeight: 200,
    };
    expect(viewPointToUser(geometry, 5, 7)).toEqual({ x: 15, y: 27 });
  });

  it("viewPointToUser: rotation 90/180/270 aplican la formula documentada", () => {
    const geometry = {
      box: { x: 0, y: 0, width: 100, height: 200 },
      rotation: 90,
      viewWidth: 200,
      viewHeight: 100,
    };
    expect(viewPointToUser({ ...geometry, rotation: 90 }, 5, 7)).toEqual({
      x: 0 + 100 - 7,
      y: 0 + 5,
    });
    expect(viewPointToUser({ ...geometry, rotation: 180 }, 5, 7)).toEqual({
      x: 0 + 100 - 5,
      y: 0 + 200 - 7,
    });
    expect(viewPointToUser({ ...geometry, rotation: 270 }, 5, 7)).toEqual({
      x: 0 + 7,
      y: 0 + 200 - 5,
    });
  });

  it("normalizedRectToUserBox: rect completo (0,0,1,1) sin rotacion cubre toda la caja", () => {
    const geometry = {
      box: { x: 0, y: 0, width: 100, height: 200 },
      rotation: 0,
      viewWidth: 100,
      viewHeight: 200,
    };
    const box = normalizedRectToUserBox(geometry, { x: 0, y: 0, width: 1, height: 1 });
    expect(box).toEqual({ x: 0, y: 0, width: 100, height: 200 });
  });

  it("normalizedRectToUserBox: rect parcial sin rotacion, origen DOM (arriba-izquierda) invertido a espacio PDF (abajo-izquierda)", () => {
    const geometry = {
      box: { x: 0, y: 0, width: 100, height: 200 },
      rotation: 0,
      viewWidth: 100,
      viewHeight: 200,
    };
    // Rect ocupa el cuarto superior-izquierdo del DOM (25% ancho, 10% alto
    // desde arriba) -> en espacio PDF (origen abajo) debe quedar arriba
    // tambien en Y, es decir con y alto.
    const box = normalizedRectToUserBox(geometry, { x: 0, y: 0, width: 0.25, height: 0.1 });
    expect(box.x).toBeCloseTo(0);
    expect(box.width).toBeCloseTo(25);
    expect(box.height).toBeCloseTo(20);
    expect(box.y).toBeCloseTo(180); // (1 - 0 - 0.1) * 200
  });
});

describe("originForCenter / rotatedBounds — src/lib/pdf/core.ts", () => {
  it("originForCenter sin rotacion resta la mitad de ancho/alto (menos baselineOffset)", () => {
    const origin = originForCenter(50, 50, 100, 50, 0, 0);
    expect(origin.x).toBeCloseTo(0);
    expect(origin.y).toBeCloseTo(25);
  });

  it("originForCenter con baselineOffset ajusta el eje Y local antes de rotar", () => {
    const origin = originForCenter(50, 50, 100, 50, 10, 0);
    expect(origin.x).toBeCloseTo(0);
    expect(origin.y).toBeCloseTo(35); // cy - (height/2 - baselineOffset) = 50 - (25-10)
  });

  it("originForCenter con rotacion de 90 grados rota el punto local", () => {
    const origin = originForCenter(0, 0, 100, 50, 0, 90);
    // localX=50, localY=25; cos=0, sin=1 => x = -(-25) = 25... calculado con la formula exacta:
    const radians = (90 * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const expectedX = 0 - (50 * cos - 25 * sin);
    const expectedY = 0 - (50 * sin + 25 * cos);
    expect(origin.x).toBeCloseTo(expectedX);
    expect(origin.y).toBeCloseTo(expectedY);
  });

  it("rotatedBounds sin rotacion devuelve el mismo tamano", () => {
    expect(rotatedBounds(100, 50, 0)).toEqual({ width: 100, height: 50 });
  });

  it("rotatedBounds a 90 grados intercambia ancho y alto", () => {
    const bounds = rotatedBounds(100, 50, 90);
    expect(bounds.width).toBeCloseTo(50);
    expect(bounds.height).toBeCloseTo(100);
  });

  it("rotatedBounds a 45 grados agranda la caja envolvente segun la formula trigonometrica", () => {
    const bounds = rotatedBounds(100, 50, 45);
    const radians = (45 * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    expect(bounds.width).toBeCloseTo(100 * cos + 50 * sin);
    expect(bounds.height).toBeCloseTo(100 * sin + 50 * cos);
  });
});

describe("standardFontFor / PDF_FONT_FAMILIES — src/lib/pdf/core.ts", () => {
  it("PDF_FONT_FAMILIES contiene exactamente las 3 familias soportadas", () => {
    expect(PDF_FONT_FAMILIES).toEqual(["helvetica", "times", "courier"]);
  });

  it("helvetica: cubre las 4 combinaciones bold/italic", () => {
    expect(standardFontFor("helvetica", false, false)).toBe(StandardFonts.Helvetica);
    expect(standardFontFor("helvetica", true, false)).toBe(StandardFonts.HelveticaBold);
    expect(standardFontFor("helvetica", false, true)).toBe(StandardFonts.HelveticaOblique);
    expect(standardFontFor("helvetica", true, true)).toBe(StandardFonts.HelveticaBoldOblique);
  });

  it("times: cubre las 4 combinaciones bold/italic", () => {
    expect(standardFontFor("times", false, false)).toBe(StandardFonts.TimesRoman);
    expect(standardFontFor("times", true, false)).toBe(StandardFonts.TimesRomanBold);
    expect(standardFontFor("times", false, true)).toBe(StandardFonts.TimesRomanItalic);
    expect(standardFontFor("times", true, true)).toBe(StandardFonts.TimesRomanBoldItalic);
  });

  it("courier: cubre las 4 combinaciones bold/italic", () => {
    expect(standardFontFor("courier", false, false)).toBe(StandardFonts.Courier);
    expect(standardFontFor("courier", true, false)).toBe(StandardFonts.CourierBold);
    expect(standardFontFor("courier", false, true)).toBe(StandardFonts.CourierOblique);
    expect(standardFontFor("courier", true, true)).toBe(StandardFonts.CourierBoldOblique);
  });
});

describe("hexToPdfColor / INK_COLORS — src/lib/pdf/core.ts", () => {
  it("convierte hex de 6 digitos correctamente", () => {
    expect(hexToPdfColor("#000000")).toEqual(rgb(0, 0, 0));
    expect(hexToPdfColor("#ffffff")).toEqual(rgb(1, 1, 1));
    expect(hexToPdfColor("#0d4bff")).toEqual(
      rgb(0x0d / 255, 0x4b / 255, 0xff / 255),
    );
  });

  it("expande hex corto de 3 digitos", () => {
    expect(hexToPdfColor("#fff")).toEqual(rgb(1, 1, 1));
    expect(hexToPdfColor("#000")).toEqual(rgb(0, 0, 0));
  });

  it("hex invalido cae a negro por seguridad", () => {
    expect(hexToPdfColor("#zzzzzz")).toEqual(rgb(0, 0, 0));
    expect(hexToPdfColor("#12345")).toEqual(rgb(0, 0, 0));
  });

  it("INK_COLORS incluye negro y blanco como extremos documentados", () => {
    expect(INK_COLORS).toContain("#000000");
    expect(INK_COLORS).toContain("#ffffff");
    expect(INK_COLORS.length).toBeGreaterThan(0);
  });
});

describe("toWinAnsiSafe — src/lib/pdf/core.ts", () => {
  it("sustituye saltos de linea por espacios", () => {
    expect(toWinAnsiSafe("linea1\nlinea2\rlinea3")).toBe("linea1 linea2 linea3");
  });

  it("conserva acentos del espanol (rango WinAnsi)", () => {
    expect(toWinAnsiSafe("cafe con leche y ano")).toBe("cafe con leche y ano");
    expect(toWinAnsiSafe("canon: espanol")).toBe("canon: espanol");
  });

  it("conserva caracteres del set WIN_ANSI_EXTRA (p.ej. el simbolo euro)", () => {
    expect(toWinAnsiSafe("precio: 10€")).toBe("precio: 10€");
  });

  it("sustituye por '?' los caracteres fuera de WinAnsi y de WIN_ANSI_EXTRA", () => {
    expect(toWinAnsiSafe("emoji \u{1F600} final")).toBe("emoji ? final");
  });

  it("normaliza a NFC antes de filtrar (acento compuesto por combinacion se conserva)", () => {
    const decomposed = "café"; // "e" + acento agudo combinante -> "café" tras NFC
    expect(toWinAnsiSafe(decomposed)).toBe("café");
  });
});

describe("formatFileSize — src/lib/pdf/core.ts", () => {
  it("valores no positivos o no finitos -> '0 KB'", () => {
    expect(formatFileSize(0)).toBe("0 KB");
    expect(formatFileSize(-5)).toBe("0 KB");
    expect(formatFileSize(Number.NaN)).toBe("0 KB");
    expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe("0 KB");
  });

  it("bytes puros se muestran en B sin decimales", () => {
    expect(formatFileSize(500)).toBe("500 B");
  });

  it("kilobytes se muestran en KB (con 1 decimal por debajo de 100 en la unidad)", () => {
    expect(formatFileSize(2048)).toBe("2,0 KB");
  });

  it("por debajo de 100 en una unidad usa 1 decimal (con coma, locale es-ES)", () => {
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1,5 MB");
  });

  it("100 o mas en una unidad usa 0 decimales", () => {
    expect(formatFileSize(150 * 1024 * 1024)).toBe("150 MB");
  });

  it("no sube de GB aunque el valor sea enorme", () => {
    const huge = 5 * 1024 * 1024 * 1024;
    expect(formatFileSize(huge)).toBe("5,0 GB");
  });
});

describe("slugify — src/lib/pdf/core.ts", () => {
  it("convierte espacios en guiones y pasa a minusculas", () => {
    expect(slugify("Unir PDF")).toBe("unir-pdf");
  });

  it("elimina diacriticos", () => {
    expect(slugify("Informe Anual - Edicion")).toBe("informe-anual-edicion");
    expect(slugify("Ano nuevo")).toBe("ano-nuevo");
  });

  it("colapsa puntuacion en un solo guion y recorta guiones extremos", () => {
    expect(slugify("  Hola, Mundo!!  ")).toBe("hola-mundo");
  });
});

describe("withSuffix — src/lib/pdf/core.ts", () => {
  it("inserta el sufijo antes de la extension", () => {
    expect(withSuffix("informe.pdf", "unido")).toBe("informe-unido.pdf");
  });

  it("sin extension original, anade la extension por defecto (pdf)", () => {
    expect(withSuffix("informe", "unido")).toBe("informe-unido.pdf");
  });

  it("permite una extension de salida distinta", () => {
    expect(withSuffix("informe.pdf", "paginas", "zip")).toBe("informe-paginas.zip");
  });

  it("nombre vacio cae a 'documento'", () => {
    expect(withSuffix("", "unido")).toBe("documento-unido.pdf");
  });
});

describe("scaleProgress — src/lib/pdf/core.ts", () => {
  it("interpola linealmente dentro del rango", () => {
    expect(scaleProgress(0.5, 0, 1)).toBe(0.5);
    expect(scaleProgress(0.5, 0.2, 0.8)).toBeCloseTo(0.5);
  });

  it("recorta valores por debajo de 0 al limite 'from'", () => {
    expect(scaleProgress(-1, 0.2, 0.8)).toBe(0.2);
  });

  it("recorta valores por encima de 1 al limite 'to'", () => {
    expect(scaleProgress(2, 0.2, 0.8)).toBe(0.8);
  });
});

describe("constantes — src/lib/pdf/core.ts", () => {
  it("MAX_SAFE_FILE_SIZE es 100 MB en bytes", () => {
    expect(MAX_SAFE_FILE_SIZE).toBe(100 * 1024 * 1024);
  });
});
