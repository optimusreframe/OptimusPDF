import type { Language } from "@/lib/i18n";
import { SIGN_STRINGS, type SignStrings } from "@/app/sign-pdf/strings";

/** Textos del modo Rellenar de PDF Pro (Wave 7 · U7), es/en. El lienzo reutiliza los textos de Firmar. */
export type FillEmbeddedStrings = {
  regionLabel: string;
  title: string;
  apply: string;
  discard: string;
  applying: string;
  /** Aviso de privacidad/sesion. */
  sessionNote: string;
  /** Lo que se escribe en el formulario y lo que se dibuja. */
  howItWorks: string;
  noForm: string;
  loadingForm: string;
  formFound: (fields: number) => string;
  formUnreadable: string;
  notReady: string;
  ready: string;
  sessionReset: string;
  staleResult: string;
  applyFailed: string;
  flattenLabel: string;
  flattenHint: string;
  choicesTitle: string;
  choicesHint: string;
  choicePage: (page: number) => string;
  choiceNone: string;
  choiceReadOnly: string;
  unsupportedChars: (chars: string) => string;
  /** Error al aplicar: campos que el formulario no admitio (no se aplica nada). */
  skippedFields: (skipped: number) => string;
  /** Aviso previo: valores mas largos que el maximo del campo. */
  willTruncate: (count: number) => string;
  labelFilled: (fields: number) => string;
  labelFlattened: string;
  warningsTitle: string;
  /** Aviso corto al pulsar «Aplicar» sin nada que aplicar (lo dicen los dos modos). */
  noChanges: string;
};

const es: FillEmbeddedStrings = {
  regionLabel: "Rellenar el formulario",
  title: "Rellenar",
  apply: "Aplicar formulario",
  discard: "Descartar",
  applying: "Escribiendo los valores en el formulario…",
  sessionNote:
    "Lo que rellenes no se guarda como borrador: si sales sin aplicar, se descarta. Lo que apliques queda en el historial del documento y se puede deshacer.",
  howItWorks:
    "Los campos reales del formulario se rellenan en el propio PDF y siguen siendo campos. El texto que añadas encima o en los huecos sugeridos se dibuja sobre la página.",
  noForm:
    "Este PDF no tiene campos de formulario: escribe encima con la herramienta Texto.",
  loadingForm: "Leyendo los campos del formulario…",
  formFound: (fields) =>
    fields === 1 ? "Se encontró 1 campo de formulario." : `Se encontraron ${fields} campos de formulario.`,
  formUnreadable:
    "No se pudieron leer los campos del formulario: solo podrás escribir encima del documento.",
  notReady: "Rellena algún campo para poder aplicar.",
  ready: "Listo para aplicar al documento.",
  sessionReset:
    "El documento cambió fuera de Rellenar, así que se descartó lo que llevabas rellenado.",
  staleResult:
    "El documento cambió mientras se aplicaba el formulario: el resultado se descartó. Vuelve a aplicarlo.",
  applyFailed: "No se pudo aplicar el formulario al documento.",
  flattenLabel: "Aplanar el formulario",
  flattenHint:
    "Los campos dejan de ser editables y su contenido pasa a formar parte de la página. Se puede deshacer.",
  choicesTitle: "Listas y opciones del formulario",
  choicesHint:
    "Estos campos no se rellenan sobre la página: elige aquí su valor.",
  choicePage: (page) => `Página ${page}`,
  choiceNone: "Sin elegir",
  choiceReadOnly: "Solo lectura",
  unsupportedChars: (chars) =>
    `Estos caracteres no se pueden dibujar con la tipografía estándar y se verán como «?» en la página: ${chars}. El valor guardado en el campo sí es correcto.`,
  skippedFields: (skipped) =>
    skipped === 1
      ? "1 campo no se pudo escribir en el formulario, así que no se aplicó nada."
      : `${skipped} campos no se pudieron escribir en el formulario, así que no se aplicó nada.`,
  willTruncate: (count) =>
    count === 1
      ? "1 valor es más largo que el máximo de su campo y se recortará."
      : `${count} valores son más largos que el máximo de su campo y se recortarán.`,
  labelFilled: (fields) => `Formulario rellenado (${fields} ${fields === 1 ? "campo" : "campos"})`,
  labelFlattened: "Formulario aplanado",
  warningsTitle: "Antes de aplicar",
  noChanges: "No hay cambios que aplicar",
};

const en: FillEmbeddedStrings = {
  regionLabel: "Fill in the form",
  title: "Fill",
  apply: "Apply form",
  discard: "Discard",
  applying: "Writing the values into the form…",
  sessionNote:
    "What you fill in isn't saved as a draft: if you leave without applying, it is discarded. What you apply stays in the document history and can be undone.",
  howItWorks:
    "The form's real fields are filled in the PDF itself and stay fields. Text you add on top or in the suggested blanks is drawn on the page.",
  noForm:
    "This PDF has no form fields: write on it with the Text tool.",
  loadingForm: "Reading the form fields…",
  formFound: (fields) => (fields === 1 ? "Found 1 form field." : `Found ${fields} form fields.`),
  formUnreadable: "The form fields couldn't be read: you can only write on top of the document.",
  notReady: "Fill in a field to be able to apply.",
  ready: "Ready to apply to the document.",
  sessionReset:
    "The document changed outside of Fill, so what you had filled in was discarded.",
  staleResult:
    "The document changed while the form was being applied: the result was discarded. Apply it again.",
  applyFailed: "The form couldn't be applied to the document.",
  flattenLabel: "Flatten the form",
  flattenHint:
    "Fields stop being editable and their content becomes part of the page. It can be undone.",
  choicesTitle: "Lists and options in the form",
  choicesHint: "These fields aren't filled on the page: pick their value here.",
  choicePage: (page) => `Page ${page}`,
  choiceNone: "Not chosen",
  choiceReadOnly: "Read-only",
  unsupportedChars: (chars) =>
    `These characters can't be drawn with the standard font and will look like “?” on the page: ${chars}. The value stored in the field is correct.`,
  skippedFields: (skipped) =>
    skipped === 1
      ? "1 field couldn't be written into the form, so nothing was applied."
      : `${skipped} fields couldn't be written into the form, so nothing was applied.`,
  willTruncate: (count) =>
    count === 1
      ? "1 value is longer than its field's maximum and will be cut."
      : `${count} values are longer than their field's maximum and will be cut.`,
  labelFilled: (fields) => `Form filled in (${fields} ${fields === 1 ? "field" : "fields"})`,
  labelFlattened: "Form flattened",
  warningsTitle: "Before applying",
  noChanges: "There are no changes to apply",
};

export const FILL_EMBEDDED_STRINGS: Record<Language, FillEmbeddedStrings> = { es, en };

/**
 * Los textos del lienzo de Firmar que hablan de FIRMAR (titulo, ayuda, «revisalos antes de firmar», huecos de
 * firma), dichos para RELLENAR. El resto del lienzo (paleta, zoom, campos sugeridos...) es el de Firmar tal cual.
 */
export function withFillWording(language: Language): SignStrings {
  const base = SIGN_STRINGS[language];
  if (language === "en") {
    return {
      ...base,
      documentTitle: "Fill in the document",
      documentHint:
        "Tap a field to type in it. With the Text, Checkbox or Date tool you can also write anywhere on the page: tap the page to place it, or drag to draw it. With Select you can move and adjust them.",
      slotsNeedSigners: "Write in the form's fields or add text wherever you need it with the Text tool.",
      canvasEmptyHint:
        "Nothing on the document yet: pick a tool and tap the page, or tap one of the form's fields.",
      detectedFieldsSummary: (count) =>
        count === 1
          ? "Found 1 field. Review it before applying."
          : `Found ${count} fields. Review them before applying.`,
      lowConfidenceHint:
        "Dashed outline = experimental detection on a scanned image. Review it before applying; if it isn't a real field, delete it.",
      scanFound: (count, page) =>
        count === 1
          ? `Found 1 possible blank on page ${page}. Review it before applying.`
          : `Found ${count} possible blanks on page ${page}. Review them before applying.`,
      checkingDocument: "Checking the document before filling it in",
    };
  }
  return {
    ...base,
    documentTitle: "Rellena el documento",
    documentHint:
      "Toca un campo para escribir en él. Con la herramienta Texto, Casilla o Fecha también puedes escribir donde quieras de la página: toca la página para colocarlo, o arrastra para dibujarlo. Con Seleccionar puedes moverlos y ajustarlos.",
    slotsNeedSigners:
      "Escribe en los campos del formulario o añade texto donde lo necesites con la herramienta Texto.",
    canvasEmptyHint:
      "Todavía no hay nada sobre el documento: elige una herramienta y toca la página, o toca uno de los campos del formulario.",
    detectedFieldsSummary: (count) =>
      count === 1
        ? "Se detectó 1 campo. Revísalo antes de aplicar."
        : `Se detectaron ${count} campos. Revísalos antes de aplicar.`,
    lowConfidenceHint:
      "Contorno discontinuo = detección experimental sobre una imagen escaneada. Revísala antes de aplicar; si no es un campo real, bórrala.",
    scanFound: (count, page) =>
      count === 1
        ? `Se encontró 1 posible hueco en la página ${page}. Revísalo antes de aplicar.`
        : `Se encontraron ${count} posibles huecos en la página ${page}. Revísalos antes de aplicar.`,
    checkingDocument: "Comprobando el documento antes de rellenarlo",
  };
}
