import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Download, Locator, Page } from "@playwright/test";
import { expect as baseExpect, openTool, runAndDownload, test, uploadFiles } from "../helpers/tool-flow";
import { makePdf } from "../helpers/test-files";
import { downloadFile } from "../helpers/downloads";
import { closeSheetIfOpen, goToTab, isMobile, noHorizontalOverflow, openProPdf, S, watchUploads } from "../helpers/pro-flow";
import { LANGUAGE_STORAGE_KEY, type Language } from "../../src/lib/i18n";
import { THEME_STORAGE_KEY } from "../../src/lib/theme";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

/**
 * PDF Pro · exportacion PERSISTENTE (Wave 9), navegador real y headless sobre la build de produccion.
 *
 * Antes la exportacion vivia en la tarjeta de «Convertir» y cambiar de pestaña la cancelaba. Ahora vive en un almacen
 * por encima de las pestañas y un indicador de la barra superior la muestra y la cancela desde cualquier sitio. Aqui:
 *  1. Un PDF de 60 paginas exportado a imagenes sigue corriendo al pasar por Paginas, Editar, Firmar e Inicio; el ZIP
 *     que se descarga al terminar es correcto (60 PNG con el tamaño esperado, uno por pagina, distintos entre si) y,
 *     con JPG por defecto, IDENTICO byte a byte al de la herramienta suelta `/pdf-to-jpg`.
 *  2. Cancelar desde otra pestaña (no se descarga nada y se puede volver a exportar).
 *  3. Aplicar una operacion DURANTE la exportacion: el ZIP es de la version de inicio (paginas verticales, no giradas) y la
 *     tarjeta lo dice («Exportado desde la versión «Original»»).
 *  4. Cerrar el documento / abrir otro durante la exportacion pide confirmar (con el texto de la exportacion), cancela
 *     y no descarga nada.
 *  5. Movil 375×812 tactil: el indicador entra en la ventana, mide 44 px y no toca el dock inferior.
 *  6. El foco nunca cae a <body> (observador fotograma a fotograma) al cancelar desde el indicador o la tarjeta ni
 *     cuando la exportacion termina con el foco en «Cancelar».
 *  7. Axe (claro/oscuro × ES/EN × 1280/375) con la exportacion en curso, el resultado en la tarjeta y la hoja de confirmar.
 *
 * Uso: `PW_PORT=3776 npx playwright test e2e/specs/pdf-pro-export-persistent.spec.ts --project=chromium --workers=2`
 */

const expect = baseExpect.configure({ timeout: 15_000 });

const E = S.export;
const AXE_PATH = require.resolve("axe-core/axe.min.js");

test.use({ locale: "es-ES", actionTimeout: 20_000 });
test.setTimeout(180_000);

/** Hoja Carta (612×792 pt): a 216 DPI cada PNG mide 1836×2376 px. */
const PAGE_SIZE: [number, number] = [612, 792];
const PNG_3X = { width: 1836, height: 2376 };

/** Descargas del navegador, sin consumirlas (para contarlas y para esperar la siguiente). */
function watchDownloads(page: Page): { items: Download[]; next: (timeout?: number) => Promise<Download> } {
  const items: Download[] = [];
  page.on("download", (download) => items.push(download));
  return {
    items,
    next: (timeout = 120_000) => page.waitForEvent("download", { timeout }),
  };
}

async function readDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("La descarga no genero un archivo legible");
  return readFile(path);
}

const sha = (bytes: Uint8Array | Buffer) => createHash("sha256").update(bytes).digest("hex");

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const indicator = (page: Page): Locator => page.locator("[data-export-indicator]");
const card = (page: Page, id: string): Locator => page.locator(`[data-export="${id}"]`);

async function openConvert(page: Page, id = "images"): Promise<Locator> {
  await closeSheetIfOpen(page);
  await goToTab(page, "convert");
  const target = card(page, id);
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  return target;
}

/** Imagenes PNG a 216 DPI (la exportacion mas lenta de las ocho: sirve para tener tiempo de cambiar de pestaña). */
async function startPngExport(page: Page): Promise<Locator> {
  const target = await openConvert(page, "images");
  await target.getByRole("button", { name: E.card.showOptions }).click();
  await target.getByRole("tab", { name: E.images.png }).click();
  await target.getByRole("tab", { name: E.images.dpi[3] }).click();
  await target.getByRole("button", { name: E.formats.images.title }).click();
  await expect(target.getByRole("progressbar")).toBeVisible();
  return target;
}

async function bigPdf(pages = 60, label = "ACTA"): Promise<Buffer> {
  return makePdf({ pages, label, size: PAGE_SIZE });
}

/**
 * Frena la CPU de la pagina (`Emulation.setCPUThrottlingRate`): la exportacion de 60 paginas a 216 DPI dura varios
 * segundos de sobra incluso en una maquina rapida, asi que cambiar de pestaña «a mitad» no depende de la suerte.
 */
async function slowDown(page: Page, rate = 4): Promise<void> {
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setCPUThrottlingRate", { rate });
}

const percentOf = async (locator: Locator): Promise<number> => Number(await locator.getAttribute("aria-valuenow"));

/** Pide cerrar el documento (escritorio: la X; movil: «Más acciones» → «Cerrar documento»). */
async function requestClose(page: Page): Promise<void> {
  if (isMobile(page)) {
    await page.getByRole("button", { name: S.shell.more }).click();
    await page.getByRole("menuitem", { name: S.shell.closeItem }).click();
  } else {
    await page.getByRole("button", { name: S.suite.close }).click();
  }
}

/** Espera a que el navegador no haya descargado nada en `ms` (una exportacion cancelada no debe descargar). */
async function expectNoDownload(downloads: { items: Download[] }, ms = 3_500): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  expect(downloads.items, "no se debe descargar nada").toHaveLength(0);
}

const sizeOf = async (zip: JSZip, name: string) => pngSize(await zip.file(name)!.async("uint8array"));

test.describe("1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("60 paginas a imagenes: sigue al cambiar de pestaña y el ZIP es correcto", async ({ page }) => {
    const uploads = watchUploads(page);
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(60) });
    await slowDown(page);
    const target = await startPngExport(page);
    await expect(indicator(page)).toBeVisible();

    const seen: number[] = [];
    for (const tab of ["pages", "edit", "sign", "home"] as const) {
      await goToTab(page, tab);
      await expect(indicator(page)).toBeVisible();
      seen.push(await percentOf(indicator(page).getByRole("progressbar")));
    }
    // Nunca se cancelo: ni descarga, ni anuncio de cancelacion; el porcentaje solo avanza.
    expect(downloads.items, "sigue en curso: aun no hay descarga").toHaveLength(0);
    await expect(page.getByRole("status")).not.toHaveText(E.card.cancelled);
    for (let index = 1; index < seen.length; index += 1) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1]);
    // Y AVANZA mientras se esta en otra pestaña (no solo «no se cancela»).
    await expect
      .poll(async () => (await indicator(page).count()) === 0 || (await percentOf(indicator(page).getByRole("progressbar"))) > seen[seen.length - 1], {
        timeout: 60_000,
      })
      .toBe(true);

    await goToTab(page, "convert");
    // Al volver: la tarjeta de imagenes muestra el progreso o, si ya termino, su resultado.
    await expect(target.locator('[role="progressbar"], [data-export-result]').first()).toBeVisible();

    const download = downloads.items[0] ?? (await downloads.next());
    expect(download.suggestedFilename()).toBe("acta-imagenes.zip");
    const zip = await JSZip.loadAsync(await readDownload(download));
    const names = Object.keys(zip.files).sort();
    expect(names).toHaveLength(60);
    const hashes = new Set<string>();
    for (const name of names) {
      const bytes = await zip.file(name)!.async("uint8array");
      expect([...bytes.slice(0, 4)], `${name}: firma PNG`).toEqual([0x89, 0x50, 0x4e, 0x47]);
      expect(pngSize(bytes), `${name}: tamaño a 216 DPI`).toEqual(PNG_3X);
      hashes.add(sha(bytes));
    }
    // Cada pagina lleva su propio texto («ACTA-n»): 60 imagenes distintas.
    expect(hashes.size).toBe(60);

    // Terminada: el indicador se va, queda UN anuncio, UNA descarga y el resultado en la tarjeta con su version.
    await expect(indicator(page)).toBeHidden();
    await expect(page.getByRole("status")).toHaveText(E.card.done("acta-imagenes.zip"));
    await expect(target.locator("[data-export-result]")).toHaveText(E.card.result("acta-imagenes.zip", "Original"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(downloads.items).toHaveLength(1);
    expect(uploads.requests).toEqual([]);
  });

  test("JPG por defecto: el ZIP es IDENTICO, byte a byte, al de la herramienta suelta /pdf-to-jpg", async ({ page, context }) => {
    const pdf = await bigPdf(24, "REF");
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "ref.pdf", bytes: pdf });
    await slowDown(page);
    const target = await openConvert(page, "images");
    await target.getByRole("button", { name: E.formats.images.title }).click();
    await expect(indicator(page)).toBeVisible();
    await goToTab(page, "pages");
    await goToTab(page, "annotate");
    await goToTab(page, "home");
    const download = await downloads.next();
    expect(download.suggestedFilename()).toBe("ref-imagenes.zip");
    const proZip = await JSZip.loadAsync(await readDownload(download));

    // La herramienta suelta, en otra pestaña del navegador, con el mismo PDF y las mismas opciones por defecto.
    const loose = await context.newPage();
    await openTool(loose, "pdf-to-jpg");
    await uploadFiles(loose, { name: "ref.pdf", mimeType: "application/pdf", buffer: pdf });
    const looseFile = await runAndDownload(loose, { timeout: 90_000 });
    expect(looseFile.filename).toBe("ref-imagenes.zip");
    const looseZip = await JSZip.loadAsync(looseFile.bytes);

    const proNames = Object.keys(proZip.files).sort();
    expect(proNames).toEqual(Object.keys(looseZip.files).sort());
    expect(proNames).toHaveLength(24);
    for (const name of proNames) {
      const a = await proZip.file(name)!.async("uint8array");
      const b = await looseZip.file(name)!.async("uint8array");
      expect(sha(a), `${name}: igual que el motor suelto`).toBe(sha(b));
    }
    await loose.close();
  });

  test("cancelar desde OTRA pestaña: no se descarga nada, la tarjeta queda libre y se puede exportar otra vez", async ({ page }) => {
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(60) });
    await slowDown(page);
    await startPngExport(page);
    await goToTab(page, "pages");
    await indicator(page).getByRole("button", { name: E.indicator.cancelLabel("imágenes") }).click();
    await expect(indicator(page)).toBeHidden();
    await expect(page.getByRole("status")).toHaveText(E.card.cancelled);
    await expectNoDownload(downloads);

    const target = await openConvert(page, "images");
    await expect(target.getByText(E.card.cancelled)).toBeVisible();
    await expect(target.getByRole("button", { name: E.formats.images.title })).not.toHaveAttribute("aria-disabled", "true");
    // Y otra exportacion funciona con normalidad despues de cancelar.
    const text = await openConvert(page, "text");
    const file = await downloadFile(page, async () => {
      await text.getByRole("button", { name: E.formats.text.title }).click();
    });
    expect(file.filename).toBe("acta-texto.txt");
    expect(file.bytes.toString("utf8")).toContain("ACTA-60");
    await expect(page.getByRole("status")).toHaveText(E.card.done("acta-texto.txt"));
  });

  test("otra exportacion mientras corre una: la tarjeta lo explica, no arranca nada y el indicador sigue siendo el de la primera", async ({ page }) => {
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(60) });
    await slowDown(page);
    await startPngExport(page);
    const word = await openConvert(page, "word");
    await expect(word.getByText(E.card.inProgressOther("imágenes"))).toBeVisible();
    await expect(word.getByRole("button", { name: E.formats.word.title })).toHaveAttribute("aria-disabled", "true");
    await word.getByRole("button", { name: E.formats.word.title }).click({ force: true });
    await expect(indicator(page)).toHaveAttribute("data-export-format", "images");
    await expect(indicator(page)).toHaveCount(1);
    await page.getByRole("button", { name: E.indicator.cancelLabel("imágenes") }).click();
    await expect(indicator(page)).toBeHidden();
    await expectNoDownload(downloads, 2_000);
  });

  test("aplicar una operacion DURANTE la exportacion: el ZIP es de la version de inicio y la tarjeta lo dice", async ({ page }) => {
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(40) });
    await slowDown(page);
    const target = await startPngExport(page);
    await goToTab(page, "home");
    await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
    await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
    // La exportacion sigue (no se reinicia ni se cancela por la operacion nueva).
    await expect(indicator(page)).toBeVisible();

    const download = await downloads.next();
    const zip = await JSZip.loadAsync(await readDownload(download));
    const names = Object.keys(zip.files).sort();
    expect(names).toHaveLength(40);
    // Version de inicio: paginas VERTICALES (1836×2376). Si fuese la girada serian 2376×1836.
    for (const name of [names[0], names[20], names[39]]) expect(await sizeOf(zip, name), name).toEqual(PNG_3X);

    await goToTab(page, "convert");
    const result = target.locator("[data-export-result]");
    await expect(result).toContainText(E.card.result("acta-imagenes.zip", "Original"));
    await expect(result).toContainText(E.card.versionChanged);

    // El documento de trabajo SI esta girado: la exportacion no lo toco ni lo dejo a medias.
    const current = await downloadFile(page, async () => {
      await page.getByRole("button", { name: S.suite.download }).click();
    });
    const pdf = await PDFDocument.load(current.bytes);
    expect(pdf.getPages().every((item) => item.getRotation().angle === 90)).toBe(true);
  });

  test("cerrar el documento durante la exportacion pide confirmar (con su texto), cancela y no descarga nada", async ({ page }) => {
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(60) });
    await slowDown(page);
    await startPngExport(page);
    await goToTab(page, "pages");
    await requestClose(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(E.notices.closeOnly("imágenes"));
    // «Cancelar» en la hoja: el documento y la exportacion siguen.
    await dialog.getByRole("button", { name: S.suite.cancel }).click();
    await expect(dialog).toBeHidden();
    await expect(indicator(page)).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: /acta\.pdf/ })).toBeVisible();

    await requestClose(page);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: S.suite.close }).click();
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await expect(indicator(page)).toBeHidden();
    await expectNoDownload(downloads);
  });

  test("abrir OTRO documento durante la exportacion pide confirmar, cancela la exportacion y no descarga el anterior", async ({ page }) => {
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "uno.pdf", bytes: await bigPdf(60, "UNO") });
    await slowDown(page);
    await startPngExport(page);
    await goToTab(page, "home");
    await page.locator("[data-pro-open-input]").setInputFiles({
      name: "dos.pdf",
      mimeType: "application/pdf",
      buffer: await makePdf({ pages: 2, label: "DOS" }),
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(E.notices.replaceOnly("imágenes"));
    await dialog.getByRole("button", { name: S.session.replaceConfirm }).click();
    await expect(page.getByRole("heading", { level: 1, name: /dos\.pdf/ })).toBeVisible();
    await expect(indicator(page)).toBeHidden();
    await expectNoDownload(downloads);
    // La tarjeta del documento nuevo esta limpia: nada de progreso, resultado ni «cancelada» del anterior.
    const target = await openConvert(page, "images");
    await expect(target.getByRole("progressbar")).toHaveCount(0);
    await expect(target.locator("[data-export-result]")).toHaveCount(0);
    await expect(target.getByText(E.card.cancelled)).toHaveCount(0);
    await expect(target.getByRole("button", { name: E.formats.images.title })).not.toHaveAttribute("aria-disabled", "true");
  });
});

test.describe("movil 375×812 tactil", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("el indicador cabe, mide 44 px, no toca el dock ni los botones de la barra, y se cancela con un toque", async ({ page }) => {
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(60) });
    await slowDown(page);
    await startPngExport(page);
    await closeSheetIfOpen(page);
    const chip = indicator(page);
    await expect(chip).toBeVisible();
    await noHorizontalOverflow(page);

    const box = (await chip.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x, "dentro de la ventana por la izquierda").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "dentro de la ventana por la derecha").toBeLessThanOrEqual(viewport.width);
    expect(box.height, "alto de al menos 44 px").toBeGreaterThanOrEqual(44);

    const cancel = chip.getByRole("button", { name: E.indicator.cancelLabel("imágenes") });
    const cancelBox = (await cancel.boundingBox())!;
    expect(cancelBox.width).toBeGreaterThanOrEqual(44);
    expect(cancelBox.height).toBeGreaterThanOrEqual(44);

    // El dock inferior queda libre: el indicador acaba por encima de su borde superior.
    const dock = (await page.locator("[data-pro-dock]").boundingBox())!;
    expect(box.y + box.height, "el indicador no tapa el dock").toBeLessThanOrEqual(dock.y);
    // ... y nada de la barra superior se le superpone (esta en su propia fila).
    const bar = page.locator('[data-pro-region="top"]');
    for (const button of await bar.getByRole("button").all()) {
      const other = await button.boundingBox();
      if (!other || (await chip.getByRole("button").filter({ has: button }).count()) > 0) continue;
      if (other.width === 0 || other.height === 0) continue;
      const overlaps = other.x < box.x + box.width && other.x + other.width > box.x && other.y < box.y + box.height && other.y + other.height > box.y;
      const inside = other.x >= box.x && other.x + other.width <= box.x + box.width && other.y >= box.y && other.y + other.height <= box.y + box.height;
      if (!inside) expect(overlaps, `el boton «${await button.getAttribute("aria-label") ?? await button.innerText()}» se superpone al indicador`).toBe(false);
    }
    // El nombre del documento sigue visible (la fila extra no lo desplaza fuera de la barra).
    await expect(page.getByRole("heading", { level: 1, name: /acta\.pdf/ })).toBeVisible();

    await cancel.tap();
    await expect(chip).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("status")).toHaveText(E.card.cancelled);
    await expectNoDownload(downloads, 2_000);
    await noHorizontalOverflow(page);
  });

  test("cerrar el documento (desde «Más acciones») durante la exportacion pide confirmar", async ({ page }) => {
    const downloads = watchDownloads(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(60) });
    await slowDown(page);
    await startPngExport(page);
    await closeSheetIfOpen(page);
    await requestClose(page);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(E.notices.closeOnly("imágenes"));
    await dialog.getByRole("button", { name: S.suite.close }).click();
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
    await expect(indicator(page)).toBeHidden();
    await expectNoDownload(downloads, 2_500);
  });
});

/* ------------------------------------------------------------------ *
 * Foco: nunca en <body>, fotograma a fotograma
 * ------------------------------------------------------------------ */

type FocusWindow = Window & {
  __frames?: { start: () => void; stop: () => { frames: number; bodyFrames: number; maxRun: number; last: string } };
};

/** Instala un bucle `requestAnimationFrame` que cuenta los fotogramas con `document.activeElement` en <body>. */
async function installFrameObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as FocusWindow;
    if (w.__frames) return;
    let on = false;
    let frames = 0;
    let bodyFrames = 0;
    let run = 0;
    let maxRun = 0;
    let last = "";
    const tick = () => {
      if (on) {
        const active = document.activeElement;
        const body = !active || active === document.body || active === document.documentElement;
        frames += 1;
        if (body) {
          bodyFrames += 1;
          run += 1;
          maxRun = Math.max(maxRun, run);
        } else run = 0;
        last = body ? "<body>" : `${active!.tagName.toLowerCase()} ${(active!.getAttribute("aria-label") ?? active!.textContent ?? "").trim().slice(0, 30)}`;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__frames = {
      start: () => {
        on = true;
        frames = 0;
        bodyFrames = 0;
        run = 0;
        maxRun = 0;
        last = "";
      },
      stop: () => {
        on = false;
        return { frames, bodyFrames, maxRun, last };
      },
    };
  });
}

const startFrames = (page: Page) => page.evaluate(() => (window as FocusWindow).__frames!.start());
const stopFrames = (page: Page) => page.evaluate(() => (window as FocusWindow).__frames!.stop());
const nextFrames = (page: Page, count = 4) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    count,
  );

test.describe("foco sin pasar por <body> (fotograma a fotograma)", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  const REPETITIONS = 6;

  test("el observador SI detecta un foco que cae a <body> (sensibilidad)", async ({ page }) => {
    await installFrameObserver(page);
    await openProPdf(page, { name: "acta.pdf", pages: 3 });
    await page.getByRole("button", { name: S.suite.download }).focus();
    await startFrames(page);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await nextFrames(page, 3);
    const result = await stopFrames(page);
    expect(result.bodyFrames).toBeGreaterThan(0);
  });

  test("cancelar desde el indicador y desde la tarjeta: 0 fotogramas con el foco en <body>", async ({ page }) => {
    await installFrameObserver(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(30) });
    await slowDown(page);
    const target = await startPngExport(page);
    for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
      const fromChip = repetition % 2 === 0;
      if (repetition > 0) {
        await target.getByRole("button", { name: E.formats.images.title }).click();
        await expect(indicator(page)).toBeVisible();
      }
      const button = fromChip
        ? indicator(page).getByRole("button", { name: E.indicator.cancelLabel("imágenes") })
        : target.getByRole("button", { name: E.card.cancel });
      await button.focus();
      await startFrames(page);
      await button.press("Enter");
      await expect(indicator(page)).toBeHidden();
      await nextFrames(page, 4);
      const result = await stopFrames(page);
      expect(result.bodyFrames, `repeticion ${repetition} (${fromChip ? "indicador" : "tarjeta"}): ${result.last}`).toBe(0);
      // Destino logico: el titulo del documento (indicador) o el boton de exportar (tarjeta).
      if (fromChip) await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
      else await expect(target.getByRole("button", { name: E.formats.images.title })).toBeFocused();
    }
  });

  test("la exportacion TERMINA con el foco en «Cancelar» del indicador: el foco pasa al titulo sin tocar <body>", async ({ page }) => {
    await installFrameObserver(page);
    await openProPdf(page, { name: "acta.pdf", bytes: await bigPdf(10) });
    await slowDown(page, 6);
    await startPngExport(page);
    await goToTab(page, "home");
    const cancel = indicator(page).getByRole("button", { name: E.indicator.cancelLabel("imágenes") });
    await cancel.focus();
    await startFrames(page);
    await expect(indicator(page)).toBeHidden({ timeout: 90_000 });
    await nextFrames(page, 4);
    const result = await stopFrames(page);
    expect(result.bodyFrames, `foco al terminar: ${result.last}`).toBe(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("status")).toHaveText(E.card.done("acta-imagenes.zip"));
  });
});

/* ------------------------------------------------------------------ *
 * Axe: claro/oscuro × ES/EN × 1280/375
 * ------------------------------------------------------------------ */

type AxeResult = { violations: Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }> };
type AxeApi = { run: (context: unknown, options: unknown) => Promise<AxeResult> };

async function runAxe(page: Page): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: AxeApi }).axe;
    const result = await axe.run(document, { rules: { "target-size": { enabled: false } }, resultTypes: ["violations"] });
    return result.violations.map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.help} → ${violation.nodes
          .slice(0, 3)
          .map((node) => `${node.target.join(" ")} :: ${(node.failureSummary ?? "").split("\n").slice(0, 2).join(" ").slice(0, 160)}`)
          .join(" | ")}`,
    );
  });
}

type Cell = { theme: "light" | "dark"; language: Language; width: number };
const CELLS: Cell[] = [];
for (const theme of ["light", "dark"] as const) {
  for (const language of ["es", "en"] as const) {
    for (const width of [1280, 375]) CELLS.push({ theme, language, width });
  }
}

test.describe("axe con la exportacion en curso, el resultado y la hoja de cierre", () => {
  for (const cell of CELLS) {
    const mobile = cell.width < 768;
    const label = `${cell.theme === "light" ? "claro" : "oscuro"} · ${cell.language.toUpperCase()} · ${cell.width}`;
    test.describe(label, () => {
      test.use({
        viewport: { width: cell.width, height: mobile ? 812 : 800 },
        colorScheme: cell.theme,
        locale: cell.language === "es" ? "es-ES" : "en-US",
        hasTouch: mobile,
        isMobile: mobile,
      });

      test("0 violaciones y una sola region viva", async ({ page }) => {
        await page.addInitScript(
          ([languageKey, themeKey, language, theme]) => {
            window.localStorage.setItem(languageKey, language);
            window.localStorage.setItem(themeKey, theme);
          },
          [LANGUAGE_STORAGE_KEY, THEME_STORAGE_KEY, cell.language, cell.theme] as const,
        );
        const P = PRO_STRINGS[cell.language];
        const X = P.export;
        const short = X.formatsShort.images;
        await page.goto("/pdf-pro");
        await page.locator('input[type="file"]').first().setInputFiles({ name: "acta.pdf", mimeType: "application/pdf", buffer: await bigPdf(40) });
        await expect(page.getByRole("heading", { level: 1, name: /acta\.pdf/ })).toBeVisible();
        await slowDown(page, 6);

        const liveRegions = () =>
          page.evaluate(
            () =>
              Array.from(document.querySelectorAll<HTMLElement>('[role="status"], [aria-live]'))
                .filter((element) => element.getAttribute("aria-live") !== "off" && element.getClientRects().length > 0 || element.classList.contains("sr-only"))
                .map((element) => element.outerHTML.slice(0, 160)),
          );
        const assertClean = async (state: string) => {
          const violations = await runAxe(page);
          expect(violations, `${label} · ${state}`).toEqual([]);
          expect(await liveRegions(), `${label} · ${state}: una sola region viva`).toHaveLength(1);
          await noHorizontalOverflow(page);
        };

        // Empieza la exportacion mas lenta desde Convertir (la tarjeta en curso: progreso, version, otra en curso).
        await closeSheetIfOpen(page);
        if (mobile) await page.locator('[data-dock="convert"]').click();
        else await page.locator('[role="tab"][data-tab="convert"]').click();
        const images = page.locator('[data-export="images"]');
        await images.getByRole("button", { name: X.card.showOptions }).click();
        await images.getByRole("tab", { name: X.images.png }).click();
        await images.getByRole("tab", { name: X.images.dpi[3] }).click();
        await images.getByRole("button", { name: X.formats.images.title }).click();
        await expect(images.getByRole("progressbar")).toBeVisible();
        await expect(page.locator('[data-export="word"]').getByText(X.card.inProgressOther(short))).toBeVisible();
        await assertClean("tarjeta con la exportacion en curso");

        // Desde otra pestaña: el indicador en la barra superior.
        await closeSheetIfOpen(page);
        if (mobile) await page.locator('[data-dock="home"]').click();
        else await page.locator('[role="tab"][data-tab="home"]').click();
        await closeSheetIfOpen(page);
        await expect(indicator(page)).toBeVisible();
        await assertClean("indicador en la barra superior");

        // La hoja de cierre con el texto de la exportacion.
        if (mobile) {
          await page.getByRole("button", { name: P.shell.more }).click();
          await page.getByRole("menuitem", { name: P.shell.closeItem }).click();
        } else {
          await page.getByRole("button", { name: P.suite.close }).click();
        }
        const dialog = page.getByRole("dialog");
        await expect(dialog).toContainText(X.notices.closeOnly(short));
        await assertClean("hoja de cierre con exportacion en curso");
        await dialog.getByRole("button", { name: P.suite.cancel }).click();
        await expect(dialog).toBeHidden();

        // Cancelar desde el indicador y comprobar el estado «cancelada» y luego un resultado terminado.
        await indicator(page).getByRole("button", { name: X.indicator.cancelLabel(short) }).click();
        await expect(indicator(page)).toBeHidden();
        if (mobile) await page.locator('[data-dock="convert"]').click();
        else await page.locator('[role="tab"][data-tab="convert"]').click();
        await expect(images.getByText(X.card.cancelled)).toBeVisible();
        await assertClean("tarjeta con la exportacion cancelada");

        const text = page.locator('[data-export="text"]');
        await text.scrollIntoViewIfNeeded();
        const download = page.waitForEvent("download");
        await text.getByRole("button", { name: X.formats.text.title }).click();
        await download;
        await expect(text.locator("[data-export-result]")).toBeVisible();
        await assertClean("tarjeta con el resultado terminado");
      });
    });
  }
});
