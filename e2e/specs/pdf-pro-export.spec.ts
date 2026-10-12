import JSZip from "jszip";
import { PDFDocument } from "@cantoo/pdf-lib";
import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { downloadFile } from "../helpers/downloads";
import { requiresPassword } from "../helpers/pdf-inspection";
import { isEncrypted } from "../helpers/pdf-structure";
import { closeSheetIfOpen, goToTab, noHorizontalOverflow, openProPdf, openSaveMenu, S, watchUploads } from "../helpers/pro-flow";
import { PROTECT_STRINGS } from "../../src/app/protect-pdf/strings";

/**
 * PDF Pro · guardar y exportar (Wave 7 · U8), navegador real y headless en 1280×800 y 375×812 tactil:
 * «Descargar PDF» (nombre, Ctrl+S, dirty limpio), «Guardar como…», «Guardar con contraseña…» (sin tocar el
 * historial) y «Exportar como…» a texto, imagenes (JPG/PNG, rango, ZIP), Word, Markdown y JSON. Sin errores de
 * consola, sin desbordes y sin ninguna peticion que suba contenido.
 */

test.setTimeout(45_000);

const E = S.export;

const projects: Array<{ name: string; viewport: { width: number; height: number }; touch: boolean }> = [
  { name: "escritorio 1280×800", viewport: { width: 1280, height: 800 }, touch: false },
  { name: "movil 375×812 tactil", viewport: { width: 375, height: 812 }, touch: true },
];

async function rotateOnce(page: Page): Promise<void> {
  await goToTab(page, "home");
  await page.getByRole("button", { name: S.operations.rotateAll90, exact: true }).click();
  await expect(page.getByText(S.suite.unsaved).first()).toBeVisible();
  await closeSheetIfOpen(page);
}

/** Pasos del historial (esta en Inicio; en movil, dentro de la hoja del panel, que se cierra despues). */
async function historyCount(page: Page): Promise<number> {
  await goToTab(page, "home");
  const count = await page.getByRole("list", { name: S.suite.historyTitle }).getByRole("listitem").count();
  await closeSheetIfOpen(page);
  return count;
}

async function exportCard(page: Page, id: string) {
  await closeSheetIfOpen(page);
  await goToTab(page, "convert");
  const card = page.locator(`[data-export="${id}"]`);
  await expect(card).toBeVisible();
  await card.scrollIntoViewIfNeeded();
  return card;
}

for (const project of projects) {
  test.describe(project.name, () => {
    test.use({ locale: "es-ES", viewport: project.viewport, hasTouch: project.touch, isMobile: project.touch });

    test("Descargar PDF: nombre con -pro, dirty limpio y sin subir nada", async ({ page }) => {
      const uploads = watchUploads(page);
      await openProPdf(page, { name: "informe.pdf" });
      await rotateOnce(page);
      const file = await downloadFile(page, async () => {
        await page.getByRole("button", { name: S.suite.download }).click();
      });
      expect(file.filename).toBe("informe-pro.pdf");
      expect((await PDFDocument.load(file.bytes)).getPageCount()).toBe(3);
      await expect(page.getByText(S.suite.saved).first()).toBeVisible();
      await expect(page.getByRole("status")).toHaveText(S.save.downloaded("informe-pro.pdf"));
      await noHorizontalOverflow(page);
      expect(uploads.requests).toEqual([]);
    });

    test("Ctrl+S descarga y Ctrl+Mayus+S abre el menu Guardar y exportar", async ({ page }) => {
      test.skip(project.touch, "atajos de teclado: solo escritorio");
      await openProPdf(page);
      await rotateOnce(page);
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      const file = await downloadFile(page, async () => {
        await page.keyboard.press("Control+s");
      });
      expect(file.filename).toBe("informe-pro.pdf");
      await page.keyboard.press("Control+Shift+s");
      const menu = page.getByRole("menu", { name: S.save.menuLabel });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveCount(4);
      await expect(menu.getByRole("menuitem").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
      await expect(page.getByRole("button", { name: S.save.menuLabel })).toBeFocused();
    });

    test("Guardar como…: el nombre elegido se usa tal cual y queda en el documento", async ({ page }) => {
      await openProPdf(page, { name: "informe.pdf" });
      const menu = await openSaveMenu(page);
      await menu.getByRole("menuitem", { name: S.save.saveAs }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(S.save.nameLabel).fill("Contrato final");
      const file = await downloadFile(page, async () => {
        await dialog.getByRole("button", { name: S.save.saveAsButton }).click();
      });
      expect(file.filename).toBe("Contrato final.pdf");
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Contrato final.pdf");
      await expect(dialog).toBeHidden();
      const again = await downloadFile(page, async () => {
        await page.getByRole("button", { name: S.suite.download }).click();
      });
      expect(again.filename).toBe("Contrato final.pdf");
    });

    test("Guardar con contraseña…: descarga cifrado y NO toca el historial", async ({ page }) => {
      await openProPdf(page);
      await rotateOnce(page);
      const before = await historyCount(page);
      const menu = await openSaveMenu(page);
      await menu.getByRole("menuitem", { name: S.save.saveWithPassword }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByLabel(PROTECT_STRINGS.es.passwordLabel, { exact: true }).fill("secreto1");
      await dialog.getByLabel(PROTECT_STRINGS.es.confirmLabel, { exact: true }).fill("secreto1");
      const file = await downloadFile(page, async () => {
        await dialog.getByRole("button", { name: S.docTools.protect.saveButton, exact: true }).click();
      });
      expect(file.filename).toBe("informe-protegido.pdf");
      expect(await isEncrypted(file.bytes)).toBe(true);
      expect(await requiresPassword(file.bytes)).toBe(true);
      await dialog.waitFor({ state: "hidden" }).catch(() => undefined);
      if (await dialog.isVisible()) await page.keyboard.press("Escape");
      expect(await historyCount(page)).toBe(before);
    });

    test("Exportar como…: texto, Markdown y JSON salen con el contenido del documento", async ({ page }) => {
      const uploads = watchUploads(page);
      await openProPdf(page, { name: "acta.pdf", label: "ACTA" });
      const text = await (async () => {
        const card = await exportCard(page, "text");
        const file = await downloadFile(page, async () => {
          await card.getByRole("button", { name: E.formats.text.title }).click();
        });
        expect(file.filename).toBe("acta-texto.txt");
        return file.bytes.toString("utf8");
      })();
      expect(text).toContain("ACTA-1");
      expect(text).toContain("ACTA-3");

      const md = await exportCard(page, "markdown");
      const mdFile = await downloadFile(page, async () => {
        await md.getByRole("button", { name: E.formats.markdown.title }).click();
      });
      expect(mdFile.filename).toBe("acta-markdown.md");
      expect(mdFile.bytes.toString("utf8")).toContain("ACTA-2");

      const json = await exportCard(page, "json");
      const jsonFile = await downloadFile(page, async () => {
        await json.getByRole("button", { name: E.formats.json.title }).click();
      });
      expect(jsonFile.filename).toBe("acta-json.json");
      expect(JSON.parse(jsonFile.bytes.toString("utf8"))).toBeTruthy();
      // Exportar no cambia el estado «guardado» ni el historial.
      await expect(page.getByText(S.suite.saved).first()).toBeVisible();
      expect(uploads.requests).toEqual([]);
    });

    test("Exportar a Word genera un .docx valido con el texto", async ({ page }) => {
      await openProPdf(page, { name: "acta.pdf", label: "ACTA" });
      const card = await exportCard(page, "word");
      const file = await downloadFile(page, async () => {
        await card.getByRole("button", { name: E.formats.word.title }).click();
      });
      expect(file.filename).toBe("acta-word.docx");
      const zip = await JSZip.loadAsync(file.bytes);
      const xml = await zip.file("word/document.xml")!.async("string");
      expect(xml).toContain("ACTA-1");
    });

    test("Exportar a imagenes: ZIP con un rango, PNG y nombres unicos", async ({ page }) => {
      await openProPdf(page, { name: "acta.pdf", label: "ACTA", pages: 5 });
      const card = await exportCard(page, "images");
      await card.getByRole("button", { name: E.card.showOptions }).click();
      await card.getByRole("tab", { name: E.images.png }).click();
      await card.getByRole("tab", { name: E.images.scopeRange }).click();
      await card.getByLabel(E.images.rangeLabel).fill("2-4");
      const file = await downloadFile(page, async () => {
        await card.getByRole("button", { name: E.formats.images.title }).click();
      });
      expect(file.filename).toBe("acta-images.zip".replace("images", "imagenes"));
      const zip = await JSZip.loadAsync(file.bytes);
      expect(Object.keys(zip.files).sort()).toEqual(["pagina-2.png", "pagina-3.png", "pagina-4.png"]);
      const head = await zip.file("pagina-2.png")!.async("uint8array");
      expect([...head.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    });

    test("un rango invalido se explica y el boton no exporta", async ({ page }) => {
      await openProPdf(page, { name: "acta.pdf", pages: 3 });
      const card = await exportCard(page, "images");
      await card.getByRole("button", { name: E.card.showOptions }).click();
      await card.getByRole("tab", { name: E.images.scopeRange }).click();
      await card.getByLabel(E.images.rangeLabel).fill("7-9");
      await expect(card.locator("[data-export-problem]")).toContainText(E.images.rangeInvalid(3));
      await expect(card.getByRole("button", { name: E.formats.images.title })).toHaveAttribute("aria-disabled", "true");
        });
  });
}

