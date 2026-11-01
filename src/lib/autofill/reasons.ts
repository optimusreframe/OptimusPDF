/**
 * Textos de la interfaz que genera el motor (razon de cada valor y avisos), en espanol e ingles. Nunca incluyen el valor leido:
 * solo la etiqueta del documento (p. ej. «Insured:»), la pagina y el metodo.
 */

import type { Candidate, Flag } from "@/lib/autofill/rules";
import type { ExtractWarningCode } from "@/lib/autofill/types";
import { clip } from "@/lib/autofill/text";

type Locale = "es" | "en";

export type ReasonFlag = Flag | "conflict";

function where(candidate: Pick<Candidate, "origin" | "pageIndex">, locale: Locale): string {
  if (candidate.origin === "pasted") return locale === "es" ? "texto pegado" : "pasted text";
  return locale === "es" ? `página ${candidate.pageIndex + 1}` : `page ${candidate.pageIndex + 1}`;
}

const FLAG_ES: Record<ReasonFlag, string> = {
  "ambiguous-date": "confirma el día y el mes",
  "shared-surname": "apellido compartido entre los dos",
  "single-word": "solo una palabra",
  lowercase: "escrito en minúsculas",
  margin: "está en el encabezado o el pie",
  "ocr-low": "lectura dudosa",
  "generic-mailbox": "buzón genérico",
  "multi-name": "más de dos nombres",
  unlabeled: "sin etiqueta",
  conflict: "hay otro valor distinto en los documentos",
};

const FLAG_EN: Record<ReasonFlag, string> = {
  "ambiguous-date": "confirm day and month",
  "shared-surname": "surname shared by both",
  "single-word": "a single word",
  lowercase: "written in lowercase",
  margin: "in the header or footer",
  "ocr-low": "doubtful reading",
  "generic-mailbox": "generic mailbox",
  "multi-name": "more than two names",
  unlabeled: "no label",
  conflict: "another different value in the documents",
};

/** Una linea que explica por que se propone el valor (sin el valor). */
export function reasonFor(candidate: Candidate, locale: Locale, flags: readonly ReasonFlag[]): string {
  const label = clip((candidate.labelText ?? "").replace(/[:：]\s*$/, ""), 28);
  const page = where(candidate, locale);
  let text: string;
  if (candidate.labeled) {
    if (locale === "es") {
      const lead = candidate.layout === "right" ? "A la derecha de" : candidate.layout === "below" ? "Debajo de" : "Junto a";
      text = `${lead} «${label}» (${page})`;
    } else {
      const lead = candidate.layout === "right" ? "To the right of" : candidate.layout === "below" ? "Below" : "Next to";
      text = `${lead} “${label}” (${page})`;
    }
  } else {
    const free: Record<NonNullable<Candidate["freeKind"]>, [string, string]> = {
      email: ["Tiene formato de correo electrónico", "Looks like an email address"],
      phone: ["Tiene formato de teléfono", "Looks like a phone number"],
      date: ["Fecha que el texto relaciona con la pérdida", "Date the text ties to the loss"],
      block: ["Bloque de destinatario: nombre y dirección", "Recipient block: name and address"],
      letterhead: ["Membrete de una aseguradora", "Insurer letterhead"],
      "id-card": ["Documento de identidad", "Identity document"],
    };
    const pair = free[candidate.freeKind ?? "block"];
    text = `${locale === "es" ? pair[0] : pair[1]} (${page})`;
  }
  const extras: string[] = [];
  if (candidate.origin === "ocr") extras.push(locale === "es" ? "leído por OCR" : "read by OCR");
  for (const flag of flags) {
    if (flag === "unlabeled" && !candidate.labeled) continue;
    extras.push((locale === "es" ? FLAG_ES : FLAG_EN)[flag]);
  }
  return extras.length > 0 ? `${text} · ${extras.join(" · ")}` : text;
}

/** Mensajes de los avisos del resultado. */
export function warningMessage(code: ExtractWarningCode, locale: Locale, detail?: number | string): string {
  const es: Record<ExtractWarningCode, string> = {
    "ocr-unavailable": "No se pudo leer con OCR porque el modelo de lectura no está disponible en este dispositivo.",
    "no-data": "No se encontraron datos que se puedan rellenar con seguridad.",
    "page-skipped": `Se omitió una página${detail === undefined ? "" : ` (${detail})`}.`,
    "too-many-pages": `Solo se leyeron las primeras ${detail ?? 12} páginas.`,
    "unreadable-source": "No se pudo leer este archivo.",
  };
  const en: Record<ExtractWarningCode, string> = {
    "ocr-unavailable": "OCR could not run because the reading model is not available on this device.",
    "no-data": "No data that can be filled in safely was found.",
    "page-skipped": `A page was skipped${detail === undefined ? "" : ` (${detail})`}.`,
    "too-many-pages": `Only the first ${detail ?? 12} pages were read.`,
    "unreadable-source": "This file could not be read.",
  };
  return (locale === "es" ? es : en)[code];
}
