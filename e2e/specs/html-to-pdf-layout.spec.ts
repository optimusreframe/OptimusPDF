import { expect, test } from "@playwright/test";
import {
  analyzePdf,
  convertHtml,
  hasColor,
  hasInk,
  inkInRow,
  installLab,
  type PageAnalysis,
} from "../helpers/html-pdf-lab";
import { articlePage, BLUE, fixedHeaderPage, GREEN, heroPage, ORANGE, printPage, RED, spacerPage, widePage } from "../helpers/html-pdf-pages";

/**
 * «HTML a PDF» · distribucion en la hoja, con el MOTOR REAL en un Chromium real (iframe aislado + html2canvas + jsPDF) sobre
 * paginas SINTETICAS (ninguna peticion a Internet). Se comprueba en el PDF resultante, no en el DOM:
 *   - todas las hojas son Carta (612 x 792 pt) y el contenido cabe en el area util;
 *   - ninguna pagina queda en blanco;
 *   - ninguna linea de texto, imagen ni fila de tabla queda partida entre dos paginas: las filas de pixeles pegadas al corte
 *     (final de una pagina e inicio de la siguiente) no tienen tinta;
 *   - cabeceras/pies fijos salen UNA vez, los avisos de cookies no tapan nada, el `@media print` se aplica, un hero `100vh`
 *     no se estira y una pagina mas ancha que la hoja se reduce en lugar de recortarse.
 * Headless siempre.
 */

test.setTimeout(240_000);

const LETTER = { width: 612, height: 792 };

function expectLetter(pages: PageAnalysis[]) {
  for (const [index, page] of pages.entries()) {
    expect(page.widthPt, `hoja ${index + 1} ancho`).toBeCloseTo(LETTER.width, 1);
    expect(page.heightPt, `hoja ${index + 1} alto`).toBeCloseTo(LETTER.height, 1);
    expect(page.image, `hoja ${index + 1} tiene imagen`).not.toBeNull();
  }
}

/** Filas de pixeles junto a cada corte entre paginas: sin tinta (un glifo, una imagen o un borde partidos dejarian tinta). */
function expectCleanCuts(pages: PageAnalysis[]) {
  for (let index = 0; index < pages.length; index += 1) {
    const image = pages[index].image!;
    if (index < pages.length - 1) {
      for (const row of [image.height - 1, image.height - 2]) {
        expect(inkInRow(image, row), `final de la pagina ${index + 1}, fila ${row}`).toBe(0);
      }
    }
    if (index > 0) {
      for (const row of [0, 1]) expect(inkInRow(image, row), `inicio de la pagina ${index + 1}, fila ${row}`).toBe(0);
    }
  }
}

test("articulo largo con imagenes y tabla: Carta, sin paginas vacias, sin lineas partidas", async ({ page }) => {
  await installLab(page);
  const { pdf, report } = await convertHtml(page, articlePage());
  const pages = await analyzePdf(pdf);

  expect(pages.length).toBeGreaterThanOrEqual(5);
  expect(pages.length).toBe(report.pages);
  expectLetter(pages);
  for (const [index, sheet] of pages.entries()) expect(hasInk(sheet.image!), `la pagina ${index + 1} no esta en blanco`).toBe(true);
  expect(report.layoutWidthPx).toBe(816); // maqueta con el ancho de la hoja
  expect(report.forcedBreaks, "ningun corte a ciegas").toBe(0);
  expectCleanCuts(pages);

  // Cabe en el area util: la imagen de cada hoja mide 540 pt de ancho y como mucho 720 pt de alto.
  for (const sheet of pages) {
    const heightPt = (540 * sheet.image!.height) / sheet.image!.width;
    expect(heightPt).toBeLessThanOrEqual(720 + 1);
  }
  // Las paginas se llenan: salvo la ultima, ninguna deja mas de ~40 % de blanco.
  for (const sheet of pages.slice(0, -1)) {
    const heightPt = (540 * sheet.image!.height) / sheet.image!.width;
    expect(heightPt).toBeGreaterThan(720 * 0.55);
  }
  // Texto nitido: escala 2 (1632 px de ancho para 816 px de maquetacion).
  expect(report.scale).toBe(2);
  expect(pages[0].image!.width).toBe(1632);
});

test("A4 sigue disponible y 'sin margen' llena la hoja", async ({ page }) => {
  await installLab(page);
  const { pdf } = await convertHtml(page, articlePage({ sections: 4 }), { pageSize: "a4", margin: "none" });
  const pages = await analyzePdf(pdf);
  for (const sheet of pages) {
    expect(sheet.widthPt).toBeCloseTo(595.28, 1);
    expect(sheet.heightPt).toBeCloseTo(841.89, 1);
  }
  expectCleanCuts(pages);
});

test("cabecera fija, aviso de cookies y chat flotante: la cabecera sale una vez, lo demas no tapa nada", async ({ page }) => {
  await installLab(page);
  const { pdf, report } = await convertHtml(page, fixedHeaderPage());
  const pages = await analyzePdf(pdf);
  expectLetter(pages);
  expect(pages.length).toBeGreaterThanOrEqual(2);

  // La cabecera roja esta arriba de la primera pagina y no se repite en ninguna otra.
  expect(hasColor(pages[0].image!, RED, { y0: 0, y1: 0.12 })).toBe(true);
  for (const sheet of pages.slice(1)) expect(hasColor(sheet.image!, RED)).toBe(false);
  // El aviso de cookies (azul) y el boton de chat (verde) no aparecen en ninguna pagina.
  for (const [index, sheet] of pages.entries()) {
    expect(hasColor(sheet.image!, BLUE), `cookies en la pagina ${index + 1}`).toBe(false);
    expect(hasColor(sheet.image!, GREEN), `chat en la pagina ${index + 1}`).toBe(false);
  }
  expect(report.forcedBreaks).toBe(0);
  expectCleanCuts(pages);
});

test("pagina mas ancha que la hoja: se reduce para caber (no se recorta)", async ({ page }) => {
  await installLab(page);
  const { pdf, report } = await convertHtml(page, widePage());
  const pages = await analyzePdf(pdf);
  expectLetter(pages);
  expect(report.layoutWidthPx).toBeGreaterThan(1300); // se maqueto con el ancho del contenido, no con 816
  expect(report.layoutWidthPx).toBeLessThanOrEqual(1800);
  // La marca roja del borde derecho (columna final de la tabla) esta en la imagen.
  expect(pages.some((sheet) => hasColor(sheet.image!, RED, { x0: 0.8 }))).toBe(true);
  // ... y la imagen sigue encajando en el area util.
  for (const sheet of pages) expect((540 * sheet.image!.height) / sheet.image!.width).toBeLessThanOrEqual(721);
});

test("@media print de la pagina se aplica: lo que oculta al imprimir sale oculto y lo que muestra al imprimir, visible", async ({ page }) => {
  await installLab(page);
  const { pdf } = await convertHtml(page, printPage());
  const pages = await analyzePdf(pdf);
  expect(pages).toHaveLength(1);
  expect(hasColor(pages[0].image!, GREEN)).toBe(false);
  expect(hasColor(pages[0].image!, BLUE)).toBe(true);
});

test("un hueco enorme en blanco no deja paginas vacias", async ({ page }) => {
  await installLab(page);
  const { pdf, report } = await convertHtml(page, spacerPage());
  const pages = await analyzePdf(pdf);
  expectLetter(pages);
  for (const [index, sheet] of pages.entries()) expect(hasInk(sheet.image!), `la pagina ${index + 1} no esta en blanco`).toBe(true);
  expect(report.blankPagesSkipped).toBeGreaterThan(0);
  expect(pages).toHaveLength(2);
});

test("un hero 100vh mide una pagina, no todo el documento", async ({ page }) => {
  await installLab(page);
  const { pdf, report } = await convertHtml(page, heroPage());
  const pages = await analyzePdf(pdf);
  expectLetter(pages);
  // Hero (una pagina) + una seccion corta: a lo sumo 2 paginas, y el documento mide ~1 pagina y poco, no cientos de px de mas.
  expect(pages.length).toBeLessThanOrEqual(2);
  expect(report.documentHeightPx).toBeLessThan(1088 * 1.5);
  expect(hasColor(pages[0].image!, ORANGE, { y0: 0.05, y1: 0.6 })).toBe(true);
});

test("horizontal y Carta: la hoja es 792 x 612 y tampoco hay lineas partidas", async ({ page }) => {
  await installLab(page);
  const { pdf } = await convertHtml(page, articlePage({ sections: 4 }), { orientation: "landscape" });
  const pages = await analyzePdf(pdf);
  for (const sheet of pages) {
    expect(sheet.widthPt).toBeCloseTo(792, 1);
    expect(sheet.heightPt).toBeCloseTo(612, 1);
  }
  expectCleanCuts(pages);
});
