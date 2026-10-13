import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { es } from "../../src/lib/locales/es";
import { downloadBytes } from "../helpers/downloads";
import { getPageCount, requiresPassword } from "../helpers/pdf-inspection";

/**
 * Wave 6 · W6-B: errores claros, estado vacio, contrasena y un solo «Procesar»,
 * en NAVEGADOR REAL (pdf.js de verdad, sin mocks) y SIEMPRE headless.
 *
 *  - los 7 archivos malos (corrupto-basura, truncado, vacio 0 B, texto con
 *    extension .pdf, PNG renombrado, cifrado, >100 MB) en 8 herramientas:
 *    el mismo mensaje en todas, «Procesar» desactivado con motivo, foco en el
 *    banner y ninguna pantalla de «Algo ha fallado»;
 *  - PDF cifrado: hoja de contrasena (mala / buena / cancelar) y trabajo con una
 *    copia sin cifrar en 4 herramientas;
 *  - estado vacio: remove-pages sin paginas, protect sin contrasena, redact sin zonas;
 *  - un solo «Procesar» visible por pantalla, en escritorio y en movil tactil.
 */

test.use({ locale: "es-ES" });

const T = es.tool;

/* ------------------------------------------------------------------ *
 * Archivos
 * ------------------------------------------------------------------ */

type Upload = { name: string; mimeType: string; buffer: Buffer };

async function buildGood(pages = 3): Promise<Buffer> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([300, 400]);
    page.drawText(`Pagina ${index + 1} con texto`, { x: 20, y: 200, size: 14, font });
  }
  return Buffer.from(await document.save());
}

async function buildEncrypted(userPassword: string): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage([200, 200]);
  document.addPage([200, 200]);
  document.encrypt({ userPassword, ownerPassword: "owner-secret", permissions: {} });
  return Buffer.from(await document.save());
}

function filler(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 131 + 17) & 0xff;
  return bytes;
}

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

type BadKind = "garbage" | "truncated" | "empty" | "notPdf" | "renamedPng" | "encrypted" | "tooLarge";

async function bad(kind: BadKind): Promise<Upload> {
  const pdf = (name: string, buffer: Buffer): Upload => ({ name, mimeType: "application/pdf", buffer });
  switch (kind) {
    case "garbage":
      return pdf("basura.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), filler(4000)]));
    case "truncated": {
      const good = await buildGood(4);
      return pdf("truncado.pdf", good.subarray(0, Math.floor(good.length / 2)));
    }
    case "empty":
      return pdf("vacio.pdf", Buffer.alloc(0));
    case "notPdf":
      return pdf("texto.pdf", Buffer.from("Esto es un texto plano con extension pdf.\n".repeat(20)));
    case "renamedPng":
      return pdf("imagen.pdf", PNG_1X1);
    case "encrypted":
      return pdf("cifrado.pdf", await buildEncrypted("secreta"));
    case "tooLarge":
      throw new Error("el archivo de mas de 100 MB va por disco: usa withHugeFile()");
  }
}

/** Un PDF de 101 MB: Playwright no admite buffers de mas de 50 MB, asi que va por un archivo temporal. */
async function withHugeFile<T>(body: (filePath: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "optimuspdf-big-"));
  const filePath = path.join(directory, "enorme.pdf");
  const buffer = Buffer.alloc(101 * 1024 * 1024, 0x20);
  Buffer.from("%PDF-1.4\n").copy(buffer);
  fs.writeFileSync(filePath, buffer);
  try {
    return await body(filePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const EXPECTED: Record<Exclude<BadKind, "encrypted" | "tooLarge">, string> = {
  garbage: T.errors.corrupt,
  truncated: T.errors.corrupt,
  empty: T.errors.emptyFile,
  notPdf: T.errors.notPdf,
  renamedPng: T.errors.notPdf,
};

/* ------------------------------------------------------------------ *
 * Helpers de pagina
 * ------------------------------------------------------------------ */

async function open(page: Page, slug: string) {
  await page.goto(`/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function upload(page: Page, ...files: Upload[]) {
  // Firmar tiene ademas entradas para importar configuraciones (.zip): se elige la que acepta PDF.
  await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(files);
}

const banner = (page: Page) => page.locator("[data-error-banner]");
/** «Procesar» visible: el de la barra movil es `md:hidden` y el de escritorio vive en la columna o en el panel. */
const run = (page: Page) => page.getByRole("button", { name: "Procesar", exact: true });

async function reasonOf(page: Page): Promise<string> {
  const id = await run(page).first().getAttribute("aria-describedby");
  if (!id) return "";
  return ((await page.locator(`[id="${id}"]`).textContent()) ?? "").trim();
}

async function focusInside(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.contains(document.activeElement));
}

async function expectNoFailureScreen(page: Page) {
  await expect(page.locator("body")).not.toContainText(T.errors.unknown);
  await expect(page.locator("body")).not.toContainText("Algo ha fallado");
}

/* ------------------------------------------------------------------ *
 * U1 — los archivos malos en 8 herramientas (escritorio)
 * ------------------------------------------------------------------ */

const TOOLS = [
  "split-pdf",
  "remove-pages",
  "extract-pages",
  "rotate-pdf",
  "compress-pdf",
  "protect-pdf",
  "pdf-to-jpg",
  "pdf-to-word",
] as const;

test.describe("archivos malos · escritorio 1280x800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.setTimeout(90_000);

  for (const slug of TOOLS) {
    for (const kind of ["garbage", "truncated", "empty", "notPdf", "renamedPng"] as const) {
      test(`${slug} · ${kind}: mismo mensaje, Procesar desactivado con motivo, foco en el banner`, async ({ page }) => {
        await open(page, slug);
        await upload(page, await bad(kind));

        const alert = banner(page);
        await expect(alert).toBeVisible({ timeout: 30_000 });
        await expect(alert).toContainText(T.fileProblemTitle);
        await expect(alert).toContainText(EXPECTED[kind]);
        await expect(alert.getByRole("button", { name: T.chooseAnother })).toBeVisible();
        await expect(alert.getByRole("button", { name: T.removeFile })).toBeVisible();

        await expect(run(page)).toHaveCount(1);
        await expect(run(page)).toBeDisabled();
        expect(await reasonOf(page)).toBe(T.blockedRun.replace("{action}", "Procesar"));
        await expect.poll(() => focusInside(alert)).toBe(true);
        await expectNoFailureScreen(page);
      });
    }
  }

  test("un archivo malo se quita con «Quitar archivo» y el foco vuelve a la zona de carga", async ({ page }) => {
    await open(page, "split-pdf");
    await upload(page, await bad("truncated"));
    await banner(page).getByRole("button", { name: T.removeFile }).click();
    await expect(banner(page)).toHaveCount(0);
    const pick = page.locator("button", { hasText: "Seleccionar archivo" });
    await expect(pick).toBeVisible();
    await expect(pick).toBeFocused();
  });

  test("«Elegir otro archivo» abre el selector y un PDF bueno sustituye al malo", async ({ page }) => {
    await open(page, "rotate-pdf");
    await upload(page, await bad("garbage"));
    const chooser = page.waitForEvent("filechooser");
    await banner(page).getByRole("button", { name: T.chooseAnother }).click();
    (await chooser).setFiles({ name: "bueno.pdf", mimeType: "application/pdf", buffer: await buildGood(3) });
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByText("bueno.pdf")).toBeVisible();
    await expect(page.getByText("basura.pdf")).toHaveCount(0);
    await expect(run(page)).toBeEnabled();
  });

  for (const slug of ["split-pdf", "pdf-to-jpg"] as const) {
    test(`${slug} · archivo de mas de 100 MB: avisa con su pista y NO bloquea`, async ({ page }) => {
      test.setTimeout(120_000);
      await open(page, slug);
      await withHugeFile(async (filePath) => {
        await page.locator('input[type="file"][accept*="pdf"]').first().setInputFiles(filePath);
        const alert = banner(page);
        await expect(alert).toBeVisible({ timeout: 60_000 });
        await expect(alert).toContainText(T.largeFileTitle);
        await expect(alert).toContainText(T.errors.tooLarge);
        await expect(alert).toHaveAttribute("role", "status");
        // Dividir PDF no se propone a si mismo.
        await expect(alert).toContainText(slug === "split-pdf" ? T.errorHints.tooLarge : T.errorHints.tooLargeSplit);
        await expect(alert).not.toContainText(T.errors.title);
        // Dividir PDF necesita leer las paginas antes de poder procesar (sin ellas no hay plan): solo se comprueba donde no.
        if (slug === "pdf-to-jpg") await expect(run(page)).toBeEnabled();
        await expect.poll(() => focusInside(alert)).toBe(true);
        await expect(alert.getByRole("button", { name: T.removeFile })).toBeVisible();
      });
    });
  }

  test("un PDF bueno entra limpio en las 8 herramientas (sin banner de archivo)", async ({ page }) => {
    for (const slug of TOOLS) {
      await open(page, slug);
      await upload(page, { name: "bueno.pdf", mimeType: "application/pdf", buffer: await buildGood(3) });
      await expect(page.getByText("bueno.pdf")).toBeVisible();
      await page.waitForTimeout(400);
      await expect(banner(page)).toHaveCount(0);
    }
  });
});

/* ------------------------------------------------------------------ *
 * U3 — PDF cifrado: hoja de contrasena
 * ------------------------------------------------------------------ */

test.describe("PDF cifrado · hoja de contrasena", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.setTimeout(90_000);

  for (const slug of ["split-pdf", "rotate-pdf", "pdf-to-jpg", "extract-pages"] as const) {
    test(`${slug}: contrasena mala, buena y copia sin cifrar`, async ({ page }) => {
      await open(page, slug);
      await upload(page, await bad("encrypted"));

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      await expect(dialog).toContainText(T.password.title);
      await expect(dialog).toContainText("cifrado.pdf");
      const field = dialog.getByLabel(T.password.label, { exact: true });
      await expect(field).toBeFocused();

      await field.fill("equivocada");
      await dialog.getByRole("button", { name: T.password.submit }).click();
      await expect(dialog.getByText(T.password.wrong)).toBeVisible();
      await expect(field).toBeFocused();
      await expect(banner(page)).toContainText(T.encryptedSheetMessage);
      await expect(run(page)).toBeDisabled();

      await field.fill("secreta");
      await dialog.getByRole("button", { name: T.password.submit }).click();
      await expect(dialog).toBeHidden();
      await expect(banner(page)).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: "sin cifrar" })).toBeVisible();
      await expect(run(page)).toBeEnabled();
      // El foco no cae a <body>.
      await expect.poll(() => page.evaluate(() => document.activeElement === document.body)).toBe(false);
    });
  }

  test("rotate-pdf: el resultado sale SIN cifrar y se abre sin contrasena", async ({ page }) => {
    await open(page, "rotate-pdf");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(T.password.label, { exact: true }).fill("secreta");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog).toBeHidden();
    await run(page).click();
    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar" }).click();
    });
    const opened = await PDFDocument.load(bytes);
    expect(opened.getPageCount()).toBe(2);
  });

  test("pdf-to-jpg: del PDF cifrado sale un ZIP con las 2 imagenes", async ({ page }) => {
    await open(page, "pdf-to-jpg");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(T.password.label, { exact: true }).fill("secreta");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog).toBeHidden();
    await run(page).click();
    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar" }).click();
    });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files)).toHaveLength(2);
  });

  test("«Cancelar» quita el archivo y devuelve la zona de carga", async ({ page }) => {
    await open(page, "split-pdf");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: T.password.cancel }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("button", { hasText: "Seleccionar archivo" })).toBeVisible();
    await expect(page.getByText("cifrado.pdf")).toHaveCount(0);
  });

  test("Esc cierra la hoja sin perder el archivo y «Escribir la contraseña» la reabre", async ({ page }) => {
    await open(page, "extract-pages");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByText("cifrado.pdf").first()).toBeVisible();
    await banner(page).getByRole("button", { name: T.enterPassword }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("permisos solo: se abre una copia sin pedir contrasena", async ({ page }) => {
    await open(page, "rotate-pdf");
    await upload(page, { name: "permisos.pdf", mimeType: "application/pdf", buffer: await buildEncrypted("") });
    await expect(page.getByRole("status").filter({ hasText: "restricciones de edición" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(run(page)).toBeEnabled();
  });

  test("privacidad: ninguna copia descifrada queda en IndexedDB / localStorage", async ({ page }) => {
    await open(page, "split-pdf");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(T.password.label, { exact: true }).fill("secreta");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(1500);
    const stored = await page.evaluate(async () => {
      const databases = (await indexedDB.databases?.()) ?? [];
      return {
        local: Object.keys(window.localStorage).filter((key) => key !== "optimuspdf.language"),
        session: Object.keys(window.sessionStorage).filter((key) => !key.startsWith("__next")),
        databases: databases.map((database) => database.name),
      };
    });
    expect(stored.local).toEqual([]);
    expect(stored.session).toEqual([]);
    expect(stored.databases.filter(Boolean)).toEqual([]);
  });

  test("Proteger PDF con un PDF cifrado: hoja de contrasena y la copia se vuelve a proteger con la contrasena NUEVA", async ({ page }) => {
    await open(page, "protect-pdf");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText("se protegerá con la contraseña nueva");
    await dialog.getByLabel(T.password.label, { exact: true }).fill("secreta");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(banner(page)).toHaveCount(0);
    await expect(page.getByText(/El resultado se protegerá con la contraseña nueva/).first()).toBeVisible();
    await page.getByLabel("Contraseña", { exact: true }).fill("nueva-clave-1");
    await page.getByLabel("Repite la contraseña", { exact: true }).fill("nueva-clave-1");
    await run(page).click();
    const bytes = await downloadBytes(page, async () => {
      await page.getByRole("button", { name: "Descargar" }).click();
    });
    // Sale cifrado con la contrasena nueva (no la antigua) y conserva las paginas.
    expect(await requiresPassword(bytes)).toBe(true);
    expect(await requiresPassword(bytes, "secreta")).toBe(true);
    expect(await requiresPassword(bytes, "nueva-clave-1")).toBe(false);
    expect(await getPageCount(bytes, "nueva-clave-1")).toBe(2);
  });

  test("Firmar PDF con un PDF cifrado pide la contrasena (D4), no muestra una pagina gris", async ({ page }) => {
    await open(page, "sign-pdf");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText("No se pudieron detectar campos");
    await dialog.getByLabel(T.password.label, { exact: true }).fill("secreta");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("body")).not.toContainText(T.errors.encrypted);
  });
});

/* ------------------------------------------------------------------ *
 * U2 — estado vacio y un solo «Procesar»
 * ------------------------------------------------------------------ */

test.describe("estado vacio · un solo Procesar", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.setTimeout(90_000);

  test("remove-pages sin paginas marcadas: desactivado con motivo y UN solo Procesar", async ({ page }) => {
    await open(page, "remove-pages");
    await upload(page, { name: "tres.pdf", mimeType: "application/pdf", buffer: await buildGood(3) });
    const tile = page.getByRole("button", { name: /^Página 1 — / });
    await expect(tile).toBeVisible({ timeout: 30_000 });
    await expect(run(page)).toHaveCount(1);
    await expect(run(page)).toBeDisabled();
    expect(await reasonOf(page)).toBe("Marca al menos una página para quitar.");
    await expect(banner(page)).toHaveCount(0);
    await expect(run(page).first().locator("xpath=ancestor::aside")).toHaveCount(1);

    await tile.click();
    await expect(run(page)).toBeEnabled();
    expect(await reasonOf(page)).toBe("");
    await tile.click();
    await expect(run(page)).toBeDisabled();
  });

  test("protect-pdf sin contraseña: motivo en linea, sin el banner generico duplicado", async ({ page }) => {
    await open(page, "protect-pdf");
    await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(2) });
    await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(run(page)).toHaveCount(1);
    await expect(run(page)).toBeDisabled();
    expect(await reasonOf(page)).toBe("Escribe una contraseña para cifrar el documento.");
    await expect(banner(page)).toHaveCount(0);
    await expectNoFailureScreen(page);

    const fields = page.locator('input[type="password"]');
    await fields.nth(0).fill("clave-larga");
    expect(await reasonOf(page)).toBe("Repite la contraseña para confirmarla.");
    await fields.nth(1).fill("otra-distinta");
    expect(await reasonOf(page)).toBe("Las dos contraseñas no coinciden.");
    await expect(banner(page)).toHaveCount(0);
    await fields.nth(1).fill("clave-larga");
    await expect(run(page)).toBeEnabled();
  });

  test("redact-pdf sin zonas: desactivado con motivo y sin alerta", async ({ page }) => {
    await open(page, "redact-pdf");
    await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(2) });
    const host = page.getByTestId("redact-canvas-host");
    await expect(host.locator("img")).toBeVisible({ timeout: 30_000 });
    await expect(run(page)).toHaveCount(1);
    await expect(run(page)).toBeDisabled();
    expect(await reasonOf(page)).toBe("Dibuja al menos una zona antes de procesar.");
    await expect(banner(page)).toHaveCount(0);

    const box = await host.boundingBox();
    if (!box) throw new Error("sin caja del lienzo");
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3, { steps: 8 });
    await page.mouse.up();
    await expect(run(page)).toBeEnabled();
  });

  for (const slug of ["split-pdf", "rotate-pdf", "extract-pages", "compress-pdf", "pdf-to-jpg"] as const) {
    test(`${slug}: con un archivo bueno hay UN solo «Procesar» visible`, async ({ page }) => {
      await open(page, slug);
      await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(3) });
      await expect(page.getByText("doc.pdf")).toBeVisible();
      await expect(run(page)).toHaveCount(1);
    });
  }

  test("merge-pdf: dos archivos, un solo Procesar; con uno solo, desactivado con motivo", async ({ page }) => {
    await open(page, "merge-pdf");
    await upload(page, { name: "a.pdf", mimeType: "application/pdf", buffer: await buildGood(2) });
    await expect(page.getByText("a.pdf").first()).toBeVisible();
    await expect(run(page)).toBeDisabled();
    expect(await reasonOf(page)).toBe(T.errors.needTwo);
    await upload(page, { name: "a.pdf", mimeType: "application/pdf", buffer: await buildGood(2) }, { name: "b.pdf", mimeType: "application/pdf", buffer: await buildGood(2) });
    await expect(run(page)).toHaveCount(1);
    await expect(run(page)).toBeEnabled({ timeout: 30_000 });
  });

  test("add-watermark con el texto vacío: desactivado con motivo", async ({ page }) => {
    await open(page, "add-watermark");
    await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(2) });
    const text = page.getByLabel("Texto de la marca");
    await expect(text).toBeVisible({ timeout: 30_000 });
    await text.fill("");
    await expect(run(page)).toBeDisabled();
    expect(await reasonOf(page)).toBe("Escribe el texto que quieres estampar.");
  });
});

/* ------------------------------------------------------------------ *
 * Movil tactil 375x812
 * ------------------------------------------------------------------ */

test.describe("movil tactil 375x812", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  test.setTimeout(90_000);

  test("archivo malo: banner legible, acciones >= 44 px, UN Procesar (barra) desactivado con motivo", async ({ page }) => {
    await open(page, "split-pdf");
    await upload(page, await bad("truncated"));
    const alert = banner(page);
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText(T.errors.corrupt);
    for (const name of [T.chooseAnother, T.removeFile]) {
      const box = await alert.getByRole("button", { name }).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    }
    await expect(run(page)).toHaveCount(1);
    await expect(run(page)).toBeDisabled();
    expect(await reasonOf(page)).toBe(T.blockedRun.replace("{action}", "Procesar"));
    // Sin desborde horizontal.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await expect.poll(() => focusInside(alert)).toBe(true);
  });

  test("remove-pages sin marcar: un Procesar y el motivo se lee sobre la barra", async ({ page }) => {
    await open(page, "remove-pages");
    await upload(page, { name: "tres.pdf", mimeType: "application/pdf", buffer: await buildGood(3) });
    await expect(page.getByRole("button", { name: /Página 1 — Marcar para eliminar/ })).toBeVisible({ timeout: 30_000 });
    await expect(run(page)).toHaveCount(1);
    await expect(run(page)).toBeDisabled();
    const reason = page.locator("[data-run-reason]:visible");
    await expect(reason).toHaveText("Marca al menos una página para quitar.");
    const reasonBox = await reason.boundingBox();
    const barBox = await run(page).boundingBox();
    expect(reasonBox && barBox && reasonBox.y < barBox.y).toBe(true);
  });

  test("PDF cifrado: la hoja de contrasena cabe y su campo y botones miden >= 44 px", async ({ page }) => {
    await open(page, "rotate-pdf");
    await upload(page, await bad("encrypted"));
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const field = dialog.getByLabel(T.password.label, { exact: true });
    for (const target of [field, dialog.getByRole("button", { name: T.password.submit }), dialog.getByRole("button", { name: T.password.cancel })]) {
      const box = await target.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
    }
    const box = await dialog.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(376);
    await field.fill("secreta");
    await dialog.getByRole("button", { name: T.password.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(run(page)).toBeEnabled();
  });
});

/* ------------------------------------------------------------------ *
 * N7 — «Procesar» siempre a la vista (pie fijo del panel) · N2 — foco
 * ------------------------------------------------------------------ */

const PANEL_TOOLS = [
  "split-pdf",
  "remove-pages",
  "extract-pages",
  "rotate-pdf",
  "compress-pdf",
  "protect-pdf",
  "add-watermark",
  "add-page-numbers",
  "pdf-to-markdown",
  "crop-pdf",
  "organize-pdf",
  "redact-pdf",
] as const;

const WINDOWS = [
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
] as const;

test.describe("«Procesar» visible sin desplazar (escritorio)", () => {
  test.setTimeout(120_000);

  for (const slug of PANEL_TOOLS) {
    test(`${slug}: el pie del panel con «Procesar» cabe en 1280x720, 1280x800 y 1440x900`, async ({ page }) => {
      await page.setViewportSize(WINDOWS[0]);
      await open(page, slug);
      await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(6) });
      await expect(run(page)).toHaveCount(1, { timeout: 30_000 });
      // Mientras se comprueba el archivo «Procesar» aun esta en la columna principal: se mide cuando ya vive en el pie del panel.
      await expect(page.locator("aside").filter({ has: run(page) })).toHaveCount(1, { timeout: 30_000 });
      await expect(page.locator("aside").getByRole("button", { name: "Procesar", exact: true })).toBeVisible();
      const row: string[] = [];
      for (const size of WINDOWS) {
        await page.setViewportSize(size);
        await expect(run(page)).toBeInViewport({ ratio: 1 });
        const box = await run(page).boundingBox();
        const y = Math.round((box?.y ?? 0) + (box?.height ?? 0));
        row.push(`${size.width}x${size.height}: ${y}`);
        expect(y).toBeLessThanOrEqual(size.height);
      }
      console.log(`[Procesar y inferior] ${slug} -> ${row.join(" | ")}`);
    });
  }

  test("tras desplazar la pagina entera «Procesar» sigue a la vista", async ({ page }) => {
    await page.setViewportSize(WINDOWS[0]);
    await open(page, "add-watermark");
    await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(10) });
    await expect(run(page)).toBeInViewport({ ratio: 1, timeout: 30_000 });
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(300);
    await expect(run(page)).toBeInViewport({ ratio: 1 });
  });
});

test.describe("«Procesar» en movil (barra fija)", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  test.setTimeout(120_000);

  for (const slug of ["add-watermark", "protect-pdf", "compress-pdf"] as const) {
    test(`${slug}: la barra con «Procesar» queda a la vista a 375x812`, async ({ page }) => {
      await open(page, slug);
      await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(4) });
      await expect(run(page)).toHaveCount(1, { timeout: 30_000 });
      await expect(run(page)).toBeInViewport({ ratio: 1 });
      const box = await run(page).boundingBox();
      expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBeLessThanOrEqual(812);
    });
  }
});

test.describe("el foco nunca cae a <body>", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test.setTimeout(90_000);

  async function bodyHasFocus(page: Page): Promise<boolean> {
    return page.evaluate(() => document.activeElement === document.body || document.activeElement === null);
  }

  for (const slug of TOOLS) {
    test(`${slug}: tras «Elegir otro archivo» con un PDF bueno el foco esta en un control`, async ({ page }) => {
      await open(page, slug);
      await upload(page, await bad("garbage"));
      const chooser = page.waitForEvent("filechooser");
      await banner(page).getByRole("button", { name: T.chooseAnother }).click();
      (await chooser).setFiles({ name: "bueno.pdf", mimeType: "application/pdf", buffer: await buildGood(3) });
      await expect(banner(page)).toHaveCount(0);
      await expect(page.getByText("bueno.pdf")).toBeVisible();
      await expect.poll(() => bodyHasFocus(page), { timeout: 8000 }).toBe(false);
    });
  }

  test("merge-pdf: «Quitar archivo» del banner con otros archivos buenos deja el foco en un control", async ({ page }) => {
    await open(page, "merge-pdf");
    await upload(
      page,
      { name: "a.pdf", mimeType: "application/pdf", buffer: await buildGood(2) },
      await bad("empty"),
      { name: "c.pdf", mimeType: "application/pdf", buffer: await buildGood(2) },
    );
    await banner(page).getByRole("button", { name: T.removeFile }).click();
    await expect(banner(page)).toHaveCount(0);
    await expect.poll(() => bodyHasFocus(page), { timeout: 8000 }).toBe(false);
  });

  test("merge-pdf: «Cancelar» en la hoja de contrasena con otros archivos buenos deja el foco en un control", async ({ page }) => {
    await open(page, "merge-pdf");
    await upload(
      page,
      { name: "a.pdf", mimeType: "application/pdf", buffer: await buildGood(2) },
      await bad("encrypted"),
    );
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: T.password.cancel }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => bodyHasFocus(page), { timeout: 8000 }).toBe(false);
  });

  test("PDF «solo-propietario» en Proteger: se abre una copia y se puede proteger (sin «protegido con contraseña»)", async ({ page }) => {
    await open(page, "protect-pdf");
    await upload(page, { name: "restringido.pdf", mimeType: "application/pdf", buffer: await buildEncrypted("") });
    await expect(page.getByRole("status").filter({ hasText: "restricciones de edición" })).toBeVisible({ timeout: 30_000 });
    await expect(banner(page)).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("protegido con contraseña");
  });
});

/* ------------------------------------------------------------------ *
 * V-F — herramientas SIN panel: «Procesar» sticky; hoja movil: pie fijo
 * ------------------------------------------------------------------ */

const NO_PANEL_TOOLS = ["repair-pdf", "pdf-to-text", "pdf-to-word", "pdf-to-excel", "pdf-to-json"] as const;

test.describe("«Procesar» sin panel visible sin desplazar (escritorio)", () => {
  test.setTimeout(120_000);

  for (const slug of NO_PANEL_TOOLS) {
    test(`${slug}: la barra con «Procesar» queda a la vista en 1280x720, 1280x800 y 1440x900`, async ({ page }) => {
      await page.setViewportSize(WINDOWS[0]);
      await open(page, slug);
      await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(8) });
      await expect(run(page)).toHaveCount(1, { timeout: 30_000 });
      await expect(run(page)).toBeVisible();
      const row: string[] = [];
      for (const size of WINDOWS) {
        await page.setViewportSize(size);
        await expect(run(page)).toBeInViewport({ ratio: 1 });
        const box = await run(page).boundingBox();
        const y = Math.round((box?.y ?? 0) + (box?.height ?? 0));
        row.push(`${size.width}x${size.height}: ${y}`);
        expect(y).toBeLessThanOrEqual(size.height);
      }
      console.log(`[Procesar y inferior sin panel] ${slug} -> ${row.join(" | ")}`);
    });
  }
});

test.describe("hoja movil de opciones: pie fijo con «Procesar»", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  test.setTimeout(120_000);

  for (const slug of ["add-watermark", "add-page-numbers", "pdf-to-markdown", "translate-pdf"] as const) {
    test(`${slug}: «Procesar» de la hoja queda a la vista (bottom <= 812) con scroll interno`, async ({ page }) => {
      await open(page, slug);
      await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(4) });
      await page.getByRole("button", { name: T.openOptions, exact: true }).click({ timeout: 30_000 });
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const button = dialog.getByRole("button", { name: "Procesar", exact: true });
      await expect(button).toBeInViewport({ ratio: 1 });
      const box = await button.boundingBox();
      const y = Math.round((box?.y ?? 0) + (box?.height ?? 0));
      console.log(`[Procesar y inferior hoja movil] ${slug} -> 375x812: ${y}`);
      expect(y).toBeLessThanOrEqual(812);
      // Las opciones se desplazan DENTRO de la hoja (el pie no se mueve con ellas).
      const scroller = dialog.locator(".overflow-y-auto").first();
      await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await page.waitForTimeout(200);
      await expect(button).toBeInViewport({ ratio: 1 });
    });
  }
});

/* ------------------------------------------------------------------ *
 * V-G — objetivos tactiles de 44 px (puntero grueso, 375 px) y hoja movil con el fondo inerte
 * ------------------------------------------------------------------ */

/** Botones con ese nombre en el arbol de accesibilidad REAL de Chromium (los inertes / ocultos no cuentan). */
async function accessibleButtonCount(page: Page, name: string): Promise<number> {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = (await session.send("Accessibility.getFullAXTree")) as {
      nodes: Array<{ ignored?: boolean; role?: { value?: string }; name?: { value?: string } }>;
    };
    return nodes.filter((node) => !node.ignored && node.role?.value === "button" && node.name?.value === name).length;
  } finally {
    await session.detach();
  }
}

test.describe("movil tactil 375x812 · objetivos y hoja", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  test.setTimeout(120_000);

  test("redact: «Vaciar esta página» y «Vaciar todo» miden 44 px de alto", async ({ page }) => {
    await open(page, "redact-pdf");
    await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(2) });
    for (const name of ["Vaciar esta página", "Vaciar todo"]) {
      const button = page.getByRole("button", { name }).first();
      await expect(button).toBeVisible({ timeout: 30_000 });
      const box = await button.boundingBox();
      expect(box?.height ?? 0, name).toBeGreaterThanOrEqual(43.5);
    }
  });

  test("scan-to-pdf: «Usar la app de Cámara…» y «Elegir fotos…» miden 44 px de alto", async ({ page }) => {
    await page.goto("/scan-to-pdf");
    for (const name of [/Usar la app de Cámara/, /Elegir fotos/]) {
      const button = page.getByRole("button", { name }).first();
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.height ?? 0, String(name)).toBeGreaterThanOrEqual(43.5);
    }
  });

  for (const slug of ["split-pdf", "compress-pdf", "crop-pdf"] as const) {
    test(`${slug}: con la hoja de opciones abierta, el «Procesar» de la barra de fondo NO esta en el arbol de accesibilidad`, async ({ page, browserName }) => {
      test.skip(browserName !== "chromium", "el arbol de accesibilidad real se pide por CDP (Accessibility.getFullAXTree), solo Chromium");
      await open(page, slug);
      await upload(page, { name: "doc.pdf", mimeType: "application/pdf", buffer: await buildGood(3) });
      const opciones = page.getByRole("button", { name: T.openOptions, exact: true });
      await expect(opciones).toBeEnabled({ timeout: 30_000 });
      await opciones.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      // Solo el «Procesar» de la hoja esta en el ARBOL DE ACCESIBILIDAD del navegador (el de la barra de fondo,
      // inerte, queda fuera). Se mide con el arbol real (CDP), no con la heuristica de los localizadores.
      expect(await accessibleButtonCount(page, "Procesar")).toBe(1);
      await expect(dialog.getByRole("button", { name: "Procesar", exact: true })).toHaveCount(1);
      // Al cerrar la hoja el fondo vuelve a ser accesible y el foco no cae a <body>.
      await dialog.getByRole("button", { name: es.common.close }).first().click();
      await expect(dialog).toBeHidden();
      expect(await accessibleButtonCount(page, "Procesar")).toBe(1);
      await expect.poll(() => page.evaluate(() => document.activeElement === document.body || document.activeElement === null), { timeout: 8000 }).toBe(false);
    });
  }
});
