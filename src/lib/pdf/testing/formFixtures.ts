import { PDFDocument, StandardFonts, degrees } from "@cantoo/pdf-lib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * PDF de prueba con formularios AcroForm reales (Wave 7 · U7) y lectores INDEPENDIENTES del motor de
 * relleno (pdf.js y poppler) para comprobar el resultado desde fuera. Solo para pruebas.
 */

export type FormFixtureOptions = {
  /** Texto de la etiqueta de cada pagina (marca de contenido). */
  pages?: number;
  /** Nombres de los campos de texto (uno por entrada, repartidos en la pagina 1). */
  textFields?: string[];
  multiline?: boolean;
  checkbox?: boolean;
  checkboxChecked?: boolean;
  dropdown?: boolean;
  radio?: boolean;
  list?: boolean;
  multiList?: boolean;
  readOnlyText?: boolean;
  maxLengthText?: number;
  /** Valor inicial del primer campo de texto. */
  initialText?: string;
  /** Un campo de texto en la pagina 2 (si `pages` >= 2). */
  textOnPage2?: boolean;
  /** Pagina rotada 90 grados. */
  rotate?: boolean;
};

export async function makeFormPdf(options: FormFixtureOptions = {}): Promise<Uint8Array> {
  const { pages = 1, textFields = ["nombre", "apellido"] } = options;
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const sheets = Array.from({ length: pages }, (_, index) => {
    const page = document.addPage([400, 500]);
    page.drawText(`Hoja ${index + 1} del formulario`, { x: 40, y: 460, size: 14, font });
    return page;
  });
  const page = sheets[0];
  const form = document.getForm();
  textFields.forEach((name, index) => {
    const field = form.createTextField(name);
    if (index === 0 && options.initialText) field.setText(options.initialText);
    if (index === 0 && options.maxLengthText) field.setMaxLength(options.maxLengthText);
    field.addToPage(page, { x: 40, y: 410 - index * 34, width: 220, height: 24 });
  });
  if (options.multiline) {
    const notes = form.createTextField("notas");
    notes.enableMultiline();
    notes.addToPage(page, { x: 40, y: 250, width: 300, height: 70 });
  }
  if (options.readOnlyText) {
    const locked = form.createTextField("fijo");
    locked.setText("VALOR FIJO");
    locked.enableReadOnly();
    locked.addToPage(page, { x: 40, y: 220, width: 160, height: 22 });
  }
  if (options.checkbox) {
    const box = form.createCheckBox("acepto");
    box.addToPage(page, { x: 40, y: 190, width: 16, height: 16 });
    if (options.checkboxChecked) box.check();
  }
  if (options.dropdown) {
    const dropdown = form.createDropdown("pais");
    dropdown.addOptions(["España", "México", "Chile"]);
    dropdown.addToPage(page, { x: 120, y: 186, width: 150, height: 24 });
  }
  if (options.radio) {
    const radio = form.createRadioGroup("sexo");
    radio.addOptionToPage("M", page, { x: 40, y: 150, width: 16, height: 16 });
    radio.addOptionToPage("F", page, { x: 80, y: 150, width: 16, height: 16 });
  }
  if (options.list) {
    const list = form.createOptionList("idiomas");
    list.addOptions(["es", "en", "fr"]);
    if (options.multiList) list.enableMultiselect();
    list.addToPage(page, { x: 200, y: 90, width: 100, height: 60 });
  }
  if (options.textOnPage2 && sheets[1]) {
    const second = form.createTextField("pagina2");
    second.addToPage(sheets[1], { x: 40, y: 400, width: 200, height: 24 });
  }
  if (options.rotate) {
    for (const sheet of sheets) sheet.setRotation(degrees(90));
  }
  return document.save();
}

/** Un PDF sin formulario, con `pages` hojas de texto. */
export async function makePlainPdf(pages = 1): Promise<Uint8Array> {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = document.addPage([400, 500]);
    page.drawText(`Contrato pagina ${index + 1}`, { x: 40, y: 450, size: 16, font });
    page.drawText("Clausula de prueba para firmar", { x: 40, y: 420, size: 11, font });
  }
  return document.save();
}

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<Pdfjs> | null = null;

/**
 * Valores de los campos tal como los lee pdf.js (`getFieldObjects`): nombre -> widgets (las hojas; el nodo
 * padre sin tipo que pdf.js tambien lista se descarta).
 */
export async function pdfjsFieldObjects(
  bytes: Uint8Array,
): Promise<Record<string, { type: string; value?: unknown; id: string }[]>> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfjsPromise;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const raw = ((await pdf.getFieldObjects()) ?? {}) as Record<string, { type: string; value?: unknown; id: string }[]>;
    return Object.fromEntries(
      Object.entries(raw).map(([name, objects]) => [name, objects.filter((object) => object.type !== "")]),
    );
  } finally {
    await task.destroy();
  }
}

/** Texto de pagina (con los widgets pintados) de pdf.js, concatenado. */
export async function pdfjsPageText(bytes: Uint8Array, pageNumber = 1): Promise<string> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjs = await pdfjsPromise;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
  } finally {
    await task.destroy();
  }
}

let poppler: boolean | null = null;
/** `pdftotext` (poppler) esta instalado. */
export function hasPoppler(): boolean {
  if (poppler === null) {
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
      poppler = true;
    } catch {
      // `pdftotext -v` sale con codigo 0 en poppler; cualquier fallo aqui significa «no esta».
      poppler = false;
    }
  }
  return poppler;
}

/** Texto de un PDF segun poppler (`pdftotext -layout`). Lanza si poppler no esta: usar con `hasPoppler()`. */
export function popplerText(bytes: Uint8Array, firstPage = 1, lastPage = firstPage): string {
  const dir = mkdtempSync(path.join(tmpdir(), "form-fixture-"));
  try {
    const file = path.join(dir, "in.pdf");
    writeFileSync(file, bytes);
    return execFileSync("pdftotext", ["-layout", "-f", String(firstPage), "-l", String(lastPage), file, "-"], {
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
