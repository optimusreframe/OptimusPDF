import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";
import { downloadFile } from "../helpers/downloads";
import { isBenignEngineNoise } from "../helpers/engine";
import { readPackage } from "../../src/lib/backup/package";
import { es } from "../../src/lib/locales/es";
import { en } from "../../src/lib/locales/en";
import { SIGN_STRINGS } from "../../src/app/sign-pdf/strings";

/**
 * «Firmas guardadas» dentro de Mis documentos: cada firmante con su firma/iniciales a la vista, «Exportar todas»,
 * «Exportar seleccionadas» e «Importar firmas» (las hojas de respaldo de Firmar PDF), en un navegador real y headless con
 * firmas SINTETICAS (garabatos pintados en un canvas; nada real).
 *
 *   CI=1 PW_REUSE_SERVER=1 PW_PORT=3874 npx playwright test documents-signatures --project=chromium
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
test.setTimeout(240_000);

const AXE_PATH = require.resolve("axe-core/axe.min.js");
const SIG = SIGN_STRINGS.es.vaultBackup;
let libBundle = "";

async function bundle(entry: string, name: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
    define: { "process.env.NEXT_PUBLIC_PDFJS_VERSION": JSON.stringify("0"), "process.env.NODE_ENV": JSON.stringify("production") },
    build: { write: false, minify: false, target: "es2022", lib: { entry: path.resolve(process.cwd(), entry), name, formats: ["iife"], fileName: () => `${name}.js` } },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error(`no se pudo empaquetar ${entry}`);
  return chunk.code;
}

test.beforeAll(async () => {
  libBundle = await bundle("e2e/helpers/package-entry.ts", "PkgLib");
});

async function withLib<T>(page: Page, fn: string, arg?: unknown): Promise<T> {
  if (!(await page.evaluate(() => "PkgLib" in window))) await page.addScriptTag({ content: libBundle });
  return page.evaluate(
    async ({ code, value }) => {
      const lib = (window as unknown as { PkgLib: Record<string, unknown> }).PkgLib;
      return (new Function("lib", "arg", `return (async () => { ${code} })();`)(lib, value) as Promise<T>);
    },
    { code: fn, value: arg },
  );
}

const names = async (page: Page): Promise<string[]> =>
  withLib<string[]>(page, `return (await lib.listVault()).entries.map((entry) => entry.signerName).sort();`);

async function seed(page: Page): Promise<void> {
  await page.goto("/documents");
  await withLib(
    page,
    `await lib.seedSignatures([
       { name: "Ana Pérez", role: "Aseguradora", seed: 1 },
       { name: "Luis Gómez", seed: 2, initials: false },
       { name: "Marta Ríos", seed: 3 },
     ]);`,
  );
  await page.reload();
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

async function axeViolations(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (scope) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run({ include: [scope] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(" | ")}`);
  }, selector);
}

test("Firmas guardadas: se ven los firmantes, exportar seleccionadas lleva solo esas, borrar e importar las devuelve, y exportar todas cifra", async ({ page }) => {
  const errors = trackErrors(page);
  await seed(page);
  const section = page.locator("[data-documents-signatures]");
  await expect(section.getByRole("heading", { name: es.documents.signatures.title })).toBeVisible();
  await expect(section.locator("[data-signatures-count]")).toHaveText("3 firmantes con firma guardada");
  await expect(section.locator("[data-signature-id]")).toHaveCount(3);
  await expect(section.locator("[data-signature-id]", { hasText: "Luis Gómez" })).toContainText("Solo firma");
  await expect(section.locator("[data-signature-id]", { hasText: "Ana Pérez" })).toContainText("Firma e iniciales");
  await expect(section.locator("[data-signature-id]", { hasText: "Ana Pérez" }).getByRole("img", { name: "Firma de Ana Pérez" })).toBeVisible();
  expect(await axeViolations(page, "[data-documents-signatures]"), "sección").toEqual([]);

  // Exportar SOLO dos de las tres.
  await expect(section.getByRole("button", { name: /Exportar seleccionadas/ })).toHaveCount(0);
  await section.getByRole("checkbox", { name: "Seleccionar la firma de Ana Pérez" }).check();
  await section.getByRole("checkbox", { name: "Seleccionar la firma de Marta Ríos" }).check();
  await section.getByRole("button", { name: "Exportar seleccionadas (2)" }).click();
  const dialog = page.getByRole("dialog", { name: SIG.exportSelectedTitle });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(SIG.exportBody(2));
  await dialog.locator("label", { hasText: SIG.protect }).click();
  await expect(dialog.getByRole("checkbox", { name: SIG.protect })).not.toBeChecked();
  const partial = await downloadFile(page, () => dialog.getByRole("button", { name: SIG.exportConfirm }).click());
  expect((await readPackage(new Blob([new Uint8Array(partial.bytes)]))).modules.map((m) => [m.name, m.meta])).toEqual([["signatures", { count: 2 }]]);
  await dialog.getByRole("button", { name: "Listo" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-documents-live]")).toContainText("2 firmas");

  // Borrar todo e importar el archivo desde la propia sección: vuelven solo esas dos.
  await withLib(page, `await lib.clearVault();`);
  await expect(section.locator("[data-signatures-empty]")).toBeVisible();
  await expect(section.getByRole("button", { name: /Exportar/ })).toHaveCount(0);
  await section.getByRole("button", { name: es.documents.signatures.importAction }).click();
  const restore = page.getByRole("dialog", { name: SIG.importTitle });
  await restore.locator("[data-backup-file-input]").setInputFiles({ name: partial.filename, mimeType: "application/zip", buffer: partial.bytes });
  await restore.getByRole("button", { name: "Importar 2 firmas" }).click();
  await expect(restore.getByRole("button", { name: "Listo" })).toBeVisible({ timeout: 30_000 });
  await restore.getByRole("button", { name: "Listo" }).click();
  await expect(restore).toBeHidden();
  await expect(section.locator("[data-signature-id]")).toHaveCount(2);
  expect(await names(page)).toEqual(["Ana Pérez", "Marta Ríos"]);
  await expect(section.locator("[data-signature-id]", { hasText: "Marta Ríos" }).getByRole("img", { name: "Iniciales de Marta Ríos" })).toBeVisible();

  // Exportar todas, con contraseña: el archivo va cifrado.
  await section.getByRole("button", { name: "Exportar todas (2)" }).click();
  const all = page.getByRole("dialog", { name: SIG.exportTitle });
  await all.getByLabel(SIG.password, { exact: true }).fill("dorada-2026-xyz");
  await all.getByLabel(SIG.confirmPassword).fill("dorada-2026-xyz");
  const sealed = await downloadFile(page, () => all.getByRole("button", { name: SIG.exportConfirm }).click());
  await expect(readPackage(new Blob([new Uint8Array(sealed.bytes)]))).rejects.toMatchObject({ code: "needsPassword" });
  expect((await readPackage(new Blob([new Uint8Array(sealed.bytes)]), "dorada-2026-xyz")).modules[0].meta).toEqual({ count: 2 });
  await all.getByRole("button", { name: "Listo" }).click();
  expect(errors).toEqual([]);
});

test("Firmas guardadas · inglés, claro/oscuro y 375/320 px con tipografía ancha: sin desbordes ni violaciones", async ({ browser }) => {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme, locale: "en-US", hasTouch: true, isMobile: true });
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem("optimuspdf.language", "en");
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("html, body, * { font-family: 'DejaVu Sans', Verdana, sans-serif !important; letter-spacing: 0.02em; }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      } catch {
        /* almacenamiento bloqueado */
      }
    });
    const page = await context.newPage();
    try {
      await seed(page);
      const section = page.locator("[data-documents-signatures]");
      await expect(section.getByRole("heading", { name: en.documents.signatures.title })).toBeVisible();
      await section.getByRole("checkbox", { name: "Select the signature of Ana Pérez" }).check();
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 812 });
        await page.waitForTimeout(400);
        const measured = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          offenders: Array.from(document.querySelectorAll<HTMLElement>("[data-documents-signatures] *"))
            .filter((element) => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
            .map((element) => element.tagName + "." + element.className.toString().slice(0, 40)),
          short: Array.from(document.querySelectorAll<HTMLElement>("[data-documents-signatures] button, [data-documents-signatures] label"))
            .filter((element) => element.getBoundingClientRect().height < 43.5)
            .map((element) => (element.textContent ?? "").trim().slice(0, 30)),
        }));
        expect(measured.overflow, `${scheme} · ${width}px: scroll horizontal`).toBeLessThanOrEqual(1);
        expect(measured.offenders, `${scheme} · ${width}px: elementos fuera`).toEqual([]);
        expect(measured.short, `${scheme} · ${width}px: objetivos < 44 px`).toEqual([]);
        expect(await axeViolations(page, "[data-documents-signatures]"), `${scheme} · ${width}px`).toEqual([]);
      }
    } finally {
      await context.close();
    }
  }
});
