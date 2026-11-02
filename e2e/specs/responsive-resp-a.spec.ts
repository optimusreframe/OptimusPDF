import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import JSZip from "jszip";
import { makeImage, makePdf } from "../helpers/test-files";
import { newTouchContext, type DeviceName } from "../helpers/touch-gestures";
import { describeMeasure, measure, type Measure } from "../helpers/responsive-measure";

/**
 * W-RESP-A · Responsive Apple Design de las herramientas PDF (carpetas por herramienta).
 *
 * Fija lo medido y corregido en la pasada de auditoria «rutas x viewports» (320, 390, 430, iPad 834 vertical, iPad 1194 horizontal, 1280, 1920):
 *   1. estado vacio: ninguna ruta de la lista desborda ni corta texto en 320 / 390 / 834 / 1280 px;
 *   2. con archivo cargado (PDF / imagen / Word / Excel sinteticos): sin desborde y con objetivos tactiles >= 44 px (320 y 834 con tacto) y sin
 *      campos < 16 px (iOS amplia la pagina al enfocarlos); tambien con la hoja «Opciones» abierta (390);
 *   3. tipografia ancha (DejaVu Sans + 6 % de espaciado a 320 px) y fuente del sistema al 150 % (393 y 834 px): sin desborde;
 *   4. las correcciones concretas (Dividir: quitar tramo; lista de paginas con teclado de texto; Censurar: quitar zona; Comparar: subrayado;
 *      Markdown: vista previa alcanzable con teclado; separacion de 8 px en acciones de miniaturas);
 *   5. axe (contraste, nombres, roles) en las pantallas tocadas, claro/oscuro x ES/EN;
 *   6. APIs ausentes (camara, OffscreenCanvas, WebGPU): mensaje honesto y via alternativa, sin errores de pagina.
 *
 * Headless siempre. Archivos 100 % sinteticos (generados aqui). `sign-pdf` y `pdf-pro` ya tienen specs moviles propios: aqui solo se comprueba
 * el desborde para no regresar nada.
 *
 * Los chequeos de color (muestras 44 px), segmentados (44 px), casillas y separacion de la rejilla de posicion dependen de los componentes
 * COMPARTIDOS de W-RESP-B (`src/components/ui`, `src/components/tool`): este spec presupone que ya estan integrados.
 */

test.setTimeout(900_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = ["color-contrast", "aria-valid-attr-value", "aria-valid-attr", "label", "button-name", "link-name", "aria-allowed-attr", "aria-required-children", "aria-required-parent", "nested-interactive", "scrollable-region-focusable"] as const;

const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;
const FONT150_CSS = `html { font-size: 150% !important; }`;

/** Todas las rutas de la unidad (las dos ultimas, solo desborde: tienen sus propios specs). */
const ROUTES = [
  "add-page-numbers", "add-watermark", "compare-pdf", "compress-pdf", "crop-pdf", "edit-pdf", "excel-to-pdf", "extract-assets", "extract-pages",
  "jpg-to-pdf", "merge-pdf", "ocr-pdf", "organize-pdf", "pdf-summarizer", "pdf-to-csv", "pdf-to-excel", "pdf-to-jpg", "pdf-to-json",
  "pdf-to-markdown", "pdf-to-pdfa", "pdf-to-powerpoint", "pdf-to-text", "pdf-to-word", "pdfs-to-zip", "powerpoint-to-pdf", "protect-pdf",
  "redact-pdf", "remove-pages", "repair-pdf", "rotate-pdf", "scan-to-pdf", "split-pdf", "translate-pdf", "unlock-pdf", "word-to-pdf",
  "sign-pdf", "pdf-pro",
] as const;
type Route = (typeof ROUTES)[number];

/** Que archivo sintetico acepta cada ruta (null = sin zona de carga util: se mide vacia). */
type Kind = "pdf" | "two-pdf" | "compare" | "image" | "docx" | "xlsx" | null;
const KIND: Record<Route, Kind> = {
  "add-page-numbers": "pdf", "add-watermark": "pdf", "compare-pdf": "compare", "compress-pdf": "pdf", "crop-pdf": "pdf", "edit-pdf": "pdf",
  "excel-to-pdf": "xlsx", "extract-assets": "pdf", "extract-pages": "pdf", "jpg-to-pdf": "image", "merge-pdf": "two-pdf", "ocr-pdf": "pdf",
  "organize-pdf": "pdf", "pdf-summarizer": "pdf", "pdf-to-csv": "pdf", "pdf-to-excel": "pdf", "pdf-to-jpg": "pdf", "pdf-to-json": "pdf",
  "pdf-to-markdown": "pdf", "pdf-to-pdfa": "pdf", "pdf-to-powerpoint": "pdf", "pdf-to-text": "pdf", "pdf-to-word": "pdf", "pdfs-to-zip": "two-pdf",
  "powerpoint-to-pdf": null, "protect-pdf": "pdf", "redact-pdf": "pdf", "remove-pages": "pdf", "repair-pdf": "pdf", "rotate-pdf": "pdf",
  "scan-to-pdf": null, "split-pdf": "pdf", "translate-pdf": "pdf", "unlock-pdf": "pdf", "word-to-pdf": "docx", "sign-pdf": "pdf", "pdf-pro": "pdf",
};
/** Con su propio spec movil de objetivos: aqui solo desborde. */
const OVERFLOW_ONLY = new Set<Route>(["sign-pdf", "pdf-pro"]);

/* ------------------------------------------------------------------ *
 * Archivos sinteticos (se generan una vez por ejecucion)
 * ------------------------------------------------------------------ */
type Upload = { name: string; mimeType: string; buffer: Buffer };
let fixtures: { pdf: Upload; pdfB: Upload; images: Upload[]; docx: Upload; xlsx: Upload; textA: Upload; textB: Upload } | null = null;

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, text] of Object.entries(files)) zip.file(name, text);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function getFixtures() {
  if (fixtures) return fixtures;
  const contentTypes = (extra: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${extra}</Types>`;
  const rels = (target: string) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;
  const docx = await zipOf({
    "[Content_Types].xml": contentTypes('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
    "_rels/.rels": rels("word/document.xml"),
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Documento sintetico de prueba</w:t></w:r></w:p></w:body></w:document>`,
  });
  const xlsx = await zipOf({
    "[Content_Types].xml": contentTypes('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
    "_rels/.rels": rels("xl/workbook.xml"),
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Concepto</t></is></c><c r="B1" t="inlineStr"><is><t>Importe</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Saldo</t></is></c><c r="B2"><v>100</v></c></row></sheetData></worksheet>`,
  });
  fixtures = {
    pdf: { name: "a.pdf", mimeType: "application/pdf", buffer: await makePdf({ pages: 3, label: "RESP" }) },
    pdfB: { name: "b.pdf", mimeType: "application/pdf", buffer: await makePdf({ pages: 2, label: "BETA" }) },
    images: [
      { name: "a.png", mimeType: "image/png", buffer: makeImage("png", 400, 300, 1) },
      { name: "b.png", mimeType: "image/png", buffer: makeImage("png", 300, 400, 2) },
    ],
    docx: { name: "s.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx },
    xlsx: { name: "s.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: xlsx },
    textA: { name: "antes.pdf", mimeType: "application/pdf", buffer: await makePdf({ pages: 1, text: () => "alfa beta gamma" }) },
    textB: { name: "despues.pdf", mimeType: "application/pdf", buffer: await makePdf({ pages: 1, text: () => "alfa delta gamma" }) },
  };
  return fixtures;
}

/* ------------------------------------------------------------------ *
 * Contextos y utilidades
 * ------------------------------------------------------------------ */
type Theme = "light" | "dark";
type Language = "es" | "en";
type Look = { theme?: Theme; language?: Language; css?: string };

async function seed(context: BrowserContext, look: Look) {
  await context.addInitScript(
    ([theme, language, css]) => {
      try {
        localStorage.setItem("optimuspdf.theme", theme);
        localStorage.setItem("optimuspdf.language", language);
        // Avisos de privacidad de Firmar/Editar: no deben tapar la pagina.
        localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
      } catch {
        /* sin almacenamiento */
      }
      if (css) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    },
    [look.theme ?? "light", look.language ?? "es", look.css ?? ""] as const,
  );
}

async function touchContext(browser: Browser, device: DeviceName, look: Look = {}) {
  const context = await newTouchContext(browser, device, { colorScheme: look.theme ?? "light", locale: look.language === "en" ? "en-US" : "es-ES" });
  await seed(context, look);
  return context;
}

async function desktopContext(browser: Browser, width: number, height: number, look: Look = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: look.theme ?? "light", locale: look.language === "en" ? "en-US" : "es-ES" });
  await seed(context, look);
  return context;
}

async function open(page: Page, route: string) {
  await page.goto(`/${route}`, { waitUntil: "networkidle" });
  await page.locator("main#content").waitFor();
}

const FILE_INPUT = 'input[type="file"][accept*="pdf"], input[type="file"][accept*="image"], input[type="file"][accept*="word"], input[type="file"][accept*="sheet"]';

/** Sube el archivo sintetico que corresponde a la ruta y deja que se asiente (pdf.js, miniaturas, lienzos). */
async function load(page: Page, route: Route) {
  const kind = KIND[route];
  if (!kind) return;
  // Sin zona de carga (p. ej. «Resumir PDF» en un navegador sin WebGPU muestra el motivo en vez del selector): se mide tal cual.
  if (!(await page.locator(FILE_INPUT).count())) return;
  const f = await getFixtures();
  if (kind === "compare") {
    await page.locator(FILE_INPUT).first().setInputFiles(f.pdf);
    await page.waitForTimeout(900);
    await page.locator(FILE_INPUT).first().setInputFiles(f.pdfB);
  } else {
    const files = kind === "two-pdf" ? [f.pdf, f.pdfB] : kind === "image" ? f.images : kind === "docx" ? [f.docx] : kind === "xlsx" ? [f.xlsx] : [f.pdf];
    await page.locator(FILE_INPUT).first().setInputFiles(files);
  }
  await page.waitForTimeout(2500);
}

/** En movil (< 768 px) las opciones viven en una hoja: se abre con «Opciones». Devuelve si se abrio. */
async function openOptionsSheet(page: Page): Promise<boolean> {
  const button = page.getByRole("button", { name: /^(Opciones|Options)$/ }).first();
  if (!(await button.count()) || !(await button.isVisible())) return false;
  await button.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(900);
  return true;
}

/** Chequeos de una medicion: lo que cuenta como fallo segun la ruta. */
function problems(route: Route, m: Measure, options: { targets: boolean }): string {
  // `edit-pdf`: los bloques de texto del PDF (`Texto: ...`) son zonas de edicion del tamaño del contenido, no controles de interfaz.
  const small = route === "edit-pdf" ? m.smallTargets.filter((entry) => !entry.startsWith("Texto:")) : m.smallTargets;
  return describeMeasure({ ...m, smallTargets: small }, { targets: options.targets && !OVERFLOW_ONLY.has(route), zoom: !OVERFLOW_ONLY.has(route) });
}

async function runAxe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (rules) => {
    type Axe = { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> };
    const axe = (window as unknown as { axe: Axe }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.slice(0, 4).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`).join(" | ")}`);
  }, AXE_RULES);
}

/* ------------------------------------------------------------------ *
 * 1. Estado vacio: sin desborde ni texto cortado
 * ------------------------------------------------------------------ */
test.describe("estado vacio · sin desborde horizontal ni texto cortado", () => {
  const SIZES: Array<{ label: string; device?: DeviceName; width?: number; height?: number }> = [
    { label: "320 (iPhone SE)", device: "se320" },
    { label: "393 (iPhone 15)", device: "iphone15" },
    { label: "834 (iPad vertical)", device: "ipadPortrait" },
    { label: "1280 (portatil)", width: 1280, height: 800 },
  ];
  for (const size of SIZES) {
    test(`${size.label}: las ${ROUTES.length} rutas`, async ({ browser }) => {
      const context = size.device ? await touchContext(browser, size.device) : await desktopContext(browser, size.width!, size.height!);
      const page = await context.newPage();
      const failures: string[] = [];
      try {
        for (const route of ROUTES) {
          try {
            await open(page, route);
            const text = problems(route, await measure(page), { targets: true });
            if (text) failures.push(`/${route}: ${text}`);
          } catch (error) {
            failures.push(`/${route}: ${String(error).slice(0, 160)}`);
          }
        }
      } finally {
        await context.close();
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------ *
 * 2. Con archivo cargado
 * ------------------------------------------------------------------ */
test.describe("con archivo · sin desborde, objetivos >= 44 px con tacto y campos de 16 px", () => {
  for (const device of ["se320", "ipadPortrait"] as DeviceName[]) {
    test(`${device}: todas las herramientas con su archivo sintetico`, async ({ browser }) => {
      const context = await touchContext(browser, device);
      const page = await context.newPage();
      const failures: string[] = [];
      try {
        for (const route of ROUTES.filter((r) => KIND[r])) {
          try {
            await open(page, route);
            await load(page, route);
            const text = problems(route, await measure(page), { targets: true });
            if (text) failures.push(`/${route}: ${text}`);
          } catch (error) {
            failures.push(`/${route}: ${String(error).slice(0, 160)}`);
          }
        }
      } finally {
        await context.close();
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }

  test("1280 (portatil): con archivo, sin desborde", async ({ browser }) => {
    const context = await desktopContext(browser, 1280, 800);
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      for (const route of ROUTES.filter((r) => KIND[r])) {
        try {
          await open(page, route);
          await load(page, route);
          const text = problems(route, await measure(page), { targets: false });
          if (text) failures.push(`/${route}: ${text}`);
        } catch (error) {
          failures.push(`/${route}: ${String(error).slice(0, 160)}`);
        }
      }
    } finally {
      await context.close();
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  test("393 (iPhone 15): la hoja «Opciones» abierta, objetivos y campos", async ({ browser }) => {
    const context = await touchContext(browser, "iphone15");
    const page = await context.newPage();
    const failures: string[] = [];
    try {
      for (const route of ROUTES.filter((r) => KIND[r] && !OVERFLOW_ONLY.has(r))) {
        try {
          await open(page, route);
          await load(page, route);
          if (!(await openOptionsSheet(page))) continue;
          const text = problems(route, await measure(page), { targets: true });
          if (text) failures.push(`/${route} (hoja Opciones): ${text}`);
        } catch (error) {
          failures.push(`/${route}: ${String(error).slice(0, 160)}`);
        }
      }
    } finally {
      await context.close();
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Tipografia grande
 * ------------------------------------------------------------------ */
test.describe("tipografia grande · sin desborde", () => {
  // DejaVu Sans + 6 % es la regla de `nav-optimustools.spec.ts` (320 px). Con la fuente al 150 % a 320 px la cabecera (ES/EN), la barra de pestañas y las barras
  // fijas del ToolShell (componentes compartidos de W-RESP-B / W-NAV2) todavia desbordan ~29 px: se mide a 393 y 834 px, donde las pantallas de las
  // herramientas ya caben (el selector de idioma de OCR / PDF a Markdown pasa a otra fila con `wrap`).
  const CASES: Array<{ label: string; css: string; device: DeviceName }> = [
    { label: "DejaVu Sans + 6 % de espaciado · 320 px", css: WIDE_CSS, device: "se320" },
    { label: "fuente del sistema al 150 % · 393 px", css: FONT150_CSS, device: "iphone15" },
    { label: "fuente del sistema al 150 % · iPad 834 px", css: FONT150_CSS, device: "ipadPortrait" },
  ];
  for (const { label, css, device } of CASES) {
    test(label, async ({ browser }) => {
      const context = await touchContext(browser, device, { css });
      const page = await context.newPage();
      const failures: string[] = [];
      try {
        for (const route of ROUTES.filter((r) => !OVERFLOW_ONLY.has(r))) {
          try {
            await open(page, route);
            await load(page, route);
            const m = await measure(page);
            // Escaner con tipografia ancha a 320 px: la barra de pestañas (`layout/*`, de W-NAV2) pasa 5 px del borde («Ajustes»); no es de la herramienta.
            const tabBarOnly = route === "scan-to-pdf" && m.offScreen.length > 0 && m.offScreen.every((entry) => entry.startsWith("Ajustes"));
            const text = describeMeasure({ ...m, smallTargets: [], zoomFields: [], ...(tabBarOnly ? { overflowPx: 0, offScreen: [] } : null) });
            if (text) failures.push(`/${route}: ${text}`);
          } catch (error) {
            failures.push(`/${route}: ${String(error).slice(0, 160)}`);
          }
        }
      } finally {
        await context.close();
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------ *
 * 4. Correcciones concretas
 * ------------------------------------------------------------------ */
test.describe("correcciones concretas", () => {
  test("Dividir PDF: «Quitar este tramo» mide 44 px con el dedo y 24 px con raton", async ({ browser }) => {
    for (const touch of [true, false]) {
      const context = touch ? await touchContext(browser, "ipadPortrait") : await desktopContext(browser, 1280, 800);
      const page = await context.newPage();
      try {
        await open(page, "split-pdf");
        await load(page, "split-pdf");
        const button = page.getByRole("button", { name: "Quitar este tramo" }).first();
        await expect(button).toBeVisible();
        const box = (await button.boundingBox())!;
        if (touch) {
          expect(Math.round(box.width), "ancho con el dedo").toBeGreaterThanOrEqual(44);
          expect(Math.round(box.height), "alto con el dedo").toBeGreaterThanOrEqual(44);
        } else {
          expect(Math.round(box.width), "con raton no cambia").toBe(24);
        }
      } finally {
        await context.close();
      }
    }
  });

  test("lista de paginas: teclado de texto (iOS necesita «-» y «,») y 16 px con el dedo", async ({ browser }) => {
    const context = await touchContext(browser, "ipadPortrait");
    const page = await context.newPage();
    try {
      await open(page, "remove-pages");
      await load(page, "remove-pages");
      const field = page.getByLabel("Páginas a eliminar");
      await expect(field).toBeVisible();
      expect(await field.getAttribute("inputmode")).toBe("text");
      expect(await field.getAttribute("autocapitalize")).toBe("off");
      expect(await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
      // «1-2, 3» se escribe de verdad (el teclado numerico de iOS no tiene «-» ni «,»).
      await field.fill("1-2, 3");
      await expect(field).toHaveValue("1-2, 3");
    } finally {
      await context.close();
    }
  });

  test("Censurar PDF: quitar una zona dibujada mide 44 px con el dedo y el selector de color tambien", async ({ browser }) => {
    const context = await touchContext(browser, "ipadPortrait");
    const page = await context.newPage();
    try {
      await open(page, "redact-pdf");
      await load(page, "redact-pdf");
      const host = page.locator('[data-testid="redact-canvas-host"]');
      await expect(host).toBeVisible();
      const box = (await host.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.32, { steps: 6 });
      await page.mouse.up();
      await expect(page.getByRole("button", { name: "Quitar esta zona" })).toBeVisible();
      await page.getByRole("tab", { name: "Color" }).click();
      const m = await measure(page);
      const small = m.smallTargets.filter((entry) => /Quitar esta zona|Color/.test(entry));
      expect(small, `objetivos < 44 px: ${small.join("; ")}`).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("Comparar PDF: lo insertado se subraya y lo eliminado se tacha (no solo color) y la leyenda lo muestra", async ({ browser }) => {
    const context = await touchContext(browser, "iphone15");
    const page = await context.newPage();
    try {
      const f = await getFixtures();
      await open(page, "compare-pdf");
      await page.locator(FILE_INPUT).first().setInputFiles(f.textA);
      await page.waitForTimeout(900);
      await page.locator(FILE_INPUT).first().setInputFiles(f.textB);
      await page.getByRole("button", { name: "Comparar", exact: true }).click();
      const inserted = page.locator("span.underline", { hasText: "delta" }).first();
      await expect(inserted).toBeVisible({ timeout: 60_000 });
      expect(await inserted.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("underline");
      const removed = page.locator("span.line-through", { hasText: "beta" }).first();
      expect(await removed.evaluate((el) => getComputedStyle(el).textDecorationLine)).toContain("line-through");
      // La leyenda repite el estilo (muestra «Aa» subrayada / tachada), no solo un punto de color.
      expect(await page.locator("span.underline", { hasText: "Aa" }).count()).toBeGreaterThan(0);
      expect(await page.locator("span.line-through", { hasText: "Aa" }).count()).toBeGreaterThan(0);
      const m = await measure(page);
      expect(describeMeasure(m, { zoom: false })).toBe("");
    } finally {
      await context.close();
    }
  });

  test("PDF a Markdown: la vista previa con scroll propio se alcanza con teclado y no pasa del 60 % de la pantalla", async ({ browser }) => {
    const context = await touchContext(browser, "iphone15");
    const page = await context.newPage();
    try {
      await open(page, "pdf-to-markdown");
      await load(page, "pdf-to-markdown");
      await page.getByRole("button", { name: "Generar vista previa" }).click();
      const preview = page.getByRole("region", { name: "Vista previa" });
      await expect(preview).toBeVisible({ timeout: 60_000 });
      expect(await preview.getAttribute("tabindex")).toBe("0");
      const height = (await preview.boundingBox())!.height;
      expect(height).toBeLessThanOrEqual(Math.ceil((page.viewportSize()!.height || 852) * 0.6) + 1);
    } finally {
      await context.close();
    }
  });

  test("miniaturas con dedo: acciones de 44 px separadas >= 8 px (Organizar) y flechas de orden (Imagen a PDF)", async ({ browser }) => {
    const context = await touchContext(browser, "iphone15");
    const page = await context.newPage();
    try {
      for (const route of ["organize-pdf", "jpg-to-pdf"] as const) {
        await open(page, route);
        await load(page, route);
        const gaps = await page.evaluate(() => {
          const buttons = [...document.querySelectorAll<HTMLElement>("main li button[aria-label], main li [role=button][aria-label]")].filter((el) => el.getBoundingClientRect().width > 2 && !el.closest("[aria-hidden=true]"));
          const worst: string[] = [];
          for (let i = 0; i < buttons.length; i += 1) {
            for (let j = i + 1; j < buttons.length; j += 1) {
              const a = buttons[i].getBoundingClientRect();
              const b = buttons[j].getBoundingClientRect();
              const overlapV = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              const overlapH = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              let gap: number | null = null;
              if (overlapV > 8) gap = Math.max(b.left - a.right, a.left - b.right);
              else if (overlapH > 8) gap = Math.max(b.top - a.bottom, a.top - b.bottom);
              if (gap !== null && gap >= -0.01 && gap < 7.5) worst.push(`${buttons[i].getAttribute("aria-label")} | ${buttons[j].getAttribute("aria-label")} ${gap.toFixed(1)} px`);
            }
          }
          return worst;
        });
        expect(gaps, `/${route}: separacion < 8 px entre acciones`).toEqual([]);
      }
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 5. axe en las pantallas tocadas
 * ------------------------------------------------------------------ */
test.describe("axe · pantallas tocadas", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const language of ["es", "en"] as const) {
      test(`${theme} · ${language} · 393 px`, async ({ browser }) => {
        const context = await touchContext(browser, "iphone15", { theme, language });
        const page = await context.newPage();
        const failures: string[] = [];
        try {
          for (const route of ["split-pdf", "remove-pages", "organize-pdf", "redact-pdf", "pdf-to-markdown", "protect-pdf", "jpg-to-pdf", "compare-pdf", "scan-to-pdf"] as const) {
            await open(page, route);
            await load(page, route);
            for (const violation of await runAxe(page)) failures.push(`/${route}: ${violation}`);
            if (await openOptionsSheet(page)) for (const violation of await runAxe(page)) failures.push(`/${route} (hoja Opciones): ${violation}`);
          }
        } finally {
          await context.close();
        }
        expect(failures, failures.join("\n")).toEqual([]);
      });
    }
  }
});

/* ------------------------------------------------------------------ *
 * 6. APIs ausentes: mensaje honesto y via alternativa
 * ------------------------------------------------------------------ */
test.describe("APIs ausentes", () => {
  test("Escanear a PDF sin camara (getUserMedia ausente): mensaje claro y elegir fotos sigue disponible", async ({ browser }) => {
    const context = await touchContext(browser, "iphone15");
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await open(page, "scan-to-pdf");
      await page.getByRole("button", { name: "Activar cámara" }).click();
      await expect(page.getByText("Este navegador no permite abrir la cámara desde una web.").first()).toBeVisible();
      await expect(page.getByText("Elegir fotos").first()).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("Resumir PDF sin WebGPU: explica por que no y no deja un error generico", async ({ browser }) => {
    const context = await touchContext(browser, "iphone15");
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await open(page, "pdf-summarizer");
      await expect(page.getByText("Tu navegador no puede ejecutar esta herramienta")).toBeVisible();
      await expect(page.getByText(/no tiene WebGPU/i).first()).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("sin OffscreenCanvas (Safari antiguo): Imagen a PDF, PDF a JPG y Extraer elementos cargan su archivo sin error de pagina", async ({ browser }) => {
    const context = await touchContext(browser, "iphone15");
    await context.addInitScript(() => {
      Object.defineProperty(window, "OffscreenCanvas", { value: undefined, configurable: true });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      for (const route of ["jpg-to-pdf", "pdf-to-jpg", "extract-assets"] as const) {
        await open(page, route);
        await load(page, route);
        await expect(page.getByText(/a\.pdf|a\.png/).first()).toBeVisible();
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
