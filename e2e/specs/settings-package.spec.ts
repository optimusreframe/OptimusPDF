import { readFileSync } from "node:fs";
import path from "node:path";
import { chromium, devices, expect, test, webkit, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import JSZip from "jszip";
import { build } from "vite";
import { downloadFile } from "../helpers/downloads";
import { isBenignEngineNoise, isExternalNetworkUrl } from "../helpers/engine";
import { syntheticContract, type SyntheticContract } from "../helpers/library-packages";
import { embeddedImages, pngPixels, sameShape } from "../helpers/pdf-images";
import { collectAllSignatures, draftedStrokeCount, expectCollectedWorkRestored, makeTwoDocs, readStoredGroups } from "../helpers/sign-flow";
import { fingerprint, readVault } from "../helpers/sign-vault-flow";
import { hostileCorpus } from "../../src/lib/backup/__fixtures__/hostileCorpus";
import { en } from "../../src/lib/locales/en";
import { es } from "../../src/lib/locales/es";

/**
 * «Respaldo y traslado» de Ajustes (U4.7) en un navegador REAL y headless (Chromium y `webkit-ipad`), SIEMPRE con la interfaz:
 *
 *   - preparar firmas + 2 contratos con plantilla + un borrador de Firmar con trazos + ajustes (tema oscuro, inglés) ->
 *     «Exportar mi paquete» con contraseña -> borrar TODO (IndexedDB y localStorage) -> «Importar paquete» (contraseña mala
 *     rechazada sin escribir) -> firmas, plantillas, documentos, borrador (Recientes -> Continuar, y el PDF final lleva las
 *     firmas) y ajustes presentes tras recargar -> añadir una firma -> reexportar -> importar sobre lo existente: fusiona
 *     sin duplicar;
 *   - un paquete de solo firmas y los dorados `package-all-v1*` entran por la misma vía;
 *   - zips hostiles rechazados en < 2 s sin escribir nada;
 *   - recordatorio de respaldo (10 cambios; 30 días con el reloj movido; «Recordármelo luego»), solo en Ajustes y Mis documentos;
 *   - axe-core (0 violaciones) en claro/oscuro x ES/EN x 1280/375 y tipografia ancha sin desbordes a 375/320 px.
 *
 *   CSP_SKIP_UPGRADE_INSECURE=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3969 [PW_BROWSERS=webkit-ipad] npx playwright test settings-package
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
test.setTimeout(300_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const PACKAGES = path.resolve(process.cwd(), "src/lib/backup/__fixtures__/packages");
const PASSWORD = "clave-segura-1";
const GOLDEN_PASSWORD = "dorada-2026";
const FILENAME = /^OptimusPDF-paquete-\d{4}-\d{2}-\d{2}\.optimuspdf\.zip$/;
const DAY = 86_400_000;

type Language = "es" | "en";
type Theme = "light" | "dark";
const copyOf = (language: Language) => (language === "es" ? es : en).settings.backup;

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
  contracts = [
    await syntheticContract("c1", "Remediación de moho", 11, 4),
    await syntheticContract("c2", "Mitigación de agua", 22, 3),
    await syntheticContract("c3", "Prueba de moho", 33, 5),
  ];
});

/* ------------------------------------------------------------------ *
 * Ayudantes de entorno y de estado
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
  return context;
}

/** Sin hoja de compartir del sistema: la descarga clasica (en `webkit-ipad` el puntero es tactil y `share` existe). */
async function noShare(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
    } catch {
      /* no se puede redefinir */
    }
  });
}

/** Ejecuta `code` en la pagina con `lib` (el arnes de preparacion) y `arg`. */
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

type Counts = { signatures: number; documents: number; templates: number; drafts: number };
const counts = (page: Page) => lab<Counts>(page, "return await lib.counts();");
const ZERO: Counts = { signatures: 0, documents: 0, templates: 0, drafts: 0 };

async function seedSignatures(page: Page, rows: Array<{ name: string; role?: string; seed: number }>): Promise<void> {
  expect(await lab<number>(page, "return await lib.seedSignatures(arg);", rows)).toBe(rows.length);
}

/** Guarda un contrato con su PDF y la huella calculada en Node (la misma que daria el navegador). */
async function putContract(page: Page, contract: SyntheticContract, id = contract.id, name = contract.name): Promise<void> {
  await lab(
    page,
    `const bytes = Uint8Array.from(atob(arg.b64), (c) => c.charCodeAt(0));
     await lib.putDocument({ id: arg.id, name: arg.name, docType: "contrato de servicio", fileName: arg.id + ".pdf", pageCount: arg.fp.pageCount, pageSizes: arg.fp.pageSizes, fingerprint: arg.fp, templateIds: [] }, bytes);`,
    { id, name, b64: contract.buffer.toString("base64"), fp: contract.fingerprint },
  );
}

async function addTemplate(page: Page, documentId: string, kind: "ready" | "single"): Promise<void> {
  await lab(
    page,
    `await lib.createTemplate(arg.kind === "ready" ? lib.sampleDraft(arg.id, { name: "Plantilla " + arg.id }) : lib.sampleDraft(arg.id, { name: "Plantilla " + arg.id, variants: { "1": lib.variantOf([lib.signField()]), "2": lib.variantOf([]) } }), { newId: () => "tpl-" + arg.id });`,
    { id: documentId, kind },
  );
}

type Stored = { id: string; name: string; hash: string; templateIds: string[] };
async function storedDocs(page: Page): Promise<Stored[]> {
  return lab<Stored[]>(
    page,
    `const { documents } = await lib.listDocuments();
     const out = [];
     for (const d of documents) {
       const bytes = await lib.getDocumentBytes(d.id);
       const digest = bytes ? await crypto.subtle.digest("SHA-256", bytes) : null;
       out.push({ id: d.id, name: d.name, templateIds: d.templateIds, hash: digest ? Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("") : "" });
     }
     return out.sort((a, b) => a.id.localeCompare(b.id));`,
  );
}

const templateIds = (page: Page) => lab<string[]>(page, "return (await lib.listTemplates()).templates.map((t) => t.id).sort();");

const readStorage = (page: Page) =>
  page.evaluate(() => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i) as string, localStorage.getItem(localStorage.key(i) as string)])));

/** «Un navegador nuevo»: borra todas las bases de datos de la app, `localStorage` y `sessionStorage`. */
async function wipeBrowser(page: Page): Promise<void> {
  await page.goto("/privacy"); // una pagina SIN autoguardado: nada vuelve a escribir lo que se borra
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
    localStorage.clear();
    sessionStorage.clear();
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

/* ------------------------------------------------------------------ *
 * Ayudantes de interfaz
 * ------------------------------------------------------------------ */

async function openSettings(page: Page, language: Language = "es"): Promise<void> {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 2, name: copyOf(language).title })).toBeVisible();
}

/** La casilla es un input sin apariencia bajo su etiqueta: se alterna pulsando la etiqueta. */
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
  await expect(dialog.locator("[data-backup-summary]")).not.toContainText(copy.summaryLoading, { timeout: 30_000 });
  await expect(dialog.locator("[data-backup-summary]")).toContainText(language === "es" ? "Se exportará" : "Will be exported", { timeout: 30_000 });
  return dialog;
}

async function exportFile(page: Page, opts: { language?: Language; password?: string | null; uncheck?: Array<string | RegExp> } = {}): Promise<{ bytes: Buffer; filename: string; dialog: Locator }> {
  const language = opts.language ?? "es";
  const copy = copyOf(language);
  const dialog = await openExport(page, language);
  for (const name of opts.uncheck ?? []) await setCheckbox(dialog, name, false);
  if (opts.password === null) {
    await setCheckbox(dialog, copy.protect, false);
  } else {
    await dialog.getByLabel(copy.password, { exact: true }).fill(opts.password ?? PASSWORD);
    await dialog.getByLabel(copy.confirmPassword).fill(opts.password ?? PASSWORD);
  }
  const { bytes, filename } = await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
  await expect(dialog.getByRole("button", { name: copy.doneClose })).toBeVisible();
  return { bytes, filename, dialog };
}

async function openImport(page: Page, language: Language = "es", file?: { name: string; buffer: Buffer }): Promise<Locator> {
  const copy = copyOf(language);
  await page.getByRole("button", { name: copy.importAction, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.importTitle });
  await expect(dialog).toBeVisible();
  if (file) await dialog.locator("[data-backup-file-input]").setInputFiles({ name: file.name, mimeType: "application/zip", buffer: file.buffer });
  return dialog;
}

const moduleOf = (dialog: Locator, name: string) => dialog.locator(`[data-backup-module="${name}"]`);
const itemsOf = (dialog: Locator, name: string) => moduleOf(dialog, name).locator("[data-backup-item]");
const statusesOf = async (dialog: Locator, name: string) => itemsOf(dialog, name).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-status")));
const golden = (name: string) => ({ name, buffer: readFileSync(path.join(PACKAGES, name)) });

/* ------------------------------------------------------------------ *
 * 1. El recorrido completo
 * ------------------------------------------------------------------ */

test("firmas + 2 contratos con plantilla + borrador con trazos + ajustes: exportar con contraseña, borrar todo, importar, retomar y fusionar sin duplicar", async ({ browser }) => {
  const context = await newContext(browser);
  await noShare(context);
  const page = await context.newPage();
  const errors = trackErrors(page);
  // Nada sale del dispositivo: ninguna peticion a un servidor ajeno en todo el recorrido.
  const external: string[] = [];
  page.on("request", (request) => {
    if (isExternalNetworkUrl(new URL(request.url()))) external.push(request.url());
  });
  try {
    const docs = await makeTwoDocs();

    // ---- Preparar: trabajo REAL en Firmar (4 firmas), firmas guardadas, 2 contratos con plantilla y ajustes ----
    await collectAllSignatures(page, docs);
    await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBe(4);
    const groups = await readStoredGroups(page);
    const shapes = await Promise.all(groups.map((group) => pngPixels(group.signature as string)));
    await page.goto("/privacy");
    await seedSignatures(page, [{ name: "Ana Pérez", role: "Directora", seed: 1 }, { name: "Luis Gómez", seed: 2 }]);
    await putContract(page, contracts[0]);
    await putContract(page, contracts[1]);
    await addTemplate(page, contracts[0].id, "ready");
    await addTemplate(page, contracts[1].id, "single");
    await page.evaluate(() => localStorage.setItem("optimuspdf.valueHistory", JSON.stringify({ version: 1, entries: { "nombre del asegurado": [{ value: "Maria Lopez", lastUsedAt: "2026-10-10T10:00:00.000Z" }] } })));
    await expect.poll(() => counts(page)).toEqual({ signatures: 2, documents: 2, templates: 2, drafts: 1 });
    const vaultBefore = fingerprint(await readVault(page));
    const docsBefore = await storedDocs(page);
    const templatesBefore = await templateIds(page);

    // Ajustes: tema oscuro e inglés, con la interfaz.
    await openSettings(page);
    await page.getByRole("tab", { name: "Oscuro" }).click();
    await page.getByRole("tab", { name: "Inglés" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await page.locator("[data-backup-last]").textContent()).toBe(en.settings.backup.lastNever);

    // ---- Exportar (EN): una casilla por módulo con su recuento; el historial de valores NO viene marcado ----
    const copyEn = en.settings.backup;
    const dialog = await openExport(page, "en");
    await expect(dialog.getByRole("checkbox", { name: /^Saved signatures \(2 signatures\)/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Templates and documents \(2 documents, 2 templates\)/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Drafts in progress \(1 draft\)/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Settings \(\d+ settings\)/ })).toBeChecked();
    await expect(dialog.getByRole("checkbox", { name: /^Include the value history \(1 label\)/ })).not.toBeChecked();
    await expect(dialog.locator("[data-backup-strokes-warning]")).toHaveText(copyEn.strokesWarning);
    await expect(dialog.getByRole("checkbox", { name: copyEn.protect })).toBeChecked();
    await expect(dialog.locator("[data-backup-summary]")).toContainText(
      /^Will be exported: 2 signatures, 2 documents, 2 templates, 1 draft \(drawn signatures in the Sign ones: yes\), settings\. Approximate size: /,
    );
    await dialog.getByLabel(copyEn.password, { exact: true }).fill(PASSWORD);
    await dialog.getByLabel(copyEn.confirmPassword).fill(PASSWORD);
    const first = await downloadFile(page, () => dialog.getByRole("button", { name: copyEn.exportConfirm }).click());
    expect(first.filename).toMatch(FILENAME);
    await expect(dialog.locator("[data-backup-result]")).toContainText("encrypted with a password");
    // Cifrado: solo un sobre y una carga; nada legible por fuera.
    expect(Object.keys((await JSZip.loadAsync(first.bytes)).files).sort()).toEqual(["envelope.json", "payload.bin"]);
    for (const secret of ["Ana", "Maria", "Contrato A", "signatures/", "manifest"]) expect(first.bytes.includes(Buffer.from(secret)), secret).toBe(false);
    await dialog.getByRole("button", { name: copyEn.doneClose }).click();
    await expect(dialog).toBeHidden();
    expect(await page.locator("[data-backup-last]").textContent()).toBe(copyEn.lastToday);

    // ---- Borrar TODO y comprobar que no queda nada ----
    await wipeBrowser(page);
    expect(await readStorage(page)).not.toHaveProperty("optimuspdf.valueHistory");

    // ---- Importar: contraseña mala rechazada sin escribir; buena -> vista previa por módulo -> importar ----
    await openSettings(page);
    const copy = es.settings.backup;
    const importDialog = await openImport(page, "es", { name: first.filename, buffer: first.bytes });
    await importDialog.getByLabel(copy.passwordLabel).fill("mala-contraseña");
    await importDialog.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(importDialog.getByRole("status")).toHaveText(copy.wrongPassword);
    expect(await counts(page)).toEqual(ZERO);
    await importDialog.getByLabel(copy.passwordLabel).fill(PASSWORD);
    await importDialog.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(moduleOf(importDialog, "settings")).toBeVisible({ timeout: 60_000 });
    await expect(importDialog.locator("[data-backup-module]")).toHaveCount(4);
    expect(await statusesOf(importDialog, "signatures")).toEqual(["new", "new"]);
    expect(await statusesOf(importDialog, "library")).toEqual(["new", "new"]);
    expect(await statusesOf(importDialog, "drafts")).toEqual(["new"]);
    await expect(moduleOf(importDialog, "drafts")).toContainText(copy.draftHasStrokes);
    await expect(importDialog.locator("[data-backup-preview-intro]")).toContainText("2 firmas, 2 documentos, 2 plantillas, 1 borrador");
    // Aún no se ha escrito nada.
    expect(await counts(page)).toEqual(ZERO);
    await importDialog.locator("[data-backup-confirm]").click();
    await expect(importDialog.locator("[data-backup-result]")).toBeVisible({ timeout: 60_000 });
    const resultText = (await importDialog.locator("[data-backup-result]").textContent()) ?? "";
    expect(resultText).toContain("Firmas: 2 importadas.");
    expect(resultText).toContain("Plantillas y documentos: 2 documentos, 2 plantillas.");
    expect(resultText).toContain("Borradores: 1 importados.");
    expect(resultText).toMatch(/Ajustes: \d+ aplicados\./);
    await expect(importDialog.locator("[data-backup-reload]")).toContainText(copy.reloadNotice);
    expect(await counts(page)).toEqual({ signatures: 2, documents: 2, templates: 2, drafts: 1 });

    // «Recargar ahora»: los ajustes (tema oscuro, inglés) se aplican y el historial de valores NO entró.
    await Promise.all([page.waitForEvent("load"), importDialog.getByRole("button", { name: copy.reloadButton }).click()]);
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    const stored = await readStorage(page);
    expect(stored["optimuspdf.theme"]).toBe("dark");
    expect(stored["optimuspdf.language"]).toBe("en");
    expect(stored).not.toHaveProperty("optimuspdf.valueHistory");
    expect(stored).not.toHaveProperty("optimuspdf.lastBackup"); // importar no finge un respaldo

    // Firmas, documentos y plantillas idénticos a los de antes (mismo hash de cada PNG y de cada PDF).
    expect(fingerprint(await readVault(page))).toEqual(vaultBefore);
    expect(await storedDocs(page)).toEqual(docsBefore);
    expect(await templateIds(page)).toEqual(templatesBefore);

    // ---- Añadir una firma, reexportar e importar sobre lo existente: fusiona sin duplicar ----
    await page.evaluate(() => localStorage.setItem("optimuspdf.language", "es"));
    await openSettings(page);
    await seedSignatures(page, [{ name: "Marta Ruiz", seed: 3 }]);
    const second = await exportFile(page, { password: PASSWORD });
    expect(second.filename).toMatch(FILENAME);
    await second.dialog.getByRole("button", { name: copy.doneClose }).click();
    const withMarta = fingerprint(await readVault(page));
    expect(withMarta).toHaveLength(3);
    // El navegador vuelve a tener SOLO lo del primer paquete (sin Marta).
    const martaId = (await readVault(page)).find((row) => row.signerName === "Marta Ruiz")!.id;
    await lab(page, "await lib.deleteVaultEntry(arg);", martaId);
    expect(fingerprint(await readVault(page))).toEqual(vaultBefore);
    const merge = await openImport(page, "es", { name: second.filename, buffer: second.bytes });
    await merge.getByLabel(copy.passwordLabel).fill(PASSWORD);
    await merge.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(moduleOf(merge, "settings")).toBeVisible({ timeout: 60_000 });
    expect((await statusesOf(merge, "signatures")).sort()).toEqual(["identical", "identical", "new"]);
    expect(await statusesOf(merge, "library")).toEqual(["identical", "identical"]);
    expect(await statusesOf(merge, "drafts")).toEqual(["identical"]);
    await expect(merge.locator("[data-backup-confirm]")).toHaveText(copy.importConfirmOne);
    await merge.locator("[data-backup-confirm]").click();
    await expect(merge.locator("[data-backup-result]")).toBeVisible({ timeout: 60_000 });
    expect(await merge.locator("[data-backup-result]").textContent()).toContain("Firmas: 1 importadas.");
    expect(await counts(page)).toEqual({ signatures: 3, documents: 2, templates: 2, drafts: 1 });
    expect(fingerprint(await readVault(page))).toEqual(withMarta);
    await merge.getByRole("button", { name: copy.doneClose }).last().click();
    // Y otra vez: todo «Ya lo tienes», nada que importar.
    const again = await openImport(page, "es", { name: second.filename, buffer: second.bytes });
    await again.getByLabel(copy.passwordLabel).fill(PASSWORD);
    await again.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(again.locator("[data-backup-confirm]")).toBeDisabled({ timeout: 60_000 });
    await expect(again.locator("[data-backup-confirm]")).toHaveText(copy.importNothing);
    for (const name of ["signatures", "library", "drafts"]) expect(new Set(await statusesOf(again, name))).toEqual(new Set(["identical"]));
    expect(await counts(page)).toEqual({ signatures: 3, documents: 2, templates: 2, drafts: 1 });
    await page.keyboard.press("Escape");

    // ---- El borrador importado: Recientes -> Continuar restaura la ronda y el PDF final lleva las firmas ----
    await page.goto("/recent");
    await expect(page.getByRole("heading", { level: 1, name: "Recientes" })).toBeVisible();
    const row = page.getByRole("heading", { name: "Sin terminar" }).locator("xpath=following::ul[1]").getByRole("listitem").filter({ hasText: "Contrato A.pdf" });
    await expect(row).toBeVisible();
    await row.getByRole("link", { name: "Continuar" }).or(row.getByRole("button", { name: "Continuar" })).click();
    await expectCollectedWorkRestored(page, docs);
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
    await expect(page.getByText("Firmados - 2 documentos.zip")).toBeVisible({ timeout: 60_000 });
    const { bytes } = await downloadFile(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files).filter((entry) => entry.endsWith(".pdf")).sort();
    expect(names).toHaveLength(2);
    for (const entry of names) {
      const fileName = entry.includes("Contrato A") ? "Contrato A.pdf" : "Anexo B.pdf";
      const images = await embeddedImages(Buffer.from(await zip.file(entry)!.async("uint8array")));
      expect(images, entry).toHaveLength(2);
      const expected = groups.map((group, index) => ({ group, shape: shapes[index] })).filter(({ group }) => group.fileNames.includes(fileName));
      expect(expected).toHaveLength(2);
      for (const { shape } of expected) expect(images.some((image) => sameShape(image, shape)), `${entry} lleva la firma capturada de cada firmante`).toBe(true);
    }
    expect(errors).toEqual([]);
    expect(external, "ninguna peticion a un servidor ajeno").toEqual([]);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 1b. De un motor a otro (aceptación de §9.3: Chromium -> iPad y vuelta)
 * ------------------------------------------------------------------ */

test("un paquete exportado en Chromium se importa en WebKit (iPad) y el exportado en WebKit, en Chromium: firmas idénticas por hash", async ({ baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "lanza ambos motores por su cuenta; basta con correrlo una vez");
  const engines = { chromium: await chromium.launch(), webkit: await webkit.launch() };
  const openPage = async (engine: "chromium" | "webkit") => {
    const common = { baseURL: baseURL as string, locale: "es-ES", acceptDownloads: true };
    const context =
      engine === "webkit"
        ? await engines.webkit.newContext({ ...devices["iPad Pro 11"], ...common })
        : await engines.chromium.newContext({ ...common, viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      try {
        localStorage.setItem("optimuspdf.sign-pdf.privacyNoticeSeen", "1");
        Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
        Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
      } catch {
        /* almacenamiento bloqueado */
      }
    });
    return { context, page: await context.newPage() };
  };
  try {
    const copy = es.settings.backup;
    const roundTrip = async (from: "chromium" | "webkit", to: "chromium" | "webkit", seed: number) => {
      const source = await openPage(from);
      await source.page.goto("/privacy");
      await seedSignatures(source.page, [{ name: "Ana Pérez", role: "Directora", seed }, { name: "Luis Gómez", seed: seed + 1 }]);
      await putContract(source.page, contracts[0]);
      await putContract(source.page, contracts[1]);
      await addTemplate(source.page, contracts[0].id, "ready");
      await addTemplate(source.page, contracts[1].id, "single");
      await source.page.evaluate(() => localStorage.setItem("optimuspdf.theme", "dark"));
      const before = { vault: fingerprint(await readVault(source.page)), docs: await storedDocs(source.page), templates: await templateIds(source.page) };
      await openSettings(source.page);
      const exported = await exportFile(source.page, { password: PASSWORD });
      await source.context.close();

      const target = await openPage(to);
      await openSettings(target.page);
      const dialog = await openImport(target.page, "es", { name: exported.filename, buffer: exported.bytes });
      await dialog.getByLabel(copy.passwordLabel).fill(PASSWORD);
      await dialog.getByRole("button", { name: copy.passwordOpen }).click();
      await expect(moduleOf(dialog, "settings")).toBeVisible({ timeout: 60_000 });
      await dialog.locator("[data-backup-confirm]").click();
      await expect(dialog.locator("[data-backup-result]")).toContainText("Firmas: 2 importadas.", { timeout: 60_000 });
      expect(await counts(target.page)).toEqual({ signatures: 2, documents: 2, templates: 2, drafts: 0 });
      expect(fingerprint(await readVault(target.page))).toEqual(before.vault);
      expect(await storedDocs(target.page)).toEqual(before.docs);
      expect(await templateIds(target.page)).toEqual(before.templates);
      expect((await readStorage(target.page))["optimuspdf.theme"]).toBe("dark");
      await target.context.close();
    };
    await roundTrip("chromium", "webkit", 1);
    await roundTrip("webkit", "chromium", 5);
  } finally {
    await engines.chromium.close();
    await engines.webkit.close();
  }
});

/* ------------------------------------------------------------------ *
 * 2. Un paquete de UN solo módulo entra por la misma vía
 * ------------------------------------------------------------------ */

test("un paquete de solo firmas (una sola casilla) y el formato antiguo de módulo suelto entran por la misma hoja", async ({ browser }) => {
  const context = await newContext(browser);
  await noShare(context);
  const page = await context.newPage();
  try {
    const copy = es.settings.backup;
    await page.goto("/privacy");
    await seedSignatures(page, [{ name: "Ana Pérez", role: "Directora", seed: 1 }, { name: "Luis Gómez", seed: 2 }]);
    await putContract(page, contracts[0]);
    await openSettings(page);

    // Solo «Firmas guardadas»: el resumen lo dice y el paquete trae un único módulo.
    const dialog = await openExport(page);
    for (const name of [/^Plantillas y documentos/, /^Ajustes/]) await setCheckbox(dialog, name, false);
    await expect(dialog.locator("[data-backup-summary]")).toContainText(/^Se exportará: 2 firmas\. Tamaño aproximado: /);
    await dialog.getByRole("checkbox", { name: copy.protect }).isChecked().then(async (checked) => {
      if (!checked) await setCheckbox(dialog, copy.protect, true);
    });
    await dialog.getByLabel(copy.password, { exact: true }).fill(PASSWORD);
    await dialog.getByLabel(copy.confirmPassword).fill(PASSWORD);
    const { bytes, filename } = await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
    await dialog.getByRole("button", { name: copy.doneClose }).click();

    await lab(page, "await lib.clearVault();");
    expect((await counts(page)).signatures).toBe(0);
    const single = await openImport(page, "es", { name: filename, buffer: bytes });
    await single.getByLabel(copy.passwordLabel).fill(PASSWORD);
    await single.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(moduleOf(single, "signatures")).toBeVisible({ timeout: 60_000 });
    await expect(single.locator("[data-backup-module]")).toHaveCount(1);
    expect(await statusesOf(single, "signatures")).toEqual(["new", "new"]);
    await single.locator("[data-backup-confirm]").click();
    await expect(single.locator("[data-backup-result]")).toContainText("Firmas: 2 importadas.");
    await expect(single.locator("[data-backup-reload]")).toHaveCount(0); // sin ajustes no hay que recargar
    expect((await counts(page)).signatures).toBe(2);
    await single.getByRole("button", { name: copy.doneClose }).last().click();

    // El formato antiguo de módulo suelto (dorado de firmas v1: imágenes sintéticas que el navegador no decodifica) se LEE y
    // se lista, pero sus elementos se rechazan como no válidos sin escribir nada.
    const old = await openImport(page, "es", golden("signatures-v1.optimuspdf.zip"));
    await expect(moduleOf(old, "signatures")).toBeVisible({ timeout: 60_000 });
    await expect(old.locator("[data-backup-module]")).toHaveCount(1);
    expect(await statusesOf(old, "signatures")).toEqual(["invalid", "invalid", "invalid"]);
    await expect(old.locator("[data-backup-confirm]")).toBeDisabled();
    expect((await counts(page)).signatures).toBe(2);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 3. Paquetes dorados del Package global
 * ------------------------------------------------------------------ */

for (const name of ["package-all-v1.optimuspdf.zip", "package-all-v1-encrypted.optimuspdf.zip"]) {
  test(`dorado ${name}: los cuatro módulos se importan con los validadores reales (pdf.js y decodificación de PNG)`, async ({ browser }) => {
    const encrypted = name.includes("-encrypted");
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    const errors = trackErrors(page);
    try {
      const copy = es.settings.backup;
      // Los trazos de los borradores caducan a la semana: el reloj se fija en la fecha del dorado.
      await page.clock.setFixedTime(new Date("2026-10-15T12:00:00.000Z"));
      await openSettings(page);
      const dialog = await openImport(page, "es", golden(name));
      if (encrypted) {
        await dialog.getByLabel(copy.passwordLabel).fill(GOLDEN_PASSWORD);
        await dialog.getByRole("button", { name: copy.passwordOpen }).click();
      }
      await expect(moduleOf(dialog, "settings")).toBeVisible({ timeout: 90_000 });
      await expect(dialog.locator("[data-backup-module]")).toHaveCount(4);
      expect(await statusesOf(dialog, "signatures")).toEqual(["new", "new", "new"]);
      expect(await statusesOf(dialog, "library")).toEqual(["new", "new", "new"]);
      expect(await statusesOf(dialog, "drafts")).toEqual(["new", "new", "new", "new"]);
      expect((await statusesOf(dialog, "settings")).slice(0, 1)).toEqual(expect.arrayContaining([expect.stringMatching(/new|different/)]));
      await expect(dialog.locator('[data-backup-item="valueHistory"]')).toHaveCount(encrypted ? 1 : 0);
      await expect(dialog.locator("[data-backup-preview-intro]")).toContainText("3 firmas, 3 documentos, 2 plantillas, 4 borradores, 10 ajustes");
      await dialog.locator("[data-backup-confirm]").click();
      await expect(dialog.locator("[data-backup-result]")).toBeVisible({ timeout: 90_000 });
      const text = (await dialog.locator("[data-backup-result]").textContent()) ?? "";
      expect(text).toContain("Firmas: 3 importadas.");
      expect(text).toContain("Plantillas y documentos: 3 documentos, 2 plantillas.");
      expect(text).toContain("Borradores: 4 importados.");
      // 10 ajustes en el paquete; uno (el aviso de privacidad ya visto) ya era igual en este navegador: se aplican 9.
      expect(text).toContain("Ajustes: 9 aplicados.");
      expect(text).not.toContain("historial de valores"); // por defecto el historial NO entra
      await expect(dialog.locator("[data-backup-reload]")).toBeVisible();
      expect(await counts(page)).toEqual({ signatures: 3, documents: 3, templates: 2, drafts: 4 });
      const stored = await readStorage(page);
      expect(stored["optimuspdf.theme"]).toBe("dark");
      expect(stored["optimuspdf.language"]).toBe("en");
      expect(stored).not.toHaveProperty("optimuspdf.valueHistory");
      expect(stored).not.toHaveProperty("optimuspdf.lastBackup");
      expect((await readVault(page)).map((row) => [row.signerName, row.signatureHash !== null, row.initialsHash !== null])).toEqual([
        ["Ana Pérez", true, true],
        ["Luis Gómez", true, false],
        ["Marta Ruiz", false, true],
      ]);
      expect((await storedDocs(page)).map((doc) => [doc.id, doc.name, doc.templateIds])).toEqual([
        ["pkgall-doc-a", "Contrato global A", ["pkgall-tpl-a"]],
        ["pkgall-doc-b", "Contrato global B", ["pkgall-tpl-b"]],
        ["pkgall-doc-c", "Contrato global C", []],
      ]);
      // Y volver a importarlo es «Ya lo tienes» en todo.
      await page.keyboard.press("Escape");
      const again = await openImport(page, "es", golden(name));
      if (encrypted) {
        await again.getByLabel(copy.passwordLabel).fill(GOLDEN_PASSWORD);
        await again.getByRole("button", { name: copy.passwordOpen }).click();
      }
      await expect(again.locator("[data-backup-confirm]")).toBeDisabled({ timeout: 90_000 });
      for (const name of ["signatures", "library", "drafts"]) expect(new Set(await statusesOf(again, name))).toEqual(new Set(["identical"]));
      expect(await counts(page)).toEqual({ signatures: 3, documents: 3, templates: 2, drafts: 4 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

/* ------------------------------------------------------------------ *
 * 4. Zips hostiles
 * ------------------------------------------------------------------ */

test("el corpus de zips hostiles se rechaza en menos de 2 s con un error claro y sin escribir nada", async ({ browser }) => {
  const context = await newContext(browser);
  await noShare(context);
  const page = await context.newPage();
  try {
    const copy = es.settings.backup;
    await page.goto("/privacy");
    await seedSignatures(page, [{ name: "Ana Pérez", seed: 1 }]);
    await putContract(page, contracts[0]);
    await openSettings(page);
    const before = await counts(page);
    const storageBefore = await readStorage(page);
    const allowed = Object.values(copy.readErrors);
    for (const hostile of hostileCorpus()) {
      const dialog = await openImport(page);
      const outcome = await page.evaluate(
        async ({ b64 }) => {
          const input = document.querySelector("[data-backup-import] [data-backup-file-input]") as HTMLInputElement;
          const status = document.querySelector('[role="dialog"] [role="status"]') as HTMLElement;
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          const transfer = new DataTransfer();
          transfer.items.add(new File([bytes], "hostil.optimuspdf.zip", { type: "application/zip" }));
          const started = performance.now();
          input.files = transfer.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
          await new Promise<void>((resolve) => {
            const check = () => (status.textContent && status.textContent.length > 0 && !/Leyendo|Revisando/.test(status.textContent) ? resolve() : requestAnimationFrame(check));
            check();
          });
          return { ms: performance.now() - started, text: status.textContent ?? "" };
        },
        { b64: Buffer.from(hostile.bytes).toString("base64") },
      );
      expect(allowed, `${hostile.name}: «${outcome.text}»`).toContain(outcome.text);
      expect(outcome.ms, `${hostile.name} tardó ${Math.round(outcome.ms)} ms`).toBeLessThan(2000);
      await expect(dialog.getByRole("button", { name: copy.pickZip })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
    expect(await counts(page)).toEqual(before);
    expect(await readStorage(page)).toEqual(storageBefore);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 5. Recordatorio de respaldo
 * ------------------------------------------------------------------ */

test.describe("recordatorio de respaldo", () => {
  const reminder = (page: Page) => page.locator("[data-backup-reminder]");

  test("tras 10 cambios aparece en Ajustes y en «Mis documentos», nunca en pantallas de trabajo; «Recordármelo luego» calla 7 días", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    try {
      const copy = es.settings.backup;
      await page.goto("/privacy");
      for (let index = 0; index < 9; index += 1) await putContract(page, contracts[0], `doc-${index}`, `Contrato ${index}`);
      // Nueve cambios: todavía no.
      await openSettings(page);
      await expect(page.locator("[data-backup-last]")).toHaveText(copy.lastNever);
      await expect(reminder(page)).toHaveCount(0);
      await putContract(page, contracts[0], "doc-9", "Contrato 9");
      await openSettings(page);
      await expect(reminder(page)).toHaveAttribute("data-backup-reminder", "changes");
      await expect(reminder(page)).toContainText("Has hecho 10 cambios en tus firmas, documentos y plantillas desde tu último respaldo.");
      await expect(reminder(page).getByRole("heading", { level: 3, name: copy.reminderTitle })).toBeVisible();
      await expect(reminder(page).getByRole("button", { name: copy.reminderNow })).toBeVisible();
      await expect(reminder(page).locator("button")).toHaveCount(2);
      await page.goto("/documents");
      await expect(reminder(page)).toHaveAttribute("data-backup-reminder", "changes");
      await expect(reminder(page).getByRole("heading", { level: 2, name: copy.reminderTitle })).toBeVisible();
      await expect(reminder(page)).toContainText("Safari puede borrar los datos de un sitio web después de 7 días"); // aquí sí lleva su motivo
      // Pantallas de trabajo: ni rastro.
      for (const work of ["/sign-pdf", "/edit-pdf", "/merge-pdf", "/pdf-pro", "/split-pdf"]) {
        await page.goto(work);
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(500);
        await expect(reminder(page), work).toHaveCount(0);
        await expect(page.getByText(copy.reminderTitle), work).toHaveCount(0);
      }

      // «Recordármelo luego»: se oculta, lo anuncia y no vuelve en 7 días.
      await openSettings(page);
      await reminder(page).getByRole("button", { name: copy.reminderLater }).click();
      await expect(reminder(page)).toHaveCount(0);
      await expect(page.locator("[data-backup-live]")).toHaveText(copy.reminderLaterDone);
      await page.reload();
      await expect(page.locator("[data-backup-last]")).toBeVisible();
      await expect(reminder(page)).toHaveCount(0);
      await page.goto("/documents");
      await expect(page.locator("[data-documents-list]")).toBeVisible();
      await expect(reminder(page)).toHaveCount(0);
      const snoozed = JSON.parse((await readStorage(page))["optimuspdf.backupReminder"] as string);
      expect(snoozed.changes).toBe(10);
      expect(Date.parse(snoozed.snoozeUntil) - Date.now()).toBeGreaterThan(6.9 * DAY);
      // A los 8 días vuelve.
      await page.clock.setFixedTime(new Date(Date.now() + 8 * DAY));
      await openSettings(page);
      await expect(reminder(page)).toHaveAttribute("data-backup-reminder", "changes");
      expect(Object.keys(JSON.parse((await readStorage(page))["optimuspdf.backupReminder"] as string)).sort()).toEqual(["changes", "since", "snoozeUntil"]);
    } finally {
      await context.close();
    }
  });

  test("a los 31 días del último respaldo (reloj simulado) avisa; «Respaldar ahora» exporta y el aviso desaparece", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    try {
      const copy = es.settings.backup;
      await page.goto("/privacy");
      await seedSignatures(page, [{ name: "Ana Pérez", seed: 1 }]);
      await openSettings(page);
      await expect(reminder(page)).toHaveCount(0);
      // Hace un respaldo de verdad, hoy.
      const first = await exportFile(page, { password: PASSWORD });
      await first.dialog.getByRole("button", { name: copy.doneClose }).click();
      await expect(page.locator("[data-backup-last]")).toHaveText(copy.lastToday);
      await page.reload();
      await expect(reminder(page)).toHaveCount(0);
      // 29 días después: todavía no; 31: sí.
      await page.clock.setFixedTime(new Date(Date.now() + 29 * DAY));
      await openSettings(page);
      await expect(page.locator("[data-backup-last]")).toHaveText("Último respaldo: hace 29 días.");
      await expect(reminder(page)).toHaveCount(0);
      await page.clock.setFixedTime(new Date(Date.now() + 31 * DAY));
      await openSettings(page);
      await expect(page.locator("[data-backup-last]")).toHaveText("Último respaldo: hace 31 días.");
      await expect(reminder(page)).toHaveAttribute("data-backup-reminder", "days");
      await expect(reminder(page)).toContainText("Han pasado 31 días desde tu último respaldo.");
      // En Ajustes el motivo (Safari) ya está justo encima del aviso: no se repite dentro de él.
      await expect(page.locator("[data-backup-why]")).toContainText("Safari puede borrar los datos de un sitio web después de 7 días");
      await expect(reminder(page)).not.toContainText("Safari");
      await reminder(page).getByRole("button", { name: copy.reminderNow }).click();
      const dialog = page.getByRole("dialog", { name: copy.exportTitle });
      await expect(dialog.locator("[data-backup-summary]")).toContainText("Se exportará: 1 firma");
      await dialog.getByLabel(copy.password, { exact: true }).fill(PASSWORD);
      await dialog.getByLabel(copy.confirmPassword).fill(PASSWORD);
      await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
      await dialog.getByRole("button", { name: copy.doneClose }).click();
      await expect(dialog).toBeHidden();
      await expect(reminder(page)).toHaveCount(0);
      await expect(page.locator("[data-backup-last]")).toHaveText(copy.lastToday);
      // El foco no se pierde en <body> al desaparecer el aviso.
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
      // «Mis documentos» ya no lo muestra.
      await page.goto("/documents");
      await expect(page.locator("[data-documents-storage]")).toBeVisible({ timeout: 30_000 });
      await expect(reminder(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("sin nada que respaldar no avisa aunque haya pasado un año; «Respaldar ahora» desde Mis documentos abre el paquete global", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    try {
      const copy = es.settings.backup;
      await page.goto("/privacy");
      await page.evaluate(() => localStorage.setItem("optimuspdf.lastBackup", new Date().toISOString()));
      await page.clock.setFixedTime(new Date(Date.now() + 400 * DAY));
      await openSettings(page);
      await expect(page.locator("[data-backup-last]")).toHaveText("Último respaldo: hace 400 días.");
      await page.waitForTimeout(600);
      await expect(reminder(page)).toHaveCount(0);
      // Con un contrato guardado, ya toca; desde «Mis documentos» el botón abre el paquete global (no solo plantillas y documentos).
      await putContract(page, contracts[0]);
      await page.goto("/documents");
      await expect(reminder(page)).toHaveAttribute("data-backup-reminder", "days");
      await reminder(page).getByRole("button", { name: copy.reminderNow }).click();
      await expect(page.getByRole("dialog", { name: copy.exportTitle })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog", { name: copy.exportTitle })).toBeHidden();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. iPad: hoja de compartir del sistema
 * ------------------------------------------------------------------ */

test("con puntero táctil y share({files}): primero «Archivo listo», se comparte en un segundo toque y el archivo se puede importar", async ({ browser }) => {
  const context = await newContext(browser, { width: 834, touch: true });
  await context.addInitScript(() => {
    const store = window as unknown as { __shared: Array<{ name: string; type: string; b64: string }>; __cancelOnce: boolean };
    store.__shared = [];
    store.__cancelOnce = true;
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: { files: File[] }) => {
        if (store.__cancelOnce) {
          store.__cancelOnce = false;
          throw new DOMException("cancel", "AbortError");
        }
        for (const file of data.files) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          store.__shared.push({ name: file.name, type: file.type, b64: btoa(binary) });
        }
      },
    });
  });
  const page = await context.newPage();
  try {
    const copy = es.settings.backup;
    await page.goto("/privacy");
    await seedSignatures(page, [{ name: "Ana Pérez", seed: 1 }]);
    await putContract(page, contracts[0]);
    await openSettings(page);
    const dialog = await openExport(page);
    await dialog.getByLabel(copy.password, { exact: true }).fill(PASSWORD);
    await dialog.getByLabel(copy.confirmPassword).fill(PASSWORD);
    let downloads = 0;
    page.on("download", () => (downloads += 1));
    await dialog.getByRole("button", { name: copy.exportConfirm }).click();
    await expect(dialog.getByRole("button", { name: copy.shareButton })).toBeVisible({ timeout: 30_000 });
    expect(downloads).toBe(0);
    await expect(page.locator("[data-backup-last]")).toHaveText(copy.lastNever);
    // Cerrar la hoja de compartir sin elegir destino NO cuenta como exportado.
    await dialog.getByRole("button", { name: copy.shareButton }).click();
    await expect(dialog.getByRole("status")).toHaveText(copy.shareCancelled);
    expect(await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.length)).toBe(0);
    await dialog.getByRole("button", { name: copy.shareButton }).click();
    await expect(dialog.locator("[data-backup-result]")).toContainText("cifrado con contraseña");
    const shared = await page.evaluate(() => (window as unknown as { __shared: Array<{ name: string; type: string; b64: string }> }).__shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toMatch(FILENAME);
    expect(shared[0].type).toBe("application/zip");
    expect(downloads).toBe(0);
    await dialog.getByRole("button", { name: copy.doneClose }).click();
    await expect(page.locator("[data-backup-last]")).toHaveText(copy.lastToday);

    // El archivo compartido es un paquete válido: se importa en un navegador nuevo.
    await wipeBrowser(page);
    await openSettings(page);
    const importDialog = await openImport(page, "es", { name: shared[0].name, buffer: Buffer.from(shared[0].b64, "base64") });
    await importDialog.getByLabel(copy.passwordLabel).fill(PASSWORD);
    await importDialog.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(moduleOf(importDialog, "signatures")).toBeVisible({ timeout: 60_000 });
    await importDialog.locator("[data-backup-confirm]").click();
    await expect(importDialog.locator("[data-backup-result]")).toContainText("Firmas: 1 importadas.");
    expect(await counts(page)).toMatchObject({ signatures: 1, documents: 1 });
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 7. Accesibilidad (axe) y objetivos tactiles
 * ------------------------------------------------------------------ */

const AXE_RULES = [
  "color-contrast", "aria-valid-attr-value", "aria-valid-attr", "aria-allowed-attr", "aria-required-attr", "aria-required-children",
  "aria-required-parent", "aria-roles", "aria-hidden-focus", "label", "button-name", "link-name", "image-alt", "nested-interactive",
  "duplicate-id-aria", "tabindex", "list", "listitem", "target-size", "region", "heading-order", "landmark-unique",
] as const;

type Violation = { id: string; help: string; nodes: string[] };

async function axeOn(page: Page, root: Locator): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const handle = await root.elementHandle();
  return page.evaluate(
    async ([element, rules]: [Element, string[]]) => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
      // `region` y `landmark-unique` miran la pagina entera; aqui solo interesa lo propio: se ejecutan sobre el elemento.
      const result = await axe.run(element, { runOnly: { type: "rule", values: [...rules] } });
      return result.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} :: ${(n.failureSummary ?? "").split("\n")[1] ?? ""}`) }));
    },
    [handle, AXE_RULES.filter((rule) => !["region", "heading-order", "landmark-unique"].includes(rule))] as [typeof handle, string[]],
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

/** Todo boton, radio y casilla visible mide >= 44 px de alto (43,5 por el redondeo). */
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
      if (box.height < 43.5) bad.push(`${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return bad;
  });
  expect(small, `${label}: objetivos de toque menores de 44 px`).toEqual([]);
}

async function expectClean(page: Page, root: Locator, label: string, options: { settle?: boolean } = {}): Promise<void> {
  if (options.settle !== false) await settle(page, root);
  const violations = await axeOn(page, root);
  expect(violations, `${label}\n${describeViolations(violations)}`).toEqual([]);
  await expectTouchTargets(root, label);
}

test("control negativo: el auditor de axe y la medida de objetivos SÍ detectan botones diminutos pegados", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  try {
    await openSettings(page);
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "axe-control";
      host.innerHTML = '<button type="button" aria-label="a" style="width:12px;height:12px;margin:0;padding:0"></button><button type="button" aria-label="b" style="width:12px;height:12px;margin:0;padding:0"></button>';
      document.body.appendChild(host);
    });
    const control = page.locator("#axe-control");
    const violations = await axeOn(page, control);
    expect(violations.map((violation) => violation.id)).toContain("target-size");
    await expect(expectTouchTargets(control, "control")).rejects.toThrow(/objetivos de toque/);
  } finally {
    await context.close();
  }
});

type Cell = { theme: Theme; language: Language; width: number };
const CELLS: Cell[] = [];
for (const theme of ["light", "dark"] as const) for (const language of ["es", "en"] as const) for (const width of [1280, 375]) CELLS.push({ theme, language, width });

test.describe("axe-core en la sección y las hojas: 0 violaciones", () => {
  for (const cell of CELLS) {
    test(`${cell.theme} · ${cell.language.toUpperCase()} · ${cell.width}px`, async ({ browser }) => {
      const copy = copyOf(cell.language);
      const tag = `${cell.theme}/${cell.language}/${cell.width}`;
      const context = await newContext(browser, { ...cell, touch: cell.width < 600 });
      await noShare(context);
      const page = await context.newPage();
      try {
        await page.clock.setFixedTime(new Date("2026-10-15T12:00:00.000Z"));
        await openSettings(page, cell.language);
        const section = page.locator("[data-settings-backup]");
        // El tema se aplica tras hidratar y los botones animan sus colores: se mide con la pagina ya quieta.
        await page.waitForTimeout(800);
        await expectClean(page, section, `${tag} · sección`, { settle: false });
        // El region tiene nombre accesible (su encabezado).
        await expect(page.getByRole("region", { name: copy.title })).toBeVisible();

        // --- Importar: elegir, contraseña (mala y buena), vista previa con todo nuevo, decisión y resultado ---
        const dialog = await openImport(page, cell.language);
        await expectClean(page, dialog, `${tag} · importar · elegir`);
        await dialog.locator("[data-backup-file-input]").setInputFiles({ name: "package-all-v1-encrypted.optimuspdf.zip", mimeType: "application/zip", buffer: golden("package-all-v1-encrypted.optimuspdf.zip").buffer });
        await expect(dialog.getByLabel(copy.passwordLabel)).toBeVisible();
        await expectClean(page, dialog, `${tag} · importar · contraseña`);
        await dialog.getByLabel(copy.passwordLabel).fill("mala-contraseña");
        await dialog.getByRole("button", { name: copy.passwordOpen }).click();
        await expect(dialog.getByRole("status")).toHaveText(copy.wrongPassword);
        await expectClean(page, dialog, `${tag} · importar · contraseña mala`);
        await dialog.getByLabel(copy.passwordLabel).fill(GOLDEN_PASSWORD);
        await dialog.getByRole("button", { name: copy.passwordOpen }).click();
        await expect(moduleOf(dialog, "settings")).toBeVisible({ timeout: 90_000 });
        await expect(dialog.locator('[data-backup-item="valueHistory"]')).toBeVisible();
        await expectClean(page, dialog, `${tag} · importar · vista previa (todo nuevo)`);
        await dialog.locator('[data-backup-item="valueHistory"]').getByRole("radio", { name: copy.decisionReplace }).click();
        await itemsOf(dialog, "drafts").first().getByRole("radio", { name: copy.decisionOmit }).click();
        await expectClean(page, dialog, `${tag} · importar · decisiones`);
        await dialog.locator("[data-backup-confirm]").click();
        await expect(dialog.locator("[data-backup-result]")).toBeVisible({ timeout: 90_000 });
        await expect(dialog.locator("[data-backup-reload]")).toBeVisible();
        await expectClean(page, dialog, `${tag} · importar · resultado y recarga`);
        await dialog.getByRole("button", { name: copy.doneClose }).last().click();
        await expect(dialog).toBeHidden();

        // --- Exportar: formulario (con aviso de firma y historial), error, sin contraseña y hecho ---
        const exportDialog = await openExport(page, cell.language);
        await expect(exportDialog.locator("[data-backup-strokes-warning]")).toBeVisible();
        await expectClean(page, exportDialog, `${tag} · exportar · formulario`);
        await exportDialog.getByLabel(copy.password, { exact: true }).fill("una-clave-larga-2026");
        await exportDialog.getByLabel(copy.confirmPassword).fill("otra-distinta-2026");
        await exportDialog.getByRole("button", { name: copy.exportConfirm }).click();
        await expect(exportDialog.getByRole("status")).toHaveText(copy.passwordMismatch);
        await expectClean(page, exportDialog, `${tag} · exportar · error`);
        await setCheckbox(exportDialog, copy.protect, false);
        await expect(exportDialog.locator("[data-backup-plain-warning]")).toHaveAttribute("data-backup-plain-warning", "sensitive");
        await expectClean(page, exportDialog, `${tag} · exportar · sin contraseña`);
        await downloadFile(page, () => exportDialog.getByRole("button", { name: copy.exportConfirm }).click());
        await expect(exportDialog.locator("[data-backup-result]")).toBeVisible();
        await expectClean(page, exportDialog, `${tag} · exportar · hecho`);
        await exportDialog.getByRole("button", { name: copy.doneClose }).click();
        await expect(exportDialog).toBeHidden();

        // --- Vista previa MEZCLADA (distinto / ya lo tienes) del mismo dorado ---
        const ana = (await readVault(page)).find((row) => row.signerName === "Ana Pérez")!;
        await lab(page, "await lib.updateVaultEntry(arg.id, { signerName: 'Ana P.' });", { id: ana.id });
        await page.evaluate(() => localStorage.setItem("optimuspdf.theme", "light"));
        const mixed = await openImport(page, cell.language, golden("package-all-v1-encrypted.optimuspdf.zip"));
        await mixed.getByLabel(copy.passwordLabel).fill(GOLDEN_PASSWORD);
        await mixed.getByRole("button", { name: copy.passwordOpen }).click();
        await expect(moduleOf(mixed, "settings")).toBeVisible({ timeout: 90_000 });
        expect(new Set(await statusesOf(mixed, "signatures"))).toEqual(new Set(["identical", "different"]));
        expect(new Set(await statusesOf(mixed, "library"))).toEqual(new Set(["identical"]));
        expect(await statusesOf(mixed, "settings")).toContain("different");
        await expectClean(page, mixed, `${tag} · importar · vista previa mezclada`);
        await page.keyboard.press("Escape");
        await expect(mixed).toBeHidden();

        // --- El recordatorio (10 cambios) dentro de la sección ---
        for (let index = 0; index < 10; index += 1) await putContract(page, contracts[0], `extra-${index}`, `Extra ${index}`);
        // El dorado trajo tema oscuro e inglés: de vuelta al idioma y tema de esta celda antes de recargar.
        await page.evaluate(([theme, language]) => {
          localStorage.setItem("optimuspdf.theme", theme);
          localStorage.setItem("optimuspdf.language", language);
        }, [cell.theme, cell.language]);
        await openSettings(page, cell.language);
        await expect(page.locator("[data-backup-reminder]")).toBeVisible();
        await page.waitForTimeout(800);
        await expectClean(page, section, `${tag} · sección con recordatorio`, { settle: false });
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 8. Tipografia ancha y desbordes
 * ------------------------------------------------------------------ */

test.describe("sin desbordes con tipografía ancha (375 y 320 px)", () => {
  const WIDE_CSS = `html *, html *::before, html *::after { font-family: "DejaVu Sans", Verdana, "Trebuchet MS", sans-serif !important; letter-spacing: 0.06em !important; }`;

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

  for (const language of ["es", "en"] as const) {
    test(`sección, recordatorio y hojas caben a 375 y 320 px (${language.toUpperCase()}) y no fallan axe target-size`, async ({ browser }) => {
      const copy = copyOf(language);
      const context = await newContext(browser, { theme: "dark", language, width: 375, touch: true });
      await noShare(context);
      await context.addInitScript((css) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }, WIDE_CSS);
      const page = await context.newPage();
      try {
        await page.clock.setFixedTime(new Date("2026-10-15T12:00:00.000Z"));
        // Nombres larguísimos para forzar el corte de líneas.
        const longName = "Un nombre bastante largo para comprobar que el corte de líneas funciona con tipografía ancha";
        await page.goto("/privacy");
        await seedSignatures(page, [{ name: `${longName} de firmante`, role: "Cargo igualmente larguísimo para la prueba de desbordes", seed: 1 }]);
        await putContract(page, contracts[0], "largo", longName);
        await addTemplate(page, "largo", "ready");
        await openSettings(page, language);
        await page.evaluate(() => localStorage.setItem("optimuspdf.backupReminder", JSON.stringify({ changes: 14, since: new Date().toISOString() })));
        // Un paquete con los nombres largos, exportado con la propia interfaz y vuelto a importar (vista previa).
        const exported = await exportFile(page, { language, password: null });
        await exported.dialog.getByRole("button", { name: copy.doneClose }).click();
        await page.evaluate(() => localStorage.setItem("optimuspdf.backupReminder", JSON.stringify({ changes: 14, since: new Date().toISOString() })));
        await page.reload();
        await expect(page.locator("[data-backup-reminder]")).toBeVisible();
        for (const width of [375, 320]) {
          await page.setViewportSize({ width, height: 812 });
          await page.waitForTimeout(400);
          const measured = await overflow(page);
          expect(measured.overflow, `sección · ${language} · ${width}px`).toBeLessThanOrEqual(1);
          expect(measured.offenders, `sección · ${language} · ${width}px`).toEqual([]);
          await expectTouchTargets(page.locator("[data-settings-backup]"), `sección · ${language} · ${width}px`);
        }
        const states: Array<[string, () => Promise<Locator>]> = [
          ["exportar", async () => openExport(page, language)],
          [
            "importar · vista previa",
            async () => {
              const dialog = await openImport(page, language, { name: exported.filename, buffer: exported.bytes });
              await expect(moduleOf(dialog, "signatures")).toBeVisible({ timeout: 60_000 });
              return dialog;
            },
          ],
          [
            "importar · dorado",
            async () => {
              const dialog = await openImport(page, language, golden("package-all-v1.optimuspdf.zip"));
              await expect(moduleOf(dialog, "settings")).toBeVisible({ timeout: 90_000 });
              return dialog;
            },
          ],
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
      } finally {
        await context.close();
      }
    });
  }
});
