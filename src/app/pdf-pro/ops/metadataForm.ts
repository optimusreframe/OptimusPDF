import type { PdfMetadataInfo, PdfMetadataPatch } from "@/lib/pdf/metadata";

/**
 * Formulario de metadatos de PDF Pro: los campos como texto (lo que escribe la persona) y la conversion a
 * un PARCHE con solo lo que de verdad cambio, para que los demas datos del documento no se toquen.
 */

export type MetadataFormFields = {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  /** `YYYY-MM-DDTHH:mm` en hora local (valor de `<input type="datetime-local">`), o vacio. */
  creationDate: string;
  modificationDate: string;
};

export const EMPTY_METADATA_FORM: MetadataFormFields = {
  title: "",
  author: "",
  subject: "",
  keywords: "",
  creator: "",
  producer: "",
  creationDate: "",
  modificationDate: "",
};

const pad = (value: number): string => String(value).padStart(2, "0");

/** Fecha → valor de `datetime-local` (hora local, sin segundos). */
export function dateToInput(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Valor de `datetime-local` → fecha, o `null` si esta vacio o no es valido. */
export function inputToDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formFromInfo(info: PdfMetadataInfo): MetadataFormFields {
  return {
    title: info.title,
    author: info.author,
    subject: info.subject,
    keywords: info.keywords,
    creator: info.creator,
    producer: info.producer,
    creationDate: dateToInput(info.creationDate),
    modificationDate: dateToInput(info.modificationDate),
  };
}

const TEXT_FIELDS = ["title", "author", "subject", "keywords", "creator", "producer"] as const;
const DATE_FIELDS = ["creationDate", "modificationDate"] as const;

/** Parche con SOLO los campos que difieren del documento original (vacio = quitar el campo). */
export function patchFromForm(form: MetadataFormFields, original: PdfMetadataInfo): PdfMetadataPatch {
  const patch: PdfMetadataPatch = {};
  for (const field of TEXT_FIELDS) {
    if (form[field] !== original[field]) patch[field] = form[field];
  }
  for (const field of DATE_FIELDS) {
    // Una fecha intacta conserva sus segundos: solo cuenta si cambio lo que se VE en el campo.
    if (form[field] === dateToInput(original[field])) continue;
    patch[field] = inputToDate(form[field]);
  }
  return patch;
}

export function hasPatch(patch: PdfMetadataPatch): boolean {
  return Object.keys(patch).length > 0;
}
