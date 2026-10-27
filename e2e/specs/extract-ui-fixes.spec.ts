import { expect, test, type Page } from "@playwright/test";
import JSZip from "jszip";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { downloadFile } from "../helpers/downloads";
import { assetList, openAndRun } from "../helpers/extract-ui-flow";

/**
 * Correcciones de «Extraer elementos» tras la verificacion independiente (H4, H8, H9, H10, H15, H16), con el MOTOR FALSO inyectado en
 * la build de produccion: descarga LIMPIA de firmas (PNG con fondo transparente, recorte ajustado) y «Original», ZIP, nombres con
 * ordinal, campos de firma vacios, aviso de anotaciones recortadas, columnas de la galeria y la primera tarjeta en el movil.
 * Chromium y webkit-ipad. Headless siempre.
 */

test.setTimeout(120_000);

type Stats = { width: number; height: number; corners: number[]; transparent: number; ink: number };

async function pngStats(bytes: Buffer): Promise<Stats> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let transparent = 0;
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) transparent += 1;
    else if (data[i + 3] > 128 && data[i] < 120) ink += 1;
  }
  const at = (x: number, y: number): number => data[(y * image.width + x) * 4 + 3];
  return { width: image.width, height: image.height, corners: [at(0, 0), at(image.width - 1, 0), at(0, image.height - 1), at(image.width - 1, image.height - 1)], transparent: transparent / (image.width * image.height), ink: ink / (image.width * image.height) };
}

const SIG_OPAQUE = /^Descargar: Firma probable, página 4/;

test.describe("extract-assets · H8 · la descarga de una firma sale limpia", () => {
  test("«PNG» entrega la firma con fondo transparente y recorte ajustado; «Original», la imagen incrustada tal cual", async ({ page }) => {
    await openAndRun(page);
    // fx-sig-2: 520 x 180 px sobre papel opaco (la imagen incrustada: papel, margenes y sin alfa).
    const clean = await downloadFile(page, () => page.getByRole("button", { name: SIG_OPAQUE }).click());
    expect(clean.filename).toBe("p04-firma-01.png");
    const cleanStats = await pngStats(clean.bytes);
    expect(cleanStats.corners).toEqual([0, 0, 0, 0]);
    expect(cleanStats.transparent).toBeGreaterThan(0.5);
    expect(cleanStats.ink).toBeGreaterThan(0.01);
    // Recortada a la tinta (con un margen pequeno) y sin deformar: el aspecto es el de la tinta, no el del papel.
    expect(cleanStats.width).toBeLessThan(520);
    expect(cleanStats.height).toBeLessThan(180);
    expect(cleanStats.width / cleanStats.height).toBeGreaterThan(1.8);
    expect(cleanStats.width / cleanStats.height).toBeLessThan(4.2);

    await page.getByRole("button", { name: "Original" }).click();
    await expect(page.locator("[data-format-hint]")).toContainText("tal cual");
    const jpg = await downloadFile(page, () => page.getByRole("button", { name: SIG_OPAQUE }).click());
    expect(jpg.filename).toBe("p04-firma-01.jpg");
    expect(jpg.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    // Una firma transparente sin JPG original: el PNG tal cual, rotulado «-original» y con los margenes de la imagen incrustada.
    const raw = await downloadFile(page, () => page.getByRole("button", { name: /^Descargar: Firma, página 3/ }).click());
    expect(raw.filename).toBe("p03-firma-01-original.png");
    const rawStats = await pngStats(raw.bytes);
    expect(rawStats.width).toBe(420);
    expect(rawStats.height).toBe(140);
  });

  test("el ZIP lleva las firmas limpias (esquinas transparentes) y el resto sin tocar", async ({ page }) => {
    await openAndRun(page);
    await page.getByRole("button", { name: /^Firmas/ }).click();
    await page.getByRole("checkbox", { name: "Seleccionar todo" }).check();
    const zipFile = await downloadFile(page, () => page.getByRole("button", { name: "Descargar seleccionados (.zip)" }).click());
    const zip = await JSZip.loadAsync(zipFile.bytes);
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(["p02-firma-01.png", "p03-firma-01.png", "p04-firma-01.png"]);
    for (const name of ["p03-firma-01.png", "p04-firma-01.png"]) {
      const stats = await pngStats(Buffer.from(await zip.files[name].async("uint8array")));
      expect(stats.corners, name).toEqual([0, 0, 0, 0]);
    }
    // El trazo (anotacion de dibujo a mano) ya sale limpio del motor: no pasa por la limpieza.
    expect((await pngStats(Buffer.from(await zip.files["p02-firma-01.png"].async("uint8array")))).width).toBe(380);
  });

  test("el detalle ofrece «PNG limpio (fondo transparente)» y «Original (imagen tal cual)» y descarga cada uno", async ({ page }) => {
    await openAndRun(page);
    await page.getByRole("button", { name: /^Ver detalles: Firma probable, página 4/ }).click();
    const dialog = page.getByRole("dialog", { name: "Detalles del elemento" });
    const clean = await downloadFile(page, () => dialog.getByRole("button", { name: "PNG limpio (fondo transparente)" }).click());
    expect(clean.filename).toBe("p04-firma-01.png");
    expect((await pngStats(clean.bytes)).corners).toEqual([0, 0, 0, 0]);
    const original = await downloadFile(page, () => dialog.getByRole("button", { name: "Original (imagen tal cual)" }).click());
    expect(original.filename).toBe("p04-firma-01.jpg");
  });
});

async function openDuplicates(page: Page): Promise<void> {
  await openAndRun(page, { fake: { scenario: "duplicates" } });
}

test.describe("extract-assets · H4, H9 y H10", () => {
  test("H9 · dos firmas iguales de la misma pagina se distinguen con «1 de 2» y «2 de 2»", async ({ page }) => {
    await openDuplicates(page);
    const list = assetList(page);
    await expect(list.getByRole("listitem", { name: "Firma probable 1 de 2, página 3, 420 × 140 px" })).toHaveCount(1);
    await expect(list.getByRole("listitem", { name: "Firma probable 2 de 2, página 3, 420 × 140 px" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Descargar: Firma probable 2 de 2, página 3, 420 × 140 px" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Guardar en Firmas guardadas: Firma probable 1 de 2, página 3, 420 × 140 px" })).toBeVisible();
    await expect(list.getByRole("listitem", { name: "Iniciales probables, página 1, 160 × 90 px" })).toHaveCount(1);
  });

  test("H4 · un campo de firma vacio no es una tarjeta (ni «Descargar» ni «Guardar»): solo un aviso de una linea", async ({ page }) => {
    await openDuplicates(page);
    await expect(page.locator('[data-asset-id="fx-field-empty"]')).toHaveCount(0);
    await expect(page.locator("[data-extract-heading]")).toHaveText("Encontramos 3 elementos en 6 páginas.");
    await expect(page.locator('[data-notice="empty-sig-field"]')).toContainText("Hay 1 campo de firma sin firma dentro");
    await expect(page.getByRole("button", { name: /^Descargar: / })).toHaveCount(3);
  });

  test("H10 · mas de 300 anotaciones en una pagina: aviso visible con la pagina y el numero", async ({ page }) => {
    await openDuplicates(page);
    await expect(page.locator('[data-notice="too-many-annotations"]')).toHaveText("La página 1 tiene 10000 anotaciones: solo se revisaron las primeras 300. Puede haber más elementos.");
  });

  test("EN: ordinales y avisos", async ({ page }) => {
    await openAndRun(page, { lang: "en", fake: { scenario: "duplicates" } });
    await expect(assetList(page).getByRole("listitem", { name: "Probable signature 2 of 2, page 3, 420 × 140 px" })).toHaveCount(1);
    await expect(page.locator('[data-notice="empty-sig-field"]')).toContainText("There is 1 signature field");
    await expect(page.locator('[data-notice="too-many-annotations"]')).toContainText("Page 1 has 10000 annotations");
  });
});

test.describe("extract-assets · H15 y H16 · galeria", () => {
  test("H15 · a 1194 px (iPad apaisado) la galeria tiene 4 o 5 columnas, no 3", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1194, height: 834 } });
    const page = await context.newPage();
    try {
      await openAndRun(page);
      await expect(page.locator("[data-extract-grid]")).toBeVisible();
      const columns = await page.locator("[data-extract-grid]").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
      expect(columns).toBeGreaterThanOrEqual(4);
      expect(columns).toBeLessThanOrEqual(5);
      // Sin desbordes y con las tarjetas dentro de su columna.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("H15 · columnas por ancho: 1 (movil), 2 (744 px), 3 (834 px) y 4-5 (1194 px)", async ({ browser }) => {
    const expected: Array<[number, number, number]> = [[375, 1, 1], [744, 2, 3], [834, 3, 3], [1194, 4, 5]];
    for (const [width, min, max] of expected) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      try {
        await openAndRun(page);
        const columns = await page.locator("[data-extract-grid]").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
        expect(columns, `${width}px`).toBeGreaterThanOrEqual(min);
        expect(columns, `${width}px`).toBeLessThanOrEqual(max);
      } finally {
        await context.close();
      }
    }
  });

  test("H16 · a 375 px la primera tarjeta se ve sin desplazar: al menos el 25 % de la pantalla", async ({ browser }) => {
    for (const lang of ["es", "en"] as const) {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      try {
        await openAndRun(page, { lang });
        await page.evaluate(() => window.scrollTo(0, 0));
        // Las animaciones de entrada asientan el layout.
        await page.waitForTimeout(800);
        const first = (await page.locator("[data-asset-id]").first().boundingBox())!;
        const visible = Math.max(0, Math.min(812, first.y + first.height) - first.y);
        expect(first.y, `${lang}: la tarjeta empieza en ${Math.round(first.y)} px`).toBeLessThanOrEqual(812 * 0.75);
        expect(visible, `${lang}: se ven ${Math.round(visible)} px de la tarjeta`).toBeGreaterThanOrEqual(812 * 0.25);
        // Los filtros van en UNA fila desplazable (no se apilan en varias antes de la tarjeta).
        const row = (await page.locator("[data-filter-row]").boundingBox())!;
        expect(row.height).toBeLessThanOrEqual(60);
        // La nota de uso sigue visible y sin interaccion.
        await expect(page.locator("[data-extract-note]")).toBeVisible();
      } finally {
        await context.close();
      }
    }
  });

  test("H16 · fuente ancha (DejaVu del CI) a 375 px: la primera tarjeta tambien se ve y no hay desbordes", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        const style = document.createElement("style");
        style.textContent = '*{font-family:"DejaVu Sans",Verdana,"Trebuchet MS",sans-serif !important}';
        document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style));
      });
      await openAndRun(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(800);
      const first = (await page.locator("[data-asset-id]").first().boundingBox())!;
      expect(Math.max(0, Math.min(812, first.y + first.height) - first.y)).toBeGreaterThanOrEqual(812 * 0.25);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
