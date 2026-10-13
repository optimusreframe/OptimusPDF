import type { Page } from "@playwright/test";
import { expect, test } from "../helpers/tool-flow";
import { openProPdf } from "../helpers/pro-flow";
import { PRO_STRINGS } from "../../src/app/pdf-pro/proStrings";

/**
 * PDF Pro · memoria del historial (Wave 8), navegador real y headless. Con la ventana caliente reducida a 0 bytes
 * (ajuste `optimuspdf.pro.historyHotBytes`, solo para diagnostico) todo lo que no sea el actual y el anterior se vuelca
 * a IndexedDB (`optimuspdf-pro-history-<sesion>`):
 *  - tras 5 operaciones hay 4 pasos en disco; deshacer hasta el original y rehacer hasta el final los recupera y el
 *    documento vuelve a ser exactamente el de cada paso (rotacion de la pagina);
 *  - cerrar el documento vacia el disco y salir de la pagina borra la base (sin fugas);
 *  - si IndexedDB falla para el historial, se avisa en el panel y en la region viva, deshacer sigue funcionando y los
 *    borradores (otra base) no se ven afectados.
 */

const S = PRO_STRINGS.es;
const PREFIX = "optimuspdf-pro-history-";
const HOT_KEY = "optimuspdf.pro.historyHotBytes";
test.use({ locale: "es-ES", viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const historyItems = (page: Page) => page.getByRole("list", { name: S.suite.historyTitle }).getByRole("listitem");
const status = (page: Page) => page.getByRole("status");

/** Bases de historial que existen y cuantos SNAPSHOTS (manifiestos; los trozos `id:n` no cuentan) tiene cada una. */
async function historyDatabases(page: Page): Promise<{ name: string; rows: number }[]> {
  return page.evaluate(async (prefix) => {
    const names = (await indexedDB.databases()).map((info) => info.name ?? "").filter((name) => name.startsWith(prefix));
    const result: { name: string; rows: number }[] = [];
    for (const name of names) {
      const rows = await new Promise<number>((resolve) => {
        const open = indexedDB.open(name);
        open.onerror = () => resolve(-1);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains("snapshots")) {
            db.close();
            resolve(0);
            return;
          }
          const keys = db.transaction("snapshots").objectStore("snapshots").getAllKeys();
          keys.onsuccess = () => {
            db.close();
            resolve((keys.result as string[]).filter((key) => !key.includes(":")).length);
          };
          keys.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      });
      result.push({ name, rows });
    }
    return result;
  }, PREFIX);
}

/** Rotacion de la primera pagina del documento ACTUAL, leida del PDF que se descarga con «Descargar PDF». */
async function firstPageRotation(page: Page): Promise<number> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: S.suite.download, exact: true }).click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error("sin descarga");
  const { PDFDocument } = await import("@cantoo/pdf-lib");
  const { readFileSync } = await import("node:fs");
  const document = await PDFDocument.load(readFileSync(path), { updateMetadata: false });
  return document.getPage(0).getRotation().angle;
}

/** Marca el anuncio actual y espera a uno NUEVO (otro <span>, aunque repita el texto) que cumpla el patron. */
async function expectNewAnnouncement(page: Page, action: () => Promise<void>, pattern: RegExp): Promise<string> {
  await page.evaluate(() => {
    const span = document.querySelector('[role="status"] span') as (HTMLElement & { __seen?: boolean }) | null;
    if (span) span.__seen = true;
  });
  await action();
  let text = "";
  await expect
    .poll(
      async () => {
        text = await page.evaluate(() => {
          const span = document.querySelector('[role="status"] span') as (HTMLElement & { __seen?: boolean }) | null;
          return span && !span.__seen ? (span.textContent ?? "") : "";
        });
        return pattern.test(text);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return text;
}

async function rotateTimes(page: Page, times: number, pattern = /^Aplicado:/): Promise<void> {
  const rotate = page.getByRole("button", { name: S.operations.rotateAll90, exact: true });
  const before = await historyItems(page).count();
  for (let i = 1; i <= times; i += 1) {
    await expectNewAnnouncement(page, () => rotate.click(), pattern);
    await expect(historyItems(page)).toHaveCount(before + i);
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((key) => window.localStorage.setItem(key, "0"), HOT_KEY);
});

test("los pasos fuera de la ventana van a IndexedDB; deshacer/rehacer los recupera exactos; cerrar y salir no dejan restos", async ({ page }) => {
  await openProPdf(page, { name: "memoria.pdf", pages: 2 });
  await rotateTimes(page, 5);

  // 6 pasos: actual (P5) y anterior (P4) en RAM; Original, P1, P2, P3 en disco (4 filas).
  await expect.poll(() => historyDatabases(page), { timeout: 15_000 }).toEqual([expect.objectContaining({ rows: 4 })]);
  const [{ name }] = await historyDatabases(page);
  expect(await firstPageRotation(page)).toBe(90); // 5 × 90° = 450° ≡ 90°

  // Deshacer cinco veces (Ctrl+Z): cada paso se anuncia y el ultimo deja el original (0°).
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  for (let i = 5; i >= 1; i -= 1) {
    const text = await expectNewAnnouncement(page, () => page.keyboard.press("Control+z"), /^Deshecho:/);
    expect(text).toBe(S.announce.undone(S.operations.rotateAll90));
    await expect(page.locator(`[data-history-index="${i - 1}"]`)).toHaveAttribute("aria-current", "step");
    await expect(page.locator('article[data-state="ready"]').first()).toBeVisible();
  }
  expect(await firstPageRotation(page)).toBe(0);
  await expect(page.getByRole("button", { name: S.suite.undo })).toHaveAttribute("aria-disabled", "true");

  // Rehacer hasta el final: vuelve a 90°, con los 6 pasos intactos.
  for (let i = 1; i <= 5; i += 1) {
    await expectNewAnnouncement(page, () => page.keyboard.press("Control+Shift+z"), /^Rehecho:/);
    await expect(page.locator(`[data-history-index="${i}"]`)).toHaveAttribute("aria-current", "step");
  }
  await expect(historyItems(page)).toHaveCount(6);
  expect(await firstPageRotation(page)).toBe(90);
  // Todo paso que ha pasado por disco conserva su fila mientras exista (volver a soltarlo es gratis): 6 de 6, nunca mas.
  await expect.poll(() => historyDatabases(page), { timeout: 15_000 }).toEqual([{ name, rows: 6 }]);

  // Un salto largo (historial → Original) tambien recupera de disco y anuncia todos los pasos agrupados.
  const jump = await expectNewAnnouncement(page, () => page.locator('[data-history-index="0"]').click(), /^Deshecho:/);
  expect(jump).toBe(S.announce.undone(`${S.operations.rotateAll90} ×5`));
  await expect(page.locator('[data-history-index="0"]')).toHaveAttribute("aria-current", "step");

  // Cerrar el documento vacia el disco (la base sigue, vacia, para el siguiente documento de esta sesion).
  await page.getByRole("button", { name: S.suite.close }).click();
  await page.getByRole("dialog").getByRole("button", { name: S.suite.close }).click();
  await expect.poll(() => historyDatabases(page), { timeout: 15_000 }).toEqual([{ name, rows: 0 }]);

  // Salir de la pagina (navegacion completa: los efectos de React no llegan a correr) suelta el Web Lock de la sesion;
  // la siguiente visita a /pdf-pro reconoce la base como muerta y la borra (sin fugas entre sesiones).
  // (Solo se listan nombres: `indexedDB.open(name)` crearia la base vacia de nuevo y falsearia la comprobacion.)
  await page.goto("/");
  await page.goto("/pdf-pro");
  await expect
    .poll(
      () =>
        page.evaluate(
          async (prefix) => (await indexedDB.databases()).map((info) => info.name ?? "").filter((n) => n.startsWith(prefix)),
          PREFIX,
        ),
      { timeout: 15_000 },
    )
    .toEqual([]);
});

test("si IndexedDB falla para el historial, se avisa (panel y region viva), deshacer sigue y los borradores no se tocan", async ({ page }) => {
  await page.addInitScript((prefix) => {
    // Solo las bases del historial fallan: los borradores (`optimuspdf-pro-drafts`) siguen funcionando.
    // En el prototipo, no en la instancia: WebKit descarta lo que se le asigna a `indexedDB` (la prueba no fallaba
    // el disco y el historial se guardaba con normalidad).
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, name: string, version?: number) {
      if (!name.startsWith(prefix)) return original.call(this, name, version);
      const request = { error: new DOMException("sin espacio", "QuotaExceededError") } as unknown as IDBOpenDBRequest & {
        onerror: ((event: Event) => void) | null;
      };
      setTimeout(() => request.onerror?.(new Event("error")), 0);
      return request;
    } as typeof IDBFactory.prototype.open;
  }, PREFIX);
  await openProPdf(page, { name: "sin-disco.pdf", pages: 2 });
  // Al segundo paso el Original sale de la ventana, el volcado falla y el aviso puede pisar al «Aplicado» al instante.
  await rotateTimes(page, 2, new RegExp(`^(Aplicado:|${S.announce.historyOffloadFailed.slice(0, 30)})`));
  await expect(status(page)).toContainText(S.announce.historyOffloadFailed, { timeout: 15_000 });
  await expect(page.locator("[data-pro-limits]")).toContainText(S.warnings.historyOffloadUnavailable, { timeout: 15_000 });
  await rotateTimes(page, 1);
  // El borrador automatico (otra base) se guardo (antes de descargar: descargar marca el documento como guardado).
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
  // El historial sigue entero en memoria (el presupuesto por bytes no recorta un PDF pequeño) y se deshace.
  await expect(historyItems(page)).toHaveCount(4);
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await expectNewAnnouncement(page, () => page.keyboard.press("Control+z"), /^Deshecho:/);
  await expect(page.locator('[data-history-index="2"]')).toHaveAttribute("aria-current", "step");
  expect(await firstPageRotation(page)).toBe(180);
});
