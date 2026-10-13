import { expect, test } from "@playwright/test";

/**
 * Tras F2 (Wave 8) el texto original se quita al exportar: Ajustes ya no ofrece el interruptor
 * «Limpiar el contenido original (proximamente)» y la unica opcion del grupo dice la verdad.
 * Chromium headless.
 */
test.describe("Ajustes · editor de PDF tras F2", () => {
  for (const [lang, title, label, removed, gone] of [
    ["es", "Editor de PDF: funciones nuevas", "Editar el texto que ya trae el PDF", /al exportar, el texto original se elimina del archivo/, /Limpiar el contenido original|pr[oó]ximamente|puede seguir existiendo/i],
    ["en", "PDF editor: new features", "Edit the text already in the PDF", /on export, the original text is removed from the file/, /Clean the original content|coming soon|may still exist/i],
  ] as const) {
    test(`${lang}: un unico interruptor y sin textos obsoletos`, async ({ page }) => {
      await page.addInitScript((l) => window.localStorage.setItem("optimuspdf.language", l), lang);
      await page.goto("/settings");
      await expect(page.getByRole("heading", { name: title })).toBeVisible();
      const card = page.getByRole("heading", { name: title }).locator("xpath=..");
      await expect(card.getByRole("checkbox")).toHaveCount(1);
      await expect(card.getByRole("checkbox", { name: label })).toBeChecked();
      await expect(card.getByRole("checkbox", { name: label })).toBeEnabled();
      await expect(card).toContainText(removed);
      await expect(card).not.toContainText(gone);
    });
  }

  test("un stripOriginalText guardado por una version anterior no rompe Ajustes y se descarta al cambiar", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem("optimuspdf.language", "es");
      if (window.localStorage.getItem("optimuspdf.editPdf.featureFlags") === null) {
        window.localStorage.setItem(
          "optimuspdf.editPdf.featureFlags",
          JSON.stringify({ editExistingText: true, stripOriginalText: true }),
        );
      }
    });
    await page.goto("/settings");
    const toggle = page.getByRole("checkbox", { name: "Editar el texto que ya trae el PDF" });
    await expect(toggle).toBeChecked();
    await page.getByText("Editar el texto que ya trae el PDF", { exact: true }).click();
    await expect(toggle).not.toBeChecked();
    const stored = await page.evaluate(() => window.localStorage.getItem("optimuspdf.editPdf.featureFlags"));
    expect(JSON.parse(stored!)).toEqual({ editExistingText: false });
  });
});
