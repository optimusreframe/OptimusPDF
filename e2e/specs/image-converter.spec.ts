import { createCanvas, loadImage } from "@napi-rs/canvas";
import JSZip from "jszip";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect as baseExpect, test as baseTest, type BrowserContext, type Page } from "@playwright/test";
import { downloadFile } from "../helpers/downloads";
import { makeExifJpeg } from "../helpers/exif-jpeg";
import {
  downloadButton,
  expect,
  openTool,
  runAndDownload,
  runButton,
  test,
  uploadFiles,
  type UploadFile,
} from "../helpers/tool-flow";
import { imageUpload } from "../helpers/test-files";
import { encodeBmp } from "../../src/lib/media/image/bmp";

/**
 * Convertidor de imagenes (OptimusTOOLS · W-IMG): conversion real en Chromium headless con imagenes SINTETICAS generadas aqui.
 *
 *  1. PNG con transparencia -> JPG con fondo blanco (por defecto) y con otro color; JPG -> WebP; la orientacion EXIF se aplica y los
 *     metadatos se borran; tamaño (ancho maximo sin ampliar, porcentaje).
 *  2. Lote -> ZIP (nombres repetidos sin pisarse), una sola -> archivo directo, tamaño antes/despues por archivo.
 *  3. Archivos malos: aviso previo por archivo, «Quitar y continuar», resultado que nombra las que no salieron, y ninguna sale.
 *  4. Formatos: lo que ofrece la interfaz coincide con lo que este navegador codifica de verdad.
 *  5. Nada sale del dispositivo: ninguna peticion con el contenido.
 *  6. axe (WCAG 2 A/AA), sin desborde horizontal a 1280/375/320 px con tipografia ancha, claro/oscuro, ES/EN, y el tactil de 44 px.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(120_000);

/* ------------------------------------------------------------------ *
 * Imagenes sinteticas (lado Node)
 * ------------------------------------------------------------------ */

/** PNG RGBA: mitad izquierda TRANSPARENTE y mitad derecha azul opaca. */
function halfTransparentPng(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0000ff";
  context.fillRect(Math.floor(width / 2), 0, width - Math.floor(width / 2), height);
  return canvas.toBuffer("image/png");
}

const png = (name: string, buffer: Buffer): UploadFile => ({ name, mimeType: "image/png", buffer });
const jpeg = (name: string, buffer: Buffer): UploadFile => ({ name, mimeType: "image/jpeg", buffer });

async function dimensionsOf(buffer: Buffer): Promise<{ width: number; height: number }> {
  const image = await loadImage(buffer);
  return { width: image.width, height: image.height };
}

/** Color [r, g, b, a] del pixel (x, y) de una imagen ya codificada. */
async function pixelOf(buffer: Buffer, x: number, y: number): Promise<number[]> {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return Array.from(context.getImageData(x, y, 1, 1).data);
}

const near = (actual: number[], expected: number[], tolerance = 24): boolean => expected.every((value, index) => Math.abs(actual[index] - value) <= tolerance);

/* ------------------------------------------------------------------ *
 * 1. Conversion
 * ------------------------------------------------------------------ */

test.describe("conversion real", () => {
  test("PNG con transparencia -> JPG: el fondo es BLANCO por defecto y se conserva lo opaco", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, png("logo.png", halfTransparentPng(120, 80)));
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("logo-convertida.jpg");
    expect(bytes.subarray(0, 3).toString("hex")).toBe("ffd8ff");
    expect(await dimensionsOf(bytes)).toEqual({ width: 120, height: 80 });
    expect(near(await pixelOf(bytes, 10, 40), [255, 255, 255])).toBe(true); // lo transparente, blanco
    expect(near(await pixelOf(bytes, 110, 40), [0, 0, 255])).toBe(true); // lo opaco, azul
  });

  test("PNG con transparencia -> JPG con otro color de fondo", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, png("logo.png", halfTransparentPng(120, 80)));
    await page.getByLabel("Color de fondo").fill("#ff0000");
    const { bytes } = await runAndDownload(page);
    expect(near(await pixelOf(bytes, 10, 40), [255, 0, 0])).toBe(true);
    expect(near(await pixelOf(bytes, 110, 40), [0, 0, 255])).toBe(true);
  });

  test("PNG -> PNG conserva la transparencia (no hay fondo que elegir)", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, png("logo.png", halfTransparentPng(60, 40)));
    await page.getByRole("tab", { name: "PNG", exact: true }).click();
    await expect(page.getByLabel("Color de fondo")).toHaveCount(0);
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("logo-convertida.png");
    expect((await pixelOf(bytes, 5, 20))[3]).toBe(0);
    expect(near(await pixelOf(bytes, 50, 20), [0, 0, 255, 255], 2)).toBe(true);
  });

  test("JPG -> WebP: archivo WebP de verdad, mismas dimensiones, con el resumen antes/despues", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, jpeg("foto.jpg", imageUpload("foto.jpg", "jpeg", 160, 100, 3).buffer));
    await page.getByRole("tab", { name: "WebP", exact: true }).click();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("foto-convertida.webp");
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(await dimensionsOf(bytes)).toEqual({ width: 160, height: 100 });
    await expect(page.locator("[data-download-summary]")).toContainText(/^Convertida a WebP: de .+ a .+\.$/);
    const row = page.locator("[data-converted-row]");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("foto-convertida.webp");
    await expect(row).toContainText("160 × 100 px");
  });

  test("la orientacion EXIF se aplica y los metadatos se borran", async ({ page }) => {
    await openTool(page, "image-converter");
    // Guardada 120 x 80 (rojo a la izquierda, azul a la derecha) con orientacion 6: se VE de 80 x 120 con el rojo ARRIBA.
    const source = makeExifJpeg({ width: 120, height: 80, orientation: 6 });
    expect(source.includes(Buffer.from("Exif"))).toBe(true);
    await uploadFiles(page, jpeg("girada.jpg", source));
    await page.getByRole("tab", { name: "PNG", exact: true }).click();
    const { bytes } = await runAndDownload(page);
    expect(await dimensionsOf(bytes)).toEqual({ width: 80, height: 120 });
    expect(near(await pixelOf(bytes, 40, 15), [255, 0, 0], 30)).toBe(true);
    expect(near(await pixelOf(bytes, 40, 105), [0, 0, 255], 30)).toBe(true);
    expect(bytes.includes(Buffer.from("Exif"))).toBe(false);
    // Y tambien al salir como JPG: el EXIF de entrada no viaja.
    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await uploadFiles(page, jpeg("girada.jpg", source));
    const jpg = await runAndDownload(page);
    expect(jpg.bytes.includes(Buffer.from("Exif"))).toBe(false);
    expect(await dimensionsOf(jpg.bytes)).toEqual({ width: 80, height: 120 });
  });

  test("tamaño: ancho maximo y porcentaje reducen con la proporcion; NUNCA amplian", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, png("ancha.png", imageUpload("a", "png", 400, 200, 4).buffer), png("pequena.png", imageUpload("b", "png", 50, 30, 5).buffer));
    await page.getByRole("tab", { name: "Ancho máx.", exact: true }).click();
    const width = page.getByLabel("Ancho máximo (px)");
    await width.fill("100");
    await width.blur();
    const { bytes } = await runAndDownload(page);
    const zip = await JSZip.loadAsync(bytes);
    expect(await dimensionsOf(Buffer.from(await zip.files["ancha-convertida.jpg"].async("uint8array")))).toEqual({ width: 100, height: 50 });
    // La pequeña (50 px) no se amplia a 100.
    expect(await dimensionsOf(Buffer.from(await zip.files["pequena-convertida.jpg"].async("uint8array")))).toEqual({ width: 50, height: 30 });

    await page.getByRole("button", { name: "Empezar de nuevo" }).click();
    await uploadFiles(page, png("ancha.png", imageUpload("a", "png", 400, 200, 4).buffer));
    await page.getByRole("tab", { name: "Porcentaje", exact: true }).click();
    await page.getByRole("slider", { name: "Escala" }).fill("25");
    const percent = await runAndDownload(page);
    expect(await dimensionsOf(percent.bytes)).toEqual({ width: 100, height: 50 });
  });

  test("lote -> UN ZIP con un archivo por imagen (nombres repetidos sin pisarse) y el tamaño de cada una", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(
      page,
      png("foto.png", imageUpload("a", "png", 64, 48, 1).buffer),
      jpeg("foto.jpg", imageUpload("b", "jpeg", 80, 60, 2).buffer),
      png("Escaneo único (1).png", imageUpload("c", "png", 40, 40, 3).buffer),
    );
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("imagenes-convertidas.zip");
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["Escaneo único (1)-convertida.jpg", "foto-convertida (2).jpg", "foto-convertida.jpg"]);
    expect(await dimensionsOf(Buffer.from(await zip.files["foto-convertida.jpg"].async("uint8array")))).toEqual({ width: 64, height: 48 });
    expect(await dimensionsOf(Buffer.from(await zip.files["foto-convertida (2).jpg"].async("uint8array")))).toEqual({ width: 80, height: 60 });
    await expect(page.locator("[data-download-summary]")).toContainText(/^3 imágenes convertidas a JPG: de .+ a .+ en total\.$/);
    await expect(page.locator("[data-converted-row]")).toHaveCount(3);
    await expect(page.locator("[data-converted-row]").first()).toContainText(/foto\.png → foto-convertida\.jpg[\d,. ]+(B|KB|MB) → [\d,. ]+(B|KB|MB) · 64 × 48 px/);
  });
});

test.describe("otras entradas", () => {
  test("GIF (primer fotograma) y BMP se convierten a PNG", async ({ page }) => {
    await openTool(page, "image-converter");
    // GIF de 1 x 1 px (89a). BMP de 2 x 1: rojo y verde.
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const bmp = Buffer.from(encodeBmp(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]), 2, 1));
    await uploadFiles(page, { name: "punto.gif", mimeType: "image/gif", buffer: gif }, { name: "dos.bmp", mimeType: "image/bmp", buffer: bmp });
    await expect(page.locator("[data-image-problems]")).toHaveCount(0);
    await expect(page.getByText(/primer fotograma/)).toBeVisible();
    await page.getByRole("tab", { name: "PNG", exact: true }).click();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("imagenes-convertidas.zip");
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["dos-convertida.png", "punto-convertida.png"]);
    const dos = Buffer.from(await zip.files["dos-convertida.png"].async("uint8array"));
    expect(await dimensionsOf(dos)).toEqual({ width: 2, height: 1 });
    expect(near(await pixelOf(dos, 0, 0), [255, 0, 0, 255], 2)).toBe(true);
    expect(near(await pixelOf(dos, 1, 0), [0, 255, 0, 255], 2)).toBe(true);
    expect(await dimensionsOf(Buffer.from(await zip.files["punto-convertida.png"].async("uint8array")))).toEqual({ width: 1, height: 1 });
  });

  test("HEIC donde el navegador no lo abre (Chromium): aviso claro por archivo y el resto sigue", async ({ page }) => {
    await openTool(page, "image-converter");
    const heic = readFileSync(path.join(__dirname, "..", "fixtures", "small-o6.heic"));
    await uploadFiles(page, { name: "iphone.heic", mimeType: "image/heic", buffer: heic }, png("buena.png", imageUpload("g", "png", 30, 20, 9).buffer));
    const alert = page.locator("[data-image-problems]");
    await expect(alert).toContainText("iphone.heic es HEIC y este navegador no puede abrirlo.", { timeout: 15_000 });
    const { filename } = await runAndDownload(page);
    expect(filename).toBe("buena-convertida.jpg");
    await expect(page.locator("[data-download-notices]")).toContainText("iphone.heic: es HEIC y este navegador no puede abrirlo.");
  });
});

/* ------------------------------------------------------------------ *
 * 2. Archivos malos
 * ------------------------------------------------------------------ */

test.describe("archivos malos", () => {
  const good = (): UploadFile => png("buena.png", imageUpload("g", "png", 48, 32, 7).buffer);
  const truncated = (): UploadFile => {
    const full = imageUpload("t", "png", 96, 96, 8).buffer;
    return png("cortada.png", full.subarray(0, Math.floor(full.length * 0.5)));
  };
  const notAnImage = (): UploadFile => jpeg("nota.jpg", Buffer.from("esto no es una imagen, es texto"));

  test("avisa ANTES de convertir, por archivo y con su motivo, y «Quitar y continuar» deja solo la buena", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, good(), truncated(), notAnImage());
    const alert = page.locator("[data-image-problems]");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("2 imágenes no se pueden convertir");
    await expect(alert).toContainText("cortada.png está incompleta: el archivo se cortó.");
    await expect(alert).toContainText("nota.jpg no es una imagen válida.");
    await alert.getByRole("button", { name: "Quitar y continuar" }).click();
    await expect(alert).toHaveCount(0);
    const { filename } = await runAndDownload(page);
    expect(filename).toBe("buena-convertida.jpg");
    await expect(page.locator("[data-download-notices]")).toHaveCount(0);
  });

  test("si no se quitan, se omiten y el resultado las nombra (una sola buena -> archivo directo)", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, good(), truncated(), notAnImage());
    const { filename, bytes } = await runAndDownload(page);
    expect(filename).toBe("buena-convertida.jpg");
    expect(await dimensionsOf(bytes)).toEqual({ width: 48, height: 32 });
    const notices = page.locator("[data-download-notices]");
    await expect(notices).toContainText("1 de 3 imágenes convertidas. No se pudo convertir:");
    await expect(notices).toContainText("cortada.png: está incompleta");
    await expect(notices).toContainText("nota.jpg: no es una imagen válida.");
  });

  test("si NINGUNA se puede convertir: error claro, lista por archivo y sin colgar la pestaña", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, notAnImage());
    await expect(page.locator("[data-image-problems]")).toContainText("nota.jpg no es una imagen válida.");
    await runButton(page).click();
    await expect(page.getByRole("alert").filter({ hasText: "Ese formato no sirve para esta herramienta." })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("[data-image-problems]")).toContainText("nota.jpg");
    await expect(downloadButton(page)).toHaveCount(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Formatos disponibles y privacidad
 * ------------------------------------------------------------------ */

test.describe("formatos y privacidad", () => {
  test("la interfaz ofrece exactamente lo que este navegador codifica; lo que no, se explica", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, png("a.png", imageUpload("a", "png", 20, 20, 1).buffer));
    const support = await page.evaluate(async () => {
      const probe = async (mime: string): Promise<boolean> => {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        canvas.getContext("2d")?.fillRect(0, 0, 2, 2);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.8));
        return !!blob && blob.type === mime;
      };
      return { webp: await probe("image/webp"), avif: await probe("image/avif") };
    });
    const tabs = page.getByRole("tablist", { name: "Formato de salida" }).getByRole("tab");
    const expected = ["JPG", "PNG", ...(support.webp ? ["WebP"] : []), ...(support.avif ? ["AVIF"] : []), "BMP"];
    await expect(tabs).toHaveText(expected);
    const missing = [...(support.webp ? [] : ["WebP"]), ...(support.avif ? [] : ["AVIF"])];
    if (missing.length > 0) await expect(page.locator("[data-unavailable-formats]")).toContainText(`${missing.join(", ")}: este navegador no sabe crearlo`);
    else await expect(page.locator("[data-unavailable-formats]")).toHaveCount(0);
  });

  test("BMP: archivo BMP valido con el fondo aplicado", async ({ page }) => {
    await openTool(page, "image-converter");
    await uploadFiles(page, png("logo.png", halfTransparentPng(30, 20)));
    await page.getByRole("tab", { name: "BMP", exact: true }).click();
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("logo-convertida.bmp");
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("BM");
    expect(bytes.readUInt32LE(2)).toBe(bytes.length);
    expect(bytes.readInt32LE(18)).toBe(30);
    expect(bytes.readInt32LE(22)).toBe(20);
    expect(bytes.readUInt16LE(28)).toBe(24);
    // Primer pixel guardado = esquina inferior izquierda: transparente -> blanco (BGR).
    expect(Array.from(bytes.subarray(54, 57))).toEqual([255, 255, 255]);
  });

  test("ninguna peticion de red con el contenido: tras cargar la pagina solo hay lecturas del propio origen", async ({ page }) => {
    await openTool(page, "image-converter");
    await page.waitForLoadState("networkidle");
    const origin = new URL(page.url()).origin;
    const requests: Array<{ method: string; url: string; body: boolean }> = [];
    page.on("request", (request) => requests.push({ method: request.method(), url: request.url(), body: request.postData() !== null }));
    await uploadFiles(page, png("a.png", imageUpload("a", "png", 64, 64, 1).buffer), jpeg("b.jpg", imageUpload("b", "jpeg", 64, 64, 2).buffer));
    await runAndDownload(page);
    const outside = requests.filter((request) => !request.url.startsWith(origin) && !request.url.startsWith("blob:") && !request.url.startsWith("data:"));
    expect(outside, `peticiones fuera del origen:\n${outside.map((request) => request.url).join("\n")}`).toEqual([]);
    expect(requests.filter((request) => request.method !== "GET" || request.body)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Accesibilidad y maquetacion
 * ------------------------------------------------------------------ */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

type Theme = "light" | "dark";
type Language = "es" | "en";
type Cell = { theme: Theme; language: Language; width: number; wide: boolean; touch: boolean };

const CELLS: Cell[] = [
  { theme: "light", language: "es", width: 1280, wide: false, touch: false },
  { theme: "dark", language: "en", width: 1280, wide: false, touch: false },
  { theme: "dark", language: "es", width: 375, wide: true, touch: true },
  { theme: "light", language: "en", width: 375, wide: true, touch: true },
  { theme: "dark", language: "es", width: 320, wide: true, touch: true },
  { theme: "light", language: "en", width: 320, wide: true, touch: true },
];

async function newContext(browser: import("@playwright/test").Browser, cell: Cell): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.width < 600 ? 812 : 900 },
    colorScheme: cell.theme,
    hasTouch: cell.touch,
    isMobile: cell.touch,
    deviceScaleFactor: cell.touch ? 2 : 1,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([theme, language, css, wide]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
        window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
      } catch {
        /* storage bloqueado */
      }
      if (wide) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    },
    [cell.theme, cell.language, WIDE_CSS, cell.wide] as const,
  );
  return context;
}

type AxeViolation = { id: string; help: string; nodes: string[] };

async function runAxe(page: Page): Promise<AxeViolation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => ({
      id: violation.id,
      help: violation.help,
      nodes: violation.nodes.slice(0, 6).map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n")[1] ?? ""}`),
    }));
  });
}

const describeViolations = (violations: AxeViolation[]): string => violations.map((violation) => `${violation.id} (${violation.help}):\n   ${violation.nodes.join("\n   ")}`).join("\n");

/** Las entradas de pantalla funden en ~1 s: axe mide el contraste de un texto a medio fundido como si fuera el final. */
const settle = (page: Page): Promise<void> => page.waitForTimeout(1500);

async function expectNoOverflow(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = Array.from(document.querySelectorAll("main *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > doc.clientWidth + 1;
      })
      .slice(0, 5)
      .map((element) => `${element.tagName.toLowerCase()}.${String((element as HTMLElement).className).slice(0, 40)}`);
    return { scroll: doc.scrollWidth, client: doc.clientWidth, offenders };
  });
  expect(overflow.scroll, `${where}: desborde horizontal (${overflow.offenders.join(", ")})`).toBeLessThanOrEqual(overflow.client + 1);
  expect(overflow.offenders, `${where}: elementos fuera de la pantalla`).toEqual([]);
}

baseTest.describe("accesibilidad: axe (WCAG 2 A/AA), sin desborde y tactil", () => {
  for (const cell of CELLS) {
    const title = `${cell.theme} · ${cell.language} · ${cell.width}px${cell.wide ? " · tipografia ancha" : ""}`;
    baseTest(title, async ({ browser }) => {
      baseTest.setTimeout(180_000);
      const context = await newContext(browser, cell);
      const page = await context.newPage();
      const run = cell.language === "es" ? "Procesar" : "Process";
      const options = cell.language === "es" ? "Opciones" : "Options";
      const download = cell.language === "es" ? "Descargar" : "Download";
      try {
        await page.goto("/image-converter", { waitUntil: "networkidle" });
        await page.locator("main#content").waitFor();
        await settle(page);
        baseExpect(await runAxe(page), "pagina vacia").toEqual([]);
        await expectNoOverflow(page, "vacia");

        await page.locator('input[type="file"]').first().setInputFiles([
          png("logo-con-un-nombre-muy-largo-para-forzar-el-ajuste-de-linea.png", halfTransparentPng(60, 40)),
          jpeg("foto.jpg", imageUpload("f", "jpeg", 60, 40, 2).buffer),
          jpeg("rota.jpg", Buffer.from("no es una imagen")),
        ]);
        await page.locator("[data-image-problems]").waitFor();
        await settle(page);
        const loaded = await runAxe(page);
        baseExpect(loaded, `con archivos\n${describeViolations(loaded)}`).toEqual([]);
        await expectNoOverflow(page, "con archivos y aviso");

        // A < 768 px las opciones viven en una hoja.
        if (cell.width < 768) {
          await page.getByRole("button", { name: options, exact: true }).click();
          await page.getByRole("dialog").waitFor();
          await page.waitForTimeout(900);
        }
        const panel = await runAxe(page);
        baseExpect(panel, `opciones\n${describeViolations(panel)}`).toEqual([]);
        await expectNoOverflow(page, "opciones");

        if (cell.touch) {
          // Objetivos tactiles: todo control visible de las opciones mide >= 44 px (43 por el redondeo).
          const small = await page.evaluate(() => {
            const scope = document.querySelector('[role="dialog"]') ?? document.querySelector("main");
            const found: string[] = [];
            scope?.querySelectorAll('button, input:not([type="hidden"]), summary, [role="tab"], [role="radio"], a[href]').forEach((element) => {
              const rect = element.getBoundingClientRect();
              if (rect.width === 0 || rect.height === 0) return;
              const label = (element.getAttribute("aria-label") || element.textContent || element.tagName).trim().slice(0, 30);
              // El range y el checkbox ocultos tapan su zona con la etiqueta: se mide el hueco real que se puede tocar.
              const hit = Math.max(rect.height, (element.parentElement?.getBoundingClientRect().height ?? 0));
              if (hit < 43 || rect.width < 24) found.push(`${element.tagName.toLowerCase()} «${label}» ${Math.round(rect.width)}x${Math.round(rect.height)}`);
            });
            return found;
          });
          baseExpect(small, `controles pequeños:\n${small.join("\n")}`).toEqual([]);
        }

        if (cell.width < 768) {
          const dialog = page.getByRole("dialog");
          const done = dialog.getByRole("button", { name: /^(Listo|Aplicar|Cerrar|Done|Apply|Close)$/ }).first();
          if (await done.isVisible()) await done.click();
          else await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
        }

        await page.getByRole("button", { name: run, exact: true }).click();
        await page.getByRole("button", { name: download, exact: true }).waitFor({ timeout: 60_000 });
        await settle(page);
        const done = await runAxe(page);
        baseExpect(done, `descarga\n${describeViolations(done)}`).toEqual([]);
        await expectNoOverflow(page, "descarga");
        await baseExpect(page.locator("[data-download-notices]")).toBeVisible();
        await baseExpect(page.locator("[data-converted-details]")).toBeVisible();
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 5. Ingles
 * ------------------------------------------------------------------ */

baseTest.describe("ingles", () => {
  baseTest("textos, nombre del archivo y resumen en ingles", async ({ browser }) => {
    baseTest.setTimeout(120_000);
    const context = await newContext(browser, { theme: "dark", language: "en", width: 1280, wide: false, touch: false });
    const page = await context.newPage();
    try {
      await page.goto("/image-converter");
      await page.locator("main#content").waitFor();
      await page.locator('input[type="file"]').first().setInputFiles([png("sunset.png", halfTransparentPng(40, 30))]);
      await baseExpect(page.getByRole("tablist", { name: "Output format" })).toBeVisible();
      await baseExpect(page.getByRole("slider", { name: "Quality" })).toBeVisible();
      await baseExpect(page.getByLabel("Background color")).toBeVisible();
      await baseExpect(page.getByText(/metadata \(location, camera, date\) is removed/)).toBeVisible();
      await page.getByRole("button", { name: "Process", exact: true }).click();
      const button = page.getByRole("button", { name: "Download", exact: true });
      await baseExpect(button).toBeVisible({ timeout: 60_000 });
      const result = await downloadFile(page, async () => {
        await button.click();
      });
      baseExpect(result.filename).toBe("sunset-converted.jpg");
      await baseExpect(page.locator("[data-download-summary]")).toContainText(/^Converted to JPG: from .+ to .+\.$/);
    } finally {
      await context.close();
    }
  });
});
