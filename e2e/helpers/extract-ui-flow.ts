/**
 * Piezas comunes de los E2E de la interfaz de «Extraer elementos» (F7 · U7.4): empaqueta el MOTOR FALSO
 * (`e2e/helpers/extract-entry.ts`, con Vite, en memoria), lo inyecta en la build de produccion ANTES de que arranque la
 * pagina (`addInitScript`: crea `globalThis.__optimusExtractEngine`, el gancho inerte de `extractAssets/index.ts`), fija el
 * idioma sin carreras es -> en y abre la herramienta con un PDF sintetico. SIEMPRE headless; ningun dato real.
 */
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { build } from "vite";
import type { FakeEngineOptions } from "../../src/lib/pdf/extractAssets/testing/fakeEngine";
import { makePdf, pdfUpload, type PdfUpload } from "./test-files";

let cachedBundle: Promise<string> | null = null;

/** El IIFE del motor falso (una vez por proceso de prueba). */
export function fakeEngineBundle(): Promise<string> {
  cachedBundle ??= (async () => {
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
        lib: { entry: path.resolve(process.cwd(), "e2e/helpers/extract-entry.ts"), name: "ExtractLab", formats: ["iife"], fileName: () => "extract.js" },
      },
    });
    const outputs = Array.isArray(output) ? output : [output];
    const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el motor falso de extraccion");
    return chunk.code;
  })();
  return cachedBundle;
}

export type Lang = "es" | "en";

/** Idioma fijo desde el primer pintado (sin carrera es -> en al hidratar). */
export async function setLanguage(page: Page, lang: Lang): Promise<void> {
  await page.addInitScript((value) => {
    try {
      window.localStorage.setItem("optimuspdf.language", value);
    } catch {
      /* almacenamiento bloqueado */
    }
  }, lang);
}

/** Inyecta el motor falso con esas opciones (antes de que la pagina arranque). */
export async function installFake(page: Page, options: FakeEngineOptions = {}): Promise<void> {
  const code = await fakeEngineBundle();
  await page.addInitScript({ content: `${code}\n;ExtractLab.installFakeEngine(${JSON.stringify(options)});` });
}

/** Cambia el escenario del motor falso en caliente. */
export async function configureFake(page: Page, options: FakeEngineOptions): Promise<void> {
  await page.evaluate((next) => (window as unknown as { __fakeExtract: { configure(o: unknown): void } }).__fakeExtract.configure(next), options);
}

export async function fakeCalls(page: Page): Promise<{ method: string; detail: string }[]> {
  return page.evaluate(() => [...(window as unknown as { __fakeExtract: { calls: { method: string; detail: string }[] } }).__fakeExtract.calls]);
}

export async function syntheticPdf(pages = 6, label = "DOC"): Promise<PdfUpload> {
  return pdfUpload("contrato.pdf", await makePdf({ pages, label }));
}

export function pdfInput(page: Page): Locator {
  return page.locator('input[type="file"][accept*="pdf"]').first();
}

export type OpenOptions = { lang?: Lang; fake?: FakeEngineOptions | null; pages?: number; fileName?: string };

/** Abre `/extract-assets` (con el motor falso) y sube un PDF sintetico; NO pulsa «Buscar elementos». */
export async function openExtract(page: Page, options: OpenOptions = {}): Promise<PdfUpload> {
  await setLanguage(page, options.lang ?? "es");
  if (options.fake !== null) await installFake(page, options.fake ?? {});
  await page.goto("/extract-assets");
  const upload = await syntheticPdf(options.pages ?? 6);
  if (options.fileName) upload.name = options.fileName;
  await pdfInput(page).setInputFiles(upload);
  return upload;
}

export const RUN_ES = "Buscar elementos";
export const RUN_EN = "Find elements";

/** Abre, sube y busca; espera el resultado. */
export async function openAndRun(page: Page, options: OpenOptions = {}): Promise<void> {
  await openExtract(page, options);
  await page.getByRole("button", { name: (options.lang ?? "es") === "en" ? RUN_EN : RUN_ES }).click();
  await expect(page.locator("[data-extract-heading]")).toBeVisible({ timeout: 30_000 });
}

/** La lista de elementos (cada `li` lleva el nombre accesible del elemento). */
export function assetList(page: Page): Locator {
  return page.getByRole("list", { name: /Elementos encontrados|Elements found/ });
}

/** Un PDF REAL de una pagina con una firma dibujada con trazos (azul, abajo a la izquierda) y la etiqueta «Firma:». */
export async function signaturePdf(options: { scannedLike?: boolean } = {}): Promise<PdfUpload> {
  const { PDFDocument, StandardFonts, rgb } = await import("@cantoo/pdf-lib");
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Contrato de servicio", { x: 72, y: 700, size: 20, font, color: rgb(0.1, 0.1, 0.1) });
  page.drawText("Firma:", { x: 72, y: 214, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  // Firma: curva sinusoidal azul entre x = 120 y x = 300, a ~ 190 pt del borde inferior (el 76 % de la altura, desde arriba).
  let previous: { x: number; y: number } | null = null;
  for (let step = 0; step <= 60; step += 1) {
    const t = step / 60;
    const point = { x: 120 + t * 180, y: 190 + Math.sin(t * Math.PI * 6) * 14 };
    if (previous) page.drawLine({ start: previous, end: point, thickness: options.scannedLike ? 2.2 : 1.6, color: rgb(0.08, 0.2, 0.55) });
    previous = point;
  }
  return pdfUpload("firma-real.pdf", Buffer.from(await doc.save()));
}

/** Region normalizada que encierra la firma de `signaturePdf` (x, y, ancho, alto: fracciones de la pagina). */
export const SIGNATURE_REGION = { x: 0.15, y: 0.7, width: 0.4, height: 0.12 } as const;

/** PNG de 1 x 1 px (valido para el baul): relleno de las entradas de siembra. */
const PNG_1X1_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Siembra `count` firmantes (solo firma, PNG de 1 px) DIRECTAMENTE en el IndexedDB del baul, con el mismo esquema que crea
 * la aplicacion. Sirve para llegar al tope de 30 firmas sin guardar 30 veces por la interfaz.
 */
export async function seedVault(page: Page, count: number, prefix = "Sembrado"): Promise<void> {
  await page.evaluate(
    async ({ total, base, png }) => {
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("optimuspdf-signature-vault", 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains("signatures")) {
            const store = request.result.createObjectStore("signatures", { keyPath: "id" });
            store.createIndex("bySignerKey", "signerKey", { unique: false });
            store.createIndex("byLastUsedAt", "lastUsedAt", { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("signatures", "readwrite");
        const store = tx.objectStore("signatures");
        for (let index = 0; index < total; index += 1) {
          const name = `${base} ${String(index + 1).padStart(2, "0")}`;
          const stamp = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
          store.put({
            id: `vault-seed-${index}`,
            schema: 1,
            signerName: name,
            signerKey: name.toLowerCase(),
            sourceDocument: "",
            createdAt: stamp,
            lastUsedAt: stamp,
            signature: { png: bytes, ratio: 1, width: 1, height: 1 },
            initials: null,
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { total: count, base: prefix, png: PNG_1X1_BASE64 },
  );
}
