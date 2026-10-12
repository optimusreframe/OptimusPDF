import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import type { Page, Response } from "@playwright/test";
import { expect as baseExpect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

/**
 * PDF Pro · carga diferida de los motores pesados (Wave 7), navegador real y headless.
 *
 * `/pdf-pro` no puede descargar docx, exceljs, pptxgenjs ni jszip hasta que el usuario los necesita. El E2E registra TODAS las
 * respuestas JavaScript (cuerpo y tamaño transferido) y busca MARCADORES EN SU CONTENIDO (no por nombre de archivo, que
 * cambia en cada compilacion):
 *
 *   `PptxGenJS`            -> pptxgenjs (PowerPoint)
 *   `ExcelJS` / `exceljs`  -> exceljs (Excel)
 *   `w:document`           -> docx (Word)
 *   `JSZip`                -> jszip (ZIP): tambien va EMBEBIDO dentro de los trozos de docx y exceljs
 *
 * Tras cargar el estado vacio, abrir un PDF y visitar TODAS las pestañas (Convertir incluida, con todas las opciones
 * abiertas) SIN exportar, ningun trozo descargado puede llevar `PptxGenJS`, `ExcelJS` ni `w:document`. Despues se exporta a Word,
 * PowerPoint y Excel (con un PDF que lleva una tabla real de 2 columnas x 3 filas, sin la cual el motor de Excel falla antes
 * de importar `exceljs`) y cada exportacion tiene que traer un trozo NUEVO con su marcador. Se imprime la tabla de bytes de
 * JavaScript por fase y el peso de cada trozo diferido, y se adjunta como `js-chunks.json`.
 *
 * HISTORIA (BUNDLE-1, arreglado en U8): `jszip` (~48 KB, ~15 KB comprimido) llegaba en la CARGA INICIAL por imports estaticos
 * (`compress.ts -> imagesToPdf.ts` solo para `canvasToBlob`; `signBatch -> pdfsToZip` solo por dos constantes; `signConfig`,
 * `signBatch` y `signVaultFile` importaban la libreria). Ahora `canvasBlob.ts`, `zipLimits.ts` y `lazyZip.ts` son modulos
 * ligeros y jszip solo se descarga al dividir en ZIP, exportar varias imagenes, crear desde imagenes o usar el baul de
 * firmas. La libreria se reconoce por su mensaje de error («Corrupted zip or bug»): otros trozos grandes solo mencionan la
 * palabra «JSZip». Con `PRO_BUNDLE_TOLERATE=1` el exceso de jszip solo se anota.
 *
 * Verificado con una mutacion sobre una copia del repositorio: añadir `import "@/lib/pdf/pdfToWord"` (estatico) a
 * `export/registerExports.ts` mete docx en la carga inicial y las dos pruebas de carga diferida fallan («w:document»).
 *
 * Uso: `PW_PORT=3673 npx playwright test e2e/specs/pdf-pro-bundle.spec.ts --project=chromium`
 */

// Con varios navegadores a la vez los 5 s de `expect` por defecto se quedan cortos al esperar hojas y descargas.
const expect = baseExpect.configure({ timeout: 12_000 });

const S = PRO_STRINGS.es;
const E = S.export;
const STRICT = process.env.PRO_BUNDLE_TOLERATE !== "1";

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 }, actionTimeout: 30_000 });
test.setTimeout(240_000);

/* ------------------------------------------------------------------ *
 * Registro de JavaScript descargado
 * ------------------------------------------------------------------ */

const MARKERS = {
  PptxGenJS: /PptxGenJS/,
  ExcelJS: /ExcelJS|exceljs/i,
  "w:document": /w:document/,
  // La libreria jszip (su mensaje de error es unico): otros trozos grandes SOLO mencionan la palabra «JSZip».
  JSZip: /Corrupted zip or bug/,
} as const;
type MarkerName = keyof typeof MARKERS;
const HEAVY: readonly MarkerName[] = ["PptxGenJS", "ExcelJS", "w:document"];

type Chunk = {
  path: string;
  phase: string;
  /** Bytes del archivo ya descomprimido. */
  raw: number;
  /** Bytes que viajaron por la red: cabeceras + cuerpo comprimido segun Playwright o, si no los da, gzip del cuerpo (estimado). */
  transferred: number;
  /** `true` cuando `transferred` es una estimacion (gzip nivel 6 del cuerpo) y no la medida de red. */
  estimated: boolean;
  markers: MarkerName[];
};

class JsRecorder {
  readonly chunks = new Map<string, Chunk>();
  phase = "inicial";
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly page: Page) {
    page.on("response", (response) => {
      this.pending.push(this.capture(response));
    });
  }

  private async capture(response: Response): Promise<void> {
    const url = response.url();
    const type = response.headers()["content-type"] ?? "";
    if (url.startsWith("data:") || !(/javascript/.test(type) || /\.m?js(\?|$)/.test(url))) return;
    if (this.chunks.has(url)) return;
    try {
      const body = await response.body();
      const text = body.toString("utf8");
      // Medida de red de Playwright cuando es verosimil (menor que el cuerpo descomprimido); si el navegador no la da bien
      // (el worker de pdf.js la devuelve igual que el cuerpo entero) y la respuesta venia comprimida, se estima con gzip.
      let transferred = body.length;
      let estimated = false;
      try {
        const sizes = await response.request().sizes();
        if (sizes.responseBodySize > 0 && sizes.responseBodySize < body.length) transferred = sizes.responseBodySize + sizes.responseHeadersSize;
        else if (response.headers()["content-encoding"]) {
          transferred = gzipSync(body, { level: 6 }).length;
          estimated = true;
        }
      } catch {
        /* sin medida de red (cache): se usa el tamaño del cuerpo */
      }
      this.chunks.set(url, {
        path: new URL(url).pathname,
        phase: this.phase,
        raw: body.length,
        transferred,
        estimated,
        markers: (Object.keys(MARKERS) as MarkerName[]).filter((name) => MARKERS[name].test(text)),
      });
    } catch {
      /* respuesta sin cuerpo (redireccion o peticion cancelada) */
    }
  }

  /** Espera a que la red se aquiete y a que se hayan leido todas las respuestas. */
  async settle(): Promise<void> {
    await this.page.waitForTimeout(900);
    await this.page.waitForLoadState("networkidle");
    await Promise.all(this.pending);
    await this.page.waitForTimeout(250);
    await Promise.all(this.pending);
  }

  inPhase(phase: string): Chunk[] {
    return [...this.chunks.values()].filter((chunk) => chunk.phase === phase);
  }

  before(phases: readonly string[]): Chunk[] {
    return [...this.chunks.values()].filter((chunk) => phases.includes(chunk.phase));
  }
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const withMarker = (chunks: readonly Chunk[], marker: MarkerName): Chunk[] => chunks.filter((chunk) => chunk.markers.includes(marker));

/* ------------------------------------------------------------------ *
 * Documento de prueba: una pagina con una tabla real (2 columnas x 3 filas)
 * ------------------------------------------------------------------ */

/**
 * Geometria que reconoce el detector de tablas (`tryTable` de `pdfToMarkdown`): columnas alineadas con un hueco mayor que
 * `CELL_GAP_RATIO x tamaño de letra`. Sin una tabla detectada, el motor de Excel lanza `noTablesFound` ANTES de importar
 * `exceljs`, y el trozo diferido no llegaria a descargarse.
 */
async function buildTablePdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  const rows = [
    ["Name", "Value"],
    ["ProductOneXYZ", "7"],
    ["ProductTwoXYZ", "5"],
  ];
  rows.forEach(([left, right], index) => {
    const y = 792 - (100 + index * 30);
    page.drawText(left, { x: 72, y, size: 11, font });
    page.drawText(right, { x: 300, y, size: 11, font });
  });
  return Buffer.from(await document.save());
}

const DOC_NAME = "table.pdf";

async function openDocument(page: Page, bytes: Buffer): Promise<void> {
  await page.locator('input[type="file"]').first().setInputFiles({ name: DOC_NAME, mimeType: "application/pdf", buffer: bytes });
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(DOC_NAME.replace(".", "\\.")) })).toBeVisible();
  await expect(page.locator('article[data-state="ready"]').first()).toBeVisible({ timeout: 30_000 });
}

async function goToTab(page: Page, tab: "home" | "pages" | "edit" | "annotate" | "sign" | "protect" | "convert"): Promise<void> {
  await page.locator(`[role="tab"][data-tab="${tab}"]`).click();
  await expect(page.locator(`[role="tab"][data-tab="${tab}"]`)).toHaveAttribute("aria-selected", "true");
}

/* ------------------------------------------------------------------ *
 * Tabla de resultados
 * ------------------------------------------------------------------ */

function table(recorder: JsRecorder, phases: readonly string[]): string[] {
  const lines = [
    "",
    "[bundle] JavaScript descargado en /pdf-pro por fase (sin comprimir / transferido; «~» = estimado con gzip):",
    `[bundle] ${"fase".padEnd(34)} ${"trozos".padStart(6)} ${"sin comprimir".padStart(14)} ${"transferido".padStart(12)}`,
  ];
  for (const phase of phases) {
    const chunks = recorder.inPhase(phase);
    const raw = chunks.reduce((sum, chunk) => sum + chunk.raw, 0);
    const transferred = chunks.reduce((sum, chunk) => sum + chunk.transferred, 0);
    const estimated = chunks.some((chunk) => chunk.estimated) ? "~" : " ";
    lines.push(`[bundle] ${phase.padEnd(34)} ${String(chunks.length).padStart(6)} ${kb(raw).padStart(14)} ${(estimated + kb(transferred)).padStart(12)}`);
  }
  lines.push("[bundle] Trozos con motores pesados (diferidos o no):");
  for (const chunk of [...recorder.chunks.values()].filter((entry) => entry.markers.length > 0)) {
    lines.push(
      `[bundle]   ${chunk.markers.join("+").padEnd(26)} fase «${chunk.phase}»  ${kb(chunk.raw).padStart(10)} sin comprimir  ${(chunk.estimated ? "~" : "") + kb(chunk.transferred).padStart(10)} transferido  ${chunk.path}`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ *
 * Pruebas
 * ------------------------------------------------------------------ */

test.describe("carga diferida de los motores pesados", () => {
  test("estado vacio, documento y todas las pestañas (sin exportar) no descargan docx, exceljs ni pptxgenjs; cada exportacion trae su trozo nuevo", async ({ page }) => {
    const recorder = new JsRecorder(page);
    const bytes = await buildTablePdf();

    /* ---- estado vacio ---- */
    recorder.phase = "1 estado vacio";
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await recorder.settle();

    /* ---- documento abierto ---- */
    recorder.phase = "2 con documento";
    await openDocument(page, bytes);
    await recorder.settle();

    /* ---- todas las pestañas, sin exportar ---- */
    recorder.phase = "3 pestañas (Convertir) sin exportar";
    for (const tab of ["pages", "edit", "annotate", "sign", "protect"] as const) {
      await goToTab(page, tab);
      await page.waitForTimeout(400);
    }
    await goToTab(page, "convert");
    // Se despliegan las opciones de TODAS las tarjetas: sus paneles tampoco pueden arrastrar un motor pesado.
    const closed = page.locator('[data-export] button[aria-expanded="false"][aria-controls]');
    for (let remaining = await closed.count(); remaining > 0; remaining = await closed.count()) {
      await closed.first().scrollIntoViewIfNeeded();
      await closed.first().click();
    }
    await expect(page.locator("[data-export-options]:visible").first()).toBeVisible();
    await recorder.settle();

    const initialPhases = ["1 estado vacio", "2 con documento", "3 pestañas (Convertir) sin exportar"];
    const beforeExport = recorder.before(initialPhases);
    expect(beforeExport.length, "se registraron trozos de JavaScript").toBeGreaterThan(20);
    for (const marker of HEAVY) {
      expect(
        withMarker(beforeExport, marker).map((chunk) => `${chunk.path} (${chunk.phase})`),
        `ningun trozo descargado antes de exportar puede llevar «${marker}»`,
      ).toEqual([]);
    }

    /* ---- Word ---- */
    recorder.phase = "4 exportar a Word";
    await page.locator('[data-export="word"]').scrollIntoViewIfNeeded();
    const word = await downloadFile(page, () => page.locator('[data-export="word"]').getByRole("button", { name: E.formats.word.title, exact: true }).click());
    await recorder.settle();
    expect(word.filename).toBe("table-word.docx");
    const docx = await JSZip.loadAsync(word.bytes);
    expect(await docx.file("word/document.xml")!.async("string"), "el .docx lleva el texto de la tabla").toContain("ProductOneXYZ");
    const wordChunks = recorder.inPhase("4 exportar a Word");
    expect(withMarker(wordChunks, "w:document").length, "aparece un trozo nuevo con «w:document» (docx)").toBeGreaterThanOrEqual(1);
    expect(withMarker(wordChunks, "PptxGenJS"), "exportar a Word no trae pptxgenjs").toEqual([]);
    expect(withMarker(wordChunks, "ExcelJS"), "exportar a Word no trae exceljs").toEqual([]);

    /* ---- PowerPoint ---- */
    recorder.phase = "5 exportar a PowerPoint";
    await page.locator('[data-export="powerpoint"]').scrollIntoViewIfNeeded();
    const pptx = await downloadFile(page, () => page.locator('[data-export="powerpoint"]').getByRole("button", { name: E.formats.powerpoint.title, exact: true }).click());
    await recorder.settle();
    expect(pptx.filename).toBe("table-presentacion.pptx");
    const slides = await JSZip.loadAsync(pptx.bytes);
    expect(Object.keys(slides.files).some((name) => name.startsWith("ppt/slides/slide")), "el .pptx lleva diapositivas").toBe(true);
    const pptxChunks = recorder.inPhase("5 exportar a PowerPoint");
    expect(withMarker(pptxChunks, "PptxGenJS").length, "aparece un trozo nuevo con «PptxGenJS»").toBeGreaterThanOrEqual(1);
    expect(withMarker(pptxChunks, "ExcelJS"), "exportar a PowerPoint no trae exceljs").toEqual([]);

    /* ---- Excel ---- */
    recorder.phase = "6 exportar a Excel";
    await page.locator('[data-export="excel"]').scrollIntoViewIfNeeded();
    const xlsx = await downloadFile(page, () => page.locator('[data-export="excel"]').getByRole("button", { name: E.formats.excel.title, exact: true }).click());
    await recorder.settle();
    expect(xlsx.filename).toBe("table-pdf-a-excel.xlsx");
    const book = await JSZip.loadAsync(xlsx.bytes);
    expect(await book.file("xl/worksheets/sheet1.xml")!.async("string"), "el .xlsx lleva las filas de la tabla").toBeTruthy();
    const excelChunks = recorder.inPhase("6 exportar a Excel");
    expect(withMarker(excelChunks, "ExcelJS").length, "aparece un trozo nuevo con «ExcelJS»").toBeGreaterThanOrEqual(1);

    /* ---- informe ---- */
    const phases = ["1 estado vacio", "2 con documento", "3 pestañas (Convertir) sin exportar", "4 exportar a Word", "5 exportar a PowerPoint", "6 exportar a Excel"];
    const lines = table(recorder, phases);
    console.log(lines.join("\n"));
    await test.info().attach("js-chunks.json", {
      body: JSON.stringify(
        phases.map((phase) => ({ phase, chunks: recorder.inPhase(phase).map((chunk) => ({ ...chunk })) })),
        null,
        2,
      ),
      contentType: "application/json",
    });

    /* ---- JSZip: llega por usos legitimos (dividir en ZIP, imagenes, baul de firmas), pero no antes de usarlos ---- */
    const earlyJsZip = withMarker(beforeExport, "JSZip").map((chunk) => `${chunk.path} (${chunk.phase}, ${kb(chunk.raw)} sin comprimir, ${kb(chunk.transferred)} transferido)`);
    if (earlyJsZip.length > 0 && !STRICT) {
      test.info().annotations.push({
        type: "defecto-de-producto BUNDLE-1",
        description: `JSZip se descarga ya en la carga de /pdf-pro, antes de usar ninguna accion que lo necesite: ${earlyJsZip.join("; ")}`,
      });
      console.log(`[bundle] DEFECTO BUNDLE-1: JSZip llega antes de usarse: ${earlyJsZip.join("; ")}`);
    } else {
      expect(earlyJsZip, "JSZip no puede llegar antes de usar dividir en ZIP, imagenes, crear desde imagenes o el baul de firmas").toEqual([]);
    }
  });

  test("el detector es sensible: tras exportar a Word SI hay un trozo con «w:document» (no es un filtro que siempre pasa)", async ({ page }) => {
    const recorder = new JsRecorder(page);
    await page.goto("/pdf-pro");
    await openDocument(page, await buildTablePdf());
    await recorder.settle();
    expect(withMarker([...recorder.chunks.values()], "w:document")).toEqual([]);
    recorder.phase = "exportar";
    await goToTab(page, "convert");
    await page.locator('[data-export="word"]').scrollIntoViewIfNeeded();
    await downloadFile(page, () => page.locator('[data-export="word"]').getByRole("button", { name: E.formats.word.title, exact: true }).click());
    await recorder.settle();
    expect(withMarker([...recorder.chunks.values()], "w:document").length).toBeGreaterThanOrEqual(1);
    expect(withMarker([...recorder.chunks.values()], "w:document")[0].phase).toBe("exportar");
  });

  test("BUNDLE-1 · JSZip no se descarga en la carga inicial de /pdf-pro (sin usar dividir en ZIP, imagenes ni el baul de firmas)", async ({ page }) => {
    const recorder = new JsRecorder(page);
    await page.goto("/pdf-pro");
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await recorder.settle();
    expect(withMarker([...recorder.chunks.values()], "JSZip").map((chunk) => chunk.path)).toEqual([]);
  });
});
