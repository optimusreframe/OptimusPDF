import { PDFDocument } from "@cantoo/pdf-lib";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { makePdf } from "../helpers/test-files";
import { es } from "../../src/lib/locales/es";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";
import { activate, tabKey } from "../helpers/engine";

/**
 * PDF Pro · fundamentos (Wave 7 · U1+U2), navegador real y headless: Home destacada, abrir un PDF por
 * arrastre, traspaso desde otra herramienta SIN subir nada, «Rotar 90°» = un snapshot deshacible con
 * Ctrl+Z, borrador que sobrevive a una recarga, «Borrar datos» que lo vacia, y que ni la consola ni
 * el ancho de la pagina se descontrolen en 1280×800 y 375×812.
 */

const S = PRO_STRINGS.es;
test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(60_000);

const ROTATE = S.operations.rotateAll90;

async function dropPdf(page: Page, bytes: Buffer, name: string): Promise<void> {
  // El titulo de la zona cambia mientras se arrastra («Suelta para añadir»): se ancla por su boton, que no cambia.
  const zone: Locator = page.locator("div.surface-card", { has: page.getByRole("button", { name: es.tool.dropButton }) });
  const transfer = await page.evaluateHandle(
    ({ base64, fileName }) => {
      const data = new DataTransfer();
      const binary = atob(base64);
      const array = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      data.items.add(new File([array], fileName, { type: "application/pdf" }));
      return data;
    },
    { base64: bytes.toString("base64"), fileName: name },
  );
  await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await zone.dispatchEvent("drop", { dataTransfer: transfer });
}

async function openProPdf(page: Page, name = "informe.pdf", pages = 3): Promise<Buffer> {
  const bytes = await makePdf({ pages, label: "PRO" });
  await page.goto("/pdf-pro");
  await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
  await dropPdf(page, bytes, name);
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(name.replace(".", "\\.")) })).toBeVisible();
  return bytes;
}

const historyItems = (page: Page) => page.getByRole("list", { name: S.suite.historyTitle }).getByRole("listitem");

async function rotationsOf(bytes: Buffer): Promise<number[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getRotation().angle);
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const [scrollWidth, clientWidth] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scrollWidth, "sin desborde horizontal").toBeLessThanOrEqual(clientWidth);
}

test.describe("Home", () => {
  test("PDF Pro es la primera herramienta y va destacada (tarjeta grande con descripcion)", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("[data-featured-tool='pdf-pro']");
    await expect(card).toBeVisible();
    await expect(card).toContainText("PDF Pro");
    await expect(card).toContainText(es.tools["pdf-pro"].description);
    await expect(card).toHaveAttribute("href", "/pdf-pro");

    // Grande: ocupa todo el ancho del contenido y es mas alta que una tarjeta normal.
    const cardBox = (await card.boundingBox())!;
    const normalBox = (await page.getByRole("link", { name: /^Unir PDF/ }).first().boundingBox())!;
    expect(cardBox.width).toBeGreaterThan(normalBox.width * 2.5);

    // Primera: antes que cualquier otra tarjeta de herramienta y antes del catalogo por categorias.
    const organize = (await page.locator("#organize").boundingBox())!;
    expect(cardBox.y + cardBox.height).toBeLessThan(organize.y);
    // Y tercer item de la barra lateral, tras «Inicio» y «Recientes» (plan OptimusTOOLS).
    const navLinks = page.getByRole("navigation", { name: es.nav.primaryNav }).getByRole("link");
    await expect(navLinks.nth(0)).toHaveAttribute("href", "/");
    await expect(navLinks.nth(1)).toHaveAttribute("href", "/recent");
    await expect(navLinks.nth(2)).toHaveAttribute("href", "/pdf-pro");
    await noHorizontalOverflow(page);
  });

  test("la tarjeta lleva a /pdf-pro", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-featured-tool='pdf-pro']").click();
    await expect(page).toHaveURL(/\/pdf-pro$/);
    await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
  });
});

test.describe("PDF Pro — abrir un PDF", () => {
  test("por arrastre: abre la suite, el foco queda en el titulo y hay una sola region viva", async ({ page }) => {
    await openProPdf(page, "contrato.pdf", 3);
    await expect(page.getByRole("tab")).toHaveCount(7);
    await expect(page.getByRole("tablist")).toBeVisible();
    await expect(page.getByText("3 páginas").first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.getByRole("status")).toHaveCount(1);
    await expect(page.getByRole("status")).toHaveText(S.announce.opened("contrato.pdf"));
    // Sin pie ni barra movil: la suite ocupa toda la altura.
    await expect(page.locator("footer")).toBeHidden();
    const [scrollHeight, innerHeight] = await page.evaluate(() => [document.documentElement.scrollHeight, window.innerHeight]);
    expect(scrollHeight).toBeLessThanOrEqual(innerHeight + 1);
  });

  test("un archivo que no es PDF se explica y no abre la suite", async ({ page }) => {
    await page.goto("/pdf-pro");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "falso.pdf", mimeType: "application/pdf", buffer: Buffer.from("esto no es un pdf") });
    await expect(page.getByText(es.tool.errors.notPdf)).toBeVisible();
    await expect(page.getByRole("tablist")).toHaveCount(0);
    await expect(page.locator("[data-error-banner]")).toBeFocused();
  });

  test("recorrido con Tab desde el documento recien abierto: el foco nunca cae a <body> salvo tras el ultimo control", async ({ page }) => {
    await openProPdf(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    const trail: Array<{ name: string; body: boolean; last: boolean }> = [];
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press(tabKey(page));
      trail.push(
        await page.evaluate(() => {
          const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
          const tabbable = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((el) => {
            if (el.tabIndex < 0) return false;
            if ((el as HTMLButtonElement).disabled || el.closest("[inert]")) return false;
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.visibility !== "hidden" && cs.display !== "none" && (r.width > 0 || r.height > 0 || el.matches(".sr-only"));
          });
          const active = document.activeElement as HTMLElement | null;
          const body = !active || active === document.body || active === document.documentElement;
          return {
            name: body ? "<body>" : `${active!.tagName.toLowerCase()} ${(active!.getAttribute("aria-label") ?? active!.textContent ?? "").trim().slice(0, 28)}`,
            body,
            last: !!active && active === tabbable[tabbable.length - 1],
          };
        }),
      );
    }
    const lost = trail.flatMap((step, i) => (step.body && !(i > 0 && trail[i - 1].last) ? [`#${i + 1} tras «${trail[i - 1]?.name ?? "inicio"}»`] : []));
    expect(lost, `foco perdido en <body>:\n${lost.join("\n")}`).toEqual([]);
    // El primer control tras el titulo es la barra del documento; la suite es alcanzable entera con teclado.
    expect(trail.map((step) => step.name).join("|")).toContain(`button ${S.suite.undo}`);
    expect(trail.map((step) => step.name).join("|")).toContain("button Inicio");
  });

  test("las pestañas se manejan con teclado", async ({ page }) => {
    await openProPdf(page);
    const home = page.getByRole("tab", { name: "Inicio" });
    await home.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Páginas" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Páginas" })).toBeFocused();
    // «Páginas» ya no es un marcador: es el organizador de paginas (W7-U4).
    await expect(page.getByRole("tabpanel").getByRole("region", { name: S.pages.panelTitle })).toBeVisible();
  });
});

test.describe("PDF Pro — traspaso desde otras herramientas", () => {
  test("«Abrir en PDF Pro» en /merge-pdf conserva el archivo y NO lo sube", async ({ page }) => {
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "GET" || request.postData()) posts.push(`${request.method()} ${request.url()}`);
    });
    const bytes = await makePdf({ pages: 2, label: "UNIR" });
    await page.goto("/merge-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "desde-unir.pdf", mimeType: "application/pdf", buffer: bytes });
    await page.getByRole("link", { name: es.tool.openInPro }).click();
    await expect(page).toHaveURL(/\/pdf-pro$/);
    await expect(page.getByRole("heading", { level: 1, name: /desde-unir\.pdf/ })).toBeVisible();
    await expect(page.getByText("2 páginas").first()).toBeVisible();
    await expect(page.getByText(S.suite.openedFrom(es.tools["merge-pdf"].name))).toBeVisible();
    // Navegacion de cliente: el archivo viajo por memoria. Nada de POST ni cuerpos de peticion.
    expect(posts).toEqual([]);
    // Al recargar, el traspaso ya no existe: estado vacio (no se reabre un archivo viejo).
    await page.reload();
    await expect(page.getByRole("heading", { name: es.tool.dropTitle })).toBeVisible();
  });

  test("«Seguir en PDF Pro» tras procesar abre el PDF RESULTADO", async ({ page }) => {
    const bytes = await makePdf({ pages: 2, label: "ROT" });
    await page.goto("/rotate-pdf");
    await page.locator('input[type="file"]').first().setInputFiles({ name: "giro.pdf", mimeType: "application/pdf", buffer: bytes });
    await page.getByRole("button", { name: es.tool.run, exact: true }).click();
    await expect(page.getByRole("button", { name: es.tool.download, exact: true })).toBeFocused();
    await page.getByRole("link", { name: es.tool.continueInPro }).click();
    await expect(page).toHaveURL(/\/pdf-pro$/);
    await expect(page.getByRole("heading", { level: 1, name: /giro-rotado\.pdf/ })).toBeVisible();
  });
});

test.describe("PDF Pro — documento de trabajo", () => {
  test("«Rotar 90°» crea un snapshot, se descarga girado y Ctrl+Z lo deshace", async ({ page }) => {
    await openProPdf(page, "informe.pdf", 3);
    await expect(historyItems(page)).toHaveCount(1);
    await page.getByRole("button", { name: ROTATE, exact: true }).click();
    await expect(historyItems(page)).toHaveCount(2);
    await expect(page.getByText(S.suite.unsaved)).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(S.announce.applied(ROTATE));

    const rotated = await downloadFile(page, async () => {
      await page.getByRole("button", { name: S.suite.download }).click();
    });
    expect(rotated.filename).toBe("informe-pro.pdf");
    expect(await rotationsOf(rotated.bytes)).toEqual([90, 90, 90]);
    await expect(page.getByText(S.suite.saved)).toBeVisible();

    // Ctrl+Z (con el foco fuera de un campo de texto) deshace: vuelve «Original».
    await page.keyboard.press("Control+z");
    await expect(page.getByRole("button", { name: `Original (${S.suite.historyCurrent})` })).toHaveAttribute("aria-current", "step");
    await expect(page.getByRole("status")).toHaveText(S.announce.undone(ROTATE));
    await page.keyboard.press("Control+Shift+z");
    await expect(page.getByRole("button", { name: `${ROTATE} (${S.suite.historyCurrent})` })).toHaveAttribute("aria-current", "step");
    await page.keyboard.press("Control+z");

    const original = await downloadFile(page, async () => {
      await page.getByRole("button", { name: S.suite.download }).click();
    });
    expect(original.filename).toBe("informe-pro.pdf");
    expect(await rotationsOf(original.bytes)).toEqual([0, 0, 0]);
    await expect(page.getByRole("status")).toHaveCount(1);
  });

  test("el foco no cae a <body> al deshacer con el boton ni al aplicar", async ({ page }) => {
    await openProPdf(page);
    const rotate = page.getByRole("button", { name: ROTATE, exact: true });
    await rotate.focus();
    await activate(rotate);
    await expect(historyItems(page)).toHaveCount(2);
    await expect(rotate).toBeFocused();
    const undo = page.getByRole("button", { name: S.suite.undo });
    await undo.focus();
    await activate(undo);
    await expect(undo).toBeFocused();
    // Ya sin nada que deshacer: el boton es aria-disabled (Playwright no hace clic en uno asi), el foco se queda.
    await page.keyboard.press("Enter");
    await expect(undo).toBeFocused();
    await expect(undo).toHaveAttribute("aria-disabled", "true");
  });

  test("cerrar con cambios pide confirmar y devuelve el foco a la zona de carga", async ({ page }) => {
    await openProPdf(page);
    await activate(page.getByRole("button", { name: ROTATE, exact: true }));
    await expect(historyItems(page)).toHaveCount(2);
    await activate(page.getByRole("button", { name: S.suite.close }));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await activate(dialog.getByRole("button", { name: S.suite.close }));
    await expect(page.getByRole("heading", { name: es.tool.dropTitle })).toBeVisible();
    // (El selector oculto comparte nombre con el boton: se ancla al <button>.)
    await expect(page.locator("button", { hasText: es.tool.dropButton })).toBeFocused();
  });
});

test.describe("PDF Pro — borradores", () => {
  test("recargar y restaurar: el borrador sobrevive, se retoma desde «Documentos recientes» y «Borrar datos» lo vacia", async ({ page }) => {
    await openProPdf(page, "borrador.pdf", 2);
    await page.getByRole("button", { name: ROTATE, exact: true }).click();
    await expect(historyItems(page)).toHaveCount(2);

    // El autoguardado (calma de 600 ms) escribe en IndexedDB; se espera a verlo en la base real.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<number>((resolve) => {
                const open = indexedDB.open("optimuspdf-pro-drafts");
                open.onerror = () => resolve(-1);
                open.onsuccess = () => {
                  const db = open.result;
                  if (!db.objectStoreNames.contains("draftMeta")) {
                    db.close();
                    resolve(0);
                    return;
                  }
                  const count = db.transaction("draftMeta").objectStore("draftMeta").count();
                  count.onsuccess = () => {
                    db.close();
                    resolve(count.result);
                  };
                };
              }),
          ),
        { timeout: 15_000 },
      )
      .toBe(1);

    await page.reload();
    await expect(page.getByRole("heading", { name: es.tool.dropTitle })).toBeVisible();
    const recent = page.getByRole("button", { name: S.empty.recentOpen("borrador.pdf") });
    await expect(recent).toBeVisible();
    await expect(recent).toContainText("1 cambio");
    await recent.click();
    await expect(page.getByRole("heading", { level: 1, name: /borrador\.pdf/ })).toBeVisible();
    await expect(page.getByText(S.suite.unsaved)).toBeVisible();
    await expect(page.getByText(S.suite.historyRestoredBody)).toBeVisible();
    const restored = await downloadFile(page, async () => {
      await page.getByRole("button", { name: S.suite.download }).click();
    });
    expect(await rotationsOf(restored.bytes)).toEqual([90, 90]);

    // «Borrar datos locales» de Ajustes lo vacia.
    await page.goto("/settings");
    await page.getByRole("button", { name: es.settings.clearData }).click();
    await expect(page.getByText(es.settings.cleared)).toBeVisible();
    await page.goto("/pdf-pro");
    await expect(page.getByText(S.empty.recentEmpty)).toBeVisible();
    await expect(page.getByRole("button", { name: S.empty.recentOpen("borrador.pdf") })).toHaveCount(0);
  });

  test("recargar justo despues de aplicar (sin esperar al autoguardado): el volcado de beforeunload lo conserva", async ({ page }) => {
    await openProPdf(page, "prisa.pdf", 2);
    await page.getByRole("button", { name: ROTATE, exact: true }).click();
    await expect(historyItems(page)).toHaveCount(2);
    await page.reload();
    await expect(page.getByRole("button", { name: S.empty.recentOpen("prisa.pdf") })).toBeVisible({ timeout: 10_000 });
  });

  test("reabrir el mismo PDF ofrece retomar el borrador", async ({ page }) => {
    const bytes = await openProPdf(page, "oferta.pdf", 2);
    await page.getByRole("button", { name: ROTATE, exact: true }).click();
    await expect(historyItems(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: S.suite.undo })).not.toHaveAttribute("aria-disabled", "true");
    await page.waitForTimeout(1500);
    await page.reload();
    await dropPdf(page, bytes, "oferta.pdf");
    const offer = page.getByRole("group", { name: S.drafts.foundTitle });
    await expect(offer).toBeVisible();
    await offer.getByRole("button", { name: S.drafts.restore }).click();
    await expect(page.getByText(S.suite.unsaved)).toBeVisible();
    await expect(offer).toHaveCount(0);
  });
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`sin desbordes ni errores de consola a ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("Home, estado vacio y suite", async ({ page, consoleErrors }) => {
      await page.goto("/");
      await expect(page.locator("[data-featured-tool='pdf-pro']")).toBeVisible();
      await noHorizontalOverflow(page);

      await page.goto("/pdf-pro");
      await expect(page.getByRole("heading", { level: 1, name: "PDF Pro" })).toBeVisible();
      await noHorizontalOverflow(page);

      await openProPdf(page, "responsive.pdf");
      await noHorizontalOverflow(page);
      // Los controles principales de la barra miden al menos 44 px. (W7-U3: en movil «Cerrar documento» vive en el
      // menu «Mas» y las pestañas son la barra inferior de herramientas, cuyas hojas se abren al tocarlas.)
      const mobile = viewport.width < 768;
      for (const name of mobile ? [S.suite.undo, S.suite.redo, S.shell.more] : [S.suite.undo, S.suite.redo, S.suite.close]) {
        const box = (await page.getByRole("button", { name }).boundingBox())!;
        expect(box.width, name).toBeGreaterThanOrEqual(44);
        expect(box.height, name).toBeGreaterThanOrEqual(44);
      }
      const tabs = mobile ? page.getByRole("toolbar", { name: S.shell.dockLabel }).getByRole("button") : page.getByRole("tab");
      for (const tab of await tabs.all()) {
        expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      }
      if (mobile) await page.getByRole("button", { name: S.suite.tabs.home }).click();
      await page.getByRole("button", { name: ROTATE, exact: true }).click();
      await expect(historyItems(page)).toHaveCount(2);
      await noHorizontalOverflow(page);
      expect(consoleErrors).toEqual([]);
    });

    test("Ajustes con la tarjeta de PDF Pro", async ({ page }) => {
      await page.goto("/settings");
      await expect(page.getByRole("checkbox", { name: es.settings.proFeatures.proAutosave.label })).toBeChecked();
      await noHorizontalOverflow(page);
    });
  });
}
