import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  continueToSign,
  createBlockSignature,
  defineSigners,
  draftHealth,
  draftRows,
  failIndexedDb,
  makeSyntheticPdf,
  makeTwoDocs,
  placeSlotsInBothDocuments,
  placeSlotsInSingleDocument,
  selectSignMode,
  sessionDraftCount,
  sessionParam,
  signWholeTurn,
  startTurn,
  uploadDocs,
  waitForDraftSettled,
} from "../helpers/sign-flow";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { jpgSignature } from "../helpers/ink-images";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";
import {
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
} from "../../src/app/sign-pdf/signFeatureFlags";

/**
 * Firmar PDF · ninguna pantalla desborda en horizontal con una tipografia ANCHA (F0-fix3).
 *
 * El CI de Linux (runner de GitHub: la fuente del sistema es DejaVu Sans, mucho mas ancha que SF Pro de Apple) destapo
 * que el boton «Sí, firmar otro con los mismos firmantes» ocupaba 381 px dentro de una pantalla de 375: el texto no se
 * partia (`whitespace-nowrap`) y la pagina ganaba scroll horizontal. En macOS no pasaba, y por eso ningun E2E lo veia.
 * Tambien ocurre en Android, ChromeOS y Linux de escritorio, donde la fuente del sistema no es la de Apple.
 *
 * Esta prueba FUERZA una fuente ancha (DejaVu Sans o, donde no existe, Verdana: ambas ~15 % mas anchas que Arial) y un
 * 6 % de espaciado entre letras en TODA la pagina, y recorre las pantallas de Firmar a 375 y a 320 px, en espanol e
 * ingles (el idioma se cambia en caliente con el selector de la cabecera), en tema claro y oscuro y con y sin tactil.
 * En cada una comprueba que la pagina no gana scroll horizontal y que ningun elemento sin recorte asoma por la derecha
 * (o la izquierda) de la pantalla; si falla, el mensaje dice QUE elemento (etiqueta, clases, texto y medidas).
 *
 * Pasa igual en Linux y en macOS (la fuente forzada no depende del sistema). Para correrla:
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3891 npx playwright test sign-wide-font --project=chromium
 *
 * Headless siempre (modo por defecto de Playwright).
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(240_000);

/** Pantallas de telefono: las anchuras mas habituales (iPhone 375) y las mas estrechas que aun se usan (320). */
const PHONE_WIDTHS = [375, 320] as const;
const PHONE_HEIGHT = 812;
const DESKTOP = { width: 1280, height: 900 } as const;

/**
 * Fuente ancha de sustitucion y un 6 % de espaciado entre letras (la guia WCAG 1.4.12 de espaciado de texto llega a 12 %),
 * aplicados con `!important` a toda la pagina. Es un margen, no el caso real: solo DejaVu Sans ya desbordaba 3 px.
 */
const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

type Theme = "light" | "dark";
type Language = "es" | "en";
type Cell = { theme: Theme; language: Language; touch: boolean };

const CELLS: Cell[] = [
  { theme: "light", language: "es", touch: true },
  { theme: "dark", language: "en", touch: true },
  { theme: "dark", language: "es", touch: false },
  { theme: "light", language: "en", touch: false },
];

/** Contexto con tema, idioma y tipografia ancha desde la primera carga (una hoja de estilo adoptada: no toca el DOM). */
async function newWideContext(browser: Browser, cell: Cell): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: cell.theme,
    hasTouch: cell.touch,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([theme, language, css]) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      // UNA sola vez por pestana: una recarga no pisa el idioma que la prueba cambie despues.
      if (window.sessionStorage.getItem("__seeded")) return;
      window.localStorage.setItem("optimuspdf.theme", theme);
      window.localStorage.setItem("optimuspdf.language", language);
      window.sessionStorage.setItem("__seeded", "1");
    },
    [cell.theme, cell.language, WIDE_CSS],
  );
  return context;
}

/** La fuente forzada ES mas ancha que Arial (si no, la prueba no probaria nada en esta maquina). */
async function expectWideFontActive(page: Page, language: Language): Promise<void> {
  // `<html lang>` sale de la build como «es» y pasa al idioma guardado cuando React hidrata (useSyncExternalStore). Con la CPU
  // apretada (runner de CI) eso tarda mas que el primer vistazo: sin esperar, `fitsEverywhere` tomaba «es» por el idioma de
  // origen de una celda EN y la prueba buscaba «Several signers» en una pantalla en espanol.
  await expect(page.locator("html")).toHaveAttribute("lang", language);
  const ratio = await page.evaluate(() => {
    const context = document.createElement("canvas").getContext("2d")!;
    const probe = "Sí, firmar otro con los mismos firmantes";
    context.font = "16px Arial";
    const narrow = context.measureText(probe).width;
    context.font = '16px "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif';
    return context.measureText(probe).width / narrow;
  });
  expect(ratio, "la fuente ancha forzada debe medir al menos un 8 % mas que Arial").toBeGreaterThan(1.08);
  const applied = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(applied).toMatch(/DejaVu Sans|Verdana|Trebuchet/);
}

type Offender = { tag: string; cls: string; text: string; left: number; right: number; width: number };
type Measure = { overflow: number; clientWidth: number; offenders: Offender[] };

/** Cuanto se desborda la pagina y que elementos asoman por los lados de la pantalla sin quedar recortados. */
async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const clientWidth = root.clientWidth;
    const clips = (element: Element): boolean => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (overflowX === "auto" || overflowX === "scroll" || overflowX === "hidden" || overflowX === "clip") return true;
      }
      return false;
    };
    const offenders: Array<{ tag: string; cls: string; text: string; left: number; right: number; width: number }> = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      // Lo invisible (enlace de salto, texto solo para lectores: 1 px) no cuenta.
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right <= clientWidth + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      if (clips(element)) continue;
      offenders.push({
        tag: element.tagName.toLowerCase(),
        cls: String(element.getAttribute("class") ?? "").slice(0, 110),
        text: (element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60),
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
      });
    }
    return { overflow: root.scrollWidth - clientWidth, clientWidth, offenders: offenders.slice(0, 8) };
  });
}

/** Mide hasta que se asienta (las tarjetas entran con una animacion): falla si tras 3 s sigue desbordando. */
async function expectFits(page: Page, label: string): Promise<void> {
  let last: Measure | null = null;
  await expect
    .poll(
      async () => {
        last = await measure(page);
        return last.overflow <= 1 && last.offenders.length === 0;
      },
      { message: `«${label}» no desborda en horizontal`, timeout: 3500, intervals: [150, 250, 400] },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `«${label}» desborda a ${last?.clientWidth} px (scrollWidth - clientWidth = ${last?.overflow}); elementos fuera: ${JSON.stringify(last?.offenders)}\n${String(error)}`,
      );
    });
}

/** Cambia de idioma con el selector de la cabecera (el unico visible en pantalla de telefono). */
async function switchLanguage(page: Page, to: Language): Promise<void> {
  const button = page.locator("button[aria-pressed]:visible").filter({ hasText: new RegExp(`^${to.toUpperCase()}$`) }).first();
  await button.click();
  await expect(page.locator("html")).toHaveAttribute("lang", to);
}

/**
 * La pantalla en curso, a 375 y a 320 px, en el idioma actual y (si `both`) tambien en el otro; deja el idioma como
 * estaba y la ventana en escritorio.
 */
async function fitsEverywhere(page: Page, label: string, options: { both?: boolean } = {}): Promise<void> {
  const original = (await page.locator("html").getAttribute("lang")) === "en" ? "en" : "es";
  const other: Language = original === "es" ? "en" : "es";
  try {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: PHONE_HEIGHT });
      await expectFits(page, `${label} · ${original} · ${width}px`);
    }
    if (options.both !== false) {
      await switchLanguage(page, other);
      for (const width of [...PHONE_WIDTHS].reverse()) {
        await page.setViewportSize({ width, height: PHONE_HEIGHT });
        await expectFits(page, `${label} · ${other} · ${width}px`);
      }
      await switchLanguage(page, original);
    }
  } finally {
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(150);
  }
}

/* ------------------------------------------------------------------ *
 * 1. El recorrido entero de una ronda (2 documentos, 2 firmantes), pantalla a pantalla
 * ------------------------------------------------------------------ */

test.describe("la ronda entera con tipografia ancha: ninguna pantalla desborda a 375 ni a 320 px", () => {
  for (const cell of CELLS) {
    test(`${cell.theme} · ${cell.language} · ${cell.touch ? "tactil" : "raton"}: de la subida al resultado y a «firmar otro»`, async ({ browser }) => {
      const context = await newWideContext(browser, cell);
      const page = await context.newPage();
      try {
        const docs = await makeTwoDocs();
        await page.goto("/sign-pdf");
        await expectWideFontActive(page, cell.language);
        await fitsEverywhere(page, "subida (vacia)");

        await uploadDocs(page, docs);
        const several = cell.language === "es" ? "Varios firmantes" : "Several signers";
        await expect(page.getByRole("tab", { name: several })).toBeVisible();
        // Los textos de esta parte del recorrido son los de la interfaz en espanol: se vuelve a ES si la celda es EN.
        if (cell.language === "en") await switchLanguage(page, "es");
        await fitsEverywhere(page, "paso Firmantes con «Solo yo»");

        await page.getByRole("tab", { name: "Varios firmantes" }).click();
        await fitsEverywhere(page, "Varios firmantes: aviso de privacidad y E-sign");

        await defineSigners(page);
        await fitsEverywhere(page, "dos firmantes con nombre");
        await selectSignMode(page, "independent");
        await fitsEverywhere(page, "tabla «¿Quién firma qué?» con una firma por documento");
        // «Por grupos» (con 2 documentos = una firma por documento) y una copia más de todos: tabla con copias y resumen.
        await page.getByRole("button", { name: "Por grupos" }).click();
        await page.getByRole("button", { name: "Una copia más en todos los documentos" }).click();
        await expect(page.getByText("Se descargarán 4 archivos.")).toBeVisible();
        await fitsEverywhere(page, "tabla «¿Quién firma qué?» con copias y resumen");

        await placeSlotsInBothDocuments(page);
        await fitsEverywhere(page, "paso Documento con huecos");

        await continueToSign(page);
        await fitsEverywhere(page, "traspaso al primer firmante");

        await startTurn(page);
        await fitsEverywhere(page, "turno 1: crear las firmas");
        await createBlockSignature(page, 1, 2, 11);
        await createBlockSignature(page, 2, 2, 12);
        await fitsEverywhere(page, "turno 1: firmas hechas");
        await page.getByRole("button", { name: "Ver cómo queda" }).click();
        await fitsEverywhere(page, "turno 1: revision");
        await page.getByRole("button", { name: "Pasar al siguiente firmante" }).click();
        await expect(page.getByText("Turno 2 de 2")).toBeVisible();
        await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
        await fitsEverywhere(page, "traspaso al segundo firmante (cabecera con «Ver borradores»)");

        await signWholeTurn(page, 2, 20, true);
        await expect(page.getByRole("heading", { name: "Ya han firmado todos" })).toBeVisible();
        await waitForDraftSettled(page);
        // Las miniaturas de «Revisar antes de descargar» llegan de una en una.
        await expect(page.getByRole("heading", { name: "Revisar antes de descargar" })).toBeVisible();
        await expect(page.locator("[data-review-page] img")).toHaveCount(2, { timeout: 30_000 });
        await fitsEverywhere(page, "«Ya han firmado todos» con «Revisar antes de descargar»");

        await page.getByRole("button", { name: "Firmar y descargar" }).click();
        const download = page.getByRole("button", { name: "Descargar", exact: true });
        await expect(download).toBeVisible({ timeout: 60_000 });
        // Deja que se asiente la animacion de entrada de la tarjeta.
        await page.waitForTimeout(900);
        await fitsEverywhere(page, "pantalla de resultado (casilla de borrado, E-sign y «firmar otro»)");

        await download.click();
        await expect(page.getByRole("button", { name: "Deshacer" })).toBeVisible();
        await fitsEverywhere(page, "resultado: aviso de borrado con «Deshacer»");
        await page.getByText("Borrar el borrador de esta firma (incluye las firmas guardadas en él)", { exact: true }).click();
        await expect(page.locator("[data-delete-draft-status]")).toBeVisible();
        await fitsEverywhere(page, "resultado: borrador conservado");

        // «Firmar otro con los mismos firmantes» vuelve a la subida con la cabecera y los borradores intactos.
        await page.getByRole("button", { name: "Sí, firmar otro con los mismos firmantes" }).click();
        await fitsEverywhere(page, "de nuevo en Firmantes tras «firmar otro»");
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 2. Hojas y avisos del borrador (cada idioma en su celda: lo modal no deja cambiar de idioma en caliente)
 * ------------------------------------------------------------------ */

const WORDS = {
  es: {
    several: "Varios firmantes",
    add: "Añadir firmante",
    cardTitle: "Tienes una firma sin terminar",
    viewAll: "Ver todos",
    offer: "Retomar lo que tenías",
    leave: /Salir de la firma/,
    stay: "Seguir firmando",
    draftsDialog: "Borradores guardados",
    noAutosave: /Sin autoguardado/,
    otherTab: "Otra pestaña modificó esta firma",
    separate: "esta copia se guardó aparte",
    soloCreate: "Crear firma",
    soloType: "Escribir",
    soloName: "Nombre",
    soloUse: "Usar esta firma",
    soloLeave: "Este modo no guarda borrador",
  },
  en: {
    several: "Several signers",
    add: "Add signer",
    cardTitle: "You have an unfinished signing",
    viewAll: "View all",
    offer: "Pick up where you left off",
    leave: /Leave signing/,
    stay: "Keep signing",
    draftsDialog: "Saved drafts",
    noAutosave: /No autosave/,
    otherTab: "Another tab changed this signing",
    separate: "this copy was saved separately",
    soloCreate: "Create signature",
    soloType: "Type",
    soloName: "Name",
    soloUse: "Use this signature",
    soloLeave: "This mode does not save a draft",
  },
} as const;

/** Una pagina nueva (con tipografia ancha y sin dialogos que bloqueen la navegacion) en un contexto propio. */
async function withFreshPage(browser: Browser, cell: Cell, body: (page: Page, context: BrowserContext) => Promise<void>): Promise<void> {
  const context = await newWideContext(browser, { ...cell, touch: true });
  const page = await context.newPage();
  // Salir con trabajo sin terminar dispara el aviso `beforeunload` del navegador: se acepta para poder navegar.
  page.on("dialog", (dialog) => void dialog.accept().catch(() => undefined));
  try {
    await body(page, context);
  } finally {
    await context.close();
  }
}

/** Sube los dos PDF y deja a un firmante anadido (hay progreso y un borrador de sesion guardandose). */
async function startRound(page: Page, language: Language): Promise<void> {
  const words = WORDS[language];
  await page.goto("/sign-pdf");
  await uploadDocs(page, await makeTwoDocs());
  await page.getByRole("tab", { name: words.several }).click();
  await page.getByRole("button", { name: words.add }).click();
}

test.describe("hojas y avisos del borrador con tipografia ancha", () => {
  for (const cell of CELLS) {
    const words = WORDS[cell.language];
    const name = `${cell.theme} · ${cell.language}`;

    test(`${name}: tarjeta de retomar, hoja de borradores, oferta al subir y hoja «¿Salir de la firma?»`, async ({ browser }) => {
      await withFreshPage(browser, cell, async (page) => {
        await startRound(page, cell.language);
        await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
        await expect.poll(() => sessionParam(page), { timeout: 10_000 }).toMatch(/^s-/);
        await page.waitForTimeout(1500);
        await fitsEverywhere(page, "paso Firmantes con borrador guardado", { both: false });

        // Hoja «¿Salir de la firma?» (el «Atras» del navegador con progreso).
        await page.goBack();
        const leave = page.getByRole("dialog", { name: words.leave });
        await expect(leave).toBeVisible();
        await page.waitForTimeout(1000);
        await fitsEverywhere(page, "hoja «¿Salir de la firma?»", { both: false });
        await leave.getByRole("button", { name: words.stay }).click();
        await expect(leave).toBeHidden();

        // Tarjeta «Tienes una firma sin terminar» al volver a la herramienta.
        await page.goto("/sign-pdf?fresh=1");
        await expect(page.locator("[data-resume-card]").getByText(words.cardTitle)).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(900);
        await fitsEverywhere(page, "tarjeta de retomar", { both: false });

        // «Ver todos» -> hoja «Borradores guardados».
        await page.locator("[data-resume-card]").getByRole("button", { name: words.viewAll, exact: true }).click();
        const sheet = page.getByRole("dialog", { name: words.draftsDialog });
        await expect(sheet).toBeVisible();
        await page.waitForTimeout(1000);
        await fitsEverywhere(page, "hoja «Borradores guardados»", { both: false });
        await page.keyboard.press("Escape");
        await expect(sheet).toBeHidden();

        // Subir los MISMOS PDF ofrece retomar.
        await uploadDocs(page, await makeTwoDocs());
        await expect(page.getByText(words.offer)).toBeVisible({ timeout: 15_000 });
        await page.waitForTimeout(900);
        await fitsEverywhere(page, "oferta «Retomar lo que tenías»", { both: false });
      });
    });

    test(`${name}: aviso «Sin autoguardado» y hoja de salida con el texto de fallo`, async ({ browser }) => {
      await withFreshPage(browser, cell, async (page) => {
        await failIndexedDb(page, "quota");
        await startRound(page, cell.language);
        await expect(draftHealth(page)).toContainText(words.noAutosave, { timeout: 10_000 });
        await page.waitForTimeout(500);
        await fitsEverywhere(page, "aviso «Sin autoguardado»", { both: false });
        await page.goBack();
        const leave = page.getByRole("dialog", { name: words.leave });
        await expect(leave).toBeVisible();
        await page.waitForTimeout(1000);
        await fitsEverywhere(page, "hoja de salida con fallo de guardado", { both: false });
      });
    });

    test(`${name}: dos pestañas — avisos «otra pestaña modificó esta firma» y «copia aparte»`, async ({ browser }) => {
      await withFreshPage(browser, cell, async (page, context) => {
        await startRound(page, cell.language);
        await expect.poll(() => sessionDraftCount(page), { timeout: 15_000 }).toBe(1);
        await expect.poll(() => sessionParam(page), { timeout: 10_000 }).toMatch(/^s-/);
        await page.waitForTimeout(1500);

        const other = await context.newPage();
        other.on("dialog", (dialog) => void dialog.accept().catch(() => undefined));
        await other.goto(page.url());
        await expect(other.getByRole("tab", { name: words.several })).toBeVisible({ timeout: 20_000 });
        await other.getByRole("button", { name: words.add }).click();
        await expect.poll(async () => (await draftRows(other))[0]?.signers.length ?? 0, { timeout: 15_000 }).toBe(2);

        await page.bringToFront();
        await expect(draftHealth(page)).toContainText(words.otherTab, { timeout: 10_000 });
        await page.waitForTimeout(500);
        await fitsEverywhere(page, "aviso «otra pestaña modificó esta firma»", { both: false });

        await page.getByRole("button", { name: words.add }).click();
        await expect(draftHealth(page)).toContainText(words.separate, { timeout: 10_000 });
        await page.waitForTimeout(500);
        await fitsEverywhere(page, "aviso «copia aparte»", { both: false });
      });
    });

    test(`${name}: «Solo yo» — hoja «Este modo no guarda borrador»`, async ({ browser }) => {
      await withFreshPage(browser, cell, async (page) => {
        await page.goto("/sign-pdf");
        await uploadDocs(page, await makeTwoDocs());
        await expect(async () => {
          if ((await page.getByRole("dialog").count()) === 0) await page.getByRole("button", { name: words.soloCreate }).first().click();
          await expect(page.getByRole("dialog")).toBeVisible({ timeout: 2500 });
        }).toPass({ timeout: 20_000 });
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("tab", { name: words.soloType }).click();
        await dialog.getByLabel(words.soloName, { exact: true }).fill("Ana");
        await page.waitForTimeout(600);
        await fitsEverywhere(page, "hoja de firma «Escribir»", { both: false });
        await dialog.getByRole("button", { name: words.soloUse }).click();
        await expect(dialog).toBeHidden();
        await page.waitForTimeout(800);
        await page.goBack();
        const sheet = page.getByRole("dialog", { name: words.leave });
        await expect(sheet).toBeVisible();
        await expect(sheet).toContainText(words.soloLeave);
        await page.waitForTimeout(1000);
        await fitsEverywhere(page, "hoja «Este modo no guarda borrador»", { both: false });
      });
    });
  }
});

/* ------------------------------------------------------------------ *
 * 3. Un documento con «registro .json»: el segundo boton de la pantalla de resultado
 * ------------------------------------------------------------------ */

test.describe("el boton «Descargar registro (.json)» con tipografia ancha", () => {
  for (const cell of CELLS.slice(0, 2)) {
    test(`${cell.theme} · ${cell.language}: un documento con dos firmantes, pantalla de resultado con el registro`, async ({ browser }) => {
      const context = await newWideContext(browser, cell);
      const page = await context.newPage();
      try {
        await page.addInitScript(
          ([flagsKey, versionKey]) => {
            if (window.sessionStorage.getItem("__flags")) return;
            window.localStorage.setItem(flagsKey, JSON.stringify({ signingRecordFile: true }));
            window.localStorage.setItem(versionKey, "2");
            window.sessionStorage.setItem("__flags", "1");
          },
          [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, SIGN_PDF_FEATURE_FLAGS_VERSION_KEY],
        );
        await page.goto("/sign-pdf");
        // La preparacion usa los textos en espanol; el idioma de la celda se aplica en caliente al medir.
        if (cell.language === "en") await switchLanguage(page, "es");
        await uploadDocs(page, [
          { name: "Contrato de arrendamiento y anexos firmados.pdf", mimeType: "application/pdf", buffer: await makeSyntheticPdf("C", 2) },
        ]);
        await defineSigners(page);
        await placeSlotsInSingleDocument(page);
        await continueToSign(page);
        await signWholeTurn(page, 1, 10, false);
        await signWholeTurn(page, 1, 20, true);
        await page.getByRole("button", { name: "Firmar y descargar" }).click();
        await page.getByRole("button", { name: "No, dejar el nombre como está" }).click();
        await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 60_000 });
        await page.waitForTimeout(900);
        await expect(page.getByRole("button", { name: "Descargar registro (.json)" })).toBeVisible();
        await fitsEverywhere(page, "resultado de un documento con «Descargar registro (.json)»");
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 3. Subir firma o iniciales y exportar / importar todas las firmas (F6 · U6.2 y U4.4-UI)
 * ------------------------------------------------------------------ */

test.describe("subir firmas y respaldarlas con tipografia ancha: ninguna hoja desborda a 375 ni a 320 px", () => {
  for (const cell of CELLS) {
    test(`${cell.theme} · ${cell.language} · ${cell.touch ? "tactil" : "raton"}: «Firmas guardadas», subir imagen (3 pasos), exportar e importar`, async ({ browser }) => {
      test.setTimeout(300_000);
      const strings = SIGN_STRINGS[cell.language];
      const ink = strings.inkImport;
      const backup = strings.vaultBackup;
      const context = await newWideContext(browser, cell);
      await context.addInitScript((key) => window.localStorage.setItem(key, "1"), PRIVACY_SEEN_KEY);
      const page = await context.newPage();
      try {
        await page.goto("/sign-pdf");
        await expectWideFontActive(page, cell.language);
        await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles({
          name: "contrato.pdf",
          mimeType: "application/pdf",
          buffer: await makeSyntheticPdf("C", 1),
        });
        await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });

        await page.getByRole("button", { name: strings.vaultButton }).first().click();
        const vault = page.getByRole("dialog", { name: strings.vaultTitle });
        await expect(vault).toBeVisible();
        await page.waitForTimeout(900);
        await fitsEverywhere(page, "Firmas guardadas (vacia) con los tres botones nuevos", { both: false });

        // --- Subir: elegir -> ajustar (recorte a mano incluido) -> resumen ---
        await vault.getByRole("button", { name: ink.entryButton }).click();
        const upload = page.getByRole("dialog", { name: ink.title });
        await expect(upload).toBeVisible();
        await page.waitForTimeout(900);
        await fitsEverywhere(page, "subir: elegir imagen", { both: false });
        await upload.locator("[data-ink-file-input]").setInputFiles(jpgSignature("shadow"));
        await expect(upload.getByRole("heading", { name: ink.adjustTitle })).toBeVisible({ timeout: 30_000 });
        await expect(upload.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
        await page.waitForTimeout(600);
        await fitsEverywhere(page, "subir: ajustar (vista previa, limpiar fondo, interruptores, color, tipo)", { both: false });
        await upload.getByRole("button", { name: ink.cropManual }).first().click();
        await expect(upload.getByRole("group", { name: ink.cropAreaLabel })).toBeVisible();
        await page.waitForTimeout(400);
        await fitsEverywhere(page, "subir: recorte a mano con las asas de 44 px", { both: false });
        await upload.getByRole("button", { name: ink.cropDone }).click();
        await expect(upload.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
        await upload.locator("[data-ink-accept]").click();
        await expect(upload.getByRole("heading", { name: ink.summaryTitle })).toBeVisible();
        await upload.getByLabel(ink.nameLabel).fill("María de los Ángeles Fernández-Villanueva y Ortega");
        await fitsEverywhere(page, "subir: resumen con nombre largo", { both: false });
        await upload.getByRole("button", { name: ink.save }).click();
        await expect(upload).toBeHidden({ timeout: 15_000 });
        await fitsEverywhere(page, "Firmas guardadas con la firma subida y su aviso", { both: false });

        // --- Exportar ---
        await vault.getByRole("button", { name: backup.exportButton }).click();
        const exportSheet = page.getByRole("dialog", { name: backup.exportTitle });
        await expect(exportSheet).toBeVisible();
        await exportSheet.getByLabel(backup.password, { exact: true }).fill("una-clave-larga-3");
        await page.waitForTimeout(900);
        await fitsEverywhere(page, "exportar: contraseña, medidor y confirmacion", { both: false });
        await exportSheet.locator("label", { hasText: backup.protect }).click();
        await expect(exportSheet.getByRole("checkbox", { name: backup.protect })).not.toBeChecked();
        await fitsEverywhere(page, "exportar: sin contraseña (aviso de que quedan sin cifrar)", { both: false });
        await exportSheet.locator("label", { hasText: backup.protect }).click();
        await expect(exportSheet.getByRole("checkbox", { name: backup.protect })).toBeChecked();
        await exportSheet.getByLabel(backup.password, { exact: true }).fill("una-clave-larga-3");
        await exportSheet.getByLabel(backup.confirmPassword).fill("una-clave-larga-3");
        const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
        await exportSheet.getByRole("button", { name: backup.exportConfirm, exact: true }).click();
        const shareOrDownload = exportSheet.getByRole("button", { name: backup.downloadButton, exact: true });
        const download = await Promise.race([
          downloadPromise,
          shareOrDownload.waitFor({ timeout: 60_000 }).then(async () => {
            const next = page.waitForEvent("download", { timeout: 30_000 });
            await shareOrDownload.click();
            return next;
          }).catch(() => new Promise<never>(() => {})),
        ]);
        const filePath = await download.path();
        await expect(exportSheet.getByRole("button", { name: backup.doneClose })).toBeVisible();
        await fitsEverywhere(page, "exportar: confirmacion «N firmas exportadas»", { both: false });
        await exportSheet.getByRole("button", { name: backup.doneClose }).click();

        // --- Importar: contraseña y vista previa ---
        await vault.getByRole("button", { name: backup.importButton, exact: true }).click();
        const importSheet = page.getByRole("dialog", { name: backup.importTitle });
        await expect(importSheet).toBeVisible();
        await page.waitForTimeout(900);
        await fitsEverywhere(page, "importar: elegir archivo", { both: false });
        await importSheet.locator("[data-backup-file-input]").setInputFiles(filePath);
        await expect(importSheet.getByLabel(backup.passwordLabel)).toBeVisible({ timeout: 30_000 });
        await fitsEverywhere(page, "importar: pedir contraseña", { both: false });
        await importSheet.getByLabel(backup.passwordLabel).fill("una-clave-larga-3");
        await importSheet.getByRole("button", { name: backup.passwordOpen }).click();
        await expect(importSheet.getByText(backup.statusIdentical).first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(500);
        await fitsEverywhere(page, "importar: vista previa (ya lo tienes, nombre largo)", { both: false });
      } finally {
        await context.close();
      }
    });
  }
});
