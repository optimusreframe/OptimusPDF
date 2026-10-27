import { test, type Page } from "@playwright/test";
import { expect, fakeControls, importPhotos, installFakeCamera, installScanFakes, pageIds, scanFiles, USE_REAL_ENGINE, waitIdle, waitVideoReady, TEST_TIMEOUT, webkitLinuxCamera, WEBKIT_LINUX_CAMERA_REASON } from "../helpers/scan-ui";

/**
 * Escaner · revisar y organizar: chips de calidad con accion de un toque, quitar blancos, orientacion automatica con aviso
 * deshacible, duplicar, repetir captura (en el mismo sitio), insertar, mover aqui, seleccion multiple, deshacer/rehacer,
 * editor (filtro, brillo/contraste, aplicar a todas, esquinas) y hoja completa.
 */
test.use({ locale: "es-ES" });
test.setTimeout(TEST_TIMEOUT);

test.beforeEach(async ({ page }) => {
  await installScanFakes(page);
  await installFakeCamera(page);
});

const tiles = (page: Page) => page.locator("[data-page-grid] [data-page-id]");

async function load(page: Page, names: string[]) {
  await page.goto("/scan-to-pdf");
  await importPhotos(page, scanFiles(names));
  await expect(tiles(page)).toHaveCount(names.length);
  await waitIdle(page);
  return pageIds(page);
}

test("chips: «En blanco» y «Quitar hojas en blanco» piden confirmacion con miniaturas; solo se quita lo marcado y se puede deshacer", async ({ page }) => {
  const ids = await load(page, ["a.jpg", "b-blank.jpg", "c.jpg", "d-blank.jpg"]);
  await expect(page.locator('[data-quality-chip="blank"]')).toHaveCount(2);
  await expect(page.locator('[data-banner="blanks"]')).toContainText("2 hojas parecen estar en blanco");
  // Un toque en el chip de la pagina 2 NO la quita: abre la confirmacion con miniaturas de lo que se quitaria.
  await page.getByRole("button", { name: "Página 2: En blanco. Revisar" }).click();
  const sheet = page.getByRole("dialog", { name: "Quitar hojas en blanco" });
  await expect(sheet).toBeVisible();
  expect(await pageIds(page)).toEqual(ids);
  await expect(sheet.locator("[data-blank-item]")).toHaveCount(2);
  await expect(sheet.locator("[data-blank-item] img")).toHaveCount(2);
  // Se desmarca la pagina 4: solo se quita la 2.
  // La casilla es el propio rotulo de la miniatura (la entrada nativa esta oculta): se pulsa la miniatura.
  await sheet.locator("[data-blank-item]").filter({ has: page.getByRole("checkbox", { name: "Página 4" }) }).click();
  await expect(sheet.getByRole("checkbox", { name: "Página 4" })).not.toBeChecked();
  await sheet.getByRole("button", { name: "Quitar 1 hoja" }).click();
  await expect.poll(() => pageIds(page)).toEqual([ids[0], ids[2], ids[3]]);
  // Aviso con «Deshacer» inmediato.
  await expect(page.locator('[data-banner="blanks-removed"]')).toContainText("Quitamos 1 hoja");
  await page.locator('[data-review-action="undo-blanks"]').click();
  await expect.poll(() => pageIds(page)).toEqual(ids);
  // «Quitar hojas en blanco (2)»: tambien con confirmacion; se quitan las dos.
  await page.getByRole("button", { name: "Quitar hojas en blanco (2)" }).click();
  await page.getByRole("dialog", { name: "Quitar hojas en blanco" }).getByRole("button", { name: "Quitar 2 hojas" }).click();
  await expect.poll(() => pageIds(page)).toEqual([ids[0], ids[2]]);
  await expect(page.locator('[data-banner="blanks"]')).toHaveCount(0);
  // Deshacer vuelve la ultima operacion; rehacer la repite.
  await page.getByRole("button", { name: "Deshacer", exact: true }).first().click();
  await expect.poll(() => pageIds(page)).toEqual(ids);
  await page.getByRole("button", { name: "Rehacer", exact: true }).click();
  await expect.poll(() => pageIds(page)).toEqual([ids[0], ids[2]]);
});

test("«Casi vacía»: el chip REVISA la hoja entera; en la confirmacion va en una lista aparte, sin marcar, y solo se quita si se marca", async ({ page }) => {
  // `flags.sparse` es del motor (aditivo): con el real depende de sus umbrales; aqui se prueba la interfaz con el doble.
  test.skip(USE_REAL_ENGINE, "solo con el motor falso: la etiqueta `sparse` la lee el doble (el motor real decide por sus umbrales)");
  const ids = await load(page, ["a.jpg", "b-sparse.jpg", "c-blank.jpg"]);
  await expect(page.locator('[data-quality-chip="sparse"]')).toHaveCount(1);
  await expect(page.locator('[data-banner="blanks"]')).toContainText("casi vacía");
  await page.getByRole("button", { name: "Página 2: Casi vacía. Revisar" }).click();
  await expect(page.locator("[data-sheet-viewer]")).toBeVisible();
  expect(await pageIds(page)).toEqual(ids);
  await page.locator('[data-sheet-action="close"]').click();
  await page.getByRole("button", { name: "Quitar hojas en blanco (1)" }).click();
  const sheet = page.getByRole("dialog", { name: "Quitar hojas en blanco" });
  await expect(sheet.locator('[data-blanks-list="blank"] [data-blank-item]')).toHaveCount(1);
  await expect(sheet.locator('[data-blanks-list="sparse"] [data-blank-item] img')).toHaveCount(1);
  await expect(sheet.locator('[data-blanks-list="sparse"] input[type=checkbox]')).not.toBeChecked();
  await expect(sheet.getByRole("button", { name: "Quitar 1 hoja" })).toBeVisible();
  await sheet.locator('[data-blanks-list="sparse"] [data-blank-item]').click();
  await expect(sheet.locator('[data-blanks-list="sparse"] input[type=checkbox]')).toBeChecked();
  await sheet.getByRole("button", { name: "Quitar 2 hojas" }).click();
  await expect.poll(() => pageIds(page)).toEqual([ids[0]]);
  await page.locator('[data-review-action="undo-blanks"]').click();
  await expect.poll(() => pageIds(page)).toEqual(ids);
});

test("chips: «Borrosa → Repetir» abre la camara y la nueva captura sustituye a la pagina EN EL MISMO SITIO", async ({ page, browserName }) => {
  test.skip(webkitLinuxCamera(browserName), WEBKIT_LINUX_CAMERA_REASON);
  const ids = await load(page, ["a.jpg", "b-blurry.jpg", "c.jpg"]);
  await expect(page.locator('[data-quality-chip="blurry"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Página 2: Borrosa. Repetir" }).click();
  await waitVideoReady(page);
  await expect(page.locator("[data-camera-stage]")).toContainText("Repetir captura");
  // Sin captura automatica: el disparador.
  await page.locator('[data-camera-action="auto"]').click();
  await page.getByRole("button", { name: "Capturar página" }).click();
  // Una sola captura y vuelve a revisar (repetir es un paso, no una rafaga).
  await expect(page.locator("[data-camera-stage]")).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(3);
  await waitIdle(page);
  const after = await pageIds(page);
  expect(after[0]).toBe(ids[0]);
  expect(after[2]).toBe(ids[2]);
  // La nueva ocupa el sitio 2 y ya no esta marcada como borrosa.
  expect(after[1]).toBe(ids[1]);
  await expect(page.locator('[data-quality-chip="blurry"]')).toHaveCount(0);
});

test("chips: «Repetida → Quitar» y «Sin documento → Recortar»", async ({ page }) => {
  // «Sin documento» sale de la deteccion de bordes del motor (umbrales propios, cubiertos en su spec): aqui solo con el motor falso.
  await load(page, USE_REAL_ENGINE ? ["a.jpg", "a-dup.jpg"] : ["a.jpg", "a-dup.jpg", "c-nodoc.jpg"]);
  await expect(page.getByRole("button", { name: /Página 2: Repetida\. Quitar/ })).toBeVisible();
  if (!USE_REAL_ENGINE) {
    await page.getByRole("button", { name: /Página 3: Sin documento detectado\. Ajusta el recorte/ }).click();
    // Abre directamente el ajuste de esquinas, con «Toda la foto» para dejar la pagina completa.
    await expect(page.locator("[data-corner-editor]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Toda la foto" })).toBeVisible();
    await page.getByRole("button", { name: "Cerrar sin cambios" }).click();
    await expect(page.locator("[data-corner-editor]")).toHaveCount(0);
  }
  await page.getByRole("button", { name: /Página 2: Repetida\. Quitar/ }).click();
  await expect(tiles(page)).toHaveCount(USE_REAL_ENGINE ? 1 : 2);
});

test("orientacion automatica: gira las de lado, avisa y el aviso se deshace", async ({ page }) => {
  await load(page, ["a.jpg", "b-sideways.jpg", "c-upsidedown.jpg"]);
  const notice = page.locator('[data-banner="orientation"]');
  await expect(notice).toContainText("Giramos 2 páginas: 1 de lado y 1 cabeza abajo.");
  await page.getByRole("button", { name: "Deshacer giro" }).click();
  await expect(notice).toHaveCount(0);
  // Al deshacer el giro, el motor recalcula las dos miniaturas.
  await waitIdle(page);
});

test("duplicar, insertar antes/despues con la fototeca y mover aqui", async ({ page }) => {
  const ids = await load(page, ["a.jpg", "b.jpg", "c.jpg"]);
  // Duplicar la 2: queda justo despues.
  await page.getByRole("button", { name: "Más acciones de la página 2" }).click();
  await page.locator('[data-more-action="duplicate"]').click();
  await expect(tiles(page)).toHaveCount(4);
  const duplicated = await pageIds(page);
  expect(duplicated[0]).toBe(ids[0]);
  expect(duplicated[1]).toBe(ids[1]);
  expect(duplicated[3]).toBe(ids[2]);

  // Insertar con la fototeca despues de la 1.
  await page.getByRole("button", { name: "Más acciones de la página 1" }).click();
  await page.locator('[data-more-action="insert-after"]').click();
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-insert="library"]').click();
  await (await chooser).setFiles(scanFiles(["z.jpg"]));
  await expect(tiles(page)).toHaveCount(5);
  await waitIdle(page);
  const inserted = await pageIds(page);
  expect(inserted[0]).toBe(ids[0]);
  expect(inserted[2]).toBe(ids[1]);
  const newId = inserted[1];

  // «Mover aqui»: la nueva pagina antes de la ultima.
  await page.getByRole("button", { name: "Más acciones de la página 2" }).click();
  await page.locator('[data-more-action="move"]').click();
  await expect(page.locator("[data-move-here]")).toHaveCount(4);
  await page.locator("[data-move-here]").last().click();
  await expect.poll(async () => (await pageIds(page)).indexOf(newId)).toBe(3);
});

test("seleccion multiple: filtro, girar, mover y borrar desde la barra inferior", async ({ page }) => {
  const ids = await load(page, ["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
  await page.getByRole("button", { name: "Seleccionar" }).click();
  await page.locator("[data-page-grid] [data-page-main]").nth(1).click();
  await page.locator("[data-page-grid] [data-page-main]").nth(2).click();
  await expect(page.locator("[data-selected-count]")).toHaveText("2 seleccionadas");

  await page.locator('[data-review-action="bulk-filter"]').click();
  await page.locator('[data-bulk-filter] [data-filter="bw"]').click();
  await page.locator('[data-review-action="bulk-rotate"]').click();
  await waitIdle(page);
  if (!USE_REAL_ENGINE) expect(await fakeControls(page, (c) => c.calls.renderPage ?? 0)).toBeGreaterThanOrEqual(2);

  // Mover las dos al final.
  await page.locator('[data-review-action="bulk-move"]').click();
  await page.locator("[data-move-end]").click();
  await expect.poll(() => pageIds(page)).toEqual([ids[0], ids[3], ids[1], ids[2]]);

  // Borrar: vuelve a la lista normal.
  await page.getByRole("button", { name: "Seleccionar" }).click();
  await page.locator("[data-page-grid] [data-page-main]").nth(1).click();
  await page.locator('[data-review-action="bulk-delete"]').click();
  await expect(tiles(page)).toHaveCount(3);
});

test("editor: filtro, brillo y contraste, «Aplicar a todas», esquinas y hoja completa", async ({ page }) => {
  await load(page, ["a.jpg", "b.jpg", "c.jpg"]);
  // Girar en la cuadricula solo pide la miniatura rapida; el resultado completo llega al abrir la pagina.
  await page.getByRole("button", { name: "Girar la página 1" }).click();
  await waitIdle(page);
  if (!USE_REAL_ENGINE) {
    expect(await fakeControls(page, (c) => c.calls.renderQuick ?? 0)).toBeGreaterThanOrEqual(1);
    expect(await fakeControls(page, (c) => c.calls.renderFull ?? 0)).toBe(0);
  }
  await page.locator("[data-page-grid] [data-page-main]").first().click();
  const editor = page.locator("[data-page-editor]");
  await expect(editor).toBeVisible();
  if (!USE_REAL_ENGINE) await expect.poll(() => fakeControls(page, (c) => c.calls.renderFull ?? 0)).toBeGreaterThanOrEqual(1);
  await expect(editor.locator("[data-editor-processing]")).toHaveCount(0);
  await expect(editor.locator("[data-editor-title]")).toHaveText("Editar página 1 de 3");
  await editor.locator('[data-filter="grayscale"]').click();
  await editor.getByRole("tab", { name: "Brillo y contraste" }).click();
  const slider = editor.getByRole("slider", { name: "Brillo" });
  await slider.focus();
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");
  if (!USE_REAL_ENGINE) {
    const renders = await fakeControls(page, (c) => c.calls.renderPage ?? 0);
    // El recalculo llega al soltar (unos 350 ms despues del ultimo cambio).
    await expect.poll(() => fakeControls(page, (c) => c.calls.renderPage ?? 0)).toBeGreaterThan(renders);
  }
  await editor.locator('[data-editor-action="apply-all"]').click();
  await editor.locator('[data-editor-action="next"]').click();
  await expect(editor.locator("[data-editor-title]")).toHaveText("Editar página 2 de 3");
  await editor.getByRole("tab", { name: "Filtro" }).click();
  await expect(editor.locator('[data-filter="grayscale"]')).toHaveAttribute("aria-pressed", "true");

  // Esquinas: se abre el editor con lupa y se cierra sin cambios devolviendo al editor.
  await editor.locator('[data-editor-action="crop"]').click();
  await expect(page.locator("[data-corner-editor]")).toBeVisible();
  await page.getByRole("button", { name: "Cerrar sin cambios" }).click();
  await expect(page.locator("[data-corner-editor]")).toHaveCount(0);
  await expect(editor).toBeVisible();

  // Hoja completa con zoom al tamano real.
  await editor.locator('[data-editor-action="sheet"]').click();
  const viewer = page.locator("[data-sheet-viewer]");
  await expect(viewer).toBeVisible();
  await viewer.locator('[data-sheet-action="zoom"]').click();
  await expect(viewer.locator('[data-sheet-action="zoom"]')).toHaveAttribute("aria-pressed", "true");
  await viewer.locator('[data-sheet-action="close"]').click();
  await expect(viewer).toHaveCount(0);
  // Cerrar la hoja devuelve al editor (estaba debajo), con el foco en el boton que la abrio.
  await expect(editor).toBeVisible();
  await expect(editor.locator('[data-editor-action="sheet"]')).toBeFocused();
});
