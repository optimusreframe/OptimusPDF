import { expect, test, type BrowserContext, type Browser, type Locator, type Page } from "@playwright/test";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";
import { jpgSignature } from "../helpers/ink-images";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";
import { makeSyntheticPdf } from "../helpers/sign-flow";
import { FORGERIES, entry, forgedEntry, packageBuffer, threeSignatures } from "../helpers/backup-packages";

/**
 * Accesibilidad de las hojas nuevas de «Firmas guardadas» (F6 · U6.2 y U4.4-UI): axe-core sobre CADA estado de la hoja
 * «Subir firma o iniciales» (elegir, ajustar, recorte a mano, resumen), «Exportar todas mis firmas» (con y sin contraseña)
 * e «Importar firmas» (elegir, vista previa «Nuevo», vista previa «Ya lo tienes»), en claro y oscuro, ES y EN, a 1280 y
 * a 375 px. Reglas: contraste, ARIA valida, etiquetas, nombres de botones/enlaces, roles, hijos requeridos, foco oculto y
 * controles anidados (0 violaciones). Ademas, objetivos tactiles de >= 44 px en las hojas con el dedo.
 *
 * axe-core llega como dependencia transitiva de eslint-config-next (como en `a11y-sweep.spec.ts`).
 * Headless siempre. Para correrla:
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3911 npx playwright test sign-upload-a11y --project=chromium --workers=2
 */

const AXE_PATH = require.resolve("axe-core/axe.min.js");
/** El equivalente REAL del dorado v1 (el dorado lleva imagenes sinteticas que la importacion ya no acepta, D5). */
const GOLDEN_NAME = "signatures-real.optimuspdf.zip";

const AXE_RULES = [
  "color-contrast",
  "aria-valid-attr-value",
  "aria-valid-attr",
  "aria-allowed-attr",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-hidden-focus",
  "label",
  "button-name",
  "link-name",
  "image-alt",
  "nested-interactive",
  "duplicate-id-aria",
  "tabindex",
  "list",
  "listitem",
] as const;

type Language = "es" | "en";
type Theme = "light" | "dark";
type Cell = { theme: Theme; language: Language; width: number };

const CELLS: Cell[] = [];
for (const theme of ["light", "dark"] as const) {
  for (const language of ["es", "en"] as const) {
    for (const width of [1280, 375]) CELLS.push({ theme, language, width });
  }
}

async function newContext(browser: Browser, cell: Cell): Promise<BrowserContext> {
  const touch = cell.width < 600;
  const context = await browser.newContext({
    viewport: { width: cell.width, height: touch ? 812 : 900 },
    colorScheme: cell.theme,
    hasTouch: touch,
    isMobile: touch,
    deviceScaleFactor: touch ? 2 : 1,
    locale: cell.language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
  });
  await context.addInitScript(
    ([theme, language, key]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
        window.localStorage.setItem(key, "1");
      } catch {
        /* almacenamiento bloqueado */
      }
    },
    [cell.theme, cell.language, PRIVACY_SEEN_KEY],
  );
  return context;
}

type Violation = { id: string; help: string; nodes: string[] };

/** axe sobre el DIALOGO (la hoja abierta): lo que hay detras queda inerte y no es el objeto de esta prueba. */
async function axeOn(page: Page, dialog: Locator): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const handle = await dialog.elementHandle();
  return page.evaluate(
    async ([element, rules]: [Element, string[]]) => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
      const result = await axe.run(element, { runOnly: { type: "rule", values: [...rules] } });
      return result.violations.map((v) => ({
        id: v.id,
        help: v.help,
        nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`),
      }));
    },
    [handle, [...AXE_RULES]] as [typeof handle, string[]],
  );
}

const describeViolations = (violations: Violation[]): string =>
  violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n");

/** Espera a que la hoja deje de moverse (entra con un muelle) antes de medir contraste. */
async function settle(page: Page, dialog: Locator): Promise<void> {
  let last = await dialog.boundingBox();
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(120);
    const next = await dialog.boundingBox();
    if (last && next && Math.abs(next.y - last.y) < 0.5 && Math.abs(next.x - last.x) < 0.5) break;
    last = next;
  }
  await page.waitForTimeout(250);
}

async function expectClean(page: Page, dialog: Locator, label: string): Promise<void> {
  if (process.env.A11Y_TRACE) console.log(`[a11y] ${label}`);
  await settle(page, dialog);
  const violations = await axeOn(page, dialog);
  expect(violations, `${label}\n${describeViolations(violations)}`).toEqual([]);
}

/** Objetivos tactiles: todo boton, radio, interruptor y casilla visible de la hoja mide >= 44 px (43,5 por el redondeo). */
async function expectTouchTargets(dialog: Locator, label: string): Promise<void> {
  const small = await dialog.evaluate((root) => {
    const bad: string[] = [];
    const selector = 'button, [role="radio"], [role="switch"], input[type="checkbox"], input[type="range"], select, a[href]';
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (element.closest(".sr-only") || element.classList.contains("sr-only")) continue;
      let box = element.getBoundingClientRect();
      if (element instanceof HTMLInputElement && element.type === "checkbox") {
        // La casilla de 22 px vive dentro de una fila de >= 44 px que SI es el objetivo.
        const row = element.closest("div.group") ?? element.parentElement;
        if (row) box = row.getBoundingClientRect();
      }
      if (element instanceof HTMLInputElement && element.type === "range") {
        // El pulgar del deslizador mide 28 px; la pista y su fila de etiqueta dan el objetivo tactil.
        const wrapper = element.parentElement;
        if (wrapper) box = wrapper.getBoundingClientRect();
      }
      if (box.width < 1 || box.height < 1) continue;
      if (box.height < 43.5 || (box.width < 43.5 && box.height < 43.5)) {
        bad.push(`${element.tagName.toLowerCase()}[${element.getAttribute("role") ?? element.getAttribute("type") ?? ""}] "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
    return bad;
  });
  expect(small, `${label}: objetivos de toque menores de 44 px`).toEqual([]);
}

test.describe("axe-core en las hojas de subir y respaldar firmas: 0 violaciones", () => {
  for (const cell of CELLS) {
    test(`${cell.theme} · ${cell.language} · ${cell.width}px`, async ({ browser }) => {
      test.setTimeout(Number(process.env.A11Y_TIMEOUT ?? 240_000));
      const strings = SIGN_STRINGS[cell.language];
      const ink = strings.inkImport;
      const backup = strings.vaultBackup;
      const touch = cell.width < 600;
      const context = await newContext(browser, cell);
      const page = await context.newPage();
      try {
        await page.goto("/sign-pdf");
        await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles({
          name: "contrato.pdf",
          mimeType: "application/pdf",
          buffer: await makeSyntheticPdf("C", 1),
        });
        await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
        await page.getByRole("button", { name: strings.vaultButton }).first().click();
        const vault = page.getByRole("dialog", { name: strings.vaultTitle });
        await expect(vault).toBeVisible();

        // --- Importar (paquete dorado): elegir, vista previa «Nuevo», resultado ---
        await vault.getByRole("button", { name: backup.importButton, exact: true }).click();
        const restore = page.getByRole("dialog", { name: backup.importTitle });
        await expectClean(page, restore, "importar: elegir archivo");
        if (touch) await expectTouchTargets(restore, "importar: elegir archivo");
        await restore.locator("[data-backup-file-input]").setInputFiles({ name: GOLDEN_NAME, mimeType: "application/zip", buffer: await threeSignatures() });
        await expect(restore.getByText(backup.statusNew).first()).toBeVisible({ timeout: 30_000 });
        await expectClean(page, restore, "importar: vista previa «Nuevo»");
        if (touch) await expectTouchTargets(restore, "importar: vista previa «Nuevo»");
        await restore.getByRole("button", { name: backup.importConfirm(3) }).click();
        await expect(restore.getByRole("button", { name: backup.doneClose })).toBeVisible({ timeout: 30_000 });
        await expectClean(page, restore, "importar: resultado");
        await restore.getByRole("button", { name: backup.doneClose }).click();
        await expect(restore).toBeHidden();

        // --- La lista con los botones nuevos ---
        await expectClean(page, vault, "Firmas guardadas con firmas y los tres botones");
        if (touch) await expectTouchTargets(vault, "Firmas guardadas");

        // --- Importar otra vez: «Ya lo tienes (idéntico)» ---
        await vault.getByRole("button", { name: backup.importButton, exact: true }).click();
        await restore.locator("[data-backup-file-input]").setInputFiles({ name: GOLDEN_NAME, mimeType: "application/zip", buffer: await threeSignatures() });
        await expect(restore.getByText(backup.statusIdentical).first()).toBeVisible({ timeout: 30_000 });
        await expectClean(page, restore, "importar: vista previa «Ya lo tienes (idéntico)»");
        await page.keyboard.press("Escape");
        await expect(restore).toBeHidden();

        // --- Exportar ---
        await vault.getByRole("button", { name: backup.exportButton }).click();
        const exportSheet = page.getByRole("dialog", { name: backup.exportTitle });
        await expect(exportSheet).toBeVisible();
        await exportSheet.getByLabel(backup.password, { exact: true }).fill("Abcdefg1");
        await expectClean(page, exportSheet, "exportar: con contraseña y medidor");
        if (touch) await expectTouchTargets(exportSheet, "exportar: con contraseña");
        await exportSheet.locator("label", { hasText: backup.protect }).click();
        await expect(exportSheet.getByRole("checkbox", { name: backup.protect })).not.toBeChecked();
        await expectClean(page, exportSheet, "exportar: sin contraseña (aviso)");
        await page.keyboard.press("Escape");
        await expect(exportSheet).toBeHidden();

        // --- Subir una imagen: elegir, ajustar, recorte a mano, resumen ---
        await vault.getByRole("button", { name: ink.entryButton }).click();
        const upload = page.getByRole("dialog", { name: ink.title });
        await expect(upload).toBeVisible();
        await expectClean(page, upload, "subir: elegir imagen");
        if (touch) await expectTouchTargets(upload, "subir: elegir imagen");
        await upload.locator("[data-ink-file-input]").setInputFiles(jpgSignature("shadow"));
        await expect(upload.getByRole("heading", { name: ink.adjustTitle })).toBeVisible({ timeout: 30_000 });
        await expect(upload.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
        await expectClean(page, upload, "subir: ajustar con vista previa");
        if (touch) await expectTouchTargets(upload, "subir: ajustar");
        await upload.getByRole("button", { name: ink.cropManual }).first().click();
        await expect(upload.getByRole("group", { name: ink.cropAreaLabel })).toBeVisible();
        await expectClean(page, upload, "subir: recorte a mano");
        if (touch) await expectTouchTargets(upload, "subir: recorte a mano");
        await upload.getByRole("button", { name: ink.cropDone }).click();
        await expect(upload.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
        await upload.locator("[data-ink-accept]").click();
        await expect(upload.getByRole("heading", { name: ink.summaryTitle })).toBeVisible();
        await expectClean(page, upload, "subir: resumen");
        await upload.getByRole("button", { name: ink.save }).click(); // sin nombre: error de campo
        await expect(upload.getByText(ink.nameNeeded)).toBeVisible();
        await expectClean(page, upload, "subir: resumen con el error del nombre");
        if (touch) await expectTouchTargets(upload, "subir: resumen");
      } finally {
        await context.close();
      }
    });
  }
});

test.describe("axe-core en la vista previa de importar: estados nuevos (U4.4-fix · D2, D3, D5)", () => {
  const NEW_CELLS: Cell[] = [
    { theme: "light", language: "es", width: 1280 },
    { theme: "dark", language: "en", width: 375 },
  ];
  for (const cell of NEW_CELLS) {
    test(`${cell.theme} · ${cell.language} · ${cell.width}px`, async ({ browser }) => {
      test.setTimeout(Number(process.env.A11Y_TIMEOUT ?? 240_000));
      const strings = SIGN_STRINGS[cell.language];
      const backup = strings.vaultBackup;
      const touch = cell.width < 600;
      const context = await newContext(browser, cell);
      const page = await context.newPage();
      try {
        await page.goto("/sign-pdf");
        await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles({
          name: "contrato.pdf",
          mimeType: "application/pdf",
          buffer: await makeSyntheticPdf("C", 1),
        });
        await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
        await page.getByRole("button", { name: strings.vaultButton }).first().click();
        const vault = page.getByRole("dialog", { name: strings.vaultTitle });
        await expect(vault).toBeVisible();
        const restore = page.getByRole("dialog", { name: backup.importTitle });

        // 1) baul de partida: Ana (con cargo) y Luis, importados desde un paquete real
        const seed = await packageBuffer([
          entry("vault-a", "Ana Pérez", { sig: 1, ini: 2, role: "Directora" }),
          entry("vault-l", "Luis", { sig: 5 }),
        ]);
        await vault.getByRole("button", { name: backup.importButton, exact: true }).click();
        await restore.locator("[data-backup-file-input]").setInputFiles({ name: "base.optimuspdf.zip", mimeType: "application/zip", buffer: seed });
        await restore.getByRole("button", { name: backup.importConfirm(2) }).click();
        await expect(restore.getByRole("button", { name: backup.doneClose })).toBeVisible({ timeout: 30_000 });
        await restore.getByRole("button", { name: backup.doneClose }).click();
        await expect(restore).toBeHidden();

        // 2) el paquete con los tres casos: renombrada (mismos dibujos), otra persona con el mismo id, imagen forjada
        const second = await packageBuffer([
          entry("vault-a", "Ana María Pérez", { sig: 1, ini: 2 }),
          entry("vault-l", "Carla", { sig: 20 }),
          forgedEntry("vault-bad", "Mala", FORGERIES[0][1]),
        ]);
        await vault.getByRole("button", { name: backup.importButton, exact: true }).click();
        await restore.locator("[data-backup-file-input]").setInputFiles({ name: "segundo.optimuspdf.zip", mimeType: "application/zip", buffer: second });
        await expect(restore.getByText(backup.statusSameDrawings)).toBeVisible({ timeout: 30_000 });
        await expect(restore.getByText(backup.otherPersonHint("Luis"))).toBeVisible();
        await expect(restore.getByText(backup.invalidReasons.invalidImage)).toBeVisible();
        await expect(restore.getByRole("radio", { name: backup.decisionReplace })).toHaveCount(1); // solo la renombrada
        await expectClean(page, restore, "importar: mismos dibujos + otra persona + imagen no valida");
        if (touch) await expectTouchTargets(restore, "importar: tres estados nuevos");
        await restore.getByRole("radio", { name: backup.decisionReplace }).click();
        await expect(restore.getByText(backup.replaceKeeps)).toBeVisible();
        await expectClean(page, restore, "importar: reemplazar con aviso de lo que se conserva");
        await page.keyboard.press("Escape");
        await expect(restore).toBeHidden();
      } finally {
        await context.close();
      }
    });
  }
});

test.describe("teclado", () => {
  test.setTimeout(90_000);
  test("la hoja de subir se cierra con Escape y devuelve el foco a su boton", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "en Safari de macOS el foco por clic no llega a los botones: lo cubre la prueba de Chromium");
    const strings = SIGN_STRINGS.es;
    await page.addInitScript(
      ([key]) => {
        window.localStorage.setItem(key, "1");
        window.localStorage.setItem("optimuspdf.language", "es");
      },
      [PRIVACY_SEEN_KEY],
    );
    await page.goto("/sign-pdf");
    await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles({
      name: "contrato.pdf",
      mimeType: "application/pdf",
      buffer: await makeSyntheticPdf("C", 1),
    });
    await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
    await page.getByRole("button", { name: strings.vaultButton }).first().click();
    const vault = page.getByRole("dialog", { name: strings.vaultTitle });
    const open = vault.getByRole("button", { name: strings.inkImport.entryButton });
    await open.focus();
    await page.keyboard.press("Enter");
    const upload = page.getByRole("dialog", { name: strings.inkImport.title });
    await expect(upload).toBeVisible();
    // el foco entra en la hoja (en «Elegir imagen») y se queda dentro mientras se tabula
    await expect(upload.getByRole("button", { name: strings.inkImport.pickFile })).toBeFocused();
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null)).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(upload).toBeHidden();
    await expect(open).toBeFocused();
  });
});
