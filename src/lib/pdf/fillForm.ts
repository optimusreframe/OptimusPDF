import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  type PDFField,
} from "@cantoo/pdf-lib";
import {
  PdfError,
  getPageGeometry,
  loadPdf,
  toPdfError,
  userBoxToNormalizedRect,
  type NormalizedRect,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { walkAcroFormTextWidgets } from "@/lib/pdf/detectFields";

/**
 * Relleno de formularios AcroForm REALES (Wave 7 · U7, modo Rellenar de PDF Pro).
 *
 * Lee los campos del formulario (texto, casillas, radios, listas desplegables y de opciones) y ESCRIBE los
 * valores en el propio PDF con pdf-lib: `/V` (y `/AS` en casillas y radios) mas la apariencia del widget, de
 * modo que cualquier lector (pdf.js, Acrobat, poppler) ve y conserva el valor, y el campo sigue siendo un
 * campo. Opcionalmente aplana (`flatten`): los campos pasan a ser contenido de la pagina.
 *
 * Ids estables: los campos de texto usan EL MISMO `acro-N` que la deteccion de Firmar (`detectAcroFormFields`,
 * por `walkAcroFormTextWidgets`); las casillas, `acro-cb-N` (un id por widget); radios, listas desplegables y
 * de opciones, `acro-ch-N` (un id por campo). Asi un id que la interfaz recibio al leer vuelve a encontrar su
 * campo al escribir.
 *
 * Limites declarados: la apariencia de un campo de texto usa la tipografia estandar (Helvetica, WinAnsi): los
 * caracteres que no tiene (por ejemplo ✓ o ideogramas) se escriben bien en `/V` pero se ven como «?» en la
 * apariencia; `writeFillForm` los lista en `unsupportedChars` para avisar. Los campos de solo lectura, los de
 * firma y los botones no se tocan. Un widget sin `/P` (pagina) no se lista (igual que en Firmar).
 */

export type FormFieldKind = "text" | "checkbox" | "radio" | "dropdown" | "list";

export type FormFieldInfo = {
  id: string;
  /** Nombre completo del campo en el formulario. */
  name: string;
  kind: FormFieldKind;
  /** Pagina y rectangulo (0..1, origen arriba-izquierda) del widget (en radios y listas, el primero). */
  pageIndex: number;
  rect: NormalizedRect;
  readOnly: boolean;
  /**
   * Valor actual: texto en texto; `"true"`/`""` en casillas; la opcion elegida en radios y desplegables
   * (`""` = ninguna); en listas de opciones, las elegidas unidas por `\n`.
   */
  value: string;
  /** Opciones de radios, desplegables y listas. */
  options?: string[];
  multiline?: boolean;
  maxLength?: number;
  /** Lista de opciones con seleccion multiple. */
  multiSelect?: boolean;
  /** Desplegable que admite texto libre. */
  editable?: boolean;
};

export type FillWrite = { id: string; value: string };

export type FormEntry = FormFieldInfo & {
  field: PDFField;
  /** Widget que representa este id (casillas y texto); en radios y listas, 0. */
  widgetIndex: number;
};

function nameOf(field: PDFField): string {
  try {
    return field.getName();
  } catch {
    return "";
  }
}

function readOnlyOf(field: PDFField): boolean {
  try {
    return field.isReadOnly();
  } catch {
    return false;
  }
}

/** Todos los campos rellenables del formulario con su campo vivo de pdf-lib (para leer y para escribir). */
export function collectFormEntries(document: PDFDocument): FormEntry[] {
  const entries: FormEntry[] = [];

  for (const widget of walkAcroFormTextWidgets(document)) {
    const field = widget.field;
    let value = "";
    try {
      value = field.getText() ?? "";
    } catch {
      value = "";
    }
    let maxLength: number | undefined;
    let multiline = false;
    try {
      maxLength = field.getMaxLength();
      multiline = field.isMultiline();
    } catch {
      // Sin esos datos sigue siendo un campo de texto.
    }
    entries.push({
      id: widget.id,
      name: nameOf(field),
      kind: "text",
      pageIndex: widget.pageIndex,
      rect: widget.rect,
      readOnly: readOnlyOf(field),
      value,
      multiline,
      ...(maxLength !== undefined ? { maxLength } : {}),
      field,
      widgetIndex: widget.widgetIndex,
    });
  }

  let fields: PDFField[];
  try {
    fields = document.getForm().getFields();
  } catch {
    return entries;
  }
  const pages = document.getPages();
  const pageRefs = pages.map((page) => page.ref.toString());
  const geometries = pages.map((page) => getPageGeometry(page));

  const widgetPlace = (field: PDFField, widgetIndex: number): { pageIndex: number; rect: NormalizedRect } | null => {
    try {
      const widget = field.acroField.getWidgets()[widgetIndex];
      const pageRef = widget?.P()?.toString();
      const pageIndex = pageRef ? pageRefs.indexOf(pageRef) : -1;
      if (pageIndex < 0) return null;
      return { pageIndex, rect: userBoxToNormalizedRect(geometries[pageIndex], widget.getRectangle()) };
    } catch {
      return null;
    }
  };

  let checkboxCounter = 0;
  let choiceCounter = 0;
  for (const field of fields) {
    if (field instanceof PDFCheckBox) {
      let widgets = 0;
      try {
        widgets = field.acroField.getWidgets().length;
      } catch {
        widgets = 0;
      }
      let checked = false;
      try {
        checked = field.isChecked();
      } catch {
        checked = false;
      }
      for (let index = 0; index < widgets; index += 1) {
        const place = widgetPlace(field, index);
        if (!place) continue;
        checkboxCounter += 1;
        entries.push({
          id: `acro-cb-${checkboxCounter}`,
          name: nameOf(field),
          kind: "checkbox",
          ...place,
          readOnly: readOnlyOf(field),
          value: checked ? "true" : "",
          field,
          widgetIndex: index,
        });
      }
      continue;
    }

    let kind: FormFieldKind | null = null;
    let options: string[] = [];
    let value = "";
    let multiSelect = false;
    let editable = false;
    try {
      if (field instanceof PDFRadioGroup) {
        kind = "radio";
        options = field.getOptions();
        value = field.getSelected() ?? "";
      } else if (field instanceof PDFDropdown) {
        kind = "dropdown";
        options = field.getOptions();
        value = field.getSelected()[0] ?? "";
        editable = field.isEditable();
      } else if (field instanceof PDFOptionList) {
        kind = "list";
        options = field.getOptions();
        value = field.getSelected().join("\n");
        multiSelect = field.isMultiselect();
      }
    } catch {
      kind = null;
    }
    if (!kind) continue;
    const place = widgetPlace(field, 0);
    if (!place) continue;
    choiceCounter += 1;
    entries.push({
      id: `acro-ch-${choiceCounter}`,
      name: nameOf(field),
      kind,
      ...place,
      readOnly: readOnlyOf(field),
      value,
      options,
      ...(multiSelect ? { multiSelect } : {}),
      ...(editable ? { editable } : {}),
      field,
      widgetIndex: 0,
    });
  }

  return entries;
}

function stripLive(entry: FormEntry): FormFieldInfo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { field, widgetIndex, ...info } = entry;
  return info;
}

export type FillFormInfo = {
  fields: FormFieldInfo[];
  /** El PDF no tiene formulario (o no se pudo leer): solo se puede escribir encima. */
  hasForm: boolean;
};

/** Lee los campos del formulario de un PDF (sin modificarlo). */
export async function readFillForm(source: Blob | Uint8Array): Promise<FillFormInfo> {
  const document = await loadPdf(source);
  const fields = collectFormEntries(document).map(stripLive);
  return { fields, hasForm: fields.length > 0 };
}

/* ------------------------------------------------------------------ *
 * Escritura
 * ------------------------------------------------------------------ */

export type FillSkipReason = "missing" | "readOnly" | "invalid";

export type FillWriteResult = {
  bytes: Uint8Array;
  /** Ids escritos en el formulario (un campo con varios widgets cuenta una vez por id). */
  written: string[];
  skipped: { id: string; reason: FillSkipReason }[];
  /** Ids de texto cuyo valor se recorto al maximo de caracteres del campo. */
  truncated: string[];
  /** Caracteres que la tipografia estandar de la apariencia no tiene (se ven como «?»). */
  unsupportedChars: string[];
  flattened: boolean;
};

/**
 * Puntos de codigo que Helvetica (codificacion WinAnsi) sabe pintar: ASCII imprimible, Latin-1 (con acentos y
 * enes) y los 27 simbolos de 0x80-0x9F de Windows-1252 (euro, comillas curvas, guiones largos...).
 */
const WIN_ANSI_EXTRA: ReadonlySet<number> = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018,
  0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsiCodePoint(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code);
}

/** Caracteres de `texts` que Helvetica no puede dibujar (sin repetidos, en orden de aparicion). */
export function unsupportedCharacters(texts: Iterable<string>): string[] {
  const found: string[] = [];
  for (const text of texts) {
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code === 10 || code === 13 || code === 9) continue;
      if (!isWinAnsiCodePoint(code) && !found.includes(char)) found.push(char);
    }
  }
  return found;
}

function sameOption(options: readonly string[], wanted: string): string | undefined {
  return options.find((option) => option === wanted);
}

/**
 * Escribe valores en los campos del formulario y, si se pide, aplana. Los ids que no existen (el documento
 * cambio), los de solo lectura y los valores que el campo no admite se SALTAN y se informan: nunca se
 * inventa un campo ni se rompe el resto.
 */
export async function writeFillForm(
  source: Blob | Uint8Array,
  writes: readonly FillWrite[],
  options: { flatten?: boolean } = {},
  onProgress?: ProgressCallback,
): Promise<FillWriteResult> {
  try {
    const document = await loadPdf(source);
    onProgress?.(0.2);
    const entries = collectFormEntries(document);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const result: FillWriteResult = {
      bytes: new Uint8Array(),
      written: [],
      skipped: [],
      truncated: [],
      unsupportedChars: [],
      flattened: false,
    };
    const textValues: string[] = [];

    for (const write of writes) {
      const entry = byId.get(write.id);
      if (!entry) {
        result.skipped.push({ id: write.id, reason: "missing" });
        continue;
      }
      if (entry.readOnly) {
        result.skipped.push({ id: write.id, reason: "readOnly" });
        continue;
      }
      const field = entry.field;
      try {
        if (entry.kind === "text" && field instanceof PDFTextField) {
          let text = write.value;
          const max = entry.maxLength;
          if (max !== undefined && [...text].length > max) {
            text = [...text].slice(0, max).join("");
            result.truncated.push(write.id);
          }
          if (text === "") field.setText(undefined);
          else field.setText(text);
          textValues.push(text);
        } else if (entry.kind === "checkbox" && field instanceof PDFCheckBox) {
          if (write.value) field.check();
          else field.uncheck();
        } else if (entry.kind === "radio" && field instanceof PDFRadioGroup) {
          if (write.value === "") field.clear();
          else {
            const option = sameOption(entry.options ?? [], write.value);
            if (!option) {
              result.skipped.push({ id: write.id, reason: "invalid" });
              continue;
            }
            field.select(option);
          }
        } else if (entry.kind === "dropdown" && field instanceof PDFDropdown) {
          if (write.value === "") field.clear();
          else {
            const option = sameOption(entry.options ?? [], write.value);
            if (!option && !entry.editable) {
              result.skipped.push({ id: write.id, reason: "invalid" });
              continue;
            }
            field.select(option ?? write.value);
            if (!option) textValues.push(write.value);
          }
        } else if (entry.kind === "list" && field instanceof PDFOptionList) {
          const wanted = write.value === "" ? [] : write.value.split("\n");
          const valid = wanted.filter((value) => sameOption(entry.options ?? [], value) !== undefined);
          if (valid.length !== wanted.length) {
            result.skipped.push({ id: write.id, reason: "invalid" });
            continue;
          }
          if (valid.length === 0) field.clear();
          else field.select(entry.multiSelect ? valid : valid[0]);
        } else {
          result.skipped.push({ id: write.id, reason: "invalid" });
          continue;
        }
        result.written.push(write.id);
      } catch {
        result.skipped.push({ id: write.id, reason: "invalid" });
      }
    }
    onProgress?.(0.6);

    if (textValues.length > 0) result.unsupportedChars = unsupportedCharacters(textValues);

    if (options.flatten && entries.length > 0) {
      document.getForm().flatten();
      result.flattened = true;
    }
    result.bytes = await document.save({ useObjectStreams: true });
    onProgress?.(1);
    return result;
  } catch (error) {
    throw error instanceof PdfError ? error : toPdfError(error);
  }
}
