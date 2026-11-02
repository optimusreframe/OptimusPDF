import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { makeReceiptPdf } from "../../src/lib/pdf/testing/signSyntheticPdfs";
import { defineSigners, makeTwoDocs, openSignAndUpload, selectSignMode } from "../helpers/sign-flow";
import { axeViolations, card, collectEarly, expectNoHorizontalOverflow, expectTarget, openPanel, status } from "../helpers/early-capture";

/**
 * Firmar PDF · recoger firma e iniciales en el paso «Firmantes»: accesibilidad y pantallas estrechas. En cada celda (tema,
 * idioma, tactil/raton, 375 / 320 / 1280 px) y con la tipografia ancha forzada (DejaVu Sans + 6 % de espaciado, como
 * `sign-wide-font`): axe sin violaciones (WCAG 2.x A/AA con contraste real), objetivos de toque >= 44 px con tacto y >= 24 con raton,
 * sin scroll horizontal y el estado dicho con TEXTO. Headless siempre; PDF sintetico.
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3961 npx playwright test sign-early-capture-a11y --project=chromium --workers=1
 */
test.setTimeout(240_000);

const WIDE_CSS = `html *, html *::before, html *::after {
  font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important;
  letter-spacing: 0.06em !important;
}`;

type Cell = { name: string; width: number; height: number; scheme: "light" | "dark"; language: "es" | "en"; touch: boolean; wide: boolean };

const CELLS: Cell[] = [
  { name: "375 · claro · es · tacto · tipografia ancha", width: 375, height: 812, scheme: "light", language: "es", touch: true, wide: true },
  { name: "320 · oscuro · en · tacto · tipografia ancha", width: 320, height: 700, scheme: "dark", language: "en", touch: true, wide: true },
  { name: "375 · oscuro · es · tacto", width: 375, height: 812, scheme: "dark", language: "es", touch: true, wide: false },
  { name: "1280 · claro · en · raton", width: 1280, height: 900, scheme: "light", language: "en", touch: false, wide: false },
  { name: "1280 · oscuro · es · raton · tipografia ancha", width: 1280, height: 900, scheme: "dark", language: "es", touch: false, wide: true },
];

async function newContext(browser: Browser, cell: Cell): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    colorScheme: cell.scheme,
    hasTouch: cell.touch,
    locale: cell.language === "es" ? "es-ES" : "en-US",
  });
  await context.addInitScript(
    ([scheme, language, css, wide]) => {
      if (wide) {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(String(css));
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      try {
        window.localStorage.setItem("optimuspdf.theme", String(scheme));
        window.localStorage.setItem("optimuspdf.language", String(language));
        window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
      } catch {
        /* sin almacenamiento */
      }
    },
    [cell.scheme, cell.language, WIDE_CSS, cell.wide],
  );
  return context;
}

/** Todos los botones de la tarjeta del firmante cumplen el tamano minimo del puntero de la celda. */
async function expectCardTargets(page: Page, signerId: string, cell: Cell): Promise<void> {
  const buttons = card(page, signerId).locator("button:visible");
  const count = await buttons.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const label = (await button.getAttribute("aria-label")) ?? ((await button.textContent()) ?? "").trim();
    await button.scrollIntoViewIfNeeded();
    await expectTarget(button, `${cell.name} · «${label}»`, cell.touch ? 43.5 : 24);
  }
}

for (const cell of CELLS) {
  test(`recoger firma e iniciales · ${cell.name}: axe, objetivos, sin desborde y estado en texto`, async ({ browser }) => {
    const context = await newContext(browser, cell);
    const page = await context.newPage();
    const es = cell.language === "es";
    await page.goto("/");
    await openSignAndUpload(page, [{ name: "Recibo.pdf", mimeType: "application/pdf", buffer: Buffer.from(await makeReceiptPdf()) }]);
    await page.getByRole("tab", { name: es ? "Varios firmantes" : "Several signers" }).click();
    const add = page.getByRole("button", { name: es ? "Añadir firmante" : "Add signer" });
    await add.click();
    await add.click();
    await page.getByLabel(es ? "Nombre del firmante 1" : "Name of signer 1").fill("Ana");
    await page.getByLabel(es ? "Nombre del firmante 2" : "Name of signer 2").fill("Luis");
    const collect = card(page, "sg-1").getByRole("button", { name: es ? "Recoger firma e iniciales de Ana" : "Collect signature and initials for Ana" });
    await expect(collect).toBeEnabled({ timeout: 30_000 });
    const list = '[role="radiogroup"]';

    // 1) Sin recoger: el estado es TEXTO y la pantalla no desborda.
    await expect(status(page, "sg-1")).toHaveText(es ? "Sin recoger" : "Not collected");
    await expectNoHorizontalOverflow(page, `${cell.name} · sin recoger`);
    await expectCardTargets(page, "sg-1", cell);
    expect(await axeViolations(page, list), `${cell.name} · sin recoger`).toEqual([]);

    // 2) Panel abierto.
    await collect.click();
    const panel = card(page, "sg-1").getByRole("group", { name: es ? "Firma e iniciales de Ana" : "Signature and initials of Ana" });
    await expect(panel).toBeVisible();
    await expect(panel).toBeFocused();
    await expectNoHorizontalOverflow(page, `${cell.name} · panel abierto`);
    await expectCardTargets(page, "sg-1", cell);
    expect(await axeViolations(page, list), `${cell.name} · panel abierto`).toEqual([]);

    // 3) Recogida (solo en espanol: el compositor se maneja por sus textos): estado en texto, sin desborde, sin violaciones.
    if (es) {
      await collectEarly(page, "sg-1", "Ana", 10, { close: false });
      await expect(status(page, "sg-1")).toHaveText("Firma e iniciales recogidas");
      await expect(card(page, "sg-1").locator("[data-early-no-fields]")).toBeVisible();
      await expectNoHorizontalOverflow(page, `${cell.name} · recogida con panel`);
      await expectCardTargets(page, "sg-1", cell);
      expect(await axeViolations(page, list), `${cell.name} · recogida con panel`).toEqual([]);
      await (await openPanel(page, "sg-1", "Ana")).getByRole("button", { name: "Listo", exact: true }).click();
      await expectNoHorizontalOverflow(page, `${cell.name} · recogida`);
      expect(await axeViolations(page, list), `${cell.name} · recogida`).toEqual([]);
      // El icono no es lo unico que dice el estado: el texto esta y el icono va oculto a los lectores.
      const iconsHidden = await status(page, "sg-1").locator("svg").evaluateAll((nodes) => nodes.every((node) => node.getAttribute("aria-hidden") === "true"));
      expect(iconsHidden).toBe(true);
    }
    await context.close();
  });
}

/** Varios documentos con DOS grupos por firmante («Una firma por documento»): el panel lleva una fila por grupo y nombra cada boton. */
for (const cell of [CELLS[0], CELLS[2]]) {
  test(`recoger firma e iniciales con varios documentos · ${cell.name}: axe, objetivos y sin desborde`, async ({ browser }) => {
    const context = await newContext(browser, cell);
    const page = await context.newPage();
    await page.goto("/");
    await openSignAndUpload(page, await makeTwoDocs());
    await defineSigners(page);
    await selectSignMode(page, "independent");
    const collect = card(page, "sg-1").getByRole("button", { name: "Recoger firma e iniciales de Ana" });
    await expect(collect).toBeEnabled({ timeout: 30_000 });
    await collect.click();
    const panel = card(page, "sg-1").getByRole("group", { name: "Firma e iniciales de Ana" });
    await expect(panel.getByText(/^Firma A — para: Contrato A/)).toBeVisible();
    await expect(panel.getByText(/^Firma B — para: Anexo B/)).toBeVisible();
    await expectNoHorizontalOverflow(page, `${cell.name} · varios documentos · panel`);
    await expectCardTargets(page, "sg-1", cell);
    expect(await axeViolations(page, '[role="radiogroup"]'), `${cell.name} · varios documentos · panel`).toEqual([]);
    // A medias: un grupo recogido, el otro no. El estado lo dice con texto y el panel explica que falta.
    await collectEarly(page, "sg-1", "Ana", 10, { group: "A", close: false });
    await expect(status(page, "sg-1")).toHaveText("Recogida en parte");
    await expect(panel).toContainText("Falta algo en alguno de los grupos");
    await expectNoHorizontalOverflow(page, `${cell.name} · varios documentos · a medias`);
    // El puntero se queda sobre «Rehacer» tras dibujar: se aparta y se espera el fin de la transicion de fondo (si no, axe mide un color a medias).
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    expect(await axeViolations(page, '[role="radiogroup"]'), `${cell.name} · varios documentos · a medias`).toEqual([]);
    await context.close();
  });
}
