/**
 * Ayudas de los E2E del autorrelleno desde documentos (interfaz): motor FALSO inyectado (sin rutas de prueba en el build,
 * igual que el Escaner: `globalThis.__optimusAutofillEngine`) y documentos SINTETICOS con datos INVENTADOS (nunca PDFs ni fotos
 * reales). Los PDF de fuente llevan de verdad el texto «Etiqueta: valor», asi que los mismos specs pueden correr contra el motor
 * real de E1 con `AUTOFILL_REAL=1` (no se inyecta nada).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "@cantoo/pdf-lib";
import { expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { fileInput } from "./sign-flow";

const ROOT = process.cwd();

/** Holgura del CI de Linux (fuente ancha, ~2,5x mas lento). */
export const SLACK = process.env.CI ? 2.5 : 1;
export const expect = baseExpect.configure({ timeout: Math.round(5_000 * SLACK * 1.5) });
export const TEST_TIMEOUT = Math.round(60_000 * SLACK);

export const USE_REAL_ENGINE = process.env.AUTOFILL_REAL === "1";
export const FAKE_ONLY_REASON = "solo con el motor falso: sus valores estan guionizados por nombre de archivo; con el real lo cubren los specs del motor";

const BUNDLE = path.join(ROOT, ".evidence", `autofill-fakes-${process.pid}.iife.js`);
let built = false;
function ensureBundle(): string {
  if (built && existsSync(BUNDLE)) return BUNDLE;
  mkdirSync(path.dirname(BUNDLE), { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, "e2e/helpers/autofill-fakes-bundle.mjs"), BUNDLE], { cwd: ROOT, stdio: "pipe" });
  built = true;
  return BUNDLE;
}

export type FakeSpec = { key: string; value: string; tier?: "high" | "review"; confidence?: number; page?: number; snippet?: string; reason?: string };
export type FakeConfig = {
  ocr?: { available?: boolean; prepare?: "ok" | "offline" | "network" | "engine"; delayMs?: number };
  byName?: Record<string, FakeSpec[]>;
  warnings?: Record<string, string[]>;
  delayMs?: number;
  steps?: number;
  failWith?: string | null;
};

/** Inyecta el motor falso (y su guion) antes de que cargue la pagina. */
export async function installAutofillFakes(page: Page, config: FakeConfig = {}): Promise<void> {
  if (USE_REAL_ENGINE) return;
  await page.addInitScript((cfg) => {
    (globalThis as unknown as { __autofillFakeConfig: unknown }).__autofillFakeConfig = cfg;
  }, config);
  await page.addInitScript({ path: ensureBundle() });
}

/** Cuantas veces se llamo al motor falso y con que fuentes (nombres, nunca contenido). */
export async function engineCalls(page: Page): Promise<{ sources: string[]; locale: string }[]> {
  return page.evaluate(() => (globalThis as unknown as { __autofillFakeCalls?: { sources: string[]; locale: string }[] }).__autofillFakeCalls ?? []);
}

/** Cuantas veces se pregunto por el modelo de lectura y cuantas se descargo (con el motor falso). */
export async function ocrCalls(page: Page): Promise<{ available: boolean; checks: number; prepares: number }> {
  return page.evaluate(() => (globalThis as unknown as { __autofillFakeOcr?: { available: boolean; checks: number; prepares: number } }).__autofillFakeOcr ?? { available: true, checks: 0, prepares: 0 });
}

/* ------------------------------------------------------------------ *
 * Datos y documentos sinteticos (INVENTADOS)
 * ------------------------------------------------------------------ */

export const CLIENT = {
  name: "Maria Perez Soto",
  phone: "(555) 010-0001",
  email: "maria.perez@ejemplo.test",
  address: "Calle Falsa 123, Ciudad Demo",
  insurer: "Aseguradora Demo S.A.",
  policy: "POL-0001-DEMO",
  claim: "CLM-2026-0042",
  loss: "2026-09-30",
} as const;

export const OTHER_CLIENT = { name: "Luis Gomez Rivas", phone: "555-010-0002", policy: "POL-0002-DEMO" } as const;

/** Lo que el motor falso «lee» del PDF de la poliza (el guion es por nombre de archivo). */
export const POLICY_SPECS: FakeSpec[] = [
  { key: "insuredName1", value: CLIENT.name, page: 1, snippet: `Insured: ${CLIENT.name}`, reason: "junto a «Insured:» en la pagina 1" },
  { key: "phone", value: CLIENT.phone, page: 1, snippet: `Phone: ${CLIENT.phone}` },
  { key: "policyNumber", value: CLIENT.policy, page: 2, snippet: `Policy Number: ${CLIENT.policy}` },
  { key: "claimNumber", value: CLIENT.claim, tier: "review", confidence: 0.55, page: 2, snippet: `Claim #: ${CLIENT.claim}` },
];

/** Una poliza de 2 paginas con las lineas «Etiqueta: valor» (el motor real puede leerla; el falso ignora el contenido). */
export async function makePolicyPdf(client: { name: string; phone: string; policy: string } = CLIENT): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const first = doc.addPage([420, 300]);
  first.drawText("POLICY DECLARATIONS", { x: 40, y: 260, size: 16, font });
  first.drawText(`Insured: ${client.name}`, { x: 40, y: 220, size: 12, font });
  first.drawText(`Phone: ${client.phone}`, { x: 40, y: 200, size: 12, font });
  const second = doc.addPage([420, 300]);
  second.drawText(`Policy Number: ${client.policy}`, { x: 40, y: 220, size: 12, font });
  second.drawText(`Claim #: ${CLIENT.claim}`, { x: 40, y: 200, size: 12, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export const FORM_LABELS = ["Insured", "Phone", "Policy Number", "Claim Number", "Observaciones"] as const;

/** El contrato A RELLENAR: un formulario AcroForm con campos de texto cuyos nombres son las etiquetas. */
export async function makeClaimForm(title = "CLAIM FORM"): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText(title, { x: 50, y: 790, size: 18, font, color: rgb(0, 0, 0) });
  const form = doc.getForm();
  FORM_LABELS.forEach((label, index) => {
    const y = 730 - index * 50;
    page.drawText(`${label}:`, { x: 50, y: y + 8, size: 11, font });
    form.createTextField(label).addToPage(page, { x: 200, y, width: 300, height: 26 });
  });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Un contrato EN BLANCO con rayas para escribir (campos «sugeridos» por la deteccion, sin formulario AcroForm). */
export async function makeBlankContract(): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(new Date(0));
  doc.setModificationDate(new Date(0));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("SERVICE CONTRACT", { x: 50, y: 790, size: 18, font });
  const lines: [string, number][] = [["Insured:", 730], ["Phone:", 700], ["Policy Number:", 670], ["Claim Number:", 640]];
  for (const [label, y] of lines) {
    page.drawText(label, { x: 50, y, size: 11, font });
    const width = font.widthOfTextAtSize(label, 11);
    page.drawLine({ start: { x: 50 + width + 6, y: y - 2 }, end: { x: 330, y: y - 2 }, thickness: 0.8, color: rgb(0, 0, 0) });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Una foto sintetica (JPEG de una hoja con texto) para la fuente «Tomar foto». */
export function tinyJpeg(): Buffer {
  // JPEG minimo valido de 1x1 px (la lectura es del motor falso; solo importa que el navegador lo acepte como imagen).
  return Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
    "base64",
  );
}

/* ------------------------------------------------------------------ *
 * Pasos de la interfaz
 * ------------------------------------------------------------------ */

export async function openSignWith(page: Page, name: string, bytes: Buffer): Promise<void> {
  await page.goto("/sign-pdf");
  await fileInput(page).setInputFiles({ name, mimeType: "application/pdf", buffer: bytes });
  await page.locator('img[alt]:not([alt=""])').first().waitFor({ state: "visible", timeout: 30_000 });
}

export const BUTTON_ES = "Rellenar con datos del cliente";
export const BUTTON_EN = "Fill with client data";

export function autofillButton(page: Page, language: "es" | "en" = "es"): Locator {
  return page.getByRole("button", { name: language === "es" ? BUTTON_ES : BUTTON_EN });
}

export function sheet(page: Page): Locator {
  return page.getByRole("dialog").first();
}

/** Abre la hoja y espera a que el primer control tenga el foco. */
export async function openAutofill(page: Page, language: "es" | "en" = "es"): Promise<Locator> {
  await expect(autofillButton(page, language)).toBeVisible({ timeout: 30_000 });
  await autofillButton(page, language).click();
  const dialog = sheet(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-autofill-initial]")).toBeFocused();
  return dialog;
}

export async function addFileSource(page: Page, name: string, bytes: Buffer, mimeType = "application/pdf", via: "file" | "camera" | "scan" = "file"): Promise<void> {
  await sheet(page).locator(`[data-autofill-input="${via}"]`).setInputFiles({ name, mimeType, buffer: bytes });
}

/** Lee las fuentes elegidas y espera al paso «Revisar». */
export async function readAndReview(page: Page, language: "es" | "en" = "es"): Promise<void> {
  await sheet(page).getByRole("button", { name: language === "es" ? "Leer datos" : "Read data" }).click();
  await expect(sheet(page).locator("[data-autofill-review]")).toBeVisible({ timeout: 30_000 });
}

/** El campo de texto del lienzo con esa etiqueta (su nombre accesible empieza por «Etiqueta, estado»). */
export function textFieldBox(page: Page, label: string): Locator {
  return page.locator(`[data-element-kind="text"][aria-label^="${label},"]`);
}

/** El texto escrito en cada campo de texto del lienzo, por etiqueta (sin la etiqueta que el campo pinta encima). */
export async function fieldValues(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const node of Array.from(document.querySelectorAll('[data-element-kind="text"][data-element-id]'))) {
      const label = (node.getAttribute("aria-label") ?? "").split(",")[0];
      const input = node.querySelector("input,textarea") as HTMLInputElement | null;
      const lines = input ? [input.value] : (((node as HTMLElement).innerText ?? "").split("\n"));
      const text = input ? lines[0] : lines.slice(1).join(" ");
      out[label] = text.trim();
    }
    return out;
  });
}
