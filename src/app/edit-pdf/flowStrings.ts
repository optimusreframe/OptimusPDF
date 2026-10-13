import type { Language } from "@/lib/i18n";

/**
 * Copy del flujo completo de Editar PDF (Wave 5 · U5): avisos al abrir el
 * documento, contrasena, firmas digitales, aplanar pagina, borradores y
 * privacidad, y el resumen/avisos de la descarga. Los textos del lienzo
 * (barra flotante, paleta, miniaturas) viven en `strings.ts`.
 */
export type EditFlowStrings = {
  /* ---- Abrir el documento ---- */
  checking: string;
  tryAnotherFile: string;
  cannotOpen: string;
  documentFailed: string;

  /* ---- PDF cifrado ---- */
  passwordTitle: string;
  passwordBody: string;
  passwordLabel: string;
  passwordShow: string;
  passwordHide: string;
  passwordSubmit: string;
  passwordOpenSheet: string;
  passwordOpening: string;
  passwordCancel: string;
  passwordWrong: string;
  passwordFailed: string;
  protectedCopy: string;

  /* ---- Firmas digitales ---- */
  signaturesActive: string;
  signaturesUnknown: string;
  signaturesConfirmTitle: string;
  signaturesConfirmBodyActive: string;
  signaturesConfirmBodyUnknown: string;
  signaturesConfirmAction: string;
  signaturesConfirmCancel: string;

  /* ---- Formularios, escaneados, ajuste apagado ---- */
  formNotice: string;
  formLink: string;
  scannedAction: string;
  existingTextOff: string;
  settingsLink: string;
  dismiss: string;

  /* ---- Aplanar pagina ---- */
  flattenAction: string;
  unflattenAction: string;
  flattenChip: string;
  flattenConfirmTitle: (page: number) => string;
  flattenConfirmBody: string;
  /** Se anade a la confirmacion cuando el PDF tiene formularios y/o marcadores que aplanar descarta. */
  flattenDropsNote: (forms: boolean, outlines: boolean) => string;
  flattenConfirmAction: string;
  flattenCancel: string;
  flattenClose: string;
  flattenedAnnounce: (page: number) => string;
  unflattenedAnnounce: (page: number) => string;
  flattenStripMark: string;

  /* ---- Borradores ---- */
  draftsButton: string;
  draftsTitle: string;
  draftsEmpty: string;
  draftsSavedAt: (date: string) => string;
  draftsChanges: (count: number) => string;
  draftsPages: (count: number) => string;
  draftsResume: string;
  draftsDelete: (name: string) => string;
  draftsConfirmDeleteTitle: string;
  draftsConfirmDeleteBody: string;
  draftsResumeFailed: string;
  draftsRestored: (count: number) => string;
  draftsRestoredPartial: (lost: number) => string;
  draftsStartFresh: string;
  draftsStartedFresh: string;
  draftsSaveFailed: string;
  draftsTooBig: string;

  /* ---- Privacidad ---- */
  privacyToggle: string;
  privacyBody: string;
  privacyClear: string;
  privacyClearTitle: string;
  privacyClearBody: string;
  privacyCleared: string;
  privacyClearFailed: string;
  confirmCancel: string;
  confirmClose: string;

  /* ---- Descarga ---- */
  exportCancelled: string;
  /** Motivo junto a «Procesar» desactivado: todavia no hay cambios que exportar. */
  exportNeedsChange: string;
  summaryEditedTexts: (count: number) => string;
  summaryAddedTexts: (count: number) => string;
  summaryImages: (count: number) => string;
  summaryShapes: (count: number) => string;
  summaryFlattened: (count: number) => string;
  noticesTitle: string;
  noticeFont: (count: number) => string;
  noticeGlyph: (count: number) => string;
  noticeRemains: (count: number) => string;
  /** (Wave 8 · F2) El texto original de N textos editados se elimino de verdad del PDF. */
  noticeRemoved: (count: number) => string;
  noticeBackground: (count: number) => string;
  noticeMixed: (count: number) => string;
  noticeOverlap: (count: number) => string;
  noticeCoverOverlap: (count: number) => string;
  noticeSkipped: (count: number) => string;
  noticeSignatures: string;
  noticeProtected: string;
  noticeFlattened: string;
  noticeFlattenDrops: (forms: boolean, outlines: boolean) => string;
};

/** «Aplanar convierte la página en imagen: se pierden campos de formulario y marcadores del documento.» */
function esDrops(forms: boolean, outlines: boolean): string {
  const what =
    forms && outlines
      ? "campos de formulario y marcadores del documento"
      : forms
        ? "campos de formulario del documento"
        : "marcadores del documento";
  return `Aplanar convierte la página en imagen: se pierden ${what}.`;
}

function enDrops(forms: boolean, outlines: boolean): string {
  const what =
    forms && outlines ? "form fields and bookmarks of the document" : forms ? "form fields of the document" : "bookmarks of the document";
  return `Flattening turns the page into an image: the ${what} are lost.`;
}

function esCount(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

const es: EditFlowStrings = {
  checking: "Comprobando el documento…",
  tryAnotherFile: "Elegir otro archivo",
  cannotOpen: "Este documento no se puede abrir aquí.",
  documentFailed: "No se pudo leer este documento: parece dañado, así que no hay nada que editar.",

  passwordTitle: "Documento protegido con contraseña",
  passwordBody:
    "Escribe la contraseña para abrirlo. Se usa solo en tu navegador y no se guarda. La copia que descargues no llevará contraseña.",
  passwordLabel: "Contraseña",
  passwordShow: "Mostrar la contraseña",
  passwordHide: "Ocultar la contraseña",
  passwordSubmit: "Abrir documento",
  passwordOpenSheet: "Escribir la contraseña",
  passwordOpening: "Abriendo…",
  passwordCancel: "Cancelar",
  passwordWrong: "La contraseña no es correcta. Revísala e inténtalo de nuevo.",
  passwordFailed: "No se pudo abrir el documento con esa contraseña. Inténtalo de nuevo.",
  protectedCopy:
    "El PDF original está protegido: la copia editada se guarda sin contraseña y no se guardan borradores de este documento.",

  signaturesActive:
    "Editar este documento invalida sus firmas digitales. Antes de exportar te pediremos confirmación.",
  signaturesUnknown:
    "No pudimos comprobar si este documento tiene firmas digitales. Si las tiene, editarlo las invalida; te pediremos confirmación antes de exportar.",
  signaturesConfirmTitle: "Editar invalida las firmas digitales",
  signaturesConfirmBodyActive:
    "Este documento tiene firmas digitales. Al exportarlo con tus cambios esas firmas dejan de ser válidas y los lectores de PDF lo mostrarán como modificado. El archivo original no se toca.",
  signaturesConfirmBodyUnknown:
    "No pudimos comprobar si el documento tiene firmas digitales. Si las tiene, al exportarlo con tus cambios dejarán de ser válidas y los lectores de PDF lo mostrarán como modificado. El archivo original no se toca.",
  signaturesConfirmAction: "Exportar de todos modos",
  signaturesConfirmCancel: "Cancelar",

  formNotice: "Los campos de formulario no se editan aquí. Para rellenarlos o firmar, usa Firmar PDF.",
  formLink: "Ir a Firmar PDF",
  scannedAction: "Añadir texto",
  existingTextOff:
    "La edición del texto que ya trae el PDF está desactivada en Ajustes. Puedes añadir texto, imágenes y formas.",
  settingsLink: "Abrir Ajustes",
  dismiss: "Ocultar este aviso",

  flattenAction: "Aplanar página",
  unflattenAction: "Quitar aplanado",
  flattenChip: "Se aplanará al exportar",
  flattenConfirmTitle: (page) => `¿Aplanar la página ${page}?`,
  flattenConfirmBody:
    "La página se convierte en una imagen: su texto deja de ser seleccionable, buscable y extraíble, y se pierden sus enlaces y campos. Así desaparece del archivo el texto original que cubriste con una edición. En el PDF que descargues no se puede deshacer; hasta entonces sí (Deshacer o «Quitar aplanado»). Las demás páginas se conservan.",
  flattenDropsNote: (forms, outlines) => esDrops(forms, outlines),
  flattenConfirmAction: "Aplanar página",
  flattenCancel: "Cancelar",
  flattenClose: "Cerrar",
  flattenedAnnounce: (page) => `Página ${page} marcada para aplanar. Puedes deshacerlo.`,
  unflattenedAnnounce: (page) => `La página ${page} ya no se aplanará.`,
  flattenStripMark: "se aplanará",

  draftsButton: "Ver borradores",
  draftsTitle: "Borradores del editor",
  draftsEmpty: "No hay borradores guardados en este dispositivo.",
  draftsSavedAt: (date) => `Guardado ${date}`,
  draftsChanges: (count) => esCount(count, "cambio", "cambios"),
  draftsPages: (count) => esCount(count, "página", "páginas"),
  draftsResume: "Retomar",
  draftsDelete: (name) => `Eliminar el borrador de ${name}`,
  draftsConfirmDeleteTitle: "¿Eliminar este borrador?",
  draftsConfirmDeleteBody:
    "Se borran de este dispositivo el documento guardado y tus cambios. No se puede deshacer.",
  draftsResumeFailed: "No se pudo abrir ese borrador. Puede que ya no exista.",
  draftsRestored: (count) =>
    `Recuperamos tu trabajo anterior en este documento (${esCount(count, "cambio", "cambios")}).`,
  draftsRestoredPartial: (lost) =>
    `${esCount(lost, "cambio no se pudo recuperar", "cambios no se pudieron recuperar")}.`,
  draftsStartFresh: "Empezar de cero",
  draftsStartedFresh: "Borrador descartado. Empiezas de cero.",
  draftsSaveFailed:
    "No se pudo guardar el borrador automático (poco espacio o el navegador lo impide). Tu trabajo sigue aquí, pero no se recuperará si cierras la pestaña.",
  draftsTooBig: "Este documento es demasiado grande para guardar un borrador automático.",

  privacyToggle: "Privacidad",
  privacyBody:
    "Todo ocurre en tu navegador: el PDF no se sube a ningún servidor. Para que no pierdas tu trabajo, el editor guarda un borrador automático en este dispositivo (IndexedDB): el documento completo, tus cambios y las imágenes que añadas. «Borrar datos» lo elimina.",
  privacyClear: "Borrar datos",
  privacyClearTitle: "¿Borrar los borradores del editor?",
  privacyClearBody:
    "Se eliminan todos los borradores guardados en este dispositivo, incluido el del documento abierto. Tu trabajo en pantalla no se toca, pero dejará de recuperarse si cierras la pestaña.",
  privacyCleared: "Datos borrados.",
  privacyClearFailed:
    "No se pudieron borrar los borradores (la base de datos está bloqueada, por ejemplo por otra pestaña). Ciérrala e inténtalo de nuevo.",
  confirmCancel: "Cancelar",
  confirmClose: "Cerrar",

  exportCancelled: "Exportación cancelada. Tus cambios siguen aquí.",
  exportNeedsChange: "Haz un cambio en el documento para poder exportarlo.",
  summaryEditedTexts: (count) => esCount(count, "texto editado", "textos editados"),
  summaryAddedTexts: (count) => esCount(count, "texto añadido", "textos añadidos"),
  summaryImages: (count) => esCount(count, "imagen añadida", "imágenes añadidas"),
  summaryShapes: (count) => esCount(count, "forma añadida", "formas añadidas"),
  summaryFlattened: (count) => esCount(count, "página aplanada", "páginas aplanadas"),
  noticesTitle: "Avisos de la exportación",
  noticeFont: (count) =>
    count === 1
      ? "1 texto usa una fuente parecida a la original, no la misma."
      : `${count} textos usan una fuente parecida a la original, no la misma.`,
  noticeGlyph: (count) =>
    count === 1
      ? "1 texto tiene caracteres que su fuente no dibuja: se usó otra fuente o un «?»."
      : `${count} textos tienen caracteres que su fuente no dibuja: se usó otra fuente o un «?».`,
  noticeRemains: (count) =>
    count === 1
      ? "No se pudo eliminar del PDF el texto original de 1 texto editado: sigue bajo la edición y se puede seleccionar o copiar. Para quitarlo del todo, aplana esa página."
      : `No se pudo eliminar del PDF el texto original de ${count} textos editados: sigue bajo la edición y se puede seleccionar o copiar. Para quitarlo del todo, aplana esas páginas.`,
  noticeRemoved: (count) =>
    count === 1
      ? "El texto original de 1 texto editado se eliminó del PDF: ya no se puede seleccionar, copiar ni buscar."
      : `El texto original de ${count} textos editados se eliminó del PDF: ya no se puede seleccionar, copiar ni buscar.`,
  noticeBackground: (count) =>
    count === 1
      ? "1 texto está sobre un fondo que no es de un solo color: puede verse un borde alrededor."
      : `${count} textos están sobre un fondo que no es de un solo color: puede verse un borde alrededor.`,
  noticeCoverOverlap: (count) =>
    count === 1
      ? "1 texto girado cruza otro texto: parte del original puede quedar visible."
      : `${count} textos girados cruzan otro texto: parte del original puede quedar visible.`,
  noticeMixed: (count) =>
    count === 1
      ? "1 texto mezclaba estilos (color, negrita, fuente…): al editarlo se unificaron con el estilo dominante."
      : `${count} textos mezclaban estilos (color, negrita, fuente…): al editarlos se unificaron con el estilo dominante.`,
  noticeOverlap: (count) =>
    count === 1
      ? "1 texto invade a otro texto del documento: pueden verse encimados."
      : `${count} textos invaden a otros textos del documento: pueden verse encimados.`,
  noticeSkipped: (count) =>
    count === 1
      ? "1 cambio no se pudo aplicar y se omitió."
      : `${count} cambios no se pudieron aplicar y se omitieron.`,
  noticeSignatures: "Las firmas digitales del documento original ya no son válidas.",
  noticeProtected: "La copia no lleva la contraseña del original.",
  noticeFlattened: "Las páginas aplanadas ya no tienen texto seleccionable.",
  noticeFlattenDrops: (forms, outlines) => esDrops(forms, outlines),
};

function enCount(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

const en: EditFlowStrings = {
  checking: "Checking the document…",
  tryAnotherFile: "Choose another file",
  cannotOpen: "This document can't be opened here.",
  documentFailed: "This document could not be read: it looks damaged, so there is nothing to edit.",

  passwordTitle: "Password-protected document",
  passwordBody:
    "Enter the password to open it. It is only used in your browser and is not stored. The copy you download will not have a password.",
  passwordLabel: "Password",
  passwordShow: "Show the password",
  passwordHide: "Hide the password",
  passwordSubmit: "Open document",
  passwordOpenSheet: "Enter the password",
  passwordOpening: "Opening…",
  passwordCancel: "Cancel",
  passwordWrong: "That password is not correct. Check it and try again.",
  passwordFailed: "The document could not be opened with that password. Try again.",
  protectedCopy:
    "The original PDF is protected: the edited copy is saved without a password and no drafts are kept for this document.",

  signaturesActive:
    "Editing this document invalidates its digital signatures. We'll ask you to confirm before exporting.",
  signaturesUnknown:
    "We couldn't check whether this document has digital signatures. If it does, editing invalidates them; we'll ask you to confirm before exporting.",
  signaturesConfirmTitle: "Editing invalidates digital signatures",
  signaturesConfirmBodyActive:
    "This document has digital signatures. Exporting it with your changes makes those signatures invalid, and PDF readers will show it as modified. The original file is not touched.",
  signaturesConfirmBodyUnknown:
    "We couldn't check whether the document has digital signatures. If it does, exporting it with your changes makes them invalid, and PDF readers will show it as modified. The original file is not touched.",
  signaturesConfirmAction: "Export anyway",
  signaturesConfirmCancel: "Cancel",

  formNotice: "Form fields can't be edited here. To fill them in or sign, use Sign PDF.",
  formLink: "Go to Sign PDF",
  scannedAction: "Add text",
  existingTextOff:
    "Editing the text already in the PDF is turned off in Settings. You can still add text, images and shapes.",
  settingsLink: "Open Settings",
  dismiss: "Hide this notice",

  flattenAction: "Flatten page",
  unflattenAction: "Remove flattening",
  flattenChip: "Will be flattened on export",
  flattenConfirmTitle: (page) => `Flatten page ${page}?`,
  flattenConfirmBody:
    "The page becomes an image: its text stops being selectable, searchable and extractable, and its links and fields are lost. That removes from the file the original text you covered with an edit. In the PDF you download it can't be undone; until then it can (Undo or “Remove flattening”). The other pages are kept.",
  flattenDropsNote: (forms, outlines) => enDrops(forms, outlines),
  flattenConfirmAction: "Flatten page",
  flattenCancel: "Cancel",
  flattenClose: "Close",
  flattenedAnnounce: (page) => `Page ${page} marked to be flattened. You can undo it.`,
  unflattenedAnnounce: (page) => `Page ${page} will no longer be flattened.`,
  flattenStripMark: "will be flattened",

  draftsButton: "View drafts",
  draftsTitle: "Editor drafts",
  draftsEmpty: "There are no drafts saved on this device.",
  draftsSavedAt: (date) => `Saved ${date}`,
  draftsChanges: (count) => enCount(count, "change", "changes"),
  draftsPages: (count) => enCount(count, "page", "pages"),
  draftsResume: "Resume",
  draftsDelete: (name) => `Delete the draft of ${name}`,
  draftsConfirmDeleteTitle: "Delete this draft?",
  draftsConfirmDeleteBody:
    "The saved document and your changes are removed from this device. This can't be undone.",
  draftsResumeFailed: "That draft could not be opened. It may no longer exist.",
  draftsRestored: (count) =>
    `We recovered your earlier work on this document (${enCount(count, "change", "changes")}).`,
  draftsRestoredPartial: (lost) =>
    `${enCount(lost, "change could not be recovered", "changes could not be recovered")}.`,
  draftsStartFresh: "Start from scratch",
  draftsStartedFresh: "Draft discarded. You're starting from scratch.",
  draftsSaveFailed:
    "The automatic draft could not be saved (low space or the browser blocks it). Your work is still here, but it won't be recovered if you close the tab.",
  draftsTooBig: "This document is too large to keep an automatic draft.",

  privacyToggle: "Privacy",
  privacyBody:
    "Everything happens in your browser: the PDF is never uploaded to a server. So you don't lose your work, the editor saves an automatic draft on this device (IndexedDB): the whole document, your changes and the images you add. “Clear data” removes it.",
  privacyClear: "Clear data",
  privacyClearTitle: "Clear the editor drafts?",
  privacyClearBody:
    "Every draft saved on this device is removed, including the one for the open document. Your work on screen is not touched, but it won't be recovered if you close the tab.",
  privacyCleared: "Data cleared.",
  privacyClearFailed:
    "The drafts could not be cleared (the database is blocked, for example by another tab). Close it and try again.",
  confirmCancel: "Cancel",
  confirmClose: "Close",

  exportCancelled: "Export cancelled. Your changes are still here.",
  exportNeedsChange: "Make a change to the document to be able to export it.",
  summaryEditedTexts: (count) => enCount(count, "text edited", "texts edited"),
  summaryAddedTexts: (count) => enCount(count, "text added", "texts added"),
  summaryImages: (count) => enCount(count, "image added", "images added"),
  summaryShapes: (count) => enCount(count, "shape added", "shapes added"),
  summaryFlattened: (count) => enCount(count, "page flattened", "pages flattened"),
  noticesTitle: "Export notices",
  noticeFont: (count) =>
    count === 1
      ? "1 text uses a font similar to the original, not the same one."
      : `${count} texts use a font similar to the original, not the same one.`,
  noticeGlyph: (count) =>
    count === 1
      ? "1 text has characters its font can't draw: another font or a “?” was used."
      : `${count} texts have characters their font can't draw: another font or a “?” was used.`,
  noticeRemains: (count) =>
    count === 1
      ? "The original text of 1 edited text could not be removed from the PDF: it stays under the edit and can be selected or copied. To remove it entirely, flatten that page."
      : `The original text of ${count} edited texts could not be removed from the PDF: it stays under the edit and can be selected or copied. To remove it entirely, flatten those pages.`,
  noticeRemoved: (count) =>
    count === 1
      ? "The original text of 1 edited text was removed from the PDF: it can no longer be selected, copied or searched."
      : `The original text of ${count} edited texts was removed from the PDF: it can no longer be selected, copied or searched.`,
  noticeBackground: (count) =>
    count === 1
      ? "1 text sits on a background that isn't a single colour: an outline may show around it."
      : `${count} texts sit on a background that isn't a single colour: an outline may show around them.`,
  noticeMixed: (count) =>
    count === 1
      ? "1 text mixed styles (colour, bold, font…): editing it unified them with the dominant style."
      : `${count} texts mixed styles (colour, bold, font…): editing them unified them with the dominant style.`,
  noticeCoverOverlap: (count) =>
    count === 1
      ? "1 rotated text crosses another text: part of the original may stay visible."
      : `${count} rotated texts cross other texts: part of the original may stay visible.`,
  noticeOverlap: (count) =>
    count === 1
      ? "1 text overlaps another text in the document: they may show on top of each other."
      : `${count} texts overlap other texts in the document: they may show on top of each other.`,
  noticeSkipped: (count) =>
    count === 1 ? "1 change could not be applied and was skipped." : `${count} changes could not be applied and were skipped.`,
  noticeSignatures: "The digital signatures of the original document are no longer valid.",
  noticeProtected: "The copy does not carry the original's password.",
  noticeFlattened: "Flattened pages no longer have selectable text.",
  noticeFlattenDrops: (forms, outlines) => enDrops(forms, outlines),
};

export const EDIT_FLOW_STRINGS: Record<Language, EditFlowStrings> = { es, en };
