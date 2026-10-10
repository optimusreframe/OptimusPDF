import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import { es } from "../../src/lib/locales/es";
import { expect, openTool, runAndDownload, runButton, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount } from "../helpers/pdf-inspection";
import { hasPdfHeader } from "../helpers/pdf-structure";
import { makeImage, makePdf, pdfUpload } from "../helpers/test-files";

/**
 * PDFs a ZIP, PDF a texto y PDF a Word (W6-D): se abre el ZIP / .txt / .docx
 * descargado y se comprueba su contenido real. NO se cubre el OCR (descarga el
 * modelo de reconocimiento por red): el OCR se apaga donde podria dispararse.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

/** Texto de los `<w:t>` del documento principal de un .docx, en orden. */
async function docxTexts(bytes: Buffer): Promise<{ texts: string[]; xml: string; files: string[] }> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  const texts = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]);
  return { texts, xml, files: Object.keys(zip.files) };
}

/**
 * Las paginas con menos de 24 caracteres de texto se tratan como escaneadas y se reconocen con OCR
 * (red y no determinista): todo el texto de prueba pasa de ese umbral para medir la extraccion real.
 */
const TEXT_CHUNKS = [
  "Primera página: acción ñandú de prueba",
  "Segunda hoja & sección <2> con más texto",
  "Tercera línea final del documento largo",
];
const longText = (label: string, n: number) => `Contenido de la página ${label}-${n} del documento`;

test.describe("pdfs-to-zip", () => {
  test("3 PDF con un nombre repetido: el ZIP los trae todos, con nombres unicos y bytes identicos", async ({ page }) => {
    await openTool(page, "pdfs-to-zip");
    const informe = await makePdf({ pages: 2, label: "INF" });
    const otro = await makePdf({ pages: 3, label: "OTRO", size: [200, 300] });
    const acentos = await makePdf({ pages: 1, label: "ACE", size: [500, 300] });
    await uploadFiles(
      page,
      pdfUpload("informe.pdf", informe),
      pdfUpload("informe.pdf", otro),
      pdfUpload("Año nuevo (final) ñ.pdf", acentos),
    );
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("pdfs.zip");
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["Año nuevo (final) ñ.pdf", "informe (1).pdf", "informe.pdf"]);
    // Empaquetado puro: cada entrada son los bytes originales, sin tocar.
    expect(Buffer.from(await zip.files["informe.pdf"].async("uint8array")).equals(informe)).toBe(true);
    expect(Buffer.from(await zip.files["informe (1).pdf"].async("uint8array")).equals(otro)).toBe(true);
    expect(Buffer.from(await zip.files["Año nuevo (final) ñ.pdf"].async("uint8array")).equals(acentos)).toBe(true);
  });

  test("un solo archivo no se puede empaquetar; con dos, si; y se puede quitar uno y reordenar", async ({ page }) => {
    await openTool(page, "pdfs-to-zip");
    await uploadFiles(page, pdfUpload("a.pdf", await makePdf({ pages: 1, label: "A" })));
    await expect(page.getByRole("button", { name: "Procesar", exact: true })).toBeDisabled();
    await page.locator('input[type="file"]').first().setInputFiles([
      pdfUpload("b.pdf", await makePdf({ pages: 1, label: "B" })),
      pdfUpload("c.pdf", await makePdf({ pages: 2, label: "C" })),
    ]);
    await expect(page.getByText("c.pdf").first()).toBeVisible();
    await page.getByRole("button", { name: "Quitar", exact: true }).nth(1).click(); // quita b.pdf
    const { bytes } = await runAndDownload(page);
    expect(Object.keys((await JSZip.loadAsync(bytes)).files).sort()).toEqual(["a.pdf", "c.pdf"]);
  });

  test("12 PDF a la vez: salen los 12", async ({ page }) => {
    await openTool(page, "pdfs-to-zip");
    const files = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => pdfUpload(`doc-${String(index + 1).padStart(2, "0")}.pdf`, await makePdf({ pages: 1, label: `D${index + 1}` }))),
    );
    await uploadFiles(page, ...files);
    const { bytes } = await runAndDownload(page);
    expect(Object.keys((await JSZip.loadAsync(bytes)).files)).toHaveLength(12);
  });
});

test.describe("pdf-to-text", () => {
  test("3 paginas con acentos: el .txt trae el texto de cada una en orden, sin separador de pagina", async ({ page }) => {
    await openTool(page, "pdf-to-text");
    await uploadFiles(
      page,
      pdfUpload(
        "Acta (año) ñ.pdf",
        await makePdf({ pages: 3, text: (index) => TEXT_CHUNKS[index] }),
      ),
    );
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Acta (año) ñ-texto.txt");
    const text = bytes.toString("utf8");
    const at = TEXT_CHUNKS.map((chunk) => text.indexOf(chunk));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(text).not.toContain("\f");
  });

  test("«Separar las páginas con un salto de página» inserta un salto entre paginas", async ({ page }) => {
    await openTool(page, "pdf-to-text");
    await uploadFiles(page, pdfUpload("sep.pdf", await makePdf({ pages: 3, text: (index) => longText("SEP", index + 1) })));
    await page.locator("label", { hasText: "Separar las páginas con un salto de página" }).click();
    await expect(page.getByRole("checkbox", { name: /Separar las páginas/ })).toBeChecked();
    const { bytes } = await runAndDownload(page);
    const parts = bytes.toString("utf8").split("\f").map((part) => part.trim());
    expect(parts).toEqual([1, 2, 3].map((n) => longText("SEP", n)));
  });

  // Regresion W6-D (corregido): una pagina con menos de 24 caracteres de texto REAL (una portada, «Fin») se
  // trataba como escaneada: se descartaba su texto y se lanzaba el OCR, que con red lo releia peor («&» salia
  // como «8» o «é») y sin red a la CDN no terminaba nunca. Ahora el texto real manda y el OCR solo es para
  // paginas sin texto o que son una imagen. Se bloquea todo lo que no sea localhost (sin red al motor de OCR).
  test("una pagina con poco texto real conserva su texto exacto y termina aunque el OCR no pueda cargar (sin red)", async ({ page, context }) => {
    await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
    await openTool(page, "pdf-to-text");
    await uploadFiles(
      page,
      pdfUpload("corto.pdf", await makePdf({ pages: 3, text: (index) => ["Tom & Jerry", "Fin del texto", "A & B"][index] })),
    );
    // OCR activado (valor por defecto): el texto corto NO debe mandarse al OCR.
    await expect(page.getByRole("checkbox", { name: /Reconocer las páginas escaneadas/ })).toBeChecked();
    const { bytes } = await runAndDownload(page, { timeout: 15_000 });
    const text = bytes.toString("utf8");
    expect(text).toContain("Tom & Jerry");
    expect(text).toContain("Fin del texto");
    expect(text).toContain("A & B");
  });

  test("paginas de un solo simbolo o palabra («&», «—», «1», «Fin.») conservan su texto con el OCR activado", async ({ page, context }) => {
    await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
    await openTool(page, "pdf-to-text");
    await uploadFiles(page, pdfUpload("simbolos.pdf", await makePdf({ pages: 4, text: (index) => ["&", "—", "1", "Fin."][index] })));
    const { bytes } = await runAndDownload(page, { timeout: 15_000 });
    const text = bytes.toString("utf8");
    for (const expected of ["&", "—", "1", "Fin."]) expect(text, expected).toContain(expected);
    expect(text).not.toContain("8");
  });

  test("el aviso de una pagina sin OCR sale en espanol en una interfaz en espanol (txt y docx)", async ({ page, context, consoleErrors }) => {
    await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
    const document = await PDFDocument.create();
    const image = await document.embedJpg(makeImage("jpeg", 300, 400, 7, 80));
    document.addPage([300, 400]).drawImage(image, { x: 0, y: 0, width: 300, height: 400 });
    const text = await document.embedFont((await import("@cantoo/pdf-lib")).StandardFonts.Helvetica);
    document.addPage([300, 400]).drawText("Texto normal de la segunda pagina del documento", { x: 10, y: 200, size: 8, font: text });
    const bytes = Buffer.from(await document.save());

    await openTool(page, "pdf-to-text");
    await uploadFiles(page, pdfUpload("mixto.pdf", bytes));
    const txt = await runAndDownload(page, { timeout: 40_000 });
    expect(txt.bytes.toString("utf8")).toContain("[OCR no disponible para esta página — comprueba tu conexión]");
    expect(txt.bytes.toString("utf8")).not.toContain("check your connection");

    await openTool(page, "pdf-to-word");
    await uploadFiles(page, pdfUpload("mixto.pdf", bytes));
    const word = await runAndDownload(page, { timeout: 40_000 });
    expect((await docxTexts(word.bytes)).texts.join(" ")).toContain("OCR no disponible para esta página");
    // Los intentos del motor de OCR avisan en consola de que su script no cargo: es lo que se provoca aqui.
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((entry) => !/importScripts.*cdn\.jsdelivr\.net/.test(entry)));
  });

  test("PDF a Word con paginas de poco texto: el .docx conserva el texto exacto (y el «&» escapado)", async ({ page, context }) => {
    await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
    await openTool(page, "pdf-to-word");
    await uploadFiles(page, pdfUpload("corto.pdf", await makePdf({ pages: 2, text: (index) => ["Tom & Jerry", "Fin"][index] })));
    const { bytes } = await runAndDownload(page, { timeout: 15_000 });
    const { texts, xml } = await docxTexts(bytes);
    expect(texts.join(" ")).toContain("Fin");
    expect(xml).toContain("Tom &amp; Jerry");
  });

  test("una pagina que es solo una imagen (escaneo) sin red (peticion rechazada): error claro y se puede reintentar", async ({ page, context, consoleErrors }) => {
    await context.route((url) => url.hostname !== "localhost", (route) => route.abort());
    await openTool(page, "pdf-to-text");
    const document = await PDFDocument.create();
    const image = await document.embedJpg(makeImage("jpeg", 300, 400, 6, 80));
    document.addPage([300, 400]).drawImage(image, { x: 0, y: 0, width: 300, height: 400 });
    await uploadFiles(page, pdfUpload("escaneo.pdf", Buffer.from(await document.save())));
    await runButton(page).click();
    const banner = page.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 40_000 });
    await expect(banner).toContainText(es.tool.errors.ocrNetworkFailure);
    await expect(runButton(page)).toBeEnabled();
    // El propio motor de OCR avisa en consola de que su script no pudo cargarse: es lo que se provoca aqui.
    consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((entry) => !/importScripts.*cdn\.jsdelivr\.net/.test(entry)));
  });

  test("una pagina que es solo una imagen (escaneo) con la CDN del motor de OCR MUDA (peticion que nunca responde): error claro en menos de 40 s y se puede reintentar, sin colgarse", async ({ page, context }) => {
    test.setTimeout(90_000);
    // Agujero negro: la peticion al motor queda abierta para siempre (antes la conversion esperaba sin limite).
    await context.route(
      (url) => url.hostname !== "localhost",
      () => {},
    );
    await openTool(page, "pdf-to-text");
    const document = await PDFDocument.create();
    const image = await document.embedJpg(makeImage("jpeg", 300, 400, 5, 80));
    document.addPage([300, 400]).drawImage(image, { x: 0, y: 0, width: 300, height: 400 });
    await uploadFiles(page, pdfUpload("escaneo.pdf", Buffer.from(await document.save())));

    await runButton(page).click();
    const banner = page.locator("[data-error-banner]");
    await expect(banner).toBeVisible({ timeout: 40_000 });
    await expect(banner).toContainText(es.tool.errors.ocrNetworkFailure);
    // Reintento posible: el archivo sigue y Procesar vuelve a estar activo; sin hilo colgado ni overlay.
    await expect(page.getByRole("button", { name: "Cancelar", exact: true })).toHaveCount(0);
    await expect(runButton(page)).toBeEnabled();
  });

  test("34 paginas con una rotada: el .txt contiene las 34 (sin OCR)", async ({ page }) => {
    await openTool(page, "pdf-to-text");
    await uploadFiles(page, pdfUpload("largo.pdf", await makePdf({ pages: 34, text: (index) => longText("LT", index + 1), size: [260, 340], rotate: (index) => (index === 6 ? 90 : 0) })));
    await page.locator("label", { hasText: "Reconocer las páginas escaneadas (OCR)" }).click();
    await expect(page.getByRole("checkbox", { name: /Reconocer las páginas escaneadas/ })).not.toBeChecked();
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    const text = bytes.toString("utf8");
    const missing = Array.from({ length: 34 }, (_, index) => index + 1).filter((n) => !new RegExp(`página LT-${n} `).test(text));
    expect(missing).toEqual([]);
  });
});

test.describe("pdf-to-word", () => {
  test("3 paginas: un .docx valido con el texto de cada pagina, escapado y en orden", async ({ page }) => {
    await openTool(page, "pdf-to-word");
    const chunks = ["Capítulo uno: acción ñandú del libro", "Tom & Jerry <b> \"citas\" y más texto", "Fin del documento de prueba largo"];
    await uploadFiles(page, pdfUpload("Informe (v2) ñ.pdf", await makePdf({ pages: 3, text: (index) => chunks[index] })));
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Informe (v2) ñ-word.docx");
    // ZIP de Office Open XML valido.
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    const { texts, xml, files } = await docxTexts(bytes);
    expect(files).toEqual(expect.arrayContaining(["[Content_Types].xml", "word/document.xml", "_rels/.rels"]));
    const joined = texts.join(" ");
    expect(joined).toContain("Capítulo uno: acción ñandú del libro");
    expect(joined).toContain("Fin del documento de prueba largo");
    // Los caracteres especiales de XML llegan escapados (si no, Word rechaza el archivo).
    expect(xml).toContain("Tom &amp; Jerry &lt;b&gt; &quot;citas&quot;");
    expect(joined.indexOf("Capítulo uno")).toBeLessThan(joined.indexOf("Fin del documento"));
  });

  test("31 paginas: el .docx contiene el texto de todas", async ({ page }) => {
    await openTool(page, "pdf-to-word");
    await uploadFiles(page, pdfUpload("largo.pdf", await makePdf({ pages: 31, text: (index) => longText("WD", index + 1), size: [250, 350] })));
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    const { texts } = await docxTexts(bytes);
    const joined = texts.join(" ");
    const missing = Array.from({ length: 31 }, (_, index) => index + 1).filter((n) => !new RegExp(`página WD-${n} `).test(joined));
    expect(missing).toEqual([]);
  });
});

test.describe("convert-out · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("pdf-to-word y pdfs-to-zip se completan con el dedo", async ({ page }) => {
    await openTool(page, "pdf-to-word");
    await uploadFiles(page, pdfUpload("m.pdf", await makePdf({ pages: 1, text: () => "Contenido de la página MOVIL-1 del documento" })));
    const word = await runAndDownload(page);
    expect((await docxTexts(word.bytes)).texts.join(" ")).toContain("MOVIL-1");

    await openTool(page, "pdfs-to-zip");
    await uploadFiles(page, pdfUpload("a.pdf", await makePdf({ pages: 1 })), pdfUpload("b.pdf", await makePdf({ pages: 2 })));
    const zip = await runAndDownload(page);
    const entries = await JSZip.loadAsync(zip.bytes);
    expect(Object.keys(entries.files).sort()).toEqual(["a.pdf", "b.pdf"]);
    const b = Buffer.from(await entries.files["b.pdf"].async("uint8array"));
    expect(hasPdfHeader(b)).toBe(true);
    expect(await getPageCount(b)).toBe(2);
  });
});
