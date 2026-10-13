import { parseTextEdit } from "@/app/edit-pdf/editSession";
import { applyTextEdits, type ApplyTextEditsOptions } from "@/lib/pdf/editTextExport";
import type { EditWarning, TextEdit } from "@/lib/pdf/editTypes";

/*
 * Ediciones del texto ORIGINAL de un documento dentro de Firmar (W6-A).
 *
 * El estado de cada documento lleva una lista de `TextEdit` (las mismas que
 * produce el editor de PDF de la Wave 5). Aqui viven las piezas puras que la
 * rodean:
 *
 *  - validacion al leer de un borrador (`sanitizeTextEdits`);
 *  - la HUELLA que ata una captura de firma al contenido editado
 *    (`textEditsKey`, `stampKeyOf`): las capturas y los sellos de bloque se
 *    calculan con `stampKeyOf(huellaDelArchivo, ediciones)`, asi que cambiar
 *    una edicion los invalida igual que cambiar un hueco. La huella del
 *    ARCHIVO (`documentKey`, la que sella `options.signature`, nombra el
 *    borrador y reinicia al cambiar de documento) NO cambia nunca con las
 *    ediciones: sin ediciones `stampKeyOf` devuelve la huella tal cual, de
 *    modo que la carrera de huellas ya corregida (W3/W4) no se toca;
 *  - aplicar las ediciones al PDF ANTES de estampar firmas (`applyEditsToFile`).
 */

/** Tope defensivo de ediciones por documento (un borrador corrupto no puede colgar la pagina). */
export const MAX_SIGN_TEXT_EDITS = 500;

/** Lee ediciones de un valor desconocido (borrador, JSON): descarta lo invalido sin lanzar. */
export function sanitizeTextEdits(raw: unknown): TextEdit[] {
  if (!Array.isArray(raw)) return [];
  const out: TextEdit[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_SIGN_TEXT_EDITS) break;
    const edit = parseTextEdit(item);
    if (!edit || seen.has(edit.id)) continue;
    seen.add(edit.id);
    out.push(edit);
  }
  return out;
}

/**
 * Las ediciones que de verdad cambian el PDF: reemplazar un bloque (aunque deje
 * el texto vacio, que BORRA el original) o un texto propio con contenido. Un
 * texto propio vacio no pinta nada.
 */
export function effectiveTextEdits(edits: readonly TextEdit[]): TextEdit[] {
  return edits.filter((edit) => edit.blockId !== undefined || edit.text.trim().length > 0);
}

/** JSON canonico: claves ordenadas y sin `undefined`, para que el mismo contenido de siempre la misma huella. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonical(record[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Hash de 53 bits (cyrb53): detecta CAMBIOS, no es criptografico. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Huella del contenido editado; `""` sin ediciones efectivas. */
export function textEditsKey(edits: readonly TextEdit[] | undefined): string {
  if (!edits || edits.length === 0) return "";
  const effective = effectiveTextEdits(edits);
  if (effective.length === 0) return "";
  return hash53(canonical(effective));
}

/**
 * Huella con la que se sellan las capturas de firma: la del archivo mas la de
 * sus ediciones. Sin ediciones es EXACTAMENTE la del archivo; sin huella de
 * archivo (`null`, `""`: aun calculandose) se queda como esta.
 */
export function stampKeyOf<K extends string | null | undefined>(
  key: K,
  edits: readonly TextEdit[] | undefined,
): K | string {
  if (!key) return key;
  const editKey = textEditsKey(edits);
  return editKey === "" ? key : `${key}+t${editKey}`;
}

/** El documento tiene ediciones que se aplicaran al firmar. */
export function hasTextEdits(edits: readonly TextEdit[] | undefined): boolean {
  return edits !== undefined && effectiveTextEdits(edits).length > 0;
}

export type AppliedEdits = {
  file: File;
  /** Avisos de todo el documento, sin repetidos. */
  warnings: EditWarning[];
  /**
   * (B1) Avisos por `TextEdit.id`: de aqui sale que textos perdieron de verdad su original y cuales no (y por que).
   * Vacio sin ediciones efectivas.
   */
  warningsByEdit: Record<string, EditWarning[]>;
  /** (B1) Ediciones que el motor omitio (pagina inexistente, tamano invalido...). */
  skipped: string[];
  /** (B1) Las ediciones efectivas que se aplicaron (las que cuentan para el resumen). */
  applied: TextEdit[];
};

/**
 * Aplica las ediciones de texto al PDF y devuelve el archivo editado (mismo
 * nombre). Sin ediciones devuelve el MISMO archivo. Es lo primero que ocurre al
 * firmar: `signPdfMulti` recibe el PDF ya editado y estampa las firmas encima.
 */
export async function applyEditsToFile(
  file: File,
  edits: readonly TextEdit[] | undefined,
  options: ApplyTextEditsOptions = {},
): Promise<AppliedEdits> {
  const effective = edits ? effectiveTextEdits(edits) : [];
  if (effective.length === 0) return { file, warnings: [], warningsByEdit: {}, skipped: [], applied: [] };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await applyTextEdits(bytes, effective, options);
  return {
    file: new File([result.bytes as BlobPart], file.name, {
      type: "application/pdf",
      lastModified: file.lastModified,
    }),
    warnings: result.warnings,
    warningsByEdit: result.warningsByEdit,
    skipped: result.skipped,
    applied: effective,
  };
}
