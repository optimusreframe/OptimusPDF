import type { Browser, Page } from "@playwright/test";
import JSZip from "jszip";
import { expect, openTool, runAndDownload, test, uploadFiles } from "../helpers/tool-flow";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import { pdfUpload } from "../helpers/test-files";
import { expectDescriptionWithoutRepeats } from "../helpers/accessible-description";
import { inspectPdf, makeRichPdf, marker } from "../../src/lib/pdf/testing/pageAssemblyFixtures";
import {
  pdfjsLinks,
  pdfjsPageLabels,
  pdfjsStructTree,
  structContentCount,
  type PdfjsLink,
} from "../../src/lib/pdf/testing/pdfjsInspect";

/**
 * Wave 8 · B3 · Unir, Quitar paginas, Organizar, Dividir y Extraer: conservar o AVISAR de lo que se pierde.
 *
 * Cada herramienta se usa de verdad (subir, operar, descargar) con PDF que traen etiquetas de pagina,
 * enlaces internos, firmas, estructura etiquetada y marcadores. Se comprueba (1) que la pantalla de
 * descarga cuenta lo que no se pudo conservar, en espanol e ingles, sin crear regiones vivas nuevas y sin
 * violaciones de axe, y (2) que el PDF descargado, abierto con pdf.js, tiene las paginas, el orden, las
 * etiquetas y los enlaces correctos.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(120_000);

const upload = (name: string, bytes: Uint8Array) => pdfUpload(name, Buffer.from(bytes));
const u8 = (bytes: Buffer) => new Uint8Array(bytes);
const page = (index: number): PdfjsLink => ({ kind: "page", page: index });
const url: PdfjsLink = { kind: "url", url: "https://example.com/" };

/** La marca de cada pagina (`MARCA-PAGINA-000N`), en orden: identifica la pagina aunque lleve mas texto. */
async function texts(bytes: Buffer): Promise<string[]> {
  const count = await getPageCount(bytes);
  const out: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    out.push(/MARCA-PAGINA-\d{4}/.exec(await getPageText(bytes, n))?.[0] ?? "");
  }
  return out;
}

/** El bloque de avisos de la pantalla de descarga y sus elementos. */
const noticeBlock = (p: Page) => p.locator("[data-download-notices]");
const noticeItems = (p: Page) => noticeBlock(p).locator("li");

/** Libro de 6 paginas: romanos (i, ii), cuerpo (1..4); enlaces, marcadores, firma aplicada y estructura. */
const BOOK = {
  pages: 6,
  title: "Libro",
  outline: true,
  links: true,
  signedSignature: true,
  taggedContent: true,
  labelRanges: [
    { start: 0, style: "r" },
    { start: 2, style: "D" },
  ],
} as const;

test.describe("Unir PDF · avisos y resultado", () => {
  test("firmas, estructura etiquetada: avisa de lo que se pierde y las etiquetas y enlaces de cada archivo son los suyos", async ({ page: p }) => {
    await openTool(p, "merge-pdf");
    await uploadFiles(
      p,
      upload("Informe.pdf", await makeRichPdf({ ...BOOK, pages: 4, outline: false })),
      upload(
        "Anexo.pdf",
        await makeRichPdf({
          pages: 3,
          links: true,
          signedSignature: true,
          taggedContent: true,
          labelRanges: [{ start: 0, style: "D", prefix: "Anexo-" }],
        }),
      ),
    );
    await expect(p.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(7);

    const { bytes, filename } = await runAndDownload(p);
    expect(filename).toBe("documento-unido.pdf");

    // --- pantalla de descarga: los avisos llegan, con titulo y en orden de importancia
    await expect(noticeBlock(p)).toBeVisible();
    await expect(noticeBlock(p).getByRole("heading", { name: "Avisos sobre el resultado" })).toBeVisible();
    await expect(noticeItems(p)).toHaveCount(3);
    await expect(noticeItems(p).nth(0)).toHaveText(
      "La firma digital del documento deja de ser válida: el archivo se ha vuelto a escribir y ya no coincide con el que se firmó.",
    );
    await expect(noticeItems(p).nth(1)).toHaveText(
      "No se copió 1 firma ya aplicada: una firma digital solo es válida en el documento en el que se firmó.",
    );
    await expect(noticeItems(p).nth(2)).toHaveText(
      "3 páginas no llevan etiquetas de accesibilidad (PDF etiquetado): la accesibilidad del resultado puede quedar incompleta.",
    );
    // Los avisos describen el boton «Descargar» (se leen al llegar el foco) y no hay regiones vivas nuevas.
    const describedBy = await p.getByRole("button", { name: "Descargar", exact: true }).getAttribute("aria-describedby");
    const noticeId = await noticeBlock(p).getAttribute("id");
    const describedIds = describedBy?.split(" ") ?? [];
    // Por el titulo y por cada aviso, nunca por el grupo entero (Chromium lo describe con todo su contenido y se leeria dos veces).
    expect(describedIds).toContain(await noticeBlock(p).getAttribute("aria-labelledby"));
    expect(describedIds).not.toContain(noticeId);
    expect(describedIds.length).toBe(1 + 3);
    await expectDescriptionWithoutRepeats(p);
    await expect(noticeBlock(p)).toHaveAttribute("role", "group");
    const liveWithText = await p
      .locator('[aria-live], [role="status"], [role="alert"]')
      .evaluateAll((nodes) => nodes.filter((node) => (node.textContent ?? "").trim() !== "").length);
    expect(liveWithText).toBe(0);
    // Nada de claves crudas ni marcadores sin sustituir.
    const noticeText = (await noticeBlock(p).innerText()).replace(/\s+/g, " ");
    expect(noticeText).not.toMatch(/\{n\}|undefined|signaturesInvalidated|structureIncomplete|signatureFieldsRemoved/);

    // --- el PDF descargado, abierto como lo abre un visor
    expect(await texts(bytes)).toEqual([0, 1, 2, 3, 0, 1, 2].map(marker));
    expect(await pdfjsPageLabels(u8(bytes))).toEqual(["i", "ii", "1", "2", "Anexo-1", "Anexo-2", "Anexo-3"]);
    const links = await pdfjsLinks(u8(bytes));
    // Cada archivo enlaza a SUS paginas: el primero a las suyas (0-3), el anexo a las suyas (4-6).
    expect(links[0]).toEqual([page(3), url, page(2)]);
    expect(links[4]).toEqual([page(6), url, page(6)]);
    const out = await inspectPdf(u8(bytes));
    expect(out.fieldNames).toEqual(["firma"]);
    expect(out.hasStructTree).toBe(true);
    // Las paginas del primer archivo conservan sus etiquetas de accesibilidad; las del anexo no las traen.
    expect(structContentCount(await pdfjsStructTree(u8(bytes), 1))).toBe(2);
    expect(structContentCount(await pdfjsStructTree(u8(bytes), 5))).toBe(0);
  });

  test("sin nada que perder: la pantalla de descarga es la de siempre, sin bloque de avisos", async ({ page: p }) => {
    await openTool(p, "merge-pdf");
    await uploadFiles(
      p,
      upload("a.pdf", await makeRichPdf({ pages: 2, links: true, labelRanges: [{ start: 0, style: "r" }] })),
      upload("b.pdf", await makeRichPdf({ pages: 2, links: true, labelRanges: [{ start: 0, style: "A" }] })),
    );
    await expect(p.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(4);
    const { bytes } = await runAndDownload(p);
    await expect(noticeBlock(p)).toHaveCount(0);
    expect(await pdfjsPageLabels(u8(bytes))).toEqual(["i", "ii", "A", "B"]);
    const links = await pdfjsLinks(u8(bytes));
    expect(links[0]).toEqual([]);
    expect((await inspectPdf(u8(bytes))).pageObjects).toBe(4);
  });

  test("quitar una pagina del plan avisa de los enlaces que llevaban a ella", async ({ page: p }) => {
    await openTool(p, "merge-pdf");
    await uploadFiles(
      p,
      upload("a.pdf", await makeRichPdf({ pages: 2 })),
      upload("b.pdf", await makeRichPdf({ pages: 4, links: true })),
    );
    await expect(p.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(6);
    // La 6.ª miniatura es la ultima de «b»: el destino del primer enlace de su pagina 1 (los dos primeros
    // «Quitar» son de los archivos; el ultimo, de la miniatura 6).
    await p.getByRole("button", { name: "Quitar", exact: true }).last().click();
    await expect(p.getByRole("button", { name: /^Página \d+$/ })).toHaveCount(5);
    const { bytes } = await runAndDownload(p);
    expect(await getPageCount(bytes)).toBe(5);
    await expect(noticeItems(p)).toHaveCount(1);
    await expect(noticeItems(p).first()).toHaveText("Se quitó 1 enlace interno que llevaba a una página que ya no está.");
    const links = await pdfjsLinks(u8(bytes));
    // La pagina 1 de «b» (ahora la 3.ª) conserva la URL y el enlace por nombre a su pagina 3 (la 5.ª).
    expect(links[2]).toEqual([url, page(4)]);
  });
});

test.describe("Quitar páginas · avisos y resultado", () => {
  test("avisa de marcadores, enlaces y firma; las etiquetas de las que quedan siguen siendo las suyas", async ({ page: p }) => {
    await openTool(p, "remove-pages");
    await uploadFiles(p, upload("libro.pdf", await makeRichPdf(BOOK)));
    await expect(p.getByRole("button", { name: "Página 1 — Marcar para eliminar" })).toBeVisible();
    // Se quitan la 3 (destino del enlace por nombre; etiqueta «1») y la 5 (etiqueta «3»).
    await p.getByLabel("Páginas a eliminar").fill("3, 5");
    await expect(p.getByText("2 páginas marcadas · Quedan 4 de 6 páginas")).toBeVisible();

    const { bytes, filename } = await runAndDownload(p);
    expect(filename).toBe("libro-sin-paginas.pdf");

    // --- avisos
    await expect(noticeItems(p)).toHaveCount(4);
    const items = await noticeItems(p).allInnerTexts();
    expect(items[0]).toBe(
      "La firma digital del documento deja de ser válida: el archivo se ha vuelto a escribir y ya no coincide con el que se firmó.",
    );
    expect(items[1]).toBe("Se quitaron 2 marcadores que apuntaban a páginas que ya no están.");
    expect(items[2]).toBe("Se quitó 1 enlace interno que llevaba a una página que ya no está.");
    expect(items[3]).toBe("Se quitó 1 destino con nombre de una página que ya no está.");
    // La estructura etiquetada y las etiquetas de pagina se conservan: no hay aviso de ellas.
    expect(items.join(" ")).not.toMatch(/accesibilidad|numeración/);

    // --- resultado abierto con pdf.js
    expect(await texts(bytes)).toEqual([0, 1, 3, 5].map(marker));
    expect(await pdfjsPageLabels(u8(bytes))).toEqual(["i", "ii", "2", "4"]);
    const links = await pdfjsLinks(u8(bytes));
    // La pagina 1 enlazaba a la ultima (ahora la 4.ª) y a una URL; el enlace por nombre a la 3.ª se fue.
    expect(links[0]).toEqual([page(3), url]);
    const out = await inspectPdf(u8(bytes));
    expect(out.outlineTitles).toEqual(["Capitulo 1", "Capitulo 2", "Capitulo 4", "Capitulo 6"]);
    expect(out.outlineTargets).toEqual([0, 1, 2, 3]);
    expect(out.pageObjects).toBe(4);
    expect(out.hasStructTree).toBe(true);
    // La pagina 2 (con el contenido compartido) y la 3 siguen etiquetadas.
    expect(structContentCount(await pdfjsStructTree(u8(bytes), 2))).toBe(2);
    expect(structContentCount(await pdfjsStructTree(u8(bytes), 3))).toBe(1);
  });

  test("EN: los mismos avisos en ingles, sin textos en espanol", async ({ browser }) => {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 800 } });
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("optimuspdf.language", "en");
      } catch {
        /* storage bloqueado */
      }
    });
    const p = await context.newPage();
    try {
      await p.goto("/remove-pages");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
      await uploadFiles(p, upload("book.pdf", await makeRichPdf(BOOK)));
      await expect(p.getByRole("button", { name: "Page 1 — Mark for deletion" })).toBeVisible();
      await p.getByLabel("Pages to delete").fill("3, 5");
      await p.getByRole("button", { name: "Process", exact: true }).click();
      await expect(p.getByRole("button", { name: "Download", exact: true })).toBeFocused({ timeout: 60_000 });
      await expect(noticeBlock(p).getByRole("heading", { name: "Notices about the result" })).toBeVisible();
      const items = await noticeItems(p).allInnerTexts();
      expect(items).toEqual([
        "The document's digital signature is no longer valid: the file was rewritten and no longer matches the one that was signed.",
        "2 bookmarks that pointed to pages that are no longer there were removed.",
        "1 internal link that led to a page that is no longer there was removed.",
        "1 named destination of a page that is no longer there was removed.",
      ]);
    } finally {
      await context.close();
    }
  });
});

test.describe("Organizar, Extraer y Dividir · los avisos llegan a la pantalla de descarga", () => {
  test("Organizar: mover una pagina conserva las etiquetas y avisa de la firma", async ({ page: p }) => {
    await openTool(p, "organize-pdf");
    await uploadFiles(p, upload("plan.pdf", await makeRichPdf({ ...BOOK, pages: 4, outline: false })));
    const tiles = p.locator("li").filter({ has: p.getByRole("button", { name: "Mover antes" }) });
    await expect(tiles).toHaveCount(4);
    // La 4.ª (etiqueta «2») pasa delante de la 3.ª (etiqueta «1»).
    await tiles.nth(3).getByRole("button", { name: "Mover antes", exact: true }).click();
    const { bytes } = await runAndDownload(p);
    expect(await texts(bytes)).toEqual([0, 1, 3, 2].map(marker));
    expect(await pdfjsPageLabels(u8(bytes))).toEqual(["i", "ii", "2", "1"]);
    await expect(noticeItems(p)).toHaveCount(1);
    await expect(noticeItems(p).first()).toContainText("La firma digital del documento deja de ser válida");
    // Reordenar no toca la estructura etiquetada: sigue completa.
    expect(structContentCount(await pdfjsStructTree(u8(bytes), 4))).toBe(1);
  });

  test("Extraer (un PDF): las etiquetas viajan con las paginas y se avisa de la firma y de los enlaces que quedan fuera", async ({ page: p }) => {
    await openTool(p, "extract-pages");
    await uploadFiles(p, upload("origen.pdf", await makeRichPdf({ ...BOOK, outline: false })));
    await expect(p.getByLabel("Páginas a extraer")).toHaveValue("1-6");
    await p.getByLabel("Páginas a extraer").fill("1, 4-5");
    const { bytes, filename } = await runAndDownload(p);
    expect(filename).toBe("origen-extraido.pdf");
    expect(await texts(bytes)).toEqual([0, 3, 4].map(marker));
    expect(await pdfjsPageLabels(u8(bytes))).toEqual(["i", "2", "3"]);
    // La pagina 1 llevaba tres enlaces: a la ultima, a una URL y por nombre a la 3.ª; solo la URL cabe.
    expect((await pdfjsLinks(u8(bytes)))[0]).toEqual([url]);
    expect(await noticeItems(p).allInnerTexts()).toEqual([
      "La firma digital del documento deja de ser válida: el archivo se ha vuelto a escribir y ya no coincide con el que se firmó.",
      "Se quitaron 2 enlaces internos que llevaban a páginas que ya no están.",
      "Se quitaron 2 destinos con nombre de páginas que ya no están.",
    ]);
  });

  test("Dividir en un ZIP: cada parte con sus etiquetas, y los avisos de lo que no viaja a las partes", async ({ page: p }) => {
    await openTool(p, "split-pdf");
    await uploadFiles(p, upload("libro.pdf", await makeRichPdf({ ...BOOK, outline: false })));
    await expect(p.getByRole("spinbutton", { name: "Hasta" }).first()).toHaveValue("6");
    await p.getByRole("spinbutton", { name: "Hasta" }).first().fill("2");
    await p.getByRole("button", { name: "Añadir otro tramo" }).click();
    const desde = p.getByRole("spinbutton", { name: "Desde" });
    const hasta = p.getByRole("spinbutton", { name: "Hasta" });
    await desde.nth(1).fill("3");
    await hasta.nth(1).fill("6");
    const { bytes } = await runAndDownload(p);
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir).sort();
    expect(names).toHaveLength(2);
    const first = new Uint8Array(await zip.files[names[0]].async("uint8array"));
    const second = new Uint8Array(await zip.files[names[1]].async("uint8array"));
    expect(await pdfjsPageLabels(first)).toEqual(["i", "ii"]);
    // Las cuatro paginas del cuerpo ya se numeran 1-4 por si solas.
    expect(await pdfjsPageLabels(second)).toBeNull();
    const items = await noticeItems(p).allInnerTexts();
    expect(items.some((item) => item.includes("No se copió 1 firma ya aplicada"))).toBe(true);
    expect(items.some((item) => item.includes("Se quitó la estructura de accesibilidad"))).toBe(true);
    expect((await inspectPdf(first)).hasStructTree).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Accesibilidad de la pantalla de descarga con avisos (axe)
 * ------------------------------------------------------------------ */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const AXE_RULES = ["color-contrast", "aria-valid-attr-value", "label", "button-name", "link-name", "list", "listitem"] as const;

async function axeViolations(p: Page): Promise<string[]> {
  if (!(await p.evaluate(() => "axe" in window))) await p.addScriptTag({ path: AXE_PATH });
  return p.evaluate(async (rules) => {
    const axe = (window as unknown as {
      axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }> };
    }).axe;
    const result = await axe.run(document, { runOnly: { type: "rule", values: [...rules] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  }, AXE_RULES);
}

async function doneScreenWithNotices(browser: Browser, theme: "light" | "dark", language: "es" | "en", width: number) {
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 812 : 900 },
    colorScheme: theme,
    locale: language === "es" ? "es-ES" : "en-US",
  });
  await context.addInitScript(
    ([themeValue, languageValue]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", themeValue);
        window.localStorage.setItem("optimuspdf.language", languageValue);
      } catch {
        /* storage bloqueado */
      }
    },
    [theme, language],
  );
  const p = await context.newPage();
  await p.goto("/remove-pages");
  await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
  await uploadFiles(p, upload("libro.pdf", await makeRichPdf(BOOK)));
  const mark = (n: number) => p.getByRole("button", { name: language === "es" ? `Página ${n} — Marcar para eliminar` : `Page ${n} — Mark for deletion` });
  await expect(mark(1)).toBeVisible();
  await mark(3).click();
  await mark(5).click();
  const run = p.getByRole("button", { name: language === "es" ? "Procesar" : "Process", exact: true });
  await expect(run).toBeEnabled();
  await run.click();
  await expect(noticeBlock(p)).toBeVisible({ timeout: 60_000 });
  // La pantalla entra con una animacion: axe mide el contraste con todo ya opaco.
  await p.waitForTimeout(1500);
  return { context, page: p };
}

test.describe("la pantalla de descarga con avisos no tiene violaciones de axe", () => {
  for (const theme of ["dark", "light"] as const) {
    for (const language of ["es", "en"] as const) {
      for (const width of [1280, 375]) {
        test(`${theme} · ${language} · ${width}px`, async ({ browser }) => {
          const { context, page: p } = await doneScreenWithNotices(browser, theme, language, width);
          try {
            expect(await axeViolations(p)).toEqual([]);
            // El bloque de avisos cabe en la pantalla: sin desbordes horizontales.
            const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow).toBeLessThanOrEqual(0);
          } finally {
            await context.close();
          }
        });
      }
    }
  }
});
