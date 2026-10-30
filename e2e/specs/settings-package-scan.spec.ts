import { createHash } from "node:crypto";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import JSZip from "jszip";
import { build } from "vite";
import { downloadFile } from "../helpers/downloads";
import { isBenignEngineNoise, isExternalNetworkUrl } from "../helpers/engine";
import { en } from "../../src/lib/locales/en";
import { es } from "../../src/lib/locales/es";

/**
 * «Respaldo y traslado» de Ajustes con los ESCANEOS EN CURSO (sesiones del Escaner) en un navegador REAL y headless (Chromium y
 * `webkit-ipad`), SIEMPRE con la interfaz:
 *
 *   - tres sesiones sinteticas (6 paginas) -> «Exportar mi paquete»: la casilla con su recuento y peso, la lista para elegir
 *     sesiones, quitar una -> contrasena -> descarga cifrada (nada legible por fuera) -> borrar la base de sesiones ->
 *     «Importar paquete» (contrasena mala rechazada sin escribir) -> vista previa con una tarjeta por escaneo -> importar ->
 *     las sesiones vuelven con los MISMOS originales (SHA-256), parametros y orden -> el Escaner las abre con `?resume=scan:` y
 *     muestra todas sus paginas -> reimportar el mismo paquete es «Ya lo tienes» y no duplica;
 *   - paquetes con fotos hostiles (un PDF disfrazado, un JPEG cortado, un SVG con script, un PNG de 60 000 x 60 000 px) se
 *     rechazan en menos de 2 s sin escribir nada;
 *   - axe-core (0 violaciones) y objetivos tactiles >= 44 px en la hoja de exportar con la lista de escaneos y en la vista previa
 *     de importar (claro/oscuro, ES/EN, 1280/375 px).
 *
 *   CSP_SKIP_UPGRADE_INSECURE=1 CI=1 PW_REUSE_SERVER=1 PW_PORT=3970 [PW_BROWSERS=webkit-ipad] npx playwright test settings-package-scan
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const SLACK = process.env.CI ? 2.5 : 1;
test.setTimeout(Math.round(240_000 * SLACK));

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const PASSWORD = "clave-segura-1";
const FILENAME = /^OptimusPDF-paquete-\d{4}-\d{2}-\d{2}\.optimuspdf\.zip$/;
const SCAN_DB = "optimuspdf-scan-sessions";

type Language = "es" | "en";
type Theme = "light" | "dark";
const copyOf = (language: Language) => (language === "es" ? es : en).settings.backup;

let labBundle = "";

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
      lib: { entry: path.resolve(process.cwd(), "e2e/helpers/package-scan-entry.ts"), name: "PackageLab", formats: ["iife"], fileName: () => "package-scan-lab.js" },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el arnes de preparacion");
  labBundle = chunk.code;
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

type Snapshot = Array<{ id: string; name: string; pages: Array<{ id: string; sha256: string; rotation: number; filter: string; corners: boolean; bytes: number; type: string }> }>;
const snapshot = (page: Page) => lab<Snapshot>(page, "return await lib.scanSnapshot();");
const seedScans = (page: Page, rows: Array<{ name: string; pages: number; seed: number }>) => lab<string[]>(page, "return await lib.seedScanSessions(arg);", rows);

/** «Un navegador nuevo»: borra la base de sesiones del Escaner (y las demas de la app), `localStorage` y `sessionStorage`. */
async function wipeBrowser(page: Page): Promise<void> {
  await page.goto("/privacy"); // una pagina SIN autoguardado: nada vuelve a escribir lo que se borra
  await page.evaluate(async (scanDb) => {
    const names = [scanDb, "optimuspdf-sign-drafts", "optimuspdf-edit-drafts", "optimuspdf-pro-drafts", "optimuspdf-signature-vault", "optimuspdf-doc-library"];
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
  }, SCAN_DB);
  await page.reload();
  await expect.poll(() => snapshot(page)).toEqual([]);
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

const SESSIONS = [
  { name: "Contrato A", pages: 3, seed: 1 },
  { name: "Recibo B", pages: 2, seed: 2 },
  { name: "Póliza C", pages: 1, seed: 3 },
];

/* ------------------------------------------------------------------ *
 * 1. El recorrido completo
 * ------------------------------------------------------------------ */

test("tres sesiones del Escáner: exportar con contraseña eligiendo cuáles, borrar todo, importar, retomar en el Escáner y no duplicar al reimportar", async ({ browser }) => {
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
    const copy = copyOf("es");
    await page.goto("/privacy");
    const ids = await seedScans(page, SESSIONS);
    const before = await snapshot(page);
    expect(before.map((session) => [session.name, session.pages.length])).toEqual([["Contrato A", 3], ["Póliza C", 1], ["Recibo B", 2]]);
    expect(before.flatMap((session) => session.pages.map((p) => p.type))).toEqual(new Array(6).fill("image/jpeg"));

    // ---- Exportar: la casilla con su recuento y peso, la lista para elegir y el resumen ----
    await openSettings(page);
    const dialog = await openExport(page);
    const scanBox = dialog.getByRole("checkbox", { name: /^Escaneos en curso \(3 escaneos, / });
    await expect(scanBox).toBeChecked();
    // Tema e idioma (sembrados por el contexto) son «Ajustes»: se quitan para que el paquete sea de SOLO escaneos.
    await setCheckbox(dialog, /^Ajustes/, false);
    const list = dialog.locator("[data-backup-scan-list]");
    await expect(list.getByRole("checkbox")).toHaveCount(3);
    await expect(dialog.locator("[data-backup-summary]")).toContainText(/^Se exportará: 3 escaneos \(6 páginas\)\. Tamaño aproximado: /);
    await expect(dialog.locator("[data-backup-scan-large]")).toHaveCount(0);
    // Quitar una sesión la saca del resumen.
    await setCheckbox(dialog, /^Póliza C/, false);
    await expect(dialog.locator("[data-backup-summary]")).toContainText(/^Se exportará: 2 escaneos \(5 páginas\)\./);
    await expect(dialog.getByRole("checkbox", { name: copy.protect })).toBeChecked();
    await dialog.getByLabel(copy.password, { exact: true }).fill(PASSWORD);
    await dialog.getByLabel(copy.confirmPassword).fill(PASSWORD);
    const first = await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
    expect(first.filename).toMatch(FILENAME);
    await expect(dialog.locator("[data-backup-result]")).toContainText("2 escaneos (5 páginas)");
    await expect(dialog.locator("[data-backup-result]")).toContainText("cifrado con contraseña");
    // Cifrado: solo un sobre y una carga; nada legible por fuera.
    expect(Object.keys((await JSZip.loadAsync(first.bytes)).files).sort()).toEqual(["envelope.json", "payload.bin"]);
    for (const secret of ["Contrato A", "Recibo B", "scan-sessions", "manifest", "JFIF"]) expect(first.bytes.includes(Buffer.from(secret)), secret).toBe(false);
    await dialog.getByRole("button", { name: copy.doneClose }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("[data-backup-last]")).toHaveText(copy.lastToday);

    // ---- Borrar todo y comprobar que está vacío ----
    await wipeBrowser(page);

    // ---- Importar: contraseña mala rechazada sin escribir; la buena, vista previa con una tarjeta por escaneo ----
    await openSettings(page);
    const importDialog = await openImport(page, "es", { name: first.filename, buffer: first.bytes });
    await importDialog.getByLabel(copy.passwordLabel).fill("mala-clave-1");
    await importDialog.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(importDialog.getByRole("status")).toHaveText(copy.wrongPassword);
    expect(await snapshot(page)).toEqual([]);
    await importDialog.getByLabel(copy.passwordLabel).fill(PASSWORD);
    await importDialog.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(moduleOf(importDialog, "scanSessions")).toBeVisible();
    await expect(importDialog.locator("[data-backup-preview-intro]")).toHaveText("El paquete trae: 2 escaneos (estaba cifrado).");
    expect(await statusesOf(importDialog, "scanSessions")).toEqual(["new", "new"]);
    const cards = itemsOf(importDialog, "scanSessions");
    await expect(cards.nth(0)).toContainText("Contrato A");
    await expect(cards.nth(0)).toContainText("3 páginas");
    await expect(cards.nth(1)).toContainText("Recibo B");
    await expect(importDialog.locator('[data-backup-limits="scanSessions"]')).toHaveText(copy.limitScan);
    // Nada se ha escrito todavía.
    expect(await snapshot(page)).toEqual([]);
    await importDialog.locator("[data-backup-confirm]").click();
    await expect(importDialog.locator("[data-backup-result]")).toContainText("Escaneos en curso: 2 importados.");
    await expect(importDialog.locator("[data-backup-result]")).toContainText("El paquete no incluye: Firmas, Plantillas y documentos, Borradores, Ajustes.");
    await importDialog.getByRole("button", { name: copy.doneClose }).click();

    // ---- Quedó EXACTAMENTE lo exportado: mismos ids, orden de páginas, parámetros y bytes de cada original ----
    const after = await snapshot(page);
    expect(after.map((session) => session.name)).toEqual(["Contrato A", "Recibo B"]);
    const wanted = before.filter((session) => session.name !== "Póliza C");
    expect(after).toEqual(wanted);
    expect(after.find((session) => session.name === "Contrato A")?.id).toBe(ids[0]);
    const rotated = after[0].pages.map((p) => [p.rotation, p.filter, p.corners]);
    expect(rotated).toEqual([[0, "auto", true], [90, "bw", false], [0, "auto", true]]);

    // ---- El Escáner la abre con todas sus páginas ----
    await page.goto(`/scan-to-pdf?resume=scan:${ids[0]}`);
    await expect(page.locator("[data-page-grid] [data-page-id]")).toHaveCount(3, { timeout: 60_000 });
    expect(await page.locator("[data-page-grid] [data-page-id]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-page-id")))).toEqual(before[0].pages.map((p) => p.id));

    // ---- Reimportar el mismo paquete es «Ya lo tienes»: no duplica nada ----
    await openSettings(page);
    const again = await openImport(page, "es", { name: first.filename, buffer: first.bytes });
    await again.getByLabel(copy.passwordLabel).fill(PASSWORD);
    await again.getByRole("button", { name: copy.passwordOpen }).click();
    await expect(moduleOf(again, "scanSessions")).toBeVisible();
    expect(await statusesOf(again, "scanSessions")).toEqual(["identical", "identical"]);
    await expect(again.locator("[data-backup-confirm]")).toBeDisabled();
    await expect(again.locator("[data-backup-confirm]")).toHaveText(copy.importNothing);
    expect((await snapshot(page)).map((session) => session.name)).toEqual(["Contrato A", "Recibo B"]);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 2. Fotos hostiles: rechazadas sin escribir y sin colgar la pestaña
 * ------------------------------------------------------------------ */

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}
function pngWithDims(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0, 0, 0, 1])), chunk("IEND", Buffer.alloc(0))]);
}

/** Cambia una foto del paquete SIN contraseña y arregla su SHA-256 y tamaño en el manifiesto (un zip «legítimo» con una foto mala). */
async function withPhoto(bytes: Buffer, path: string, data: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  zip.file(path, data);
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  for (const file of manifest.files) {
    if (file.path === path) {
      file.sha256 = createHash("sha256").update(data).digest("hex");
      file.bytes = data.length;
    }
  }
  zip.file("manifest.json", JSON.stringify(manifest));
  return Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

test("fotos hostiles (PDF disfrazado, JPEG cortado, SVG con script, PNG de 60 000 x 60 000 px): la sesión se rechaza en < 2 s y no se escribe nada", async ({ browser }) => {
  const context = await newContext(browser);
  await noShare(context);
  const page = await context.newPage();
  const errors = trackErrors(page);
  try {
    const copy = copyOf("es");
    await page.goto("/privacy");
    await seedScans(page, [{ name: "Una sola foto", pages: 1, seed: 4 }]);
    await openSettings(page);
    const dialog = await openExport(page);
    await setCheckbox(dialog, copy.protect, false);
    const clear = await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
    const photo = Object.keys((await JSZip.loadAsync(clear.bytes)).files).find((name) => name.startsWith("scan-sessions/s1-p1."));
    expect(photo).toBe("scan-sessions/s1-p1.jpg");
    const jpeg = await (await JSZip.loadAsync(clear.bytes)).file(photo!)!.async("nodebuffer");
    const variants: Array<[string, Buffer]> = [
      ["un PDF disfrazado de foto", Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF")],
      ["un JPEG cortado", jpeg.subarray(0, 120)],
      ["un SVG con script", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
      ["un PNG de 60 000 x 60 000 px bajo extensión .jpg", pngWithDims(60_000, 60_000)],
    ];
    for (const [name, data] of variants) {
      await wipeBrowser(page);
      await openSettings(page);
      const hostile = await withPhoto(clear.bytes, photo!, data);
      const started = Date.now();
      const importDialog = await openImport(page, "es", { name: "hostil.optimuspdf.zip", buffer: hostile });
      const card = itemsOf(importDialog, "scanSessions").first();
      await expect(card, name).toBeVisible();
      expect(Date.now() - started, `${name}: tardó`).toBeLessThan(2000 * SLACK);
      await expect(card, name).toHaveAttribute("data-status", "invalid");
      await expect(card, name).toContainText(copy.scanInvalidReasons.noValidPages);
      await expect(importDialog.locator("[data-backup-confirm]"), name).toBeDisabled();
      expect(await snapshot(page), name).toEqual([]);
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/* ------------------------------------------------------------------ *
 * 3. Accesibilidad (axe) y objetivos táctiles
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

async function expectClean(page: Page, root: Locator, label: string): Promise<void> {
  await settle(page, root);
  const violations = await axeOn(page, root);
  expect(violations, `${label}\n${violations.map((v) => `${v.id} (${v.help}):\n   ${v.nodes.join("\n   ")}`).join("\n")}`).toEqual([]);
  await expectTouchTargets(root, label);
}

for (const cell of [
  { theme: "light" as const, language: "es" as const, width: 1280 },
  { theme: "dark" as const, language: "en" as const, width: 375 },
]) {
  test(`axe-core en la hoja de exportar (con la lista de escaneos) y en la vista previa de importar: ${cell.theme} · ${cell.language.toUpperCase()} · ${cell.width}px`, async ({ browser }) => {
    const copy = copyOf(cell.language);
    const context = await newContext(browser, { ...cell, touch: cell.width < 600 });
    await noShare(context);
    const page = await context.newPage();
    try {
      await page.goto("/privacy");
      await seedScans(page, SESSIONS);
      await openSettings(page, cell.language);
      const dialog = await openExport(page, cell.language);
      await expect(dialog.locator("[data-backup-scan-list]").getByRole("checkbox")).toHaveCount(3);
      await expectClean(page, dialog, `exportar ${cell.theme}/${cell.language}/${cell.width}`);
      // Sin contraseña para no esperar al cifrado: lo que se mide es la vista previa.
      await setCheckbox(dialog, copy.protect, false);
      const clear = await downloadFile(page, () => dialog.getByRole("button", { name: copy.exportConfirm }).click());
      await dialog.getByRole("button", { name: copy.doneClose }).click();
      await page.getByRole("button", { name: copy.importAction, exact: true }).waitFor();
      // Con una sesión local distinta, la vista previa tiene también la tarjeta «Distinto» y su aviso.
      await lab(page, "const [s] = await lib.listScanSessionSummaries(); const loaded = await lib.scanSessionStore.load(s.id); await lib.scanSessionStore.save({ ...loaded, updatedAt: '2999-01-01T00:00:00.000Z', name: loaded.name + ' (local)' });");
      const importDialog = await openImport(page, cell.language, { name: clear.filename, buffer: clear.bytes });
      await expect(moduleOf(importDialog, "scanSessions")).toBeVisible();
      expect(await statusesOf(importDialog, "scanSessions")).toContain("different");
      await expect(itemsOf(importDialog, "scanSessions").locator("[data-backup-hint]")).toHaveCount(1);
      await expectClean(page, importDialog, `importar ${cell.theme}/${cell.language}/${cell.width}`);
    } finally {
      await context.close();
    }
  });
}
