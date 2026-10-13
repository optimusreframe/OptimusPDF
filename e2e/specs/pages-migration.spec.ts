import type { Page } from "@playwright/test";
import { expect, openTool, runAndDownload, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import { pdfUpload } from "../helpers/test-files";
import { allStreamsText, inspectPdf, makeRichPdf, marker } from "../../src/lib/pdf/testing/pageAssemblyFixtures";

/**
 * Wave 8 · migracion de las herramientas sueltas de paginas al motor en sitio `pageAssembly`.
 * Cada herramienta se usa de verdad (subir, operar, descargar) con PDF que traen titulo, autor,
 * formulario y marcadores; el resultado se reabre con pdfjs (texto y orden) y con un lector
 * independiente (`inspectPdf`: metadatos, marcadores y a que pagina apuntan, campos, objetos
 * huerfanos) y se busca el texto de las paginas quitadas en los flujos descomprimidos.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const RICH = { title: "Informe anual", author: "Ana Perez", form: true, outline: true } as const;

async function pageTexts(bytes: Buffer): Promise<string[]> {
  const count = await getPageCount(bytes);
  const out: string[] = [];
  for (let n = 1; n <= count; n += 1) out.push((await getPageText(bytes, n)).trim());
  return out;
}

const upload = (name: string, bytes: Uint8Array) => pdfUpload(name, Buffer.from(bytes));

/** Las fichas del tablero de Organizar, en orden de documento final. */
const tiles = (page: Page) => page.locator("li").filter({ has: page.getByRole("button", { name: "Mover antes" }) });

test.describe("Wave 8 · herramientas de paginas sobre pageAssembly", () => {
  test("Unir: metadatos del primer archivo, marcadores por documento, formulario con campos renombrados", async ({ page }) => {
    await openTool(page, "merge-pdf");
    await uploadFiles(
      page,
      upload("Informe.pdf", await makeRichPdf({ ...RICH, pages: 3 })),
      upload("Anexo.pdf", await makeRichPdf({ pages: 2, title: "Anexo", form: true, outline: true })),
    );
    await expect(page.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(5);

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("documento-unido.pdf");
    expect(await pageTexts(bytes)).toEqual([marker(0), marker(1), marker(2), marker(0), marker(1)]);

    const out = await inspectPdf(new Uint8Array(bytes));
    expect(out.title).toBe("Informe anual");
    expect(out.author).toBe("Ana Perez");
    expect(out.outlineTitles).toEqual(["Informe", "Capitulo 1", "Capitulo 2", "Capitulo 3", "Anexo", "Capitulo 1", "Capitulo 2"]);
    expect(out.outlineTargets).toEqual([0, 0, 1, 2, 3, 3, 4]);
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-1_2", "campo-2", "campo-2_2", "campo-3"]);
    expect(out.pageObjects).toBe(5);
  });

  test("Quitar paginas: conserva titulo y marcadores de las que quedan; el texto de las quitadas desaparece", async ({ page }) => {
    await openTool(page, "remove-pages");
    await uploadFiles(page, upload("seis.pdf", await makeRichPdf({ ...RICH, pages: 6 })));
    await expect(page.getByRole("button", { name: "Página 1 — Marcar para eliminar" })).toBeVisible();
    await page.getByLabel("Páginas a eliminar").fill("2, 4-5");
    await expect(page.getByText("3 páginas marcadas · Quedan 3 de 6 páginas")).toBeVisible();

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("seis-sin-paginas.pdf");
    expect(await pageTexts(bytes)).toEqual([marker(0), marker(2), marker(5)]);

    const out = await inspectPdf(new Uint8Array(bytes));
    expect(out.title).toBe("Informe anual");
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 3", "Capitulo 6"]);
    expect(out.outlineTargets).toEqual([0, 1, 2]);
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-3", "campo-6"]);
    expect(out.pageObjects).toBe(3);
    const streams = await allStreamsText(new Uint8Array(bytes));
    for (const index of [1, 3, 4]) expect(streams).not.toContain(marker(index));
  });

  test("Organizar: mover una pagina conserva titulo y los marcadores siguen a su pagina", async ({ page }) => {
    await openTool(page, "organize-pdf");
    await uploadFiles(page, upload("plan.pdf", await makeRichPdf({ ...RICH, pages: 4 })));
    await expect(tiles(page)).toHaveCount(4);
    // La 4.ª pasa delante de la 3.ª: [1, 2, 4, 3].
    await tiles(page).nth(3).getByRole("button", { name: "Mover antes", exact: true }).click();

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("plan-organizado.pdf");
    expect(await pageTexts(bytes)).toEqual([marker(0), marker(1), marker(3), marker(2)]);

    const out = await inspectPdf(new Uint8Array(bytes));
    expect(out.title).toBe("Informe anual");
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 2", "Capitulo 3", "Capitulo 4"]);
    expect(out.outlineTargets).toEqual([0, 1, 3, 2]);
    expect(out.fieldNames.sort()).toEqual(["campo-1", "campo-2", "campo-3", "campo-4"]);
  });

  test("Extraer paginas (un PDF): conserva titulo, formulario y marcadores de las paginas extraidas", async ({ page }) => {
    await openTool(page, "extract-pages");
    await uploadFiles(page, upload("origen.pdf", await makeRichPdf({ ...RICH, pages: 6 })));
    await expect(page.getByLabel("Páginas a extraer")).toHaveValue("1-6");
    await page.getByLabel("Páginas a extraer").fill("2, 5");

    const { bytes, filename } = await runAndDownload(page);
    expect(filename).toBe("origen-extraido.pdf");
    expect(await pageTexts(bytes)).toEqual([marker(1), marker(4)]);

    const out = await inspectPdf(new Uint8Array(bytes));
    expect(out.title).toBe("Informe anual");
    expect(out.outlineTitles).toEqual(["Capitulo 2", "Capitulo 5"]);
    expect(out.outlineTargets).toEqual([0, 1]);
    expect(out.fieldNames.sort()).toEqual(["campo-2", "campo-5"]);
    expect(out.pageObjects).toBe(2);
    const streams = await allStreamsText(new Uint8Array(bytes));
    for (const index of [0, 2, 3, 5]) expect(streams).not.toContain(marker(index));
  });
});
