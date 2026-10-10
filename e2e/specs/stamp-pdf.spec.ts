import type { Page } from "@playwright/test";
import { expect, openOptionsIfSheet, closeOptionsSheet, openTool, runAndDownload, runButton, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageOperatorCounts, getPageText, getTextItems } from "../helpers/pdf-inspection";
import { imageUpload, makePdf, pdfUpload } from "../helpers/test-files";

/**
 * Marca de agua y Numerar paginas (W6-D): lo estampado se localiza con pdfjs
 * (texto presente en cada pagina del rango, posicion por ancla, giro, formato
 * y total {p}); la marca de imagen se comprueba por operadores de pintado.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const radio = (page: Page, name: string | RegExp) => page.getByRole("radio", { name, exact: typeof name === "string" });

/** Interruptor de las opciones («Mosaico», «Negrita»...): un `role="switch"`. */
async function toggleRow(page: Page, name: string) {
  const row = page.getByRole("switch", { name });
  const before = await row.getAttribute("aria-checked");
  await row.click();
  await expect(row).toHaveAttribute("aria-checked", before === "true" ? "false" : "true");
}

/** Texto estampado = el que no es el «WM-n» del documento original. */
async function stamped(bytes: Buffer, n: number, original: string) {
  return (await getTextItems(bytes, n)).filter((item) => !item.str.includes(original));
}

test.describe("add-watermark", () => {
  test("texto por defecto («CONFIDENCIAL», centro, 45°): esta en cada pagina, girado, y el texto original sigue", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(page, pdfUpload("Informe anual.pdf", await makePdf({ pages: 4, label: "WM", size: [400, 500] })));
    await expect(page.getByLabel("Texto de la marca")).toHaveValue("CONFIDENCIAL");
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Informe anual-con-marca.pdf");
    expect(await getPageCount(bytes)).toBe(4);
    for (const n of [1, 2, 3, 4]) {
      const text = await getPageText(bytes, n);
      expect(text).toContain("CONFIDENCIAL");
      expect(text).toContain(`WM-${n}`);
      const [mark] = await stamped(bytes, n, "WM-");
      expect(mark.str).toBe("CONFIDENCIAL");
      // Girada 45°: la matriz de texto lleva seno y coseno de 45°.
      expect(Math.abs(mark.transform[1])).toBeGreaterThan(1);
      expect(Math.abs(mark.transform[0])).toBeGreaterThan(1);
    }
  });

  test("«BORRADOR ñ» arriba a la izquierda sin giro: esta en la esquina de cada pagina", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(page, pdfUpload("wm.pdf", await makePdf({ pages: 3, label: "WM", size: [400, 500] })));
    await page.getByLabel("Texto de la marca").fill("BORRADOR ñ");
    await radio(page, "0°").click();
    await radio(page, "Arriba a la izquierda").click();
    await radio(page, "Sin transparencia").click();
    const { bytes } = await runAndDownload(page);
    for (const n of [1, 2, 3]) {
      const [mark] = await stamped(bytes, n, "WM-");
      expect(mark.str).toBe("BORRADOR ñ");
      expect(mark.transform[1]).toBeCloseTo(0, 3);
      expect(mark.x).toBeLessThan(400 * 0.2); // arranca en el margen izquierdo
      expect(mark.y).toBeGreaterThan(500 * 0.7);
    }
  });

  test("rango de paginas 2-3 de 5: solo esas llevan la marca", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(page, pdfUpload("rango.pdf", await makePdf({ pages: 5, label: "RG" })));
    await page.getByLabel("Desde", { exact: true }).fill("2");
    await page.getByLabel("Hasta", { exact: true }).fill("3");
    const { bytes } = await runAndDownload(page);
    const marked = await Promise.all([1, 2, 3, 4, 5].map(async (n) => (await getPageText(bytes, n)).includes("CONFIDENCIAL")));
    expect(marked).toEqual([false, true, true, false, false]);
  });

  test("mosaico: la marca se repite muchas veces por pagina", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(page, pdfUpload("mosaico.pdf", await makePdf({ pages: 2, label: "MS", size: [400, 500] })));
    await page.getByRole("slider", { name: "Tamaño" }).fill("16");
    await radio(page, "0°").click();
    await toggleRow(page, "Mosaico");
    const { bytes } = await runAndDownload(page);
    for (const n of [1, 2]) {
      const repeats = (await getTextItems(bytes, n)).filter((item) => item.str === "CONFIDENCIAL").length;
      expect(repeats).toBeGreaterThanOrEqual(6);
    }
  });

  test("marca de imagen (PNG): cada pagina pinta una imagen mas y no hay texto estampado", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(page, pdfUpload("img.pdf", await makePdf({ pages: 2, label: "IM" })));
    await page.getByRole("tab", { name: "Imagen" }).click();
    await expect(runButton(page)).toBeDisabled(); // falta elegir la imagen
    await page.locator('input[type="file"][accept*="png"]').setInputFiles(imageUpload("sello.png", "png", 120, 60, 3));
    await expect(page.getByText("sello.png")).toBeVisible();
    const { bytes } = await runAndDownload(page);
    for (const n of [1, 2]) {
      expect((await getPageOperatorCounts(bytes, n)).imagePaintOps).toBeGreaterThanOrEqual(1);
      expect(await getPageText(bytes, n)).not.toContain("CONFIDENCIAL");
    }
  });

  test("texto vacio: Procesar desactivado con su motivo", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(page, pdfUpload("vacio.pdf", await makePdf({ pages: 1 })));
    await page.getByLabel("Texto de la marca").fill("   ");
    await expect(runButton(page)).toBeDisabled();
    await expect(page.getByText("Escribe el texto que quieres estampar.").first()).toBeVisible();
    await page.getByLabel("Texto de la marca").fill("OK");
    await expect(runButton(page)).toBeEnabled();
  });

  test("33 paginas con una rotada 90° y nombre con acentos: la marca llega a todas", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(
      page,
      pdfUpload(
        "Catálogo (2024) ñ.pdf",
        await makePdf({ pages: 33, label: "CT", size: (index) => (index % 2 ? [500, 300] : [300, 500]), rotate: (index) => (index === 2 ? 90 : 0) }),
      ),
    );
    await page.getByLabel("Texto de la marca").fill("COPIA");
    const { bytes, filename } = await runAndDownload(page, { timeout: 90_000 });
    expect(filename).toBe("Catálogo (2024) ñ-con-marca.pdf");
    expect(await getPageCount(bytes)).toBe(33);
    const missing: number[] = [];
    for (let n = 1; n <= 33; n += 1) if (!(await getPageText(bytes, n)).includes("COPIA")) missing.push(n);
    expect(missing).toEqual([]);
  });
});

test.describe("add-watermark · movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test("texto propio desde la hoja de opciones", async ({ page }) => {
    await openTool(page, "add-watermark");
    await uploadFiles(page, pdfUpload("m.pdf", await makePdf({ pages: 2, label: "MV" })));
    const sheet = await openOptionsIfSheet(page);
    await sheet!.getByLabel("Texto de la marca").fill("SOLO MOVIL");
    await closeOptionsSheet(page, sheet);
    const { bytes } = await runAndDownload(page);
    expect(await getPageText(bytes, 2)).toContain("SOLO MOVIL");
  });
});

/* ------------------------------------------------------------------ *
 * Numerar paginas
 * ------------------------------------------------------------------ */

/** Fragmentos que no son el «PN-n» del documento original. */
const numbers = (bytes: Buffer, n: number) => stamped(bytes, n, "PN-");

test.describe("add-page-numbers", () => {
  test("por defecto: solo el numero, abajo en el centro de cada pagina, y el texto original sigue", async ({ page }) => {
    await openTool(page, "add-page-numbers");
    await uploadFiles(page, pdfUpload("Tesis (v3).pdf", await makePdf({ pages: 4, label: "PN", size: [400, 500] })));
    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("Tesis (v3)-numerado.pdf");
    for (const n of [1, 2, 3, 4]) {
      const [mark] = await numbers(bytes, n);
      expect(mark.str).toBe(String(n));
      expect(mark.x + mark.width / 2).toBeCloseTo(200, -1);
      expect(mark.y).toBeLessThan(500 * 0.2);
      expect(await getPageText(bytes, n)).toContain(`PN-${n}`);
    }
  });

  test("«Página {n} de {p}», arriba a la derecha, empezando en 5: el total es el ultimo numero asignado", async ({ page }) => {
    await openTool(page, "add-page-numbers");
    await uploadFiles(page, pdfUpload("f.pdf", await makePdf({ pages: 4, label: "PN", size: [400, 500] })));
    await radio(page, "Arriba a la derecha").click();
    await radio(page, "Página {n} de {p}").click();
    await page.getByLabel("Primer número").fill("5");
    const { bytes } = await runAndDownload(page);
    const labels: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const [mark] = await numbers(bytes, n);
      labels.push(mark.str);
      expect(mark.x + mark.width / 2).toBeGreaterThan(400 * 0.7);
      expect(mark.y).toBeGreaterThan(500 * 0.8);
    }
    expect(labels).toEqual(["Página 5 de 8", "Página 6 de 8", "Página 7 de 8", "Página 8 de 8"]);
  });

  test("paginas enfrentadas con ancla abajo a la derecha: las pares pasan al lado izquierdo", async ({ page }) => {
    await openTool(page, "add-page-numbers");
    await uploadFiles(page, pdfUpload("libro.pdf", await makePdf({ pages: 4, label: "PN", size: [400, 500] })));
    await page.getByRole("tab", { name: "Páginas enfrentadas" }).click();
    await radio(page, "Abajo a la derecha").click();
    const { bytes } = await runAndDownload(page);
    const sides: string[] = [];
    for (const n of [1, 2, 3, 4]) {
      const [mark] = await numbers(bytes, n);
      sides.push(mark.x + mark.width / 2 > 200 ? "derecha" : "izquierda");
    }
    expect(sides).toEqual(["derecha", "izquierda", "derecha", "izquierda"]);
  });

  test("rango desde la 2.a y plantilla personalizada con acentos: la 1.a queda sin numero", async ({ page }) => {
    await openTool(page, "add-page-numbers");
    await uploadFiles(page, pdfUpload("rango.pdf", await makePdf({ pages: 3, label: "PN", size: [400, 500] })));
    await page.getByLabel("Desde", { exact: true }).fill("2");
    await radio(page, "Personalizado").click();
    await page.getByLabel("Plantilla").fill("Folio {n} de {p} (ñ)");
    const { bytes } = await runAndDownload(page);
    expect(await numbers(bytes, 1)).toEqual([]);
    expect((await numbers(bytes, 2))[0].str).toBe("Folio 1 de 2 (ñ)");
    expect((await numbers(bytes, 3))[0].str).toBe("Folio 2 de 2 (ñ)");
  });

  test("34 paginas de tamanos mezclados, una rotada: todas llevan su numero", async ({ page }) => {
    await openTool(page, "add-page-numbers");
    await uploadFiles(
      page,
      pdfUpload("Largo.pdf", await makePdf({ pages: 34, label: "PN", size: (index) => (index % 3 ? [500, 300] : [300, 500]), rotate: (index) => (index === 4 ? 270 : 0) })),
    );
    const { bytes } = await runAndDownload(page, { timeout: 90_000 });
    expect(await getPageCount(bytes)).toBe(34);
    const wrong: number[] = [];
    for (let n = 1; n <= 34; n += 1) {
      const text = await getPageText(bytes, n);
      if (!new RegExp(`(^|\\s)${n}(\\s|$)`).test(text)) wrong.push(n);
    }
    expect(wrong).toEqual([]);
  });
});
