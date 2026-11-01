import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import {
  CLIENT,
  FAKE_ONLY_REASON,
  OTHER_CLIENT,
  POLICY_SPECS,
  TEST_TIMEOUT,
  USE_REAL_ENGINE,
  addFileSource,
  autofillButton,
  installAutofillFakes,
  makeClaimForm,
  makePolicyPdf,
  openAutofill,
  openSignWith,
  sheet,
  textFieldBox,
  tinyJpeg,
} from "../helpers/autofill-ui";
import { fileInput } from "../helpers/sign-flow";
import { PRIVACY_SEEN_KEY } from "../helpers/sign-vault-flow";

/**
 * Accesibilidad de «Rellenar con datos del cliente»: axe-core sobre CADA paso de la hoja (elegir fuentes, fuentes elegidas con
 * aviso, leyendo, revisar con conflicto + pisado + avisos, guardar como perfil con su error, lista de perfiles, editor de perfil
 * y confirmacion de borrado) en claro y oscuro x ES y EN x 1280, 375 y 320 px; objetivos tactiles de >= 44 px con el dedo;
 * teclado (Tab cicla dentro de la hoja, Escape cierra y el foco vuelve al boton); movimiento reducido. 0 violaciones.
 *
 * axe-core llega como dependencia transitiva de eslint-config-next (como en `a11y-sweep.spec.ts`). Headless siempre.
 */

test.setTimeout(TEST_TIMEOUT * 6);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
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
  "target-size",
  "form-field-multiple-labels",
  "empty-heading",
] as const;

type Language = "es" | "en";
type Theme = "light" | "dark";
type Cell = { theme: Theme; language: Language; width: number };

const CELLS: Cell[] = [];
for (const theme of ["light", "dark"] as const) for (const language of ["es", "en"] as const) for (const width of [1280, 375, 320]) CELLS.push({ theme, language, width });

const KEY = "optimuspdf.clientProfiles";

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
    ([theme, language, privacy, key]) => {
      try {
        window.localStorage.setItem("optimuspdf.theme", theme);
        window.localStorage.setItem("optimuspdf.language", language);
        window.localStorage.setItem(privacy, "1");
        // Dos perfiles ya guardados (datos inventados) para ver la lista y el editor.
        if (!window.localStorage.getItem(key)) {
          const at = "2026-10-20T10:00:00.000Z";
          const value = (text: string) => ({ value: text, updatedAt: at, source: "extracted" });
          window.localStorage.setItem(
            key,
            JSON.stringify({
              version: 1,
              profiles: [
                { id: "cp-a11y-1", name: "Pérez Soto, María", updatedAt: at, values: { insuredName1: value("Maria Perez Soto"), phone: value("(555) 010-0001") } },
                { id: "cp-a11y-2", name: "Gómez Rivas, Luis", updatedAt: "2026-10-21T10:00:00.000Z", values: { insuredName1: value("Luis Gomez Rivas") } },
              ],
            }),
          );
        }
      } catch {
        /* almacenamiento bloqueado */
      }
    },
    [cell.theme, cell.language, PRIVACY_SEEN_KEY, KEY],
  );
  return context;
}

type Violation = { id: string; help: string; nodes: string[] };

async function axeOn(page: Page, root: Locator): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const handle = await root.elementHandle();
  return page.evaluate(
    async ([element, rules]: [Element, string[]]) => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
      const result = await axe.run(element, { runOnly: { type: "rule", values: [...rules] } });
      return result.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`) }));
    },
    [handle, [...AXE_RULES]] as [typeof handle, string[]],
  );
}

const describeViolations = (violations: Violation[]): string => violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n");

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

async function expectClean(page: Page, root: Locator, label: string): Promise<void> {
  await settle(page, root);
  const violations = await axeOn(page, root);
  expect(violations, `${label}\n${describeViolations(violations)}`).toEqual([]);
}

/** Objetivos tactiles: todo boton, radio, casilla, enlace y campo visible mide >= 44 px de alto (43,5 por el redondeo). */
async function expectTouchTargets(dialog: Locator, label: string): Promise<void> {
  const small = await dialog.evaluate((root) => {
    const bad: string[] = [];
    const selector = 'button, [role="radio"], input[type="checkbox"], input[type="radio"], input[type="text"], textarea, a[href]';
    for (const element of root.querySelectorAll<HTMLElement>(selector)) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (element.closest(".sr-only") || element.classList.contains("sr-only")) continue;
      if (element instanceof HTMLInputElement && element.type === "file") continue;
      let box = element.getBoundingClientRect();
      if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) {
        // La casilla de 22 px vive dentro de una fila de >= 44 px que SI es el objetivo.
        const row = element.closest("div.group") ?? element.parentElement;
        if (row) box = row.getBoundingClientRect();
      }
      if (box.width < 1 || box.height < 1) continue;
      if (box.height < 43.5 && box.width < 43.5) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      else if (box.height < 43.5 && !(element instanceof HTMLAnchorElement)) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return bad;
  });
  expect(small, `${label}: objetivos de toque menores de 44 px`).toEqual([]);
}

const LABELS = {
  es: { read: "Leer datos", paste: "Pegar texto", pasteLabel: "Texto con los datos del cliente", pasteAdd: "Añadir texto", save: "Guardar como perfil", profileName: "Nombre del perfil", profiles: /^Usar un perfil guardado/, back: "Volver", edit: "Editar el perfil Pérez Soto, María", del: "Borrar el perfil Pérez Soto, María", fill: /^Rellenar \d+ campos?$/ },
  en: { read: "Read data", paste: "Paste text", pasteLabel: "Text with the client's data", pasteAdd: "Add text", save: "Save as profile", profileName: "Profile name", profiles: /^Use a saved profile/, back: "Back", edit: "Edit the profile Pérez Soto, María", del: "Delete the profile Pérez Soto, María", fill: /^Fill \d+ fields?$/ },
} as const;

for (const cell of CELLS) {
  const label = `${cell.theme} · ${cell.language} · ${cell.width}px`;
  test(`${label}: cada paso de la hoja sin violaciones de axe y con objetivos tactiles de 44 px`, async ({ browser }) => {
    test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
    const t = LABELS[cell.language];
    const touch = cell.width < 600;
    const context = await newContext(browser, cell);
    const page = await context.newPage();
    try {
      await installAutofillFakes(page, {
        // Sin modelo de lectura: la foto hace pasar por el paso del modelo y por su descarga (lenta, para poder mirarla).
        ocr: { available: false, prepare: "ok", delayMs: 1800 },
        delayMs: 500,
        steps: 4,
        byName: {
          "poliza.pdf": [...POLICY_SPECS, { key: "phone", value: OTHER_CLIENT.phone, page: 2, snippet: `Tel. ${OTHER_CLIENT.phone}` }],
          "licencia.jpg": [{ key: "email", value: "maria.perez@ejemplo.test", tier: "review", confidence: 0.5, snippet: "maria.perez@ejemplo.test" }],
        },
        warnings: { "licencia.jpg": ["ocr-unavailable"] },
      });
      await openSignWith(page, "reclamo.pdf", await makeClaimForm());
      // Un campo ya escrito -> la vista previa trae un «pisado».
      await textFieldBox(page, "Insured").click();
      const typed = page.locator("input[data-canvas-input]");
      await typed.fill("Escrito a mano");
      await typed.press("Enter");

      const dialog = await openAutofill(page, cell.language);
      await expectClean(page, dialog, `${label} · elegir fuentes`);
      if (touch) await expectTouchTargets(dialog, `${label} · elegir fuentes`);

      // Fuentes: un PDF, una foto, un texto pegado y un archivo que no se puede leer (aviso).
      await addFileSource(page, "poliza.pdf", await makePolicyPdf());
      await addFileSource(page, "licencia.jpg", tinyJpeg(), "image/jpeg", "camera");
      await dialog.locator('[data-autofill-input="file"]').setInputFiles({ name: "notas.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("x") });
      await dialog.getByRole("button", { name: t.paste }).click();
      await dialog.getByLabel(t.pasteLabel).fill(`Address: ${CLIENT.address}`);
      await expectClean(page, dialog, `${label} · pegar texto`);
      if (touch) await expectTouchTargets(dialog, `${label} · pegar texto`);
      await dialog.getByRole("button", { name: t.pasteAdd }).click();
      await expect(dialog.locator("[data-autofill-source]")).toHaveCount(3);
      await expectClean(page, dialog, `${label} · fuentes elegidas con aviso`);
      if (touch) await expectTouchTargets(dialog, `${label} · fuentes elegidas con aviso`);

      // La foto necesita el modelo de lectura: el motor NO lo baja, se pide con un boton.
      await dialog.getByRole("button", { name: t.read }).click();
      await expect(dialog.locator("[data-autofill-model]")).toBeVisible();
      await expectClean(page, dialog, `${label} · modelo de lectura`);
      if (touch) await expectTouchTargets(dialog, `${label} · modelo de lectura`);
      await dialog.locator("[data-autofill-model-download]").click();
      await expect(dialog.locator("[data-autofill-downloading]")).toBeVisible();
      await expectClean(page, dialog, `${label} · descargando el modelo`);
      if (touch) await expectTouchTargets(dialog, `${label} · descargando el modelo`);

      // Leyendo (progreso con cancelar).
      await expect(dialog.getByRole("progressbar")).toBeVisible({ timeout: 30_000 });
      await expectClean(page, dialog, `${label} · leyendo`);
      if (touch) await expectTouchTargets(dialog, `${label} · leyendo`);

      // Revisar: conflicto (dos telefonos), pisado (Insured escrito), aviso del OCR y cada confianza.
      await expect(dialog.locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
      await expect(dialog.locator('[data-autofill-group="phone"][data-autofill-multiple]')).toBeVisible();
      await expect(dialog.locator('[data-autofill-row="acro-1"][data-overwrites]')).toBeVisible();
      await expect(dialog.locator('[data-autofill-warning="ocr-unavailable"]')).toBeVisible();
      await expectClean(page, dialog, `${label} · revisar`);
      if (touch) await expectTouchTargets(dialog, `${label} · revisar`);

      // Guardar como perfil, con su error (sin nombre).
      await dialog.getByRole("checkbox", { name: t.save }).check({ force: true });
      await dialog.getByLabel(t.profileName).fill("");
      await dialog.getByRole("group").first(); // el dialogo sigue montado
      await dialog.locator("[data-autofill-fill]").click();
      await expect(dialog.locator("[data-autofill-profile-error]")).toBeVisible();
      await expectClean(page, dialog, `${label} · guardar como perfil con error`);
      if (touch) await expectTouchTargets(dialog, `${label} · guardar como perfil con error`);

      // Rellenar sin guardar el perfil: la hoja se cierra y el foco vuelve al boton.
      await dialog.getByRole("checkbox", { name: t.save }).uncheck({ force: true });
      await dialog.getByRole("button", { name: t.fill }).click();
      await expect(sheet(page)).toHaveCount(0);
      await expect(autofillButton(page, cell.language)).toBeFocused();

      // Perfiles guardados: lista, editor y confirmacion de borrado.
      const second = await openAutofill(page, cell.language);
      await second.getByRole("button", { name: t.profiles }).click();
      await expect(second.locator("[data-autofill-profiles]")).toBeVisible();
      await expectClean(page, second, `${label} · lista de perfiles`);
      if (touch) await expectTouchTargets(second, `${label} · lista de perfiles`);
      await second.getByRole("button", { name: t.edit }).click();
      await expect(second.locator("[data-autofill-profile-editor]")).toBeVisible();
      await expectClean(page, second, `${label} · editor de perfil`);
      if (touch) await expectTouchTargets(second, `${label} · editor de perfil`);
      await second.getByRole("button", { name: t.del }).click();
      const confirm = page.getByRole("dialog").last();
      await expect(confirm).toBeVisible();
      await expectClean(page, confirm, `${label} · confirmar borrado`);
      if (touch) await expectTouchTargets(confirm, `${label} · confirmar borrado`);
    } finally {
      await context.close();
    }
    void fileInput;
  });
}

test("teclado: Tab no se sale de la hoja, Escape la cierra y el foco vuelve al boton; con movimiento reducido el progreso no gira", async ({ browser, browserName }) => {
  test.skip(USE_REAL_ENGINE, FAKE_ONLY_REASON);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce", locale: "es-ES", acceptDownloads: true });
  await context.addInitScript(([privacy]) => window.localStorage.setItem(privacy, "1"), [PRIVACY_SEEN_KEY]);
  const page = await context.newPage();
  try {
    await installAutofillFakes(page, { delayMs: 800, steps: 6, byName: { "poliza.pdf": POLICY_SPECS } });
    await openSignWith(page, "reclamo.pdf", await makeClaimForm());
    const trigger = autofillButton(page);
    await trigger.focus();
    await page.keyboard.press("Enter");
    const dialog = sheet(page);
    await expect(dialog.locator("[data-autofill-initial]")).toBeFocused();
    // Tab recorre la hoja y vuelve a su inicio sin salir a la pagina de detras. (WebKit en macOS solo tabula a los botones con «acceso
    // completo al teclado» del sistema: alli se comprueba lo demas, no el recorrido con Tab.)
    if (browserName !== "webkit") {
      for (let i = 0; i < 18; i += 1) {
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((root) => root.contains(document.activeElement)), `Tab ${i + 1}`).toBe(true);
      }
    }
    await addFileSource(page, "poliza.pdf", await makePolicyPdf());
    await dialog.getByRole("button", { name: "Leer datos" }).click();
    await expect(dialog.getByRole("progressbar")).toBeVisible();
    const spinning = await dialog.locator("svg.animate-spin").first().evaluate((el) => getComputedStyle(el).animationName);
    expect(spinning).toBe("none");
    await expect(dialog.locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
    // El titulo del paso recibe el foco al cambiar de paso.
    await expect(dialog.locator("[data-autofill-review] h3")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sheet(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await context.close();
  }
});
