import type { Language } from "@/lib/i18n";
import type { PageAssemblyWarning, PageAssemblyWarningCode } from "@/lib/pdf/pageAssembly";

/**
 * Avisos de las herramientas sueltas de paginas (Unir, Quitar paginas, Organizar, Dividir y Extraer):
 * lo que el motor de paginas NO pudo conservar, dicho en lenguaje llano y listo para la pantalla de
 * descarga (`ProcessResult.notices`). Compartido por las cinco herramientas: un solo texto por codigo,
 * en espanol e ingles, con singular y plural. Modulo puro (sin React).
 *
 * Solo se muestra lo que PASO: una operacion que lo conserva todo no genera avisos (y entonces la pantalla
 * de descarga es exactamente la de siempre).
 */

export type PageNotices = { title: string; items: string[] };

type Text = (count: number) => string;

type NoticeStrings = {
  title: string;
  texts: Record<Exclude<PageAssemblyWarningCode, "largeInsert">, Text>;
};

/** Orden de lectura: primero lo que cambia el valor del documento (firmas), luego lo estructural, luego lo menudo. */
export const NOTICE_ORDER: readonly Exclude<PageAssemblyWarningCode, "largeInsert">[] = [
  "signaturesInvalidated",
  "signedSignaturesRemoved",
  "signatureFieldsRemoved",
  "structureRemoved",
  "structureIncomplete",
  "pageLabelsRemoved",
  "outlinesRemoved",
  "linksRemoved",
  "namedDestinationsRemoved",
  "formFieldsRemoved",
  "fieldsRenamed",
];

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many.replace("{n}", String(count));

const STRINGS: Record<Language, NoticeStrings> = {
  es: {
    title: "Avisos sobre el resultado",
    texts: {
      signaturesInvalidated: (n) =>
        plural(
          n,
          "La firma digital del documento deja de ser válida: el archivo se ha vuelto a escribir y ya no coincide con el que se firmó.",
          "Las {n} firmas digitales del documento dejan de ser válidas: el archivo se ha vuelto a escribir y ya no coincide con el que se firmó.",
        ),
      signedSignaturesRemoved: (n) =>
        plural(
          n,
          "No se copió 1 firma ya aplicada: una firma digital solo es válida en el documento en el que se firmó.",
          "No se copiaron {n} firmas ya aplicadas: una firma digital solo es válida en el documento en el que se firmó.",
        ),
      signatureFieldsRemoved: (n) =>
        plural(
          n,
          "No se copió 1 campo de firma vacío: no se podrá firmar en el resultado.",
          "No se copiaron {n} campos de firma vacíos: no se podrán firmar en el resultado.",
        ),
      structureRemoved: () =>
        "Se quitó la estructura de accesibilidad (PDF etiquetado): no se pudo llevar a las páginas del resultado.",
      structureIncomplete: (n) =>
        plural(
          n,
          "1 página no lleva etiquetas de accesibilidad (PDF etiquetado): la accesibilidad del resultado puede quedar incompleta.",
          "{n} páginas no llevan etiquetas de accesibilidad (PDF etiquetado): la accesibilidad del resultado puede quedar incompleta.",
        ),
      pageLabelsRemoved: () =>
        "No se pudo conservar la numeración de páginas (i, ii, 1…) de un documento: el resultado no la lleva.",
      outlinesRemoved: (n) =>
        plural(
          n,
          "Se quitó 1 marcador que apuntaba a una página que ya no está.",
          "Se quitaron {n} marcadores que apuntaban a páginas que ya no están.",
        ),
      linksRemoved: (n) =>
        plural(
          n,
          "Se quitó 1 enlace interno que llevaba a una página que ya no está.",
          "Se quitaron {n} enlaces internos que llevaban a páginas que ya no están.",
        ),
      namedDestinationsRemoved: (n) =>
        plural(
          n,
          "Se quitó 1 destino con nombre de una página que ya no está.",
          "Se quitaron {n} destinos con nombre de páginas que ya no están.",
        ),
      formFieldsRemoved: (n) =>
        plural(
          n,
          "Se quitó 1 campo de formulario de una página que ya no está.",
          "Se quitaron {n} campos de formulario de páginas que ya no están.",
        ),
      fieldsRenamed: (n) =>
        plural(
          n,
          "1 campo de formulario cambió de nombre porque ya había otro con ese nombre.",
          "{n} campos de formulario cambiaron de nombre porque ya había otros con ese nombre.",
        ),
    },
  },
  en: {
    title: "Notices about the result",
    texts: {
      signaturesInvalidated: (n) =>
        plural(
          n,
          "The document's digital signature is no longer valid: the file was rewritten and no longer matches the one that was signed.",
          "The document's {n} digital signatures are no longer valid: the file was rewritten and no longer matches the one that was signed.",
        ),
      signedSignaturesRemoved: (n) =>
        plural(
          n,
          "1 signature that was already applied was not copied: a digital signature is only valid in the document it was signed in.",
          "{n} signatures that were already applied were not copied: a digital signature is only valid in the document it was signed in.",
        ),
      signatureFieldsRemoved: (n) =>
        plural(
          n,
          "1 empty signature field was not copied: it can't be signed in the result.",
          "{n} empty signature fields were not copied: they can't be signed in the result.",
        ),
      structureRemoved: () =>
        "The accessibility structure (tagged PDF) was removed: it could not be carried over to the pages of the result.",
      structureIncomplete: (n) =>
        plural(
          n,
          "1 page carries no accessibility tags (tagged PDF): the accessibility of the result may be incomplete.",
          "{n} pages carry no accessibility tags (tagged PDF): the accessibility of the result may be incomplete.",
        ),
      pageLabelsRemoved: () =>
        "The page numbering (i, ii, 1…) of a document could not be kept: the result does not carry it.",
      outlinesRemoved: (n) =>
        plural(
          n,
          "1 bookmark that pointed to a page that is no longer there was removed.",
          "{n} bookmarks that pointed to pages that are no longer there were removed.",
        ),
      linksRemoved: (n) =>
        plural(
          n,
          "1 internal link that led to a page that is no longer there was removed.",
          "{n} internal links that led to pages that are no longer there were removed.",
        ),
      namedDestinationsRemoved: (n) =>
        plural(
          n,
          "1 named destination of a page that is no longer there was removed.",
          "{n} named destinations of pages that are no longer there were removed.",
        ),
      formFieldsRemoved: (n) =>
        plural(
          n,
          "1 form field of a page that is no longer there was removed.",
          "{n} form fields of pages that are no longer there were removed.",
        ),
      fieldsRenamed: (n) =>
        plural(
          n,
          "1 form field was renamed because another one already had that name.",
          "{n} form fields were renamed because others already had those names.",
        ),
    },
  },
};

/** Titulo del bloque de avisos en el idioma dado. */
export function pageNoticesTitle(language: Language): string {
  return STRINGS[language].title;
}

/** Texto de un aviso con su cantidad, o `null` si ese codigo no se cuenta al usuario (`largeInsert`). */
export function pageNoticeText(language: Language, warning: PageAssemblyWarning): string | null {
  if (warning.code === "largeInsert") return null;
  return STRINGS[language].texts[warning.code](warning.count);
}

/**
 * Bloque de avisos para `ProcessResult.notices`: un texto por codigo (ordenados por importancia), o
 * `undefined` si no hay nada que contar.
 */
export function pageNotices(language: Language, warnings: readonly PageAssemblyWarning[]): PageNotices | undefined {
  const items: string[] = [];
  for (const code of NOTICE_ORDER) {
    const count = warnings.filter((warning) => warning.code === code).reduce((total, warning) => total + warning.count, 0);
    if (count > 0) items.push(STRINGS[language].texts[code](count));
  }
  return items.length > 0 ? { title: STRINGS[language].title, items } : undefined;
}
