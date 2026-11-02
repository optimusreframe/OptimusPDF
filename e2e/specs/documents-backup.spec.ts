import { createHash } from "node:crypto";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { build } from "vite";
import { downloadFile } from "../helpers/downloads";
import { isBenignEngineNoise } from "../helpers/engine";
import { libraryPackage, fileByPath, syntheticContract, type SyntheticContract } from "../helpers/library-packages";
import { hostileCorpus } from "../../src/lib/backup/__fixtures__/hostileCorpus";
import { readPackage } from "../../src/lib/backup/package";
import { es } from "../../src/lib/locales/es";
import { en } from "../../src/lib/locales/en";

/**
 * Exportar e importar «Plantillas y documentos» en «Mis documentos» (U4.5 + U4.2) en un navegador real y headless (Chromium
 * y `webkit-ipad`), con contratos SINTÉTICOS (nada real):
 *
 *   - añadir 3 contratos con plantilla -> exportar (sin y con contraseña) -> borrar todo -> importar -> todo presente con ✓
 *     -> exportar de nuevo e importar sobre lo existente: «Ya lo tienes», sin duplicados.
 *   - zips hostiles (del contenedor y del módulo) rechazados sin escribir nada.
 *   - tactil: compartir con `navigator.share({files})`.
 *   - axe-core: 0 violaciones en cada estado de las hojas x claro/oscuro x ES/EN x 1280/375.
 *   - sin desbordes a 375 y 320 px con tipografia ancha (la de CI en Linux).
 *
 *   CSP_SKIP_UPGRADE_INSECURE=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3967 [PW_BROWSERS=webkit-ipad] npx playwright test documents-backup
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
test.setTimeout(240_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const PASSWORD = "dorada-2026-xyz";
const ZIP_NAME = "OptimusPDF-documentos.optimuspdf.zip";

let libBundle = "";
let contracts: SyntheticContract[] = [];

async function bundle(entry: string, name: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    build: { write: false, minify: false, target: "es2022", lib: { entry: path.resolve(process.cwd(), entry), name, formats: ["iife"], fileName: () => `${name}.js` } },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error(`no se pudo empaquetar ${entry}`);
  return chunk.code;
}

test.beforeAll(async () => {
  libBundle = await bundle("e2e/helpers/documents-entry.ts", "DocsLib");
  contracts = [
    await syntheticContract("c1", "Remediación de moho", 11, 4),
    await syntheticContract("c2", "Mitigación de agua", 22, 3),
    await syntheticContract("c3", "Prueba de moho", 33, 5),
  ];
});

/* ------------------------------------------------------------------ *
 * Ayudantes
 * ------------------------------------------------------------------ */

type Theme = "light" | "dark";
type Language = "es" | "en";

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

async function withLib<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  if (!(await page.evaluate(() => "DocsLib" in window))) await page.addScriptTag({ content: libBundle });
  return page.evaluate(
    async ({ code, value }) => {
      const lib = (window as unknown as { DocsLib: Record<string, unknown> }).DocsLib;
      return (new Function("lib", "arg", `return (async () => { ${code} })();`)(lib, value) as Promise<T>);
    },
    { code: fn, value: arg },
  );
}

const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

async function openDocuments(page: Page): Promise<void> {
  await page.goto("/documents");
  await expect(page.locator("h1")).toBeVisible();
}

/** Guarda un contrato con su PDF y la huella calculada en Node (la misma que daría el navegador). */
async function putContract(page: Page, contract: SyntheticContract, id = contract.id, name = contract.name): Promise<void> {
  await withLib(
    page,
    `const bytes = Uint8Array.from(atob(arg.b64), (c) => c.charCodeAt(0));
     await lib.putDocument({ id: arg.id, name: arg.name, docType: "contrato de servicio", fileName: arg.id + ".pdf", pageCount: arg.fp.pageCount, pageSizes: arg.fp.pageSizes, fingerprint: arg.fp, templateIds: [] }, bytes);`,
    { id, name, b64: contract.buffer.toString("base64"), fp: contract.fingerprint },
  );
}

async function addContract(page: Page, contract: SyntheticContract): Promise<void> {
  await page.getByRole("button", { name: "Añadir contrato" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Añadir contrato" });
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-add-file]").setInputFiles({ name: `${contract.name}.pdf`, mimeType: "application/pdf", buffer: contract.buffer });
  await expect(dialog.getByLabel("Nombre")).toHaveValue(contract.name);
  await dialog.getByRole("button", { name: "Guardar documento" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(card(page, contract.name)).toBeVisible();
}

const card = (page: Page, name: string) => page.locator("[data-document-id]", { has: page.getByRole("heading", { level: 3, name, exact: true }) });
const stateOf = (page: Page, name: string) => card(page, name).locator("[data-template-state]");

type Stored = { id: string; name: string; hash: string; templateIds: string[] };
async function stored(page: Page): Promise<Stored[]> {
  return withLib<Stored[]>(
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

async function templateIds(page: Page): Promise<string[]> {
  return withLib<string[]>(page, `return (await lib.listTemplates()).templates.map((t) => t.id).sort();`);
}

async function clearAll(page: Page): Promise<void> {
  await withLib(page, `await lib.clearLibrary();`);
  await page.reload();
}

/* ---- exportar ---- */


/** La casilla es un input sin apariencia bajo su etiqueta: se alterna pulsando la etiqueta (como en el baúl de firmas). */
async function setProtect(dialog: Locator, label: string, wanted: boolean): Promise<void> {
  const checkbox = dialog.getByRole("checkbox", { name: label });
  if ((await checkbox.isChecked()) !== wanted) await dialog.locator("label", { hasText: label }).click();
  await expect(checkbox).toBeChecked({ checked: wanted });
}

type Copy = typeof es.documents.backup;

async function openExport(page: Page, copy: Copy = es.documents.backup): Promise<Locator> {
  await page.getByRole("button", { name: copy.exportAction, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.exportTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-backup-summary]")).not.toContainText(copy.summaryLoading);
  await expect(dialog.locator("[data-backup-summary]")).not.toBeEmpty();
  return dialog;
}

async function exportFile(page: Page, opts: { password?: string } = {}): Promise<{ bytes: Buffer; filename: string; dialog: Locator }> {
  const dialog = await openExport(page);
  if (opts.password === undefined) {
    await setProtect(dialog, "Proteger con contraseña (recomendado)", false);
  } else {
    await dialog.getByLabel("Contraseña", { exact: true }).fill(opts.password);
    await dialog.getByLabel("Repite la contraseña").fill(opts.password);
  }
  const { bytes, filename } = await downloadFile(page, () => dialog.getByRole("button", { name: "Crear respaldo" }).click());
  return { bytes, filename, dialog };
}

/* ---- importar ---- */

async function openImport(page: Page, file?: { name: string; buffer: Buffer }, copy: Copy = es.documents.backup): Promise<Locator> {
  await page.getByRole("button", { name: copy.importAction, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: copy.importTitle });
  await expect(dialog).toBeVisible();
  if (file) await dialog.locator("[data-backup-file-input]").setInputFiles({ name: file.name, mimeType: "application/zip", buffer: file.buffer });
  return dialog;
}

const itemOf = (dialog: Locator, key: string) => dialog.locator(`[data-backup-item="${key}"]`);

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

async function seedThree(page: Page): Promise<void> {
  await openDocuments(page);
  for (const contract of contracts) await addContract(page, contract);
  const ids = await withLib<string[]>(page, `const { documents } = await lib.listDocuments(); return documents.map((d) => d.name + "|" + d.id);`);
  const idOf = (contract: SyntheticContract) => ids.find((entry) => entry.startsWith(`${contract.name}|`))!.split("|")[1];
  await withLib(page, `await lib.createTemplate(lib.sampleDraft(arg));`, idOf(contracts[0]));
  await withLib(page, `await lib.createTemplate(lib.sampleDraft(arg, { variants: { "1": lib.variantOf([lib.signField()]), "2": lib.variantOf([]) } }));`, idOf(contracts[1]));
  await expect(stateOf(page, contracts[0].name)).toHaveAttribute("data-template-state", "ready");
  await expect(stateOf(page, contracts[1].name)).toHaveAttribute("data-template-state", "single");
}

/* ------------------------------------------------------------------ *
 * 1. Ida y vuelta completa
 * ------------------------------------------------------------------ */

test.describe("exportar e importar: ida y vuelta", () => {
  test("3 contratos con plantilla → exportar (sin y con contraseña) → borrar todo → importar ✓ → reexportar e importar encima: «Ya lo tienes»", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    const errors = trackErrors(page);
    try {
      await seedThree(page);
      const original = await stored(page);
      expect(original).toHaveLength(3);
      for (const contract of contracts) expect(original.find((d) => d.name === contract.name)?.hash).toBe(sha(contract.buffer));
      const originalTemplates = await templateIds(page);
      expect(originalTemplates).toHaveLength(2);

      // El hueco «Próximamente» ya no existe.
      await expect(page.locator("[data-documents-backup]")).not.toContainText("Próximamente");
      await expect(page.locator("[data-backup-last]")).toHaveText("Aún no has hecho un respaldo.");

      // --- Exportar sin contraseña ---------------------------------------------------------------------
      const plain = await exportFile(page);
      expect(plain.filename).toBe(ZIP_NAME);
      await expect(plain.dialog.locator("[data-backup-result]")).toContainText("Respaldo creado (3 documentos, 2 plantillas; sin cifrar).");
      await plain.dialog.getByRole("button", { name: "Listo" }).click();
      await expect(plain.dialog).toBeHidden();
      await expect(page.locator("[data-backup-last]")).toHaveText("Último respaldo: hoy.");
      expect(await page.evaluate(() => window.localStorage.getItem("optimuspdf.lastBackup"))).not.toBeNull();
      const plainRead = await readPackage(new Blob([new Uint8Array(plain.bytes)]));
      expect(plainRead.encrypted).toBe(false);
      expect(plainRead.modules.map((m) => [m.name, m.meta])).toEqual([["library", { documents: 3, templates: 2 }]]);

      // --- Exportar con contraseña --------------------------------------------------------------------
      const sealed = await exportFile(page, { password: PASSWORD });
      await expect(sealed.dialog.locator("[data-backup-result]")).toContainText("Respaldo creado (3 documentos, 2 plantillas; cifrado con contraseña).");
      await sealed.dialog.getByRole("button", { name: "Listo" }).click();
      await expect(readPackage(new Blob([new Uint8Array(sealed.bytes)]))).rejects.toMatchObject({ code: "needsPassword" });
      expect((await readPackage(new Blob([new Uint8Array(sealed.bytes)]), PASSWORD)).encrypted).toBe(true);

      // --- Borrar todo e importar el archivo sin contraseña ----------------------------------------
      await clearAll(page);
      await expect(page.getByText("Sube tus contratos una vez y configura dónde firma cada quien")).toBeVisible();
      const dialog = await openImport(page, { name: ZIP_NAME, buffer: plain.bytes });
      for (const item of original) await expect(itemOf(dialog, item.id)).toHaveAttribute("data-status", "new");
      await expect(dialog.getByText("El archivo trae 3 documentos, 2 plantillas.")).toBeVisible();
      await expect(dialog.getByText(/Después de importar tendrás 3 de 50 documentos y 2 de 200 plantillas\./)).toBeVisible();
      await dialog.getByRole("button", { name: "Importar 3 elementos" }).click();
      await expect(dialog.getByText("Importación terminada: 3 documentos, 2 plantillas.").first()).toBeVisible({ timeout: 60_000 });
      await dialog.getByRole("button", { name: "Listo" }).click();
      await expect(dialog).toBeHidden();

      // Todo presente, con ✓ y con los MISMOS bytes de PDF.
      for (const contract of contracts) await expect(card(page, contract.name)).toBeVisible();
      await expect(stateOf(page, contracts[0].name)).toHaveAttribute("data-template-state", "ready");
      await expect(stateOf(page, contracts[1].name)).toHaveAttribute("data-template-state", "single");
      await expect(stateOf(page, contracts[2].name)).toHaveAttribute("data-template-state", "none");
      const restored = await stored(page);
      expect(restored.map((d) => [d.id, d.name, d.hash, d.templateIds.length])).toEqual(original.map((d) => [d.id, d.name, d.hash, d.templateIds.length]));
      expect(await templateIds(page)).toEqual(originalTemplates);

      // Persisten tras recargar.
      await page.reload();
      await expect(card(page, contracts[0].name)).toBeVisible();
      await expect(stateOf(page, contracts[0].name)).toHaveAttribute("data-template-state", "ready");

      // --- Reexportar e importar SOBRE lo existente: «Ya lo tienes», sin duplicados ---------------
      const again = await exportFile(page);
      await again.dialog.getByRole("button", { name: "Listo" }).click();
      const over = await openImport(page, { name: ZIP_NAME, buffer: again.bytes });
      for (const item of original) {
        await expect(itemOf(over, item.id)).toHaveAttribute("data-status", "identical");
        await expect(itemOf(over, item.id).getByText("Ya lo tienes")).toBeVisible();
      }
      const confirm = over.getByRole("button", { name: "No hay nada que importar" });
      await expect(confirm).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(over).toBeHidden();
      expect(await stored(page)).toEqual(restored);
      expect(await templateIds(page)).toEqual(originalTemplates);
      await expect(page.locator("[data-document-id]")).toHaveCount(3);

      // --- Archivo cifrado: contraseña incorrecta, luego la buena ------------------------------------
      await clearAll(page);
      const locked = await openImport(page, { name: ZIP_NAME, buffer: sealed.bytes });
      await locked.getByLabel("Contraseña del archivo").fill("mala-contraseña");
      await locked.getByRole("button", { name: "Abrir archivo" }).click();
      await expect(locked.getByRole("status")).toHaveText("La contraseña no es correcta, o el archivo está dañado.");
      expect(await stored(page)).toEqual([]);
      await locked.getByLabel("Contraseña del archivo").fill(PASSWORD);
      await locked.getByRole("button", { name: "Abrir archivo" }).click();
      await expect(locked.getByText("El archivo trae 3 documentos, 2 plantillas (estaba cifrado).")).toBeVisible();
      await locked.getByRole("button", { name: "Importar 3 elementos" }).click();
      await expect(locked.getByText("Importación terminada: 3 documentos, 2 plantillas.").first()).toBeVisible({ timeout: 60_000 });
      expect(await stored(page)).toEqual(restored);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("«Distinto»: otro PDF con el mismo id → Conservar ambos (copia con id nuevo) y Reemplazar; plantillas nuevas → «Añadir plantillas»", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    try {
      await openDocuments(page);
      const other = await syntheticContract("c1", "Contrato distinto", 99, 2);
      // La biblioteca ya tiene c1 (otro PDF) y c2 con una plantilla de menos que el paquete.
      await putContract(page, other, "c1", "Mío");
      await putContract(page, contracts[1], "c2");
      const fromFile = await libraryPackage({ docs: [contracts[0], contracts[1]], templates: { c1: "ready", c2: "ready" } });
      await page.reload();
      const dialog = await openImport(page, { name: ZIP_NAME, buffer: fromFile });
      const c1 = itemOf(dialog, "c1");
      const c2 = itemOf(dialog, "c2");
      await expect(c1).toHaveAttribute("data-status", "different");
      await expect(c1.getByRole("radio")).toHaveText(["Reemplazar", "Conservar ambos", "Omitir"]);
      await expect(c1.getByRole("radio", { name: "Conservar ambos" })).toHaveAttribute("aria-checked", "true");
      await expect(c2).toHaveAttribute("data-status", "different");
      await expect(c2.getByRole("radio")).toHaveText(["Añadir plantillas", "Omitir"]);
      await c1.getByRole("radio", { name: "Reemplazar" }).click();
      await dialog.getByRole("button", { name: "Importar 2 elementos" }).click();
      await expect(dialog.getByText(/Importación terminada: 1 documento, 2 plantillas\./).first()).toBeVisible({ timeout: 60_000 });
      await dialog.getByRole("button", { name: "Listo" }).click();
      const after = await stored(page);
      expect(after.map((d) => d.id)).toEqual(["c1", "c2"]);
      // c1 ahora es el PDF del archivo y se llama como en el archivo.
      expect(after.find((d) => d.id === "c1")).toMatchObject({ name: contracts[0].name, hash: sha(contracts[0].buffer) });
      expect(await templateIds(page)).toEqual(["tpl-c1", "tpl-c2"]);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. Zips hostiles
 * ------------------------------------------------------------------ */

test.describe("exportar solo lo seleccionado", () => {
  const SELECTION_ZIP = "OptimusPDF-seleccion.optimuspdf.zip";
  const exportSelectedLabel = (n: number) => es.documents.backup.exportSelectedAction.replace("{n}", String(n));

  test("seleccionar 2 de 3 → «Exportar seleccionados (2)» lleva solo esos y su plantilla, no marca respaldo y se importa de vuelta; el menú ⋯ exporta uno solo", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    const errors = trackErrors(page);
    try {
      await seedThree(page);
      const original = await stored(page);
      const [one, two, three] = contracts;
      // Sin selección no hay boton de exportar seleccionados.
      await expect(page.getByRole("button", { name: /Exportar seleccionados/ })).toHaveCount(0);

      // Se eligen el contrato 1 (con plantilla) y el 3 (sin plantilla).
      await card(page, one.name).getByRole("checkbox").check();
      await card(page, three.name).getByRole("checkbox").check();
      const trigger = page.getByRole("button", { name: exportSelectedLabel(2) });
      await expect(trigger).toBeVisible();
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: es.documents.backup.exportSelectedTitle });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("[data-backup-summary]")).toContainText("Se exportará: 2 documentos, 1 plantilla");
      await expect(dialog.locator("[data-backup-selection-note]")).toContainText("No cuenta como respaldo completo");
      await expectClean(page, dialog, "Exportar seleccionados");
      await setProtect(dialog, "Proteger con contraseña (recomendado)", false);
      const { bytes, filename } = await downloadFile(page, () => dialog.getByRole("button", { name: "Crear respaldo" }).click());
      expect(filename).toBe(SELECTION_ZIP);
      await expect(dialog.locator("[data-backup-result]")).toContainText("2 documentos, 1 plantilla");
      await dialog.getByRole("button", { name: "Listo" }).click();
      await expect(dialog).toBeHidden();
      // Una parte NO es un respaldo.
      await expect(page.locator("[data-backup-last]")).toHaveText("Aún no has hecho un respaldo.");
      expect(await page.evaluate(() => window.localStorage.getItem("optimuspdf.lastBackup"))).toBeNull();
      const read = await readPackage(new Blob([new Uint8Array(bytes)]));
      expect(read.modules.map((m) => [m.name, m.meta])).toEqual([["library", { documents: 2, templates: 1 }]]);

      // Borrar todo e importar el archivo: vuelven SOLO esos dos, con la plantilla del 1.
      await clearAll(page);
      const importing = await openImport(page, { name: SELECTION_ZIP, buffer: bytes });
      await expect(importing.getByText("El archivo trae 2 documentos, 1 plantilla.")).toBeVisible();
      await importing.getByRole("button", { name: "Importar 2 elementos" }).click();
      await expect(importing.getByText("Importación terminada: 2 documentos, 1 plantilla.").first()).toBeVisible({ timeout: 60_000 });
      await importing.getByRole("button", { name: "Listo" }).click();
      await expect(card(page, one.name)).toBeVisible();
      await expect(card(page, three.name)).toBeVisible();
      await expect(card(page, two.name)).toHaveCount(0);
      await expect(stateOf(page, one.name)).toHaveAttribute("data-template-state", "ready");
      await expect(stateOf(page, three.name)).toHaveAttribute("data-template-state", "none");
      const back = await stored(page);
      for (const doc of back) expect(doc.hash).toBe(original.find((o) => o.id === doc.id)?.hash);
      expect(back.map((d) => d.name).sort()).toEqual([one.name, three.name].sort());

      // El menú ⋯ de un documento: exporta solo ese y su plantilla.
      await page.getByRole("button", { name: `Más acciones de ${one.name}` }).click();
      await page.getByRole("button", { name: es.documents.exportOne }).click();
      const single = page.getByRole("dialog", { name: es.documents.backup.exportSelectedTitle });
      await expect(single.locator("[data-backup-summary]")).toContainText("Se exportará: 1 documento, 1 plantilla");
      await setProtect(single, "Proteger con contraseña (recomendado)", false);
      const one1 = await downloadFile(page, () => single.getByRole("button", { name: "Crear respaldo" }).click());
      expect((await readPackage(new Blob([new Uint8Array(one1.bytes)]))).modules.map((m) => m.meta)).toEqual([{ documents: 1, templates: 1 }]);
      await single.getByRole("button", { name: "Listo" }).click();
      await expect(single).toBeHidden();
      // El foco no se pierde en <body> al cerrar (el boton ⋯ ya no esta bajo el menu).
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe("zips hostiles: rechazados sin escribir nada", () => {
  test("el corpus del contenedor se rechaza con un error claro y la biblioteca no cambia", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    try {
      await openDocuments(page);
      await putContract(page, contracts[0]);
      const before = await stored(page);
      const dialog = await openImport(page);
      const allowed = Object.values(es.documents.backup.readErrors);
      for (const hostile of hostileCorpus()) {
        const started = Date.now();
        await dialog.locator("[data-backup-file-input]").setInputFiles({ name: "hostil.optimuspdf.zip", mimeType: "application/zip", buffer: Buffer.from(hostile.bytes) });
        await expect(dialog.getByRole("status")).not.toHaveText("", { timeout: 15_000 });
        const text = (await dialog.getByRole("status").textContent()) ?? "";
        expect(allowed, `${hostile.name}: «${text}»`).toContain(text);
        expect(Date.now() - started, `${hostile.name} tardó`).toBeLessThan(8000);
        await expect(dialog.getByRole("button", { name: "Elegir archivo .zip" })).toBeVisible();
      }
      expect(await stored(page)).toEqual(before);
    } finally {
      await context.close();
    }
  });

  test("módulo con un PDF falso, una huella que miente y una plantilla fuera de rango: lo malo se aísla y no se escribe", async ({ browser }) => {
    const context = await newContext(browser);
    await noShare(context);
    const page = await context.newPage();
    try {
      await openDocuments(page);
      const fake = Buffer.from("%PDF-1.7\n" + "esto parece un pdf pero no lo es ".repeat(30));
      const file = await libraryPackage({
        docs: [contracts[0], contracts[1], contracts[2]],
        templates: { c1: "ready", c3: "ready" },
        mutate: (mod) => {
          const indexFile = fileByPath(mod, "documents/index.json");
          const index = JSON.parse(Buffer.from(indexFile.data).toString("utf8")) as Array<{ id: string; file: string; fingerprint: { exact: string } }>;
          // c1: bytes falsos con el encabezado %PDF- y su SHA-256 declarado bien (solo la puerta de entrada lo detiene).
          const first = index.find((doc) => doc.id === "c1")!;
          fileByPath(mod, first.file).data = new Uint8Array(fake);
          first.fingerprint.exact = sha(fake);
          // c2: la huella declara el SHA-256 de OTRO PDF.
          index.find((doc) => doc.id === "c2")!.fingerprint.exact = "a".repeat(64);
          indexFile.data = new Uint8Array(Buffer.from(JSON.stringify(index)));
          // La plantilla de c3 con un campo fuera de 0..1.
          const templateFile = fileByPath(mod, "templates/tpl-c3.json");
          const template = JSON.parse(Buffer.from(templateFile.data).toString("utf8"));
          template.variants["1"].fields[0].rect.x = 2;
          templateFile.data = new Uint8Array(Buffer.from(JSON.stringify(template)));
        },
      });
      const dialog = await openImport(page, { name: ZIP_NAME, buffer: file });
      await expect(itemOf(dialog, "c1")).toHaveAttribute("data-status", "invalid", { timeout: 60_000 });
      await expect(itemOf(dialog, "c1").getByText("El PDF no es válido.")).toBeVisible();
      await expect(itemOf(dialog, "c2")).toHaveAttribute("data-status", "invalid");
      await expect(itemOf(dialog, "c2").getByText("El PDF no corresponde a lo que dice el archivo.")).toBeVisible();
      await expect(itemOf(dialog, "c3")).toHaveAttribute("data-status", "new");
      await expect(itemOf(dialog, "tpl-c3")).toHaveAttribute("data-status", "invalid");
      await expect(itemOf(dialog, "tpl-c3").getByText("Sus datos no son válidos.")).toBeVisible();
      await dialog.getByRole("button", { name: "Importar 1 elemento" }).click();
      await expect(dialog.getByText("Importación terminada: 1 documento, 0 plantillas.").first()).toBeVisible({ timeout: 60_000 });
      await expect(dialog.locator("[data-backup-problems]")).toBeVisible();
      const after = await stored(page);
      expect(after.map((d) => d.id)).toEqual(["c3"]);
      expect(await templateIds(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. Tactil: compartir con la hoja del sistema
 * ------------------------------------------------------------------ */

test.describe("tactil: compartir el archivo", () => {
  test.use({ hasTouch: true });

  test("con share({files}) disponible: primero «Archivo listo»; «Compartir…» entrega el archivo y se puede importar", async ({ page }) => {
    await page.addInitScript(() => {
      const shared: Array<{ name: string; type: string; base64: string }> = [];
      (window as unknown as { __shared: typeof shared }).__shared = shared;
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async (data: { files?: File[] }) => {
          for (const file of data.files ?? []) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = "";
            for (const byte of bytes) binary += String.fromCharCode(byte);
            shared.push({ name: file.name, type: file.type, base64: btoa(binary) });
          }
        },
      });
    });
    await openDocuments(page);
    await putContract(page, contracts[0]);
    await putContract(page, contracts[1]);
    await page.reload();
    const coarse = await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches);
    test.skip(!coarse, "este navegador no reporta puntero tactil: la ruta de compartir solo existe con dedo");
    const dialog = await openExport(page);
    await dialog.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
    await dialog.getByLabel("Repite la contraseña").fill(PASSWORD);
    await dialog.getByRole("button", { name: "Crear respaldo" }).click();
    await expect(dialog.getByText(`Archivo listo: ${ZIP_NAME}`)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("[data-backup-last]")).toHaveText("Aún no has hecho un respaldo.");
    await dialog.getByRole("button", { name: "Compartir o guardar en Archivos" }).click();
    await expect(dialog.getByText(/Respaldo creado \(2 documentos, 0 plantillas; cifrado con contraseña\)/).first()).toBeVisible();
    const shared = await page.evaluate(() => (window as unknown as { __shared: Array<{ name: string; type: string; base64: string }> }).__shared);
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe(ZIP_NAME);
    expect(shared[0].type).toBe("application/zip");
    const bytes = Buffer.from(shared[0].base64, "base64");
    expect((await readPackage(new Blob([new Uint8Array(bytes)]), PASSWORD)).modules[0].meta).toEqual({ documents: 2, templates: 0 });
    await dialog.getByRole("button", { name: "Listo" }).click();
    await expect(page.locator("[data-backup-last]")).toHaveText("Último respaldo: hoy.");
    await page.evaluate(() => (window as unknown as { __shared: unknown[] }).__shared.splice(0));
    // Los objetivos de toque de la hoja miden >= 44 px.
    await clearAll(page);
    const restore = await openImport(page, { name: ZIP_NAME, buffer: bytes });
    await expectTouchTargets(restore, "Importar · contraseña");
  });
});

/* ------------------------------------------------------------------ *
 * 4. Accesibilidad (axe) y objetivos tactiles
 * ------------------------------------------------------------------ */

const AXE_RULES = [
  "color-contrast", "aria-valid-attr-value", "aria-valid-attr", "aria-allowed-attr", "aria-required-attr", "aria-required-children",
  "aria-required-parent", "aria-roles", "aria-hidden-focus", "label", "button-name", "link-name", "image-alt", "nested-interactive",
  "duplicate-id-aria", "tabindex", "list", "listitem", "target-size",
] as const;

type Violation = { id: string; help: string; nodes: string[] };

async function axeOn(page: Page, dialog: Locator): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ path: AXE_PATH });
  const handle = await dialog.elementHandle();
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

async function expectClean(page: Page, dialog: Locator, label: string): Promise<void> {
  await settle(page, dialog);
  const violations = await axeOn(page, dialog);
  expect(violations, `${label}\n${describeViolations(violations)}`).toEqual([]);
  await expectTouchTargets(dialog, label);
}

/** Todo boton, radio y casilla visible de la hoja mide >= 44 px (43,5 por el redondeo). */
async function expectTouchTargets(dialog: Locator, label: string): Promise<void> {
  const small = await dialog.evaluate((root) => {
    const bad: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>('button, [role="radio"], input[type="checkbox"], a[href]')) {
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

type Cell = { theme: Theme; language: Language; width: number };
const CELLS: Cell[] = [];
for (const theme of ["light", "dark"] as const) for (const language of ["es", "en"] as const) for (const width of [1280, 375]) CELLS.push({ theme, language, width });

test.describe("axe-core en las hojas de exportar e importar: 0 violaciones", () => {
  for (const cell of CELLS) {
    test(`${cell.theme} · ${cell.language.toUpperCase()} · ${cell.width}px`, async ({ browser }) => {
      const copy = (cell.language === "es" ? es : en).documents.backup;
      const context = await newContext(browser, { ...cell, touch: cell.width < 600 });
      await noShare(context);
      const page = await context.newPage();
      try {
        // Biblioteca: «same» (idéntico al archivo), «diff» (mismo id, otro PDF) y un contrato propio.
        const mine = await syntheticContract("diff", "Contrato mío", 77, 2);
        const same = contracts[0];
        const fresh = contracts[2];
        const file = await libraryPackage({
          docs: [{ ...same, id: "same", name: "Contrato igual" }, { ...contracts[1], id: "diff", name: "Contrato del archivo" }, { ...fresh, id: "fresh", name: "Contrato nuevo" }],
          templates: { same: "ready", fresh: "single", diff: "ready" },
          mutate: (mod) => {
            const indexFile = fileByPath(mod, "documents/index.json");
            const index = JSON.parse(Buffer.from(indexFile.data).toString("utf8")) as Array<Record<string, unknown> & { fingerprint: { exact: string } }>;
            const bad = { ...index[2], id: "bad", name: "Contrato dañado", file: "documents/bad.pdf" };
            const garbage = Buffer.from("%PDF-1.7\n" + "datos sin sentido ".repeat(40));
            bad.fingerprint = { ...bad.fingerprint, exact: sha(garbage) };
            index.push(bad as (typeof index)[number]);
            mod.files.push({ path: "documents/bad.pdf", data: new Uint8Array(garbage), type: "application/pdf" });
            indexFile.data = new Uint8Array(Buffer.from(JSON.stringify(index)));
          },
        });
        const locked = await libraryPackage({ docs: [{ ...same, id: "same", name: "Contrato igual" }], templates: { same: "ready" }, password: PASSWORD });

        await openDocuments(page);
        await putContract(page, same, "same", "Contrato igual");
        await withLib(page, `await lib.createTemplate(lib.sampleDraft("same", { name: "Plantilla same" }), { newId: () => "tpl-same" });`);
        await putContract(page, mine, "diff", "Contrato mío");
        await page.reload();
        await expect(page.locator("[data-document-id]")).toHaveCount(2);

        // --- Exportar: formulario con contraseña, aviso sin cifrar y confirmación -------------------
        const exportDialog = await openExport(page, copy);
        await expectClean(page, exportDialog, `${cell.theme}/${cell.language}/${cell.width} · exportar · con contraseña`);
        await exportDialog.getByLabel(copy.password, { exact: true }).fill("una-clave-larga-2026");
        await exportDialog.getByLabel(copy.confirmPassword).fill("otra-distinta-2026");
        await exportDialog.getByRole("button", { name: copy.exportConfirm }).click();
        await expect(exportDialog.getByRole("status")).toHaveText(copy.passwordMismatch);
        await expectClean(page, exportDialog, `${cell.theme}/${cell.language}/${cell.width} · exportar · error`);
        await setProtect(exportDialog, copy.protect, false);
        await expectClean(page, exportDialog, `${cell.theme}/${cell.language}/${cell.width} · exportar · sin contraseña`);
        await downloadFile(page, () => exportDialog.getByRole("button", { name: copy.exportConfirm }).click());
        await expect(exportDialog.getByRole("button", { name: copy.doneClose })).toBeVisible();
        await expectClean(page, exportDialog, `${cell.theme}/${cell.language}/${cell.width} · exportar · hecho`);
        await exportDialog.getByRole("button", { name: copy.doneClose }).click();
        await expect(exportDialog).toBeHidden();

        // --- Importar: elegir, contraseña (mala y buena), vista previa y resultado --------------------
        const dialog = await openImport(page, undefined, copy);
        if (cell.language === "en") await expect(dialog.getByRole("button", { name: copy.pickZip })).toBeVisible();
        await expectClean(page, dialog, `${cell.theme}/${cell.language}/${cell.width} · importar · elegir`);
        await dialog.locator("[data-backup-file-input]").setInputFiles({ name: ZIP_NAME, mimeType: "application/zip", buffer: locked });
        await expect(dialog.getByLabel(copy.passwordLabel)).toBeVisible();
        await expectClean(page, dialog, `${cell.theme}/${cell.language}/${cell.width} · importar · contraseña`);
        await dialog.getByLabel(copy.passwordLabel).fill("mala-contraseña");
        await dialog.getByRole("button", { name: copy.passwordOpen }).click();
        await expect(dialog.getByRole("status")).toHaveText(copy.wrongPassword);
        await expectClean(page, dialog, `${cell.theme}/${cell.language}/${cell.width} · importar · contraseña mala`);

        await dialog.getByLabel(copy.passwordLabel).fill(PASSWORD);
        await dialog.getByRole("button", { name: copy.passwordOpen }).click();
        await expect(itemOf(dialog, "same")).toHaveAttribute("data-status", "identical", { timeout: 60_000 });
        // Ahora el archivo con los cuatro estados.
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        const preview = await openImport(page, { name: ZIP_NAME, buffer: file }, copy);
        await expect(itemOf(preview, "bad")).toHaveAttribute("data-status", "invalid", { timeout: 60_000 });
        await expect(itemOf(preview, "fresh")).toHaveAttribute("data-status", "new");
        await expect(itemOf(preview, "diff")).toHaveAttribute("data-status", "different");
        await expect(itemOf(preview, "same")).toHaveAttribute("data-status", "identical");
        await expectClean(page, preview, `${cell.theme}/${cell.language}/${cell.width} · importar · vista previa`);
        await preview.getByRole("radio", { name: copy.decisionReplace }).first().click();
        await expectClean(page, preview, `${cell.theme}/${cell.language}/${cell.width} · importar · decisión`);
        await preview.locator("[data-backup-confirm]").click();
        await expect(preview.locator("[data-backup-result]")).toBeVisible({ timeout: 60_000 });
        await expectClean(page, preview, `${cell.theme}/${cell.language}/${cell.width} · importar · resultado`);
      } finally {
        await context.close();
      }
    });
  }
});

/* ------------------------------------------------------------------ *
 * 5. Tipografia ancha y desbordes
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
    test(`panel y hojas caben a 375 y 320 px (${language.toUpperCase()}) y no fallan axe target-size`, async ({ browser }) => {
      const copy = (language === "es" ? es : en).documents.backup;
      const context = await newContext(browser, { theme: "dark", language, width: 375, touch: true });
      await noShare(context);
      await context.addInitScript((css) => {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(css);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }, WIDE_CSS);
      const page = await context.newPage();
      try {
        const long = await syntheticContract("larguisimo", "Un nombre de contrato bastante largo para comprobar que el corte de líneas funciona con tipografía ancha", 55, 2);
        const file = await libraryPackage({ docs: [{ ...contracts[0], id: "uno", name: long.name }, { ...contracts[1], id: "dos" }], templates: { uno: "ready" } });
        await openDocuments(page);
        await putContract(page, contracts[2], "tres", long.name);
        await page.reload();
        await expect(page.locator("[data-documents-backup]")).toBeVisible();
        for (const width of [375, 320]) {
          await page.setViewportSize({ width, height: 812 });
          await page.waitForTimeout(400);
          const measured = await overflow(page);
          expect(measured.overflow, `panel · ${language} · ${width}px`).toBeLessThanOrEqual(1);
          expect(measured.offenders, `panel · ${language} · ${width}px`).toEqual([]);
        }
        const states: Array<[string, () => Promise<Locator>]> = [
          ["exportar", async () => openExport(page, copy)],
          [
            "importar · vista previa",
            async () => {
              const dialog = await openImport(page, { name: ZIP_NAME, buffer: file }, copy);
              await expect(itemOf(dialog, "uno")).toBeVisible({ timeout: 60_000 });
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
