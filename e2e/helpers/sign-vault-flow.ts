/**
 * Piezas comunes de los E2E de «Subir firma o iniciales» y «Exportar / Importar firmas» (F6 · U6.2 y U4.4-UI): abrir
 * «Firmas guardadas», subir una imagen sintetica, exportar e importar, y leer de verdad el baul (IndexedDB) con el hash de
 * cada PNG y la estadistica de su transparencia. Los textos son los de la interfaz en espanol. SIEMPRE headless.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import type { SyntheticImage } from "./ink-images";

export const VAULT_TITLE = "Firmas guardadas";
export const PRIVACY_SEEN_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";

/** Color de fondo de la hoja de prueba: amarillo palido, para que un recuadro BLANCO alrededor de la firma se note. */
export const PAGE_BG = { r: 237, g: 230, b: 158 };

/** PDF de una pagina con fondo de color (no blanco) y un titulo arriba. */
export async function makeColoredPdf(label = "Contrato"): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sheet = doc.addPage([400, 300]);
  sheet.drawRectangle({ x: 0, y: 0, width: 400, height: 300, color: rgb(PAGE_BG.r / 255, PAGE_BG.g / 255, PAGE_BG.b / 255) });
  sheet.drawText(`${label} de servicio`, { x: 40, y: 262, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  return Buffer.from(await doc.save());
}

export function pdfInput(page: Page): Locator {
  return page.locator('input[type="file"][accept*="pdf"]').first();
}

/** Abre `/sign-pdf` con el aviso de privacidad ya visto y sube el PDF; espera a que la hoja este pintada. */
export async function openSignWithPdf(page: Page, bytes: Buffer, name = "contrato.pdf"): Promise<void> {
  await page.addInitScript((key) => {
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      /* almacenamiento bloqueado */
    }
  }, PRIVACY_SEEN_KEY);
  await page.goto("/sign-pdf");
  await pdfInput(page).setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
}

/** Abre la hoja «Firmas guardadas» desde el boton del panel de firma. */
export async function openVault(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: VAULT_TITLE }).first().click();
  const dialog = page.getByRole("dialog", { name: VAULT_TITLE });
  await expect(dialog).toBeVisible();
  return dialog;
}

export function uploadSheet(page: Page): Locator {
  return page.getByRole("dialog", { name: "Subir firma o iniciales" });
}

/** Sube la imagen en la hoja de subida (ya abierta) y llega a la vista previa lista. */
export async function chooseImage(page: Page, image: SyntheticImage): Promise<Locator> {
  const sheet = uploadSheet(page);
  await sheet.locator("[data-ink-file-input]").setInputFiles(image);
  await expect(sheet.getByRole("heading", { name: "Ajusta la imagen" })).toBeVisible({ timeout: 30_000 });
  await expect(sheet.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
  return sheet;
}

/** Subir una imagen y guardarla en «Firmas guardadas» desde la hoja de vault ya abierta. */
export async function uploadAndSave(
  page: Page,
  image: SyntheticImage,
  options: { name: string; role?: string; kind?: "Firma" | "Iniciales" },
): Promise<void> {
  const vault = page.getByRole("dialog", { name: VAULT_TITLE });
  await vault.getByRole("button", { name: "Subir firma o iniciales" }).click();
  const sheet = await chooseImage(page, image);
  if (options.kind === "Iniciales") await sheet.getByRole("radio", { name: "Iniciales" }).click();
  await expect(sheet.locator("[data-ink-accept]")).toBeEnabled({ timeout: 60_000 });
  await sheet.locator("[data-ink-accept]").click();
  await expect(sheet.getByRole("heading", { name: "Lo que se guardará" })).toBeVisible();
  await sheet.getByLabel("Nombre del firmante").fill(options.name);
  if (options.role) await sheet.getByLabel("Cargo (opcional)").fill(options.role);
  await sheet.getByRole("button", { name: "Guardar en Firmas guardadas" }).click();
  await expect(sheet).toBeHidden({ timeout: 15_000 });
}

export type VaultRow = {
  id: string;
  signerName: string;
  role: string | null;
  origin: string | null;
  sourceDocument: string;
  signatureHash: string | null;
  initialsHash: string | null;
  signatureBytes: number;
  signature: PngStats | null;
  initials: PngStats | null;
};

export type PngStats = {
  width: number;
  height: number;
  /** Fraccion de pixeles totalmente transparentes. */
  transparent: number;
  /** Fraccion de pixeles casi opacos (alfa >= 200). */
  opaque: number;
  /** Alfa de las cuatro esquinas. */
  corners: number[];
  /** Color medio de la tinta (pixeles opacos). */
  ink: { r: number; g: number; b: number } | null;
};

/** Lo que HAY en el baul (IndexedDB real del navegador), con hash de cada PNG y estadistica de su transparencia. */
export async function readVault(page: Page): Promise<VaultRow[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("optimuspdf-signature-vault");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      if (!db.objectStoreNames.contains("signatures")) {
        resolve([]);
        return;
      }
      const request = db.transaction("signatures").objectStore("signatures").getAll();
      request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const hex = async (bytes: Uint8Array) =>
      Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    const stats = async (bytes: Uint8Array) => {
      // Un PNG que el navegador no sabe decodificar (los paquetes dorados llevan imagenes sinteticas) no tiene estadistica.
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" })).catch(() => null);
      if (!bitmap) return null;
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let transparent = 0;
      let opaque = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) transparent += 1;
        if (alpha >= 200) {
          opaque += 1;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }
      const count = canvas.width * canvas.height;
      const at = (x: number, y: number) => data[(y * canvas.width + x) * 4 + 3];
      return {
        width: canvas.width,
        height: canvas.height,
        transparent: transparent / count,
        opaque: opaque / count,
        corners: [at(0, 0), at(canvas.width - 1, 0), at(0, canvas.height - 1), at(canvas.width - 1, canvas.height - 1)],
        ink: opaque > 0 ? { r: Math.round(r / opaque), g: Math.round(g / opaque), b: Math.round(b / opaque) } : null,
      };
    };
    const rows = [];
    for (const record of records) {
      const signature = record.signature as { png: Uint8Array } | null;
      const initials = record.initials as { png: Uint8Array } | null;
      rows.push({
        id: String(record.id),
        signerName: String(record.signerName),
        role: typeof record.role === "string" ? record.role : null,
        origin: typeof record.origin === "string" ? record.origin : null,
        sourceDocument: String(record.sourceDocument ?? ""),
        signatureHash: signature ? await hex(signature.png) : null,
        initialsHash: initials ? await hex(initials.png) : null,
        signatureBytes: signature ? signature.png.byteLength : 0,
        signature: signature ? await stats(signature.png) : null,
        initials: initials ? await stats(initials.png) : null,
      });
    }
    return rows.sort((a, b) => a.signerName.localeCompare(b.signerName));
  });
}

/** Huella comparable de un baul: firmante + hash de cada imagen (lo que debe quedar IDENTICO al exportar/importar). */
export function fingerprint(rows: readonly VaultRow[]): string[] {
  return rows.map((row) => [row.signerName, row.role ?? "", row.signatureHash ?? "-", row.initialsHash ?? "-"].join("|")).sort();
}

/** Borra TODAS las firmas desde la hoja del baul (con su confirmacion). */
export async function deleteAllSignatures(page: Page): Promise<void> {
  const vault = page.getByRole("dialog", { name: VAULT_TITLE });
  await vault.getByRole("button", { name: "Borrar todas" }).click();
  const confirm = page.getByRole("dialog", { name: "¿Borrar todas las firmas guardadas?" });
  await confirm.getByRole("button", { name: "Borrar todas" }).click();
  await expect(page.getByText("Todas las firmas guardadas se han borrado.")).toBeVisible();
  await expect.poll(async () => (await readVault(page)).length).toBe(0);
}

export type ExportedFile = { bytes: Buffer; filename: string };

/**
 * «Exportar todas mis firmas»: rellena la hoja y devuelve el archivo. Con el puntero tactil y `navigator.share({files})`
 * disponible la hoja pide un segundo toque («Compartir o guardar en Archivos» / «Descargar»): aqui se usa «Descargar».
 */
export async function exportAll(page: Page, options: { password?: string } = {}): Promise<ExportedFile> {
  const vault = page.getByRole("dialog", { name: VAULT_TITLE });
  await vault.getByRole("button", { name: "Exportar todas mis firmas" }).click();
  const sheet = page.getByRole("dialog", { name: "Exportar todas mis firmas" });
  await expect(sheet).toBeVisible();
  const protect = sheet.getByRole("checkbox", { name: "Proteger con contraseña" });
  if (options.password) {
    await expect(protect).toBeChecked();
    await sheet.getByLabel("Contraseña", { exact: true }).fill(options.password);
    await sheet.getByLabel("Repite la contraseña").fill(options.password);
  } else {
    // La casilla del sistema se activa por su etiqueta (la fila entera es el objetivo; el input queda bajo ella).
    await sheet.locator("label", { hasText: "Proteger con contraseña" }).click();
    await expect(protect).not.toBeChecked();
    await expect(sheet.getByText(/Sin contraseña, el archivo llevará tus firmas sin cifrar/)).toBeVisible();
  }
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await sheet.getByRole("button", { name: "Exportar", exact: true }).click();
  const downloadButton = sheet.getByRole("button", { name: "Descargar", exact: true });
  const download = await Promise.race([
    downloadPromise,
    downloadButton
      .waitFor({ timeout: 60_000 })
      .then(async () => {
        const next = page.waitForEvent("download", { timeout: 30_000 });
        await downloadButton.click();
        return next;
      })
      // Si no aparece (descarga directa), esta rama no decide nada: manda la otra.
      .catch(() => new Promise<never>(() => {})),
  ]);
  const fs = await import("node:fs/promises");
  const path = await download.path();
  return { bytes: await fs.readFile(path), filename: download.suggestedFilename().normalize("NFC") };
}

/** Abre «Importar firmas» y entrega el archivo; devuelve la hoja (en la fase siguiente: contrasena o vista previa). */
export async function startImport(page: Page, file: { name: string; buffer: Buffer }): Promise<Locator> {
  const vault = page.getByRole("dialog", { name: VAULT_TITLE });
  await vault.getByRole("button", { name: "Importar firmas", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Importar firmas" });
  await expect(sheet).toBeVisible();
  await sheet.locator("[data-backup-file-input]").setInputFiles({ name: file.name, mimeType: "application/zip", buffer: file.buffer });
  return sheet;
}
