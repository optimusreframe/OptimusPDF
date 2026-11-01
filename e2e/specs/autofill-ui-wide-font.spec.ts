import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import {
  CLIENT,
  FAKE_ONLY_REASON,
  OTHER_CLIENT,
  POLICY_SPECS,
  TEST_TIMEOUT,
  USE_REAL_ENGINE,
  addFileSource,
  installAutofillFakes,
  makeClaimForm,
  makePolicyPdf,
  openAutofill,
  openSignWith,
  textFieldBox,
  tinyJpeg,
} from "../helpers/autofill-ui";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";

/**
 * Autorrelleno · tipografia ANCHA: la hoja «Rellenar con datos del cliente» (elegir fuentes con sus avisos, revisar con conflicto,
 * pisado y avisos, guardar como perfil y la lista/editor de perfiles) no desborda en horizontal a 375 ni a 320 px con DejaVu Sans
 * / Verdana + 6 % de espaciado, en claro y oscuro, ES y EN, con y sin tactil. Misma medida que `sign-templates-wide-font.spec.ts`.
 * Headless siempre.
 */

test.setTimeout(TEST_TIMEOUT * 4);

const PHONE_WIDTHS = [375, 320] as const;
const PHONE_HEIGHT = 812;
const DESKTOP = { width: 1280, height: 900 } as const;
const KEY = "optimuspdf.clientProfiles";

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

async function newWideContext(browser: Browser, cell: Cell): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: cell.theme,
    hasTouch: cell.touch,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([theme, language, css, privacy, key]) => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      if (window.sessionStorage.getItem("__seeded")) return;
      window.localStorage.setItem("optimuspdf.theme", theme);
      window.localStorage.setItem("optimuspdf.language", language);
      window.localStorage.setItem(privacy, "1");
      const at = "2026-10-20T10:00:00.000Z";
      const value = (text: string) => ({ value: text, updatedAt: at, source: "extracted" });
      window.localStorage.setItem(
        key,
        JSON.stringify({
          version: 1,
          profiles: [
            { id: "cp-wide-1", name: "Pérez Soto, María de los Ángeles Fernanda", updatedAt: at, values: { insuredName1: value("Maria Perez Soto"), phone: value("(555) 010-0001"), address: value("Calle Falsa 123, Ciudad Demo, Provincia Imaginaria") } },
          ],
        }),
      );
      window.sessionStorage.setItem("__seeded", "1");
    },
    [cell.theme, cell.language, WIDE_CSS, PRIVACY_SEEN_KEY, KEY],
  );
  return context;
}

async function expectWideFontActive(page: Page, language: Language): Promise<void> {
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
}

type Offender = { tag: string; cls: string; text: string; left: number; right: number; width: number };
type Measure = { overflow: number; clientWidth: number; offenders: Offender[] };

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

/** Mide hasta que se asienta (la hoja entra con un muelle): falla si tras 3,5 s sigue desbordando. */
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
      throw new Error(`«${label}» desborda a ${last?.clientWidth} px (scrollWidth - clientWidth = ${last?.overflow}); elementos fuera: ${JSON.stringify(last?.offenders)}\n${String(error)}`);
    });
}

/** La pantalla en curso a 375 y a 320 px (y vuelve a escritorio). */
async function fitsEverywhere(page: Page, label: string): Promise<void> {
  try {
    for (const width of PHONE_WIDTHS) {
      await page.setViewportSize({ width, height: PHONE_HEIGHT });
      await expectFits(page, `${label} · ${width}px`);
    }
  } finally {
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(150);
  }
}

for (const cell of CELLS) {
  test(`${cell.theme} · ${cell.language} · ${cell.touch ? "tactil" : "raton"}: la hoja del autorrelleno cabe en 375 y 320 px con tipografia ancha`, async ({ browser }) => {
    test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
    const es = cell.language === "es";
    const context = await newWideContext(browser, cell);
    const page = await context.newPage();
    try {
      await installAutofillFakes(page, {
        delayMs: 0,
        ocr: { available: false, prepare: "ok" },
        byName: {
          "poliza.pdf": [...POLICY_SPECS, { key: "phone", value: OTHER_CLIENT.phone, page: 2, snippet: `Tel. ${OTHER_CLIENT.phone}` }, { key: "address", value: CLIENT.address, tier: "review", confidence: 0.5 }],
          "licencia-de-conducir-con-un-nombre-de-archivo-muy-largo-para-probar-el-corte.jpg": [{ key: "email", value: "maria.perez@ejemplo.test", tier: "review", confidence: 0.5 }],
        },
        warnings: { "licencia-de-conducir-con-un-nombre-de-archivo-muy-largo-para-probar-el-corte.jpg": ["ocr-unavailable", "page-skipped"] },
      });
      await openSignWith(page, "reclamo.pdf", await makeClaimForm());
      await expectWideFontActive(page, cell.language);
      await textFieldBox(page, "Insured").click();
      const typed = page.locator("input[data-canvas-input]");
      await typed.fill("Escrito a mano con un texto bastante largo para ver como se corta");
      await typed.press("Enter");

      // El boton y su nota, en la propia pagina.
      await fitsEverywhere(page, "boton en el paso Documento");

      const dialog = await openAutofill(page, cell.language);
      await fitsEverywhere(page, "elegir fuentes");

      await addFileSource(page, "poliza.pdf", await makePolicyPdf());
      await addFileSource(page, "licencia-de-conducir-con-un-nombre-de-archivo-muy-largo-para-probar-el-corte.jpg", tinyJpeg(), "image/jpeg", "camera");
      await dialog.locator('[data-autofill-input="file"]').setInputFiles({ name: "notas-de-la-reunion-con-el-cliente.docx", mimeType: "application/octet-stream", buffer: Buffer.from("x") });
      await dialog.getByRole("button", { name: es ? "Pegar texto" : "Paste text" }).click();
      await dialog.getByLabel(es ? "Texto con los datos del cliente" : "Text with the client's data").fill("Insured: texto de prueba");
      await fitsEverywhere(page, "fuentes elegidas y texto a pegar");
      await dialog.getByRole("button", { name: es ? "Añadir texto" : "Add text" }).click();

      // La foto necesita el modelo de lectura: el paso del modelo tambien cabe.
      await dialog.getByRole("button", { name: es ? "Leer datos" : "Read data" }).click();
      await expect(dialog.locator("[data-autofill-model]")).toBeVisible();
      await fitsEverywhere(page, "modelo de lectura");
      await dialog.locator("[data-autofill-model-download]").click();
      await expect(dialog.locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
      await expect(dialog.locator("[data-autofill-warnings] li")).toHaveCount(2);
      await fitsEverywhere(page, "revisar (conflicto, pisado y avisos)");

      await dialog.getByRole("checkbox", { name: es ? "Guardar como perfil" : "Save as profile" }).check({ force: true });
      await dialog.getByLabel(es ? "Nombre del perfil" : "Profile name").fill("Pérez Soto, María de los Ángeles Fernanda de la Cruz");
      await fitsEverywhere(page, "guardar como perfil con un nombre largo");

      await dialog.getByRole("button", { name: es ? "Volver" : "Back", exact: true }).click();
      await dialog.getByRole("button", { name: es ? /^Usar un perfil guardado/ : /^Use a saved profile/ }).click();
      await expect(dialog.locator("[data-autofill-profiles]")).toBeVisible();
      await fitsEverywhere(page, "lista de perfiles");
      await dialog.locator("[data-autofill-profile]").getByRole("button", { name: /^(Editar|Edit) /, includeHidden: false }).first().click();
      await expect(dialog.locator("[data-autofill-profile-editor]")).toBeVisible();
      await fitsEverywhere(page, "editor de perfil");
    } finally {
      await context.close();
    }
  });
}
