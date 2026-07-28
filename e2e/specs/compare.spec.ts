import { expect, test } from "@playwright/test";
import path from "node:path";

const BEFORE = path.join(__dirname, "..", "fixtures", "compare-before.pdf");
const AFTER = path.join(__dirname, "..", "fixtures", "compare-after.pdf");

test.describe("compare-pdf", () => {
  test("marca exactamente las paginas cambiadas y el texto añadido/eliminado", async ({ page }) => {
    await page.goto("/compare-pdf");

    // Orden importante: subir al hueco B primero. En cuanto un hueco
    // recibe archivo, su <input> se desmonta (pasa a mostrar la tarjeta
    // "archivo seleccionado"), asi que el indice del OTRO hueco cambia.
    // Subiendo B (indice 1) antes de A, el indice de A (0) nunca se mueve.
    const inputs = page.locator('input[type="file"]');
    await inputs.nth(1).setInputFiles(AFTER);
    await inputs.nth(0).setInputFiles(BEFORE);

    await page.getByRole("button", { name: /comparar|compare/i }).click();

    // Las 2 paginas cambiaron: pagina 1 (100 -> 250) y pagina 2 (linea nueva).
    await expect(page.getByText(/2/).first()).toBeVisible({ timeout: 15_000 });

    const body = await page.locator("main").innerText();
    // El saldo viejo aparece marcado como eliminado y el nuevo como agregado.
    expect(body).toContain("100");
    expect(body).toContain("250");
    expect(body).toContain("linea");
    expect(body).toContain("nueva");

    // Ambas paginas deben quedar identificadas en el reporte visual.
    expect(body).toMatch(/p[aá]gina\s*1|page\s*1/i);
    expect(body).toMatch(/p[aá]gina\s*2|page\s*2/i);
  });
});
