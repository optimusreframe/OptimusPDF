"use client";

import { useOptionalLanguage, type Language } from "@/lib/i18n";

/**
 * Textos del modo «Rellenar» (asistente de campo en campo) y de «Firmar con mi firma guardada» (W3-B2), es/en. Viven aqui, no en
 * `strings.ts` ni en `locales/*`, porque los usan a la vez Firmar y PDF Pro (mismo patron que `tagStrings.ts`).
 */
export type FillStrings = {
  /* --- Entrada --- */
  /** Boton destacado: «Rellenar (12 campos)». */
  entryButton: (count: number) => string;
  entryTitle: string;
  /** «3 de 12 ya tienen datos»; vacio si no hay ninguno. */
  entryBody: (filled: number, total: number) => string;

  /* --- Panel --- */
  regionLabel: string;
  /** «4 de 12». */
  progress: (position: number, total: number) => string;
  progressLabel: (position: number, total: number) => string;
  /** «Contrato A · p. 2». */
  where: (document: string | null, page: number) => string;
  /** Nombre cuando el campo no trae rotulo ni etiqueta. */
  unnamedField: (page: number) => string;
  requiredBadge: string;
  autoBadge: string;
  autoConfirm: string;
  inputLabel: (name: string) => string;
  switchOn: string;
  switchOff: string;
  switchLabel: (name: string) => string;
  today: string;
  todayDone: (date: string) => string;
  prev: string;
  next: string;
  nextLast: string;
  confirmNext: string;
  skip: string;
  undo: string;
  undone: (name: string) => string;
  list: string;
  close: string;
  closeHint: string;
  gotoEmpty: string;
  noEmptyLeft: string;
  suggestionsLabel: string;
  suggestionPicked: (value: string) => string;
  sourceMemory: string;
  sourceProfile: (name: string) => string;
  sourceDocument: (name: string) => string;
  /** Linea bajo el nombre cuando no hay ninguna sugerencia. */
  noSuggestions: string;
  noTagHint: string;
  tagButton: (tag: string | null) => string;
  tagClose: string;

  /* --- Lista de campos --- */
  listTitle: string;
  listIntro: string;
  listFilterPending: (count: number) => string;
  listFilterAll: (count: number) => string;
  listEmpty: string;
  listRowFilled: string;
  listRowEmpty: string;
  listRowAuto: string;
  listRowChecked: string;
  listRowUnchecked: string;
  reviewAuto: string;
  reviewAutoHint: string;
  closeList: string;

  /* --- Final --- */
  doneTitle: string;
  doneTitleRequired: (count: number) => string;
  doneBody: string;
  doneBodyRequired: string;
  doneMore: (count: number) => string;
  doneOptionalMissing: (count: number) => string;
  doneGoTo: (name: string) => string;
  doneContinue: string;
  doneContinueBlocked: string;
  doneReview: string;
  doneExit: string;

  /* --- Anuncios (region viva) --- */
  moved: (position: number, total: number, name: string) => string;
  started: (total: number) => string;
  finished: string;
  confirmed: (name: string) => string;
  skipped: (name: string) => string;
};

/* ------------------------------------------------------------------ *
 * «Firmar con mi firma guardada» (un toque)
 * ------------------------------------------------------------------ */

export type QuickSignStrings = {
  /** Boton primario del turno: «Firmar con la firma guardada de Ana». */
  button: (name: string) => string;
  buttonShort: string;
  /** Linea previa: «Se pondrá tu firma en 5 huecos y tus iniciales en 12.» */
  willPlace: (signatures: number, initials: number) => string;
  /** Resumen editable del turno: «Firmas: 5 · Iniciales: 12 · Campos: 8». */
  summary: (signatures: number, initials: number, fields: number) => string;
  summaryEdit: string;
  summaryEditHint: string;
  /** Vista previa: nombre accesible de las miniaturas. */
  previewSignature: string;
  previewInitials: string;
  /** Cuando hay mas de una firma guardada. */
  chooseOther: string;
  /** Falta algo: «Solo falta: Iniciales.» */
  onlyMissing: (labels: readonly string[]) => string;
  /** Aviso tras aplicar. */
  applied: (name: string) => string;
  appliedMissing: (name: string, labels: readonly string[]) => string;
  undo: string;
  undone: string;
  /** Un solo firmante: se salta el traspaso y se dice por que. */
  singleSigner: string;
  /** Resumen de quien firma en el paso «Documento» (los firmantes ya estaban decididos). */
  signersRecap: (names: string) => string;
  signersChange: string;
  signersChangeHint: string;
  /** Pantalla final unica. */
  finalTitle: string;
  finalBody: (documents: number) => string;
  finalButton: string;
  finalRedo: string;
  /** Nombre accesible del bloque «Revisar y descargar». */
  finalRegion: string;
  /** Resultado: la descarga empezo sola. */
  downloadedSubtitle: (name: string) => string;
};

const FILL_ES: FillStrings = {
  entryButton: (count) => (count === 1 ? "Rellenar (1 campo)" : `Rellenar (${count} campos)`),
  entryTitle: "Rellenar de campo en campo",
  entryBody: (filled, total) =>
    filled > 0
      ? `${filled} de ${total} ya tienen datos. Te llevo a cada campo, con tus datos guardados a un toque.`
      : "Te llevo a cada campo, con tus datos guardados a un toque.",

  regionLabel: "Asistente para rellenar",
  progress: (position, total) => `${position} de ${total}`,
  progressLabel: (position, total) => `Campo ${position} de ${total}`,
  where: (document, page) => (document ? `${document} · p. ${page}` : `Página ${page}`),
  unnamedField: (page) => `Campo sin nombre (p. ${page})`,
  requiredBadge: "Obligatorio",
  autoBadge: "Rellenado automáticamente",
  autoConfirm: "Confirmar",
  inputLabel: (name) => `Valor de «${name}»`,
  switchOn: "Marcada",
  switchOff: "Sin marcar",
  switchLabel: (name) => `Casilla «${name}»`,
  today: "Hoy",
  todayDone: (date) => `Fecha de hoy puesta: ${date}`,
  prev: "Anterior",
  next: "Siguiente",
  nextLast: "Terminar",
  confirmNext: "Confirmar y seguir",
  skip: "Saltar",
  undo: "Deshacer",
  undone: (name) => `Deshecho: ${name}`,
  list: "Lista",
  close: "Salir",
  closeHint: "Lo que escribiste se queda en el documento.",
  gotoEmpty: "Ir al siguiente vacío",
  noEmptyLeft: "No queda ningún campo vacío.",
  suggestionsLabel: "Sugerencias para este campo",
  suggestionPicked: (value) => `Puesto: ${value}`,
  sourceMemory: "Escrito antes",
  sourceProfile: (name) => `Perfil de ${name}`,
  sourceDocument: (name) => `Leído de un documento de ${name}`,
  noSuggestions: "Aún no hay datos guardados para esta etiqueta: lo que escribas se recordará.",
  noTagHint: "Pon una etiqueta para recordar este dato y rellenar los campos que lo repiten.",
  tagButton: (tag) => (tag ? `Etiqueta: ${tag}` : "Poner etiqueta"),
  tagClose: "Cerrar etiquetas",

  listTitle: "Campos del documento",
  listIntro: "Toca un campo para ir a él.",
  listFilterPending: (count) => `Pendientes (${count})`,
  listFilterAll: (count) => `Todos (${count})`,
  listEmpty: "No queda nada pendiente.",
  listRowFilled: "Con datos",
  listRowEmpty: "Vacío",
  listRowAuto: "Rellenado automáticamente",
  listRowChecked: "Marcada",
  listRowUnchecked: "Sin marcar",
  reviewAuto: "Revisar los autorrellenados",
  reviewAutoHint: "Si lo apagas, el asistente se salta los campos que se rellenaron solos al repetir un dato.",
  closeList: "Cerrar",

  doneTitle: "Todo rellenado",
  doneTitleRequired: (count) => (count === 1 ? "Falta 1 campo obligatorio" : `Faltan ${count} campos obligatorios`),
  doneBody: "Puedes seguir con las firmas. Lo escrito ya está en el documento.",
  doneBodyRequired: "Toca un campo para ir a él. Lo escrito ya está en el documento.",
  doneMore: (count) => `+${count} más`,
  doneOptionalMissing: (count) => (count === 1 ? "1 campo opcional vacío" : `${count} campos opcionales vacíos`),
  doneGoTo: (name) => `Ir a «${name}»`,
  doneContinue: "Continuar a firmar",
  doneContinueBlocked: "Aún no hay nada que firmar: pon los huecos de firma o rellena algún campo.",
  doneReview: "Seguir revisando",
  doneExit: "Cerrar",

  moved: (position, total, name) => `Campo ${position} de ${total}: ${name}`,
  started: (total) => `Rellenar: ${total} campos.`,
  finished: "Todos los campos revisados.",
  confirmed: (name) => `Confirmado: ${name}`,
  skipped: (name) => `Saltado: ${name}`,
};

const FILL_EN: FillStrings = {
  entryButton: (count) => (count === 1 ? "Fill in (1 field)" : `Fill in (${count} fields)`),
  entryTitle: "Fill in field by field",
  entryBody: (filled, total) =>
    filled > 0
      ? `${filled} of ${total} already have data. I take you to each field, with your saved data one tap away.`
      : "I take you to each field, with your saved data one tap away.",

  regionLabel: "Fill-in assistant",
  progress: (position, total) => `${position} of ${total}`,
  progressLabel: (position, total) => `Field ${position} of ${total}`,
  where: (document, page) => (document ? `${document} · p. ${page}` : `Page ${page}`),
  unnamedField: (page) => `Unnamed field (p. ${page})`,
  requiredBadge: "Required",
  autoBadge: "Filled automatically",
  autoConfirm: "Confirm",
  inputLabel: (name) => `Value of “${name}”`,
  switchOn: "Checked",
  switchOff: "Unchecked",
  switchLabel: (name) => `Checkbox “${name}”`,
  today: "Today",
  todayDone: (date) => `Today's date set: ${date}`,
  prev: "Previous",
  next: "Next",
  nextLast: "Finish",
  confirmNext: "Confirm and continue",
  skip: "Skip",
  undo: "Undo",
  undone: (name) => `Undone: ${name}`,
  list: "List",
  close: "Exit",
  closeHint: "What you typed stays in the document.",
  gotoEmpty: "Go to the next empty one",
  noEmptyLeft: "No empty field left.",
  suggestionsLabel: "Suggestions for this field",
  suggestionPicked: (value) => `Set: ${value}`,
  sourceMemory: "Typed before",
  sourceProfile: (name) => `${name}'s profile`,
  sourceDocument: (name) => `Read from a document of ${name}`,
  noSuggestions: "No saved data for this tag yet: whatever you type will be remembered.",
  noTagHint: "Add a tag to remember this data and fill the fields that repeat it.",
  tagButton: (tag) => (tag ? `Tag: ${tag}` : "Add a tag"),
  tagClose: "Close tags",

  listTitle: "Document fields",
  listIntro: "Tap a field to go to it.",
  listFilterPending: (count) => `Pending (${count})`,
  listFilterAll: (count) => `All (${count})`,
  listEmpty: "Nothing left pending.",
  listRowFilled: "Filled",
  listRowEmpty: "Empty",
  listRowAuto: "Filled automatically",
  listRowChecked: "Checked",
  listRowUnchecked: "Unchecked",
  reviewAuto: "Review the auto-filled ones",
  reviewAutoHint: "If you turn it off, the assistant skips fields that filled themselves when a piece of data repeats.",
  closeList: "Close",

  doneTitle: "Everything filled in",
  doneTitleRequired: (count) => (count === 1 ? "1 required field is missing" : `${count} required fields are missing`),
  doneBody: "You can move on to the signatures. What you typed is already in the document.",
  doneBodyRequired: "Tap a field to go to it. What you typed is already in the document.",
  doneMore: (count) => `+${count} more`,
  doneOptionalMissing: (count) => (count === 1 ? "1 optional field is empty" : `${count} optional fields are empty`),
  doneGoTo: (name) => `Go to “${name}”`,
  doneContinue: "Continue to sign",
  doneContinueBlocked: "There is nothing to sign yet: place the signature spots or fill in a field.",
  doneReview: "Keep reviewing",
  doneExit: "Close",

  moved: (position, total, name) => `Field ${position} of ${total}: ${name}`,
  started: (total) => `Fill in: ${total} fields.`,
  finished: "All fields reviewed.",
  confirmed: (name) => `Confirmed: ${name}`,
  skipped: (name) => `Skipped: ${name}`,
};

const QUICK_ES: QuickSignStrings = {
  button: (name) => (name ? `Firmar todo con la firma guardada de ${name}` : "Firmar todo con mi firma guardada"),
  buttonShort: "Firmar todo con mi firma guardada",
  willPlace: (signatures, initials) => {
    const parts = [
      signatures > 0 ? `tu firma en ${signatures} ${signatures === 1 ? "hueco" : "huecos"}` : "",
      initials > 0 ? `tus iniciales en ${initials} ${initials === 1 ? "hueco" : "huecos"}` : "",
    ].filter(Boolean);
    return parts.length > 0 ? `Se pondrá ${parts.join(" y ")}. Antes de descargar verás cómo queda.` : "";
  },
  summary: (signatures, initials, fields) => `Firmas: ${signatures} · Iniciales: ${initials} · Campos: ${fields}`,
  summaryEdit: "Editar",
  summaryEditHint: "Vuelve al documento para cambiar los huecos o los campos.",
  previewSignature: "Tu firma guardada",
  previewInitials: "Tus iniciales guardadas",
  chooseOther: "Elegir otra firma guardada",
  onlyMissing: (labels) => `Solo falta: ${labels.join(" y ")}.`,
  applied: (name) => `Firma guardada de ${name} puesta en todos sus huecos.`,
  appliedMissing: (name, labels) => `Se usó la firma guardada de ${name}. Solo falta: ${labels.join(" y ")}.`,
  undo: "Deshacer",
  undone: "Firma quitada: puedes elegir otra o crearla.",
  singleSigner: "Firma una sola persona: no hace falta pasar el dispositivo.",
  signersRecap: (names) => `Firman: ${names}`,
  signersChange: "Cambiar",
  signersChangeHint: "Vuelve al paso Firmantes para cambiar quién firma.",
  finalTitle: "Revisa y descarga",
  finalBody: (documents) =>
    documents === 1
      ? "Así quedará tu documento. Al tocar el botón se firma y se descarga."
      : `Así quedarán tus ${documents} documentos. Al tocar el botón se firman y se descargan.`,
  finalButton: "Firmar y descargar",
  finalRedo: "Cambiar mi firma",
  finalRegion: "Revisar y descargar",
  downloadedSubtitle: (name) => `Se ha descargado «${name}». Si no lo ves, toca Descargar.`,
};

const QUICK_EN: QuickSignStrings = {
  button: (name) => (name ? `Sign everything with ${name}'s saved signature` : "Sign everything with my saved signature"),
  buttonShort: "Sign everything with my saved signature",
  willPlace: (signatures, initials) => {
    const parts = [
      signatures > 0 ? `your signature in ${signatures} ${signatures === 1 ? "spot" : "spots"}` : "",
      initials > 0 ? `your initials in ${initials} ${initials === 1 ? "spot" : "spots"}` : "",
    ].filter(Boolean);
    return parts.length > 0 ? `This puts ${parts.join(" and ")}. You will see how it looks before downloading.` : "";
  },
  summary: (signatures, initials, fields) => `Signatures: ${signatures} · Initials: ${initials} · Fields: ${fields}`,
  summaryEdit: "Edit",
  summaryEditHint: "Goes back to the document to change the spots or the fields.",
  previewSignature: "Your saved signature",
  previewInitials: "Your saved initials",
  chooseOther: "Choose another saved signature",
  onlyMissing: (labels) => `Only missing: ${labels.join(" and ")}.`,
  applied: (name) => `${name}'s saved signature placed in all their spots.`,
  appliedMissing: (name, labels) => `${name}'s saved signature was used. Only missing: ${labels.join(" and ")}.`,
  undo: "Undo",
  undone: "Signature removed: you can pick another or create one.",
  singleSigner: "Only one person signs: there is no need to hand the device over.",
  signersRecap: (names) => `Signing: ${names}`,
  signersChange: "Change",
  signersChangeHint: "Goes back to the Signers step to change who signs.",
  finalTitle: "Review and download",
  finalBody: (documents) =>
    documents === 1
      ? "This is how your document will look. Tapping the button signs it and downloads it."
      : `This is how your ${documents} documents will look. Tapping the button signs and downloads them.`,
  finalButton: "Sign and download",
  finalRedo: "Change my signature",
  finalRegion: "Review and download",
  downloadedSubtitle: (name) => `“${name}” was downloaded. If you don't see it, tap Download.`,
};

export const FILL_STRINGS: Record<Language, FillStrings> = { es: FILL_ES, en: FILL_EN };
export const QUICK_SIGN_STRINGS: Record<Language, QuickSignStrings> = { es: QUICK_ES, en: QUICK_EN };

/** Sin proveedor de idioma (piezas probadas sueltas) cae a espanol, como las demas piezas compartidas de Firmar. */
export function useFillStrings(): FillStrings {
  return FILL_STRINGS[useOptionalLanguage()];
}

export function useQuickSignStrings(): QuickSignStrings {
  return QUICK_SIGN_STRINGS[useOptionalLanguage()];
}
