import { expect, test } from "@playwright/test";
import path from "node:path";

const BEFORE = path.join(__dirname, "..", "fixtures", "compare-before.pdf");
const AFTER = path.join(__dirname, "..", "fixtures", "compare-after.pdf");

test.describe("compare-pdf", () => {
  test("marca exactamente las paginas cambiadas y el texto añadido/eliminado por pagina", async ({ page }) => {
    await page.goto("/compare-pdf");

    // Orden importante: subir al hueco B primero. En cuanto un hueco recibe
    // archivo, su <input> se desmonta (pasa a la tarjeta "archivo
    // seleccionado"), asi que el indice del OTRO hueco cambia. Subiendo B
    // (indice 1) antes que A, el indice de A (0) nunca se mueve.
    const inputs = page.locator('input[type="file"]');
    await inputs.nth(1).setInputFiles(AFTER);
    await inputs.nth(0).setInputFiles(BEFORE);

    await page.getByRole("button", { name: /comparar|compare/i }).click();

    // Texto EXACTO del contador de paginas cambiadas (strings.ts:
    // changedPages(2) -> "2 páginas con diferencias" / "2 pages with
    // differences") -- no una coincidencia parcial de "2" en cualquier
    // parte de la pantalla, que podria dar un falso positivo con
    // cualquier otro "2" visible (el saldo "250", la paginacion, etc).
    await expect(
      page.getByText(/^(2 páginas con diferencias|2 pages with differences)$/i),
    ).toBeVisible({ timeout: 15_000 });

    // Pagina 1: "saldo 100 EUR" -> "saldo 250 EUR" es una sustitucion de
    // una sola palabra. La seccion de la pagina 1 debe mostrar
    // exactamente 1 eliminada y 1 agregada.
    const page1Section = page.locator("section", {
      has: page.getByRole("heading", { name: /página\s*1|page\s*1/i }),
    });
    await expect(page1Section.getByText("+1", { exact: true })).toBeVisible();
    await expect(page1Section.getByText("-1", { exact: true })).toBeVisible();
    // El propio valor viejo/nuevo debe aparecer en el contraste de esa pagina.
    await expect(page1Section.getByText("100")).toBeVisible();
    await expect(page1Section.getByText("250")).toBeVisible();

    // Pagina 2: se agregaron 4 palabras nuevas ("linea nueva agregada
    // despues"), ninguna eliminada.
    const page2Section = page.locator("section", {
      has: page.getByRole("heading", { name: /página\s*2|page\s*2/i }),
    });
    await expect(page2Section.getByText("+4", { exact: true })).toBeVisible();
    await expect(page2Section.getByText(/^-\d+$/)).toHaveCount(0);
  });
});
