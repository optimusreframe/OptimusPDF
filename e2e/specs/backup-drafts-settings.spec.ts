import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { build } from "vite";
import { bytesOfDownload, downloadFile } from "../helpers/downloads";
import { hostileDraftPackages, hostileSettingsPackage } from "../helpers/drafts-packages";
import { embeddedImages, pngPixels, sameShape } from "../helpers/pdf-images";
import { S as PRO, openProPdf } from "../helpers/pro-flow";
import {
  collectAllSignatures,
  draftedStrokeCount,
  expectCollectedWorkRestored,
  makeTwoDocs,
  readStoredGroups,
} from "../helpers/sign-flow";

/**
 * Modulos «Ajustes» y «Borradores» del paquete de respaldo (U4.6, SOLO libreria) en un NAVEGADOR REAL y headless
 * (Chromium y `webkit-ipad`), a traves de un arnes de prueba sin interfaz definitiva (`e2e/helpers/backup-entry.ts`, que
 * Vite empaqueta al vuelo y se inyecta en una pagina cualquiera de la app, como `my-documents.spec.ts`):
 *
 *   - trabajo REAL en Firmar (ronda de 2 documentos y 2 firmantes con las 4 firmas), Editar (un texto cambiado) y PDF Pro (un
 *     paso) -> exportar con contrasena -> BORRAR los tres almacenes y los ajustes -> importar -> Recientes lo lista en
 *     «Sin terminar» -> «Continuar» restaura cada trabajo y el PDF firmado final lleva las MISMAS firmas que se capturaron;
 *   - ajustes de un navegador a otro limpio (la lista blanca viaja; `optimuspdf.lastBackup`, claves ajenas y el historial de
 *     valores, no, salvo que se pida);
 *   - los paquetes dorados v1 se importan con los validadores reales (pdf.js abre cada PDF; cada trazo se decodifica);
 *   - un corpus de paquetes hostiles se rechaza en < 2 s sin escribir nada.
 *
 *   CSP_SKIP_UPGRADE_INSECURE=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3968 [PW_BROWSERS=webkit-ipad] npx playwright test backup-drafts-settings
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 } });
test.setTimeout(300_000);

const PASSWORD = "clave-segura-1";
let labBundle = "";

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
    // `core.ts` lee `process.env.NEXT_PUBLIC_PDFJS_VERSION` (Next lo sustituye al compilar; aqui lo fijamos).
    define: { "process.env.NEXT_PUBLIC_PDFJS_VERSION": JSON.stringify("0"), "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: path.resolve(process.cwd(), "e2e/helpers/backup-entry.ts"), name: "BackupLab", formats: ["iife"], fileName: () => "backup-lab.js" },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el arnes de respaldo");
  labBundle = chunk.code;
});

/** Ejecuta `code` en la pagina con `lab` (el arnes) y `arg`. Un error de la libreria vuelve como `{ error: <codigo> }`. */
async function lab<T = any>(page: Page, code: string, arg?: unknown): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!(await page.evaluate(() => "BackupLab" in window))) await page.addScriptTag({ content: labBundle });
  return page.evaluate(
    async ({ source, value }) => {
      const lib = (window as unknown as { BackupLab: Record<string, unknown> }).BackupLab;
      try {
        return await (new Function("lab", "arg", `return (async () => { ${source} })();`)(lib, value) as Promise<unknown>);
      } catch (error) {
        return { error: (error as { code?: string }).code ?? String(error) };
      }
    },
    { source: code, value: arg },
  ) as Promise<T>;
}

/* ------------------------------------------------------------------ *
 * Almacenes de borradores (IndexedDB) y trabajo real en Editar / PDF Pro
 * ------------------------------------------------------------------ */

type DraftDb = "optimuspdf-sign-drafts" | "optimuspdf-edit-drafts" | "optimuspdf-pro-drafts";

async function storeCount(page: Page, dbName: DraftDb, store: string): Promise<number> {
  return page.evaluate(
    ({ dbName, store }) =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open(dbName);
        request.onerror = () => resolve(-1);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(-1);
            return;
          }
          const count = db.transaction(store, "readonly").objectStore(store).count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
    { dbName, store },
  );
}

async function clearDraftDb(page: Page, dbName: DraftDb): Promise<void> {
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const stores = Array.from(db.objectStoreNames);
          if (stores.length === 0) {
            db.close();
            resolve();
            return;
          }
          const tx = db.transaction(stores, "readwrite");
          for (const store of stores) tx.objectStore(store).clear();
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    dbName,
  );
}

async function clearEverything(page: Page): Promise<void> {
  await page.goto("/privacy"); // una pagina SIN autoguardado: nada vuelve a escribir lo que se borra
  for (const db of ["optimuspdf-sign-drafts", "optimuspdf-edit-drafts", "optimuspdf-pro-drafts"] as const) await clearDraftDb(page, db);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  for (const [db, store] of [
    ["optimuspdf-sign-drafts", "sessionMeta"],
    ["optimuspdf-edit-drafts", "draftMeta"],
    ["optimuspdf-pro-drafts", "draftMeta"],
  ] as const) {
    expect(await storeCount(page, db, store)).toBeLessThanOrEqual(0);
  }
}

const EDITED_TEXT = "Pagado 99,00";
const EDIT_NAME = "edit-informe.pdf";
const PRO_NAME = "pro-informe.pdf";

async function makeEditPdf(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < 2; index += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(`${label} pagina ${index + 1}`, { x: 50, y: 770, size: 24, font });
    page.drawText("Total a pagar: 1.250,00", { x: 50, y: 600, size: 14, font, color: rgb(0.8, 0.1, 0.1) });
  }
  return Buffer.from(await doc.save());
}

const editBlock = (page: Page, text: string) => page.getByRole("button", { name: new RegExp(`^Texto: ${text}`) });

async function workOnEdit(page: Page): Promise<void> {
  await page.goto("/edit-pdf");
  await page.locator('input[type="file"]').first().setInputFiles({ name: EDIT_NAME, mimeType: "application/pdf", buffer: await makeEditPdf("Contrato") });
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
  await expect(page.locator('[data-element-kind="text"]').first()).toBeVisible({ timeout: 30_000 });
  const total = editBlock(page, "Total a pagar");
  await total.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await total.dblclick();
  await expect(page.getByRole("textbox", { name: "Editando el texto del bloque" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(EDITED_TEXT);
  await page.keyboard.press("Escape");
  await expect(editBlock(page, EDITED_TEXT)).toBeVisible();
  await expect.poll(() => storeCount(page, "optimuspdf-edit-drafts", "draftMeta"), { timeout: 15_000 }).toBe(1);
}

async function workOnPro(page: Page): Promise<void> {
  await openProPdf(page, { name: PRO_NAME, pages: 2 });
  await page.getByRole("button", { name: PRO.operations.rotateAll90, exact: true }).click();
  await expect(page.getByRole("list", { name: PRO.suite.historyTitle }).getByRole("listitem")).toHaveCount(2);
  await expect.poll(() => storeCount(page, "optimuspdf-pro-drafts", "draftMeta"), { timeout: 15_000 }).toBe(1);
}

/* ------------------------------------------------------------------ *
 * Recientes
 * ------------------------------------------------------------------ */

async function openRecent(page: Page): Promise<void> {
  await page.goto("/recent");
  await expect(page.getByRole("heading", { level: 1, name: "Recientes" })).toBeVisible();
}

function unfinishedRow(page: Page, name: string): Locator {
  return page
    .getByRole("heading", { name: "Sin terminar" })
    .locator("xpath=following::ul[1]")
    .getByRole("listitem")
    .filter({ hasText: name });
}

async function continueFrom(page: Page, name: string): Promise<void> {
  await openRecent(page);
  const row = unfinishedRow(page, name);
  await expect(row).toBeVisible();
  await row.getByRole("link", { name: "Continuar" }).or(row.getByRole("button", { name: "Continuar" })).click();
}

/** Ajustes de este navegador + claves que NO deben viajar. */
const SETTINGS = {
  "optimuspdf.theme": "dark",
  "optimuspdf.language": "es",
  "optimuspdf.sidebarCollapsed": "1",
  "optimuspdf.signPdf.featureFlags": JSON.stringify({ completionCertificate: true, autoApplyTemplates: false, autoDetectFields: false }),
  "optimuspdf.signPdf.featureFlags.v": "2",
  "optimuspdf.sign.templateSigners": "2",
  "optimuspdf.editPdf.featureFlags": JSON.stringify({ editExistingText: false }),
  "optimuspdf.pro.featureFlags": JSON.stringify({ proAutosave: true }),
  "optimuspdf.pro.layout.v1": JSON.stringify({ thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true }),
  "optimuspdf.sign-pdf.privacyNoticeSeen": "1",
  "optimuspdf.edit-pdf.privacyNoticeSeen": "1",
};
const NOT_SETTINGS = { "optimuspdf.lastBackup": "2026-10-01T00:00:00.000Z", apiKey: "sk-live-secreto", "otra.app.token": "abc" };

async function seedStorage(page: Page, values: Record<string, string>): Promise<void> {
  await page.evaluate((entries) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value);
  }, values);
}

const readStorage = (page: Page) =>
  page.evaluate(() => Object.fromEntries(Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i) as string, localStorage.getItem(localStorage.key(i) as string)])));

/* ------------------------------------------------------------------ *
 * 1. Firmar + Editar + PDF Pro: exportar -> borrar -> importar -> Continuar
 * ------------------------------------------------------------------ */

test("Firmar, Editar y PDF Pro: exportar con contraseña, borrar todo, importar y retomar desde Recientes (el PDF firmado lleva las mismas firmas)", async ({ page }) => {
  const docs = await makeTwoDocs();

  // Trabajo REAL en las tres herramientas.
  await collectAllSignatures(page, docs);
  await expect.poll(() => draftedStrokeCount(page), { timeout: 20_000 }).toBe(4);
  const groups = await readStoredGroups(page);
  const shapes = await Promise.all(groups.map((group) => pngPixels(group.signature as string)));
  await workOnEdit(page);
  await workOnPro(page);
  await page.goto("/privacy");
  await seedStorage(page, { ...SETTINGS, ...NOT_SETTINGS });

  // Resumen previo.
  const summary = await lab(page, "return await lab.summarizeDrafts();");
  expect(summary).toMatchObject({
    ok: true,
    sign: { documents: 0, sessions: 1, count: 1 },
    edit: { count: 1 },
    pro: { count: 1 },
    total: { count: 3 },
    withSignatureStrokes: 1,
    includesSignatureStrokes: true,
    containsClientData: true,
    encryptionRecommended: true,
    fitsInPackage: true,
  });

  // Exportar CON contraseña.
  const exported = await lab(page, "return await lab.exportPackage({ password: arg });", PASSWORD);
  expect(exported.report).toMatchObject({ signDocuments: 0, signSessions: 1, edit: 1, pro: 1, includesStrokes: true, skipped: 0 });
  const packageBytes = Buffer.from(exported.b64, "base64");
  const outer = await JSZip.loadAsync(packageBytes);
  expect(Object.keys(outer.files).sort(), "cifrado: solo sobre y carga").toEqual(["envelope.json", "payload.bin"]);
  for (const secret of ["Contrato A", "Ana", "settings", "drafts/"]) expect(packageBytes.includes(Buffer.from(secret)), secret).toBe(false);

  // Borrar todo (los tres almacenes y los ajustes).
  await clearEverything(page);
  await openRecent(page);
  await expect(page.getByRole("heading", { name: "Sin terminar" })).toHaveCount(0);

  // Importar: sin contraseña y con una mala se rechaza sin tocar nada; con la buena entra.
  await page.goto("/privacy");
  expect(await lab(page, "return await lab.importPackage(arg, { apply: true });", exported.b64)).toEqual({ error: "needsPassword" });
  expect(await lab(page, "return await lab.importPackage(arg.b64, { apply: true, password: 'mala' });", exported)).toEqual({ error: "wrongPassword" });
  expect(await storeCount(page, "optimuspdf-sign-drafts", "sessionMeta")).toBeLessThanOrEqual(0);
  // «Reemplazar todos» en Ajustes (F4-fix, H8): con las decisiones sugeridas los avisos de privacidad «ya visto» se omiten; aquí se pide TODO.
  const imported = await lab(page, "return await lab.importPackage(arg.b64, { apply: true, password: arg.password, settings: { settings: 'replace' } });", { b64: exported.b64, password: PASSWORD });
  expect(imported.modules).toEqual([["settings", "ok"], ["drafts", "ok"]]);
  expect(imported.drafts.counts).toEqual({ new: 3, identical: 0, different: 0, invalid: 0 });
  expect(imported.settings.counts.invalid).toBe(0);
  expect(imported.settings.counts.new + imported.settings.counts.identical + imported.settings.counts.different).toBe(10);
  expect(imported.settings.ignoredKeys).toBe(0);
  expect(imported.appliedDrafts).toMatchObject({ ok: true, written: 3, replaced: 0, keptBoth: 0, skipped: 0 });
  expect(imported.appliedSettings).toMatchObject({ ok: true });
  expect(imported.appliedSettings.written + imported.appliedSettings.skipped).toBe(10);

  // Los ajustes llegaron (solo la lista blanca) y las claves ajenas / lastBackup NO.
  await page.reload();
  const stored = await readStorage(page);
  for (const [key, value] of Object.entries(SETTINGS)) {
    const same = value.startsWith("{") ? JSON.parse(stored[key] as string) : stored[key];
    expect(same, key).toEqual(value.startsWith("{") ? JSON.parse(value) : value);
  }
  expect(JSON.parse(stored["optimuspdf.pro.layout.v1"] as string)).toEqual({ thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true });
  expect(Object.keys(stored)).not.toContain("optimuspdf.lastBackup");
  expect(Object.keys(stored)).not.toContain("apiKey");
  expect(Object.keys(stored)).not.toContain("otra.app.token");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");

  // Reimportar lo mismo no duplica nada.
  const again = await lab(page, "return await lab.importPackage(arg.b64, { apply: true, password: arg.password, settings: { settings: 'replace' } });", { b64: exported.b64, password: PASSWORD });
  expect(again.drafts.counts).toEqual({ new: 0, identical: 3, different: 0, invalid: 0 });
  expect(again.appliedDrafts).toMatchObject({ ok: true, written: 0, skipped: 3 });

  // Recientes lista los tres trabajos importados y «Continuar» restaura cada uno.
  await openRecent(page);
  await expect(page.getByRole("heading", { name: "Sin terminar" })).toBeVisible();
  for (const name of ["Contrato A.pdf", EDIT_NAME, PRO_NAME]) await expect(unfinishedRow(page, name), name).toBeVisible();

  // Editar
  await continueFrom(page, EDIT_NAME);
  await expect(page.locator('[data-render-state="ready"]')).toBeVisible({ timeout: 40_000 });
  await expect(editBlock(page, EDITED_TEXT), "la edicion hecha vuelve").toBeVisible({ timeout: 15_000 });
  await expect(page.locator("[data-edit-notices]")).toContainText("Recuperamos tu trabajo anterior");

  // PDF Pro
  await continueFrom(page, PRO_NAME);
  await expect(page.getByRole("heading", { level: 1, name: /pro-informe\.pdf/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(PRO.suite.unsaved)).toBeVisible();

  // Firmar: la ronda entera vuelve y el PDF final lleva las firmas capturadas.
  await continueFrom(page, "Contrato A.pdf");
  await expectCollectedWorkRestored(page, docs);
  // Ola 3 (W3-B2): «Firmar y descargar» baja el ZIP SOLO al llegar al resultado; el PDF que se mira es el que recibe la persona.
  const [automatic] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Firmar y descargar" }).click()]);
  await expect(page.getByText("Firmados - 2 documentos.zip", { exact: true })).toBeVisible({ timeout: 60_000 });
  const bytes = await bytesOfDownload(automatic);
  // «Descargar» queda de respaldo y baja el mismo ZIP.
  const manual = await downloadFile(page, async () => {
    await page.getByRole("button", { name: "Descargar", exact: true }).click();
  });
  expect(manual.bytes.byteLength).toBe(bytes.byteLength);
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((entry) => entry.endsWith(".pdf")).sort();
  expect(names).toHaveLength(2);
  for (const entry of names) {
    const fileName = entry.includes("Contrato A") ? "Contrato A.pdf" : "Anexo B.pdf";
    const images = await embeddedImages(Buffer.from(await zip.file(entry)!.async("uint8array")));
    expect(images, entry).toHaveLength(2);
    const expected = groups.map((group, index) => ({ group, shape: shapes[index] })).filter(({ group }) => group.fileNames.includes(fileName));
    expect(expected).toHaveLength(2);
    for (const { shape } of expected) {
      expect(images.some((image) => sameShape(image, shape)), `${entry} lleva la firma capturada de cada firmante`).toBe(true);
    }
  }
});

/* ------------------------------------------------------------------ *
 * 2. Ajustes de un navegador a otro
 * ------------------------------------------------------------------ */

test("Ajustes: la lista blanca viaja a un navegador limpio; `lastBackup`, claves ajenas y el historial de valores no (salvo que se pida)", async ({ browser }) => {
  const HISTORY = JSON.stringify({ version: 1, entries: { "nombre del asegurado": [{ value: "Maria Lopez", lastUsedAt: "2026-10-10T10:00:00.000Z" }] } });
  const source = await browser.newContext({ locale: "es-ES" });
  const from = await source.newPage();
  await from.goto("/privacy");
  await seedStorage(from, { ...SETTINGS, ...NOT_SETTINGS, "optimuspdf.language": "en", "optimuspdf.valueHistory": HISTORY, "optimuspdf.recent": JSON.stringify([{ id: "x", slug: "merge-pdf", fileName: "contrato-secreto.pdf", date: new Date().toISOString() }]) });

  // Por defecto, sin historial de valores.
  const plain = await lab(from, "return await lab.exportPackage({ drafts: false });");
  const settingsJson = JSON.parse(await (await JSZip.loadAsync(Buffer.from(plain.b64, "base64"))).file("settings/settings.json")!.async("string"));
  expect(Object.keys(settingsJson.settings).sort()).toEqual(Object.keys(SETTINGS).filter((key) => !key.endsWith(".v")).sort());
  expect(plain.files).toEqual(["settings/settings.json"]);
  for (const forbidden of ["lastBackup", "apiKey", "sk-live", "contrato-secreto", "Maria Lopez", "otra.app.token"]) {
    expect(JSON.stringify(settingsJson), forbidden).not.toContain(forbidden);
  }
  // Con el historial (PII) solo si se pide.
  const withHistory = await lab(from, "return await lab.exportPackage({ drafts: false, includeValueHistory: true, password: 'otra-clave-1' });");
  expect(withHistory.size).toBeGreaterThan(0);
  await source.close();

  const target = await browser.newContext({ locale: "en-US" });
  const to = await target.newPage();
  await to.goto("/privacy");
  const preview = await lab(to, "return await lab.importPackage(arg.b64, { apply: false, password: arg.password });", { b64: withHistory.b64, password: "otra-clave-1" });
  expect(preview.settings).toMatchObject({ state: "ok", valueHistory: "new" });
  // Por defecto el historial de valores se OMITE; los ajustes entran.
  // Con las decisiones SUGERIDAS los dos avisos de privacidad «ya visto» se omiten (F4-fix, H8): entran 8 de 10.
  const suggested = await lab(to, "return await lab.importPackage(arg.b64, { apply: true, password: arg.password });", { b64: withHistory.b64, password: "otra-clave-1" });
  expect(suggested.appliedSettings).toMatchObject({ ok: true, written: 8, valueHistory: false });
  expect((await readStorage(to))["optimuspdf.sign-pdf.privacyNoticeSeen"]).toBeUndefined();
  // «Reemplazar todos» (lo pide la persona): entran los 10.
  const applied = await lab(to, "return await lab.importPackage(arg.b64, { apply: true, password: arg.password, settings: { settings: 'replace' } });", { b64: withHistory.b64, password: "otra-clave-1" });
  expect(applied.appliedSettings).toMatchObject({ ok: true, written: 2, valueHistory: false });
  const first = await readStorage(to);
  expect(first["optimuspdf.valueHistory"]).toBeUndefined();
  expect(first["optimuspdf.language"]).toBe("en");
  expect(first["optimuspdf.signPdf.featureFlags.v"]).toBe("2");
  expect(Object.keys(first).every((key) => Object.keys(SETTINGS).includes(key))).toBe(true);
  // Pidiendolo a proposito, entra.
  const withPii = await lab(to, "return await lab.importPackage(arg.b64, { apply: true, password: arg.password, settings: { settings: 'omit', valueHistory: 'replace' } });", { b64: withHistory.b64, password: "otra-clave-1" });
  expect(withPii.appliedSettings).toMatchObject({ ok: true, valueHistory: true });
  expect(JSON.parse((await readStorage(to))["optimuspdf.valueHistory"] as string)).toEqual(JSON.parse(HISTORY));
  await to.reload();
  // El idioma y el tema se aplican al hidratar: se espera a que el navegador los pinte.
  await expect.poll(() => to.evaluate(() => document.documentElement.lang)).toBe("en");
  await expect.poll(() => to.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  await target.close();
});

/* ------------------------------------------------------------------ *
 * 3. Paquetes dorados con los validadores reales
 * ------------------------------------------------------------------ */

const GOLDEN = path.resolve(process.cwd(), "src/lib/backup/__fixtures__/packages");
const golden = (name: string) => readFileSync(path.join(GOLDEN, name)).toString("base64");
const GOLDEN_NOW = Date.parse("2026-10-15T12:00:00.000Z");

test("los paquetes dorados v1 de ajustes y borradores se importan (pdf.js abre cada PDF, cada trazo se decodifica)", async ({ page }) => {
  await page.goto("/privacy");
  await page.evaluate(() => localStorage.clear());

  // Ajustes (en claro y cifrado)
  for (const [name, password] of [["settings-v1.optimuspdf.zip", undefined], ["settings-v1-encrypted.optimuspdf.zip", "dorada-2026"]] as const) {
    const result = await lab(page, "return await lab.importPackage(arg.b64, { apply: false, password: arg.password });", { b64: golden(name), password });
    expect(result.settings, name).toMatchObject({ state: "ok", counts: { new: 10, invalid: 0 }, ignoredKeys: 0 });
  }

  // Borradores: con trazos (fecha fija: el dorado caduca a la semana), y sin trazos aplicado de verdad
  for (const [name, password] of [["drafts-v1.optimuspdf.zip", undefined], ["drafts-v1-encrypted.optimuspdf.zip", "dorada-2026"]] as const) {
    const withStrokes = await lab(
      page,
      "return await lab.importPackage(arg.b64, { apply: false, password: arg.password, keepStrokes: true, now: arg.now });",
      { b64: golden(name), password, now: GOLDEN_NOW },
    );
    expect(withStrokes.drafts.items.map((i: { kind: string; status: string }) => `${i.kind}:${i.status}`), name).toEqual(["sign-document:new", "sign-session:new", "edit:new", "pro:new"]);
    expect(withStrokes.drafts.includesStrokes).toBe(true);
  }
  const applied = await lab(
    page,
    "return await lab.importPackage(arg.b64, { apply: true, password: arg.password, keepStrokes: false, now: arg.now });",
    { b64: golden("drafts-v1-encrypted.optimuspdf.zip"), password: "dorada-2026", now: GOLDEN_NOW },
  );
  expect(applied.appliedDrafts).toMatchObject({ ok: true, written: 4, strokesDropped: 2 });
  await openRecent(page);
  for (const name of ["Poliza.pdf", "Contrato A.pdf", "Informe.pdf", "Pro.pdf"]) await expect(unfinishedRow(page, name), name).toBeVisible();
  await continueFrom(page, "Contrato A.pdf");
  await expect(page.getByRole("button", { name: "1. Contrato A.pdf" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "2. Anexo B.pdf" })).toBeVisible();
});

/* ------------------------------------------------------------------ *
 * 4. Hostiles: rechazados en < 2 s, sin escribir nada
 * ------------------------------------------------------------------ */

test("paquetes hostiles (PDF falso o truncado, bomba de pixeles, 10 000 bloques, ajustes con __proto__): < 2 s y no escriben nada", async ({ page }) => {
  await page.goto("/privacy");
  await page.evaluate(() => localStorage.clear());
  const before = await readStorage(page);

  for (const hostile of await hostileDraftPackages()) {
    const started = Date.now();
    const result = await lab(page, "return await lab.importPackage(arg, { apply: true, keepStrokes: true });", hostile.buffer.toString("base64"));
    expect(Date.now() - started, `${hostile.name}: tiempo`).toBeLessThan(2000);
    expect(result.error, hostile.name).toBeUndefined();
    const statuses = result.drafts.items.map((i: { kind: string; status: string; reason?: string }) => `${i.kind}:${i.status}${i.reason ? `:${i.reason}` : ""}`);
    expect(statuses.some((s: string) => hostile.expect.test(s)), `${hostile.name}: ${statuses.join(", ")}`).toBe(true);
    if (hostile.name !== "id repetido") expect(result.drafts.counts.new, hostile.name).toBe(0);
  }
  // Nada de lo anterior dejo una sola fila (salvo el primero valido del caso de id repetido, que es legitimo).
  expect(await storeCount(page, "optimuspdf-edit-drafts", "draftMeta")).toBeLessThanOrEqual(0);
  expect(await storeCount(page, "optimuspdf-pro-drafts", "draftMeta")).toBeLessThanOrEqual(0);
  expect(await storeCount(page, "optimuspdf-sign-drafts", "sessionMeta")).toBeLessThanOrEqual(0);

  // Ajustes hostiles: solo la clave valida de la lista blanca puede entrar.
  const started = Date.now();
  const settings = await lab(page, "return await lab.importPackage(arg, { apply: true });", (await hostileSettingsPackage()).toString("base64"));
  expect(Date.now() - started).toBeLessThan(2000);
  expect(settings.settings).toMatchObject({ state: "ok", ignoredKeys: 4 });
  const after = await readStorage(page);
  expect(Object.keys(after).sort()).toEqual(
    [...Object.keys(before), "optimuspdf.language"].sort(),
  );
  expect(after["optimuspdf.language"]).toBe("en");
  expect(await page.evaluate(() => ({} as Record<string, unknown>).polluted)).toBeUndefined();
});
