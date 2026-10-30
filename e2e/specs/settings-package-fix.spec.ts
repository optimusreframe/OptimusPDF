import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { build } from "vite";
import { downloadFile } from "../helpers/downloads";
import { isBenignEngineNoise } from "../helpers/engine";
import { syntheticContract, type SyntheticContract } from "../helpers/library-packages";
import { en } from "../../src/lib/locales/en";
import { es } from "../../src/lib/locales/es";

/**
 * Correcciones tras la verificación independiente de «Respaldo y traslado» (F4-fix) en un navegador REAL y headless
 * (Chromium y `webkit-ipad`), SIEMPRE con la interfaz:
 *
 *   - H2: exportar SOLO una parte no marca «último respaldo» ni reinicia el recordatorio; la línea dice «parcial».
 *   - H4: un paquete de solo firmas dice «El paquete no incluye: …» y no «no se importó».
 *   - H5: los documentos sin copia del PDF se avisan antes y después de exportar (Ajustes y Mis documentos).
 *   - H8: la vista previa de Ajustes lista qué cambiaría (nombre legible, Ahora → Paquete), marca y omite por defecto lo
 *     sensible, y se decide por ajuste o para todos.
 *   - Cerrar la hoja (Escape, clic fuera, X) MIENTRAS se importa no pierde el resultado.
 *   - axe-core (0 violaciones) en claro/oscuro x ES/EN x 1280/375 sobre lo nuevo, objetivos >= 44 px con puntero grueso y
 *     tipografía ancha sin desbordes a 375 y 320 px.
 *
 *   CSP_SKIP_UPGRADE_INSECURE=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3970 [PW_BROWSERS=webkit-ipad] npx playwright test settings-package-fix
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
test.setTimeout(300_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const FLAGS_KEY = "optimuspdf.signPdf.featureFlags";
const NOTICE_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";

type Language = "es" | "en";
type Theme = "light" | "dark";
const dictOf = (language: Language) => (language === "es" ? es : en);
const copyOf = (language: Language) => dictOf(language).settings.backup;

let labBundle = "";
let contracts: SyntheticContract[] = [];

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
    define: { "process.env.NEXT_PUBLIC_PDFJS_VERSION": JSON.stringify("0"), "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: path.resolve(process.cwd(), "e2e/helpers/package-entry.ts"), name: "PackageLab", formats: ["iife"], fileName: () => "package-lab.js" },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el arnes de preparacion");
  labBundle = chunk.code;
  contracts = [await syntheticContract("c1", "Remediación de moho", 11, 4), await syntheticContract("c2", "Mitigación de agua", 22, 3)];
});

/* ------------------------------------------------------------------ *
 * Ayudantes (los mismos del spec `settings-package`, sin compartirlos para no tocar ese archivo)
 * ------------------------------------------------------------------ */

async function newContext(browser: Browser, opts: { theme?: Theme; language?: Language; width?: number; touch?: boolean } = {}): Promise<BrowserContext> {
  const { theme = "light", language = "es", width = 1280, touch = false } = opts;
  const context = await browser.newContext({
    viewport: { width, height: width < 600 ? 812 : 900 },
    colorScheme: theme,
    locale: language === "es" ? "es-ES" : "en-US",
    acceptDownloads: true,
    hasTouch: touch,
    isMobile: touch,
  });
  await context.addInitScript(
    ([themeName, lang]) => {
      try {
        if (window.sessionStorage.getItem("__seeded")) return;
        window.localStorage.setItem("optimuspdf.theme", themeName);
        window.localStorage.setItem("optimuspdf.language", lang);
        window.localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
        window.sessionStorage.setItem("__seeded", "1");
      } catch {
        /* almacenamiento bloqueado */
      }
    },
    [theme, language],
  );
  // Sin hoja de compartir del sistema: la descarga clasica (en `webkit-ipad` el puntero es tactil y `share` existe).
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    } catch {
      /* no se puede redefinir */
    }
  });
  return context;
}

async function lab<T = unknown>(page: Page, code: string, arg?: unknown): Promise<T> {
  if (!(await page.evaluate(() => "PackageLab" in window))) await page.addScriptTag({ content: labBundle });
  return page.evaluate(
    async ({ source, value }) => {
      const lib = (window as unknown as { PackageLab: Record<string, unknown> }).PackageLab;
      return (new Function("lib", "arg", `return (async () => { ${source} })();`)(lib, value) as Promise<unknown>) as Promise<T>;
    },
    { source: code, value: arg },
  );
}

async function seedSignatures(page: Page, rows: Array<{ name: string; role?: string; seed: number }>): Promise<void> {
  expect(await lab<number>(page, "return await lib.seedSignatures(arg);", rows)).toBe(rows.length);
}

async function putContract(page: Page, contract: SyntheticContract, id = contract.id, name = contract.name): Promise<void> {
  await lab(
    page,
    `const bytes = Uint8Array.from(atob(arg.b64), (c) => c.charCodeAt(0));
     await lib.putDocument({ id: arg.id, name: arg.name, docType: "contrato de servicio", fileName: arg.id + ".pdf", pageCount: arg.fp.pageCount, pageSizes: arg.fp.pageSizes, fingerprint: arg.fp, templateIds: [] }, bytes);`,
    { id, name, b64: contract.buffer.toString("base64"), fp: contract.fingerprint },
  );
}

/** Borra la COPIA del PDF de un documento (su fila sigue diciendo que la tiene): el caso «la copia se perdió». */
async function dropPdfCopy(page: Page, id: string): Promise<void> {
  await page.evaluate(
    (documentId) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("optimuspdf-doc-library");
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("blobs", "readwrite");
          tx.objectStore("blobs").delete(documentId);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      }),
    id,
  );
}

type Counts = { signatures: number; documents: number; templates: number; drafts: number };
const counts = (page: Page) => lab<Counts>(page, "return await lib.counts();");
const ZERO: Counts = { signatures: 0, documents: 0, templates: 0, drafts: 0 };
const readStorage = (page: Page) =>
  page.evaluate(() => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i) as string, localStorage.getItem(localStorage.key(i) as string)])));

async function wipeBrowser(page: Page): Promise<void> {
  await page.goto("/privacy");
  await page.evaluate(async () => {
    const names = ["optimuspdf-sign-drafts", "optimuspdf-edit-drafts", "optimuspdf-pro-drafts", "optimuspdf-signature-vault", "optimuspdf-doc-library"];
    await Promise.all(
      names.map(
        (name) =>
          new Promise<void>((resolve) => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
          }),
      ),
    );
    localStorage.removeItem("optimuspdf.lastBackup");
    localStorage.removeItem("optimuspdf.lastBackupParts");
    localStorage.removeItem("optimuspdf.backupReminder");
  });
  await page.reload();
  await expect.poll(() => counts(page)).toEqual(ZERO);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !isBenignEngineNoise(message.text())) errors.push(message.text());
  });
  page.on("pageerror", (error) => {
    if (!isBenignEngineNoise(error.message)) errors.push(error.message);
  });
  return errors;
}

async function openSettings(page: Page, language: Language = "es"): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 2, name: copyOf(language).title })).toBeVisible();
}

async function setCheckbox(dialog: Locator, name: string | RegExp, wanted: boolean): Promise<void> {
  const checkbox = dialog.getByRole("checkbox", { name });
  if ((await checkbox.isChecked()) !== wanted) await dialog.locator("label").filter({ hasText: name }).first().click();
  await expect(checkbox).toBeChecked({ checked: wanted });
}

async function openExport(page: Page, language: Language = "es"): Promise<Locator> {
  const copy = copyOf(language);
  await page.getByRole("button", { name: copy.exportAction, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.exportTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-backup-summary]")).toContainText(language === "es" ? "Se exportará" : "Will be exported", { timeout: 30_000 });
  return dialog;
}

const MODULE_LABELS: Record<Language, Record<"signatures" | "library" | "drafts" | "settings", RegExp>> = {
  es: { signatures: /^Firmas guardadas/, library: /^Plantillas y documentos/, drafts: /^Borradores en curso/, settings: /^Ajustes/ },
  en: { signatures: /^Saved signatures/, library: /^Templates and documents/, drafts: /^Drafts in progress/, settings: /^Settings/ },
};

/** Exporta con la interfaz SOLO los módulos pedidos, sin contraseña, y cierra la hoja. */
async function exportOnly(page: Page, keep: Array<"signatures" | "library" | "drafts" | "settings">, language: Language = "es", close = true): Promise<{ bytes: Buffer; filename: string; dialog: Locator }> {
  const copy = copyOf(language);
  const dialog = await openExport(page, language);
  // La contraseña primero: con la decisión explícita, cambiar los módulos ya no la recalcula (la recomendada depende de ellos).
  await setCheckbox(dialog, copy.protect, false);
  for (const name of ["signatures", "library", "drafts", "settings"] as const) await setCheckbox(dialog, MODULE_LABELS[language][name], keep.includes(name));
  const { bytes, filename } = await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
  await expect(dialog.getByRole("button", { name: copy.doneClose })).toBeVisible();
  if (close) {
    await dialog.getByRole("button", { name: copy.doneClose }).click();
    await expect(dialog).toBeHidden();
  }
  return { bytes, filename, dialog };
}

async function openImport(page: Page, language: Language, file?: { filename: string; bytes: Buffer }): Promise<Locator> {
  const copy = copyOf(language);
  await page.getByRole("button", { name: copy.importAction, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.importTitle });
  await expect(dialog).toBeVisible();
  if (file) await dialog.locator("[data-backup-file-input]").setInputFiles({ name: file.filename, mimeType: "application/zip", buffer: file.bytes });
  return dialog;
}

const moduleOf = (dialog: Locator, name: string) => dialog.locator(`[data-backup-module="${name}"]`);
const rowOf = (dialog: Locator, id: string) => dialog.locator(`[data-backup-setting-row="${id}"]`);

/* ------------------------------------------------------------------ *
 * H2 — exportar solo una parte
 * ------------------------------------------------------------------ */

test("H2: exportar SOLO Ajustes no marca «último respaldo» ni reinicia el recordatorio; la línea dice «parcial»; luego las firmas completan", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    await page.goto("/privacy");
    await seedSignatures(page, [{ name: "Ana Pérez", seed: 1 }, { name: "Luis Gómez", seed: 2 }]);
    await page.evaluate(() => localStorage.setItem("optimuspdf.backupReminder", JSON.stringify({ changes: 12, by: { signatures: 12 }, since: new Date().toISOString() })));
    await openSettings(page);
    await expect(page.locator("[data-backup-reminder]")).toBeVisible();
    expect(await page.locator("[data-backup-last]").textContent()).toBe(es.settings.backup.lastNever);

    await exportOnly(page, ["settings"]);
    const afterSettings = await readStorage(page);
    expect(afterSettings["optimuspdf.lastBackup"]).toBeUndefined();
    expect(JSON.parse(afterSettings["optimuspdf.backupReminder"] as string)).toMatchObject({ changes: 12, by: { signatures: 12 } });
    expect(JSON.parse(afterSettings["optimuspdf.lastBackupParts"] as string)).toHaveProperty("settings");
    await expect(page.locator("[data-backup-last]")).toHaveText("Último respaldo parcial (Ajustes): hoy. Aún no has hecho un respaldo completo.");
    // Lo que importa (las firmas) sigue sin respaldar: el aviso sigue ahí.
    await expect(page.locator("[data-backup-reminder]")).toBeVisible();

    await exportOnly(page, ["signatures"]);
    const afterSignatures = await readStorage(page);
    expect(afterSignatures["optimuspdf.lastBackup"]).toBeTruthy();
    expect(afterSignatures["optimuspdf.backupReminder"]).toBeUndefined();
    await expect(page.locator("[data-backup-last]")).toHaveText(es.settings.backup.lastToday);
    await expect(page.locator("[data-backup-reminder]")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * H4 — «El paquete no incluye esto»
 * ------------------------------------------------------------------ */

for (const language of ["es", "en"] as const) {
  test(`H4 (${language.toUpperCase()}): un paquete de solo firmas dice qué NO incluye y no «no se importó»`, async ({ browser }) => {
    const copy = copyOf(language);
    const context = await newContext(browser, { language });
    const page = await context.newPage();
    try {
      await page.goto("/privacy");
      await seedSignatures(page, [{ name: "Ana Pérez", seed: 1 }]);
      await openSettings(page, language);
      const exported = await exportOnly(page, ["signatures"], language);
      await wipeBrowser(page);
      await openSettings(page, language);
      const dialog = await openImport(page, language, exported);
      await expect(moduleOf(dialog, "signatures")).toBeVisible({ timeout: 60_000 });
      await dialog.locator("[data-backup-confirm]").click();
      const result = dialog.locator("[data-backup-result]");
      await expect(result).toBeVisible({ timeout: 30_000 });
      const names = copy.moduleNames;
      await expect(result.locator("li")).toHaveText([
        copy.resultSignatures.replace("{n}", "1"),
        copy.resultAbsent.replace("{names}", `${names.library}, ${names.drafts}, ${names.scanSessions}, ${names.settings}`),
      ]);
      await expect(result).not.toContainText(language === "es" ? "no se importó" : "not imported");
      expect((await counts(page)).signatures).toBe(1);
    } finally {
      await context.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * H5 — documentos sin copia del PDF
 * ------------------------------------------------------------------ */

test("H5: un documento sin copia del PDF se avisa antes y después de exportar (Ajustes y Mis documentos)", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  try {
    await page.goto("/privacy");
    await putContract(page, contracts[0]);
    await putContract(page, contracts[1]);
    await dropPdfCopy(page, contracts[1].id);

    // Ajustes
    await openSettings(page);
    const dialog = await openExport(page);
    await expect(dialog.locator("[data-backup-summary]")).toContainText("1 documento");
    await expect(dialog.locator("[data-backup-without-copy]")).toHaveText("1 documento no se incluirá porque falta su copia del PDF.");
    await setCheckbox(dialog, es.settings.backup.protect, false);
    const { bytes } = await downloadFile(page, () => dialog.getByRole("button", { name: es.settings.backup.exportConfirm }).click());
    await expect(dialog.locator("[data-backup-note]")).toHaveText("1 documento no se incluyó porque falta su copia del PDF.");
    expect(bytes.byteLength).toBeGreaterThan(0);
    await dialog.getByRole("button", { name: es.settings.backup.doneClose }).click();

    // Mis documentos
    await page.goto("/documents");
    await page.getByRole("button", { name: es.documents.backup.exportAction }).click();
    const sheet = page.getByRole("dialog", { name: es.documents.backup.exportTitle });
    await expect(sheet.getByText("1 documento no tiene copia del PDF y no se incluirá.")).toBeVisible();
    await sheet.getByRole("checkbox", { name: es.documents.backup.protect }).uncheck({ force: true }).catch(async () => {
      await sheet.locator("label").filter({ hasText: es.documents.backup.protect }).first().click();
    });
    await downloadFile(page, () => sheet.getByRole("button", { name: es.documents.backup.exportConfirm }).click());
    await expect(sheet.locator("[data-backup-note]")).toHaveText("1 documento no se incluyó porque falta su copia del PDF.");
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * H8 — Ajustes: qué cambiaría
 * ------------------------------------------------------------------ */

/** Un paquete de SOLO ajustes con `packaged`, hecho con la propia interfaz; luego el navegador queda con `local`. */
async function settingsPackage(page: Page, language: Language, packaged: Record<string, string>, local: Record<string, string>): Promise<{ bytes: Buffer; filename: string }> {
  await page.goto("/privacy");
  await page.evaluate((values) => Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value)), packaged);
  await openSettings(page, language);
  const exported = await exportOnly(page, ["settings"], language);
  await page.evaluate(
    ([values, notice]) => {
      // El navegador local arranca SIN el aviso de privacidad de Firmar visto (la preparación del contexto lo pone), salvo que se pida.
      if (!Object.hasOwn(values, notice)) localStorage.removeItem(notice);
      Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
    },
    [local, NOTICE_KEY] as [Record<string, string>, string],
  );
  return exported;
}

const PACKAGED = (theme: Theme) => ({
  "optimuspdf.theme": theme,
  [FLAGS_KEY]: JSON.stringify({ keyboardNav: false, signatureVault: false }),
  [NOTICE_KEY]: "1",
});
const LOCAL = (theme: Theme) => ({
  "optimuspdf.theme": theme,
  [FLAGS_KEY]: JSON.stringify({ keyboardNav: true, signatureVault: true }),
});

for (const language of ["es", "en"] as const) {
  test(`H8 (${language.toUpperCase()}): la vista previa de Ajustes lista qué cambiaría, marca y omite lo sensible, y se decide por ajuste o para todos`, async ({ browser }) => {
    const copy = copyOf(language);
    const dict = dictOf(language);
    const context = await newContext(browser, { language, theme: "light" });
    const page = await context.newPage();
    const errors = trackErrors(page);
    try {
      const exported = await settingsPackage(page, language, PACKAGED("dark"), LOCAL("light"));
      await page.reload();
      const dialog = await openImport(page, language, exported);
      await expect(moduleOf(dialog, "settings")).toBeVisible({ timeout: 60_000 });
      // Una fila por ajuste que cambia, con nombre legible (nunca la clave técnica).
      await expect(dialog.locator("[data-backup-setting-row]")).toHaveCount(4);
      const group = (name: string) => copy.settingGroups[name as keyof typeof copy.settingGroups];
      await expect(rowOf(dialog, "optimuspdf.theme")).toContainText(`${group("appearance")} · ${copy.settingNames.theme}`);
      await expect(rowOf(dialog, `${FLAGS_KEY}#signatureVault`)).toContainText(`${group("sign")} · ${dict.settings.signPdfFeatures.signatureVault.label}`);
      await expect(rowOf(dialog, `${FLAGS_KEY}#keyboardNav`)).toContainText(dict.settings.signPdfFeatures.keyboardNav.label);
      await expect(moduleOf(dialog, "settings")).not.toContainText("optimuspdf.");
      // Lo sensible: marcado y en «Omitir»; lo demás, en «Reemplazar».
      await expect(rowOf(dialog, NOTICE_KEY).locator("[data-backup-setting-sensitive]")).toHaveText(copy.settingSensitiveBadge);
      await expect(rowOf(dialog, `${FLAGS_KEY}#signatureVault`).locator("[data-backup-setting-sensitive]")).toBeVisible();
      await expect(rowOf(dialog, "optimuspdf.theme").locator("[data-backup-setting-sensitive]")).toHaveCount(0);
      await expect(rowOf(dialog, NOTICE_KEY).getByRole("radio", { name: copy.decisionOmit })).toHaveAttribute("aria-checked", "true");
      await expect(rowOf(dialog, `${FLAGS_KEY}#signatureVault`).getByRole("radio", { name: copy.decisionOmit })).toHaveAttribute("aria-checked", "true");
      await expect(rowOf(dialog, "optimuspdf.theme").getByRole("radio", { name: copy.decisionReplace })).toHaveAttribute("aria-checked", "true");
      await expect(dialog.locator("[data-backup-confirm]")).toHaveText(copy.importConfirmMany.replace("{n}", "2"));

      // «Omitir todos» -> nada; «Reemplazar todos» -> 3 ajustes (incluidos los sensibles).
      await dialog.getByRole("radio", { name: copy.decisionOmitAll }).click();
      await expect(dialog.locator("[data-backup-confirm]")).toBeDisabled();
      await dialog.getByRole("radio", { name: copy.decisionReplaceAll }).click();
      await expect(dialog.locator("[data-backup-confirm]")).toHaveText(copy.importConfirmMany.replace("{n}", "3"));
      // Por ajuste: solo el tema y el interruptor sensible «Firmas guardadas».
      await dialog.getByRole("radio", { name: copy.decisionOmitAll }).click();
      await rowOf(dialog, "optimuspdf.theme").getByRole("radio", { name: copy.decisionReplace }).click();
      await rowOf(dialog, `${FLAGS_KEY}#signatureVault`).getByRole("radio", { name: copy.decisionReplace }).click();
      await expect(dialog.locator("[data-backup-confirm]")).toHaveText(copy.importConfirmMany.replace("{n}", "2"));
      await dialog.locator("[data-backup-confirm]").click();
      await expect(dialog.locator("[data-backup-result]")).toContainText(copy.resultSettings.replace("{n}", "2"), { timeout: 30_000 });
      const stored = await readStorage(page);
      expect(stored["optimuspdf.theme"]).toBe("dark");
      expect(JSON.parse(stored[FLAGS_KEY] as string)).toEqual({ keyboardNav: true, signatureVault: false });
      expect(stored[NOTICE_KEY]).toBeUndefined(); // lo sensible que no se eligió se queda como estaba
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test("H8: con las decisiones sugeridas lo sensible NO se escribe", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  try {
    const exported = await settingsPackage(page, "es", PACKAGED("dark"), { ...LOCAL("light") });
    await page.reload();
    const dialog = await openImport(page, "es", exported);
    await expect(moduleOf(dialog, "settings")).toBeVisible({ timeout: 60_000 });
    await dialog.locator("[data-backup-confirm]").click();
    await expect(dialog.locator("[data-backup-result]")).toContainText("Ajustes: 2 aplicados.", { timeout: 30_000 });
    const stored = await readStorage(page);
    expect(stored["optimuspdf.theme"]).toBe("dark");
    // keyboardNav cambia; la firma guardada (sensible) y el aviso de privacidad se quedan como estaban.
    expect(JSON.parse(stored[FLAGS_KEY] as string)).toEqual({ keyboardNav: false, signatureVault: true });
    expect(stored[NOTICE_KEY]).toBeUndefined();
    await expect(dialog.locator("[data-backup-reload]")).toBeVisible();
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * Cerrar la hoja mientras se aplica la importación
 * ------------------------------------------------------------------ */

test("Escape, clic fuera y la X NO cierran la hoja mientras se aplica la importación: el resultado se conserva", async ({ browser }) => {
  const context = await newContext(browser);
  // Frena (9 s por llamada) el SHA-256 que la importación repite al aplicar, para tener un hueco real de tiempo.
  await context.addInitScript(() => {
    const proto = (window.SubtleCrypto ?? ({} as { prototype?: SubtleCrypto })).prototype as SubtleCrypto | undefined;
    if (!proto) return;
    const original = proto.digest;
    proto.digest = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto["digest"]>) {
      const delay = (window as unknown as { __digestDelay?: number }).__digestDelay ?? 0;
      return delay > 0 ? new Promise<ArrayBuffer>((resolve, reject) => setTimeout(() => original.apply(this, args).then(resolve, reject), delay)) : original.apply(this, args);
    } as SubtleCrypto["digest"];
  });
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    await page.goto("/privacy");
    await putContract(page, contracts[0]);
    await openSettings(page);
    const exported = await exportOnly(page, ["library"]);
    await wipeBrowser(page);
    await openSettings(page);
    const copy = es.settings.backup;
    const dialog = await openImport(page, "es", exported);
    await expect(moduleOf(dialog, "library")).toBeVisible({ timeout: 90_000 });
    await page.evaluate(() => ((window as unknown as { __digestDelay: number }).__digestDelay = 9000));
    await dialog.locator("[data-backup-confirm]").click();
    await expect(dialog.getByRole("status")).toContainText("Importando", { timeout: 10_000 });

    await expect(dialog.getByRole("button", { name: es.common.close })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("status")).toContainText(copy.closeBusy);
    // Clic fuera (el fondo) y la X: se disparan sin esperas de accionabilidad para no gastar el hueco de tiempo.
    await page.evaluate((closeLabel) => {
      (document.querySelector("[data-sheet-scrim]") as HTMLElement).click();
      (document.querySelector(`[role="dialog"] button[aria-label="${closeLabel}"]`) as HTMLElement).click();
    }, es.common.close);
    await expect(dialog.getByRole("status")).toContainText(copy.closeBusy);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: es.common.close })).toHaveAttribute("aria-disabled", "true");

    await expect(dialog.locator("[data-backup-result]")).toContainText("Plantillas y documentos: 1 documento", { timeout: 30_000 });
    await expect(dialog.getByRole("button", { name: es.common.close })).not.toHaveAttribute("aria-disabled", "true");
    expect((await counts(page)).documents).toBe(1);
    await page.evaluate(() => ((window as unknown as { __digestDelay: number }).__digestDelay = 0));
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * Accesibilidad (axe), objetivos táctiles y tipografía ancha
 * ------------------------------------------------------------------ */

const AXE_RULES = [
  "color-contrast", "aria-valid-attr-value", "aria-valid-attr", "aria-allowed-attr", "aria-required-attr", "aria-required-children",
  "aria-required-parent", "aria-roles", "aria-hidden-focus", "label", "button-name", "link-name", "image-alt", "nested-interactive",
  "duplicate-id-aria", "tabindex", "list", "listitem", "target-size",
] as const;

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
const describeViolations = (violations: Violation[]) => violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n");

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

async function expectTouchTargets(root: Locator, label: string): Promise<void> {
  const small = await root.evaluate((container) => {
    const bad: string[] = [];
    for (const element of container.querySelectorAll<HTMLElement>('button, [role="radio"], input[type="checkbox"], a[href]')) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (element.closest(".sr-only") || element.classList.contains("sr-only")) continue;
      let box = element.getBoundingClientRect();
      if (element instanceof HTMLInputElement && element.type === "checkbox") {
        const row = element.closest("div.group") ?? element.parentElement;
        if (row) box = row.getBoundingClientRect();
      }
      if (box.width < 1 || box.height < 1) continue;
      if (box.height < 43.5 || box.width < 24) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return bad;
  });
  expect(small, `${label}: objetivos de toque menores de 44 px`).toEqual([]);
}

async function expectClean(page: Page, root: Locator, label: string): Promise<void> {
  await settle(page, root);
  const violations = await axeOn(page, root);
  expect(violations, `${label}\n${describeViolations(violations)}`).toEqual([]);
  await expectTouchTargets(root, label);
}

async function overflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const width = root.clientWidth;
    const offenders: string[] = [];
    for (const element of document.querySelectorAll("body *")) {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1.5 || rect.height <= 1.5) continue;
      if (rect.right <= width + 1 && rect.left >= -1) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      let clipped = false;
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const ox = getComputedStyle(parent).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") clipped = true;
      }
      if (!clipped) offenders.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
    return { overflow: root.scrollWidth - width, offenders: offenders.slice(0, 6) };
  });
}

type Cell = { theme: Theme; language: Language; width: number };
const CELLS: Cell[] = [];
for (const theme of ["light", "dark"] as const) for (const language of ["es", "en"] as const) for (const width of [1280, 375]) CELLS.push({ theme, language, width });

test.describe("axe-core en lo nuevo: 0 violaciones", () => {
  for (const cell of CELLS) {
    test(`${cell.theme} · ${cell.language.toUpperCase()} · ${cell.width}px`, async ({ browser }) => {
      const copy = copyOf(cell.language);
      const tag = `${cell.theme}/${cell.language}/${cell.width}`;
      const context = await newContext(browser, { ...cell, touch: cell.width < 600 });
      const page = await context.newPage();
      try {
        await page.clock.setFixedTime(new Date("2026-10-15T12:00:00.000Z"));
        // Estado: una firma, un contrato con su copia, otro SIN copia y ajustes; un paquete de ajustes con filas sensibles.
        await page.goto("/privacy");
        await seedSignatures(page, [{ name: "Ana Pérez", seed: 1 }]);
        await putContract(page, contracts[0]);
        await putContract(page, contracts[1]);
        await dropPdfCopy(page, contracts[1].id);
        await openSettings(page, cell.language);
        await page.waitForTimeout(800);

        // Exportar con el aviso «sin copia» -> resultado con la nota -> línea «parcial» (solo Ajustes) en la sección.
        const dialog = await openExport(page, cell.language);
        await expect(dialog.locator("[data-backup-without-copy]")).toBeVisible();
        await expectClean(page, dialog, `${tag} · exportar con aviso sin copia`);
        await setCheckbox(dialog, copy.protect, false);
        await setCheckbox(dialog, MODULE_LABELS[cell.language].signatures, false);
        await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
        await expect(dialog.locator("[data-backup-note]")).toBeVisible();
        await expectClean(page, dialog, `${tag} · exportar hecho con nota`);
        await dialog.getByRole("button", { name: copy.doneClose }).click();
        await expect(dialog).toBeHidden();
        await expect(page.locator("[data-backup-last]")).toContainText(cell.language === "es" ? "Último respaldo parcial" : "Last partial backup");
        await expectClean(page, page.locator("[data-settings-backup]"), `${tag} · sección con respaldo parcial`);

        // Importar un paquete de ajustes: vista previa con filas (sensibles y no) y resultado con «no incluye».
        const exported = await settingsPackage(page, cell.language, PACKAGED(cell.theme === "dark" ? "light" : "dark"), LOCAL(cell.theme));
        await page.reload();
        await page.waitForTimeout(600);
        const importDialog = await openImport(page, cell.language, exported);
        await expect(moduleOf(importDialog, "settings")).toBeVisible({ timeout: 60_000 });
        await expect(importDialog.locator("[data-backup-setting-row]")).toHaveCount(4);
        await expectClean(page, importDialog, `${tag} · vista previa de ajustes con filas`);
        await importDialog.getByRole("radio", { name: copy.decisionReplaceAll }).click();
        await importDialog.locator("[data-backup-confirm]").click();
        await expect(importDialog.locator("[data-backup-result]")).toBeVisible({ timeout: 30_000 });
        await expect(importDialog.locator("[data-backup-result]")).toContainText(cell.language === "es" ? "El paquete no incluye" : "The package does not include");
        await expectClean(page, importDialog, `${tag} · resultado con «no incluye»`);
      } finally {
        await context.close();
      }
    });
  }
});

test.describe("sin desbordes con tipografía ancha (375 y 320 px)", () => {
  const WIDE_CSS = `html *, html *::before, html *::after { font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important; letter-spacing: 0.06em !important; }`;

  for (const language of ["es", "en"] as const) {
    test(`vista previa de ajustes, exportar con aviso y línea parcial caben a 375 y 320 px (${language.toUpperCase()})`, async ({ browser }) => {
      const copy = copyOf(language);
      const context = await newContext(browser, { theme: "dark", language, width: 375, touch: true });
      await context.addInitScript((css) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }, WIDE_CSS);
      const page = await context.newPage();
      try {
        await page.clock.setFixedTime(new Date("2026-10-15T12:00:00.000Z"));
        const longName = "Un nombre bastante largo para comprobar que el corte de líneas funciona con tipografía ancha";
        await page.goto("/privacy");
        await putContract(page, contracts[0], "largo", longName);
        await putContract(page, contracts[1], "largo2", `${longName} sin copia`);
        await dropPdfCopy(page, "largo2");
        const exported = await settingsPackage(page, language, PACKAGED("light"), LOCAL("dark"));
        await page.reload();
        // Partes del paquete (solo ajustes) -> la sección dice «parcial».
        for (const width of [375, 320]) {
          await page.setViewportSize({ width, height: 812 });
          await page.waitForTimeout(400);
          const measured = await overflow(page);
          expect(measured.overflow, `sección · ${language} · ${width}px`).toBeLessThanOrEqual(1);
          expect(measured.offenders, `sección · ${language} · ${width}px`).toEqual([]);
          await expectTouchTargets(page.locator("[data-settings-backup]"), `sección · ${language} · ${width}px`);
        }
        const states: Array<[string, () => Promise<Locator>]> = [
          ["exportar con aviso", async () => {
            const dialog = await openExport(page, language);
            await expect(dialog.locator("[data-backup-without-copy]")).toBeVisible();
            return dialog;
          }],
          ["importar · vista previa de ajustes", async () => {
            const dialog = await openImport(page, language, exported);
            await expect(moduleOf(dialog, "settings")).toBeVisible({ timeout: 60_000 });
            return dialog;
          }],
        ];
        for (const [label, open] of states) {
          for (const width of [375, 320]) {
            await page.setViewportSize({ width, height: 812 });
            const dialog = await open();
            await settle(page, dialog);
            const measured = await overflow(page);
            expect(measured.overflow, `${label} · ${language} · ${width}px`).toBeLessThanOrEqual(1);
            expect(measured.offenders, `${label} · ${language} · ${width}px`).toEqual([]);
            const violations = await axeOn(page, dialog);
            expect(violations, `${label} · ${language} · ${width}px\n${describeViolations(violations)}`).toEqual([]);
            await expectTouchTargets(dialog, `${label} · ${language} · ${width}px`);
            await page.keyboard.press("Escape");
            await expect(dialog).toBeHidden();
          }
        }
        expect(copy.title.length).toBeGreaterThan(0);
      } finally {
        await context.close();
      }
    });
  }
});
