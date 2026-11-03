"use client";

import { useOptionalLanguage, type Language } from "@/lib/i18n";

/**
 * Textos de las etiquetas de campo, la memoria de datos y el autorrelleno (W3-A1), es/en. Viven aqui, no en `strings.ts` ni
 * en `locales/*`, porque los usan a la vez Firmar y PDF Pro, igual que `lib/touch/strings.ts`.
 */
export type TagStrings = {
  /* --- Etiqueta de un campo --- */
  /** Nombre accesible del grupo de chips. */
  pickerLabel: string;
  /** Pastilla sin etiqueta (abre los chips). */
  pillNoTag: string;
  /** Pastilla con la etiqueta que sugiere el rotulo del campo. */
  pillSuggest: (tag: string) => string;
  /** Pastilla de una etiqueta puesta (nombre accesible). */
  pillTagged: (tag: string) => string;
  chipOther: string;
  chipNone: string;
  chipClose: string;
  /** Boton de la barra flotante: abre los chips. */
  barTag: (tag: string | null) => string;
  /** Aviso hablado al poner una etiqueta. */
  tagSet: (field: string, tag: string) => string;
  tagCleared: (field: string) => string;
  /** Lo que se dice de un campo que lleva etiqueta (nombre accesible del campo). */
  fieldTagged: (tag: string) => string;

  /* --- Etiqueta propia --- */
  customTitle: string;
  customBody: string;
  customNameLabel: string;
  customNamePlaceholder: string;
  customCreate: string;
  customCancel: string;
  customEmpty: string;
  customFull: (max: number) => string;

  /* --- Sugerencias --- */
  /** Nombre accesible de la barra de sugerencias sobre el teclado. */
  barLabel: (tag: string | null) => string;
  /** Texto de ayuda (solo lectores de pantalla) de una sugerencia. */
  suggestionHint: string;
  suggestionPinned: string;
  manageOn: string;
  manageOff: string;
  manageTitle: (value: string) => string;
  pin: string;
  unpin: string;
  forget: string;
  forgetNamed: (value: string) => string;
  manageClose: string;
  forgotten: (value: string) => string;
  pinnedNotice: (value: string) => string;
  unpinnedNotice: (value: string) => string;
  pinFull: (max: number) => string;
  /** Texto de los botones de acciones del desplegable con raton. */
  pinNamed: (value: string) => string;
  unpinNamed: (value: string) => string;

  /* --- Autorrelleno --- */
  /** Marca visible y accesible de un campo rellenado solo. */
  autoFilledMark: string;
  /** Aviso del autorrelleno (`tag` = nombre de la etiqueta). */
  autoFilledToast: (count: number, tag: string) => string;
  /** Varias etiquetas a la vez (campos que llegan con etiqueta): sin nombrar ninguna. */
  autoFilledGeneric: (count: number) => string;
  autoFillUndo: string;
  autoFillDismiss: string;
  autoFillUndone: (count: number) => string;
  autoFillRegion: string;

  /* --- Datos recordados --- */
  rememberedButton: string;
  rememberedButtonHint: string;
  rememberedTitle: string;
  rememberedIntro: string;
  rememberedSearch: string;
  rememberedSearchLabel: string;
  rememberedEmpty: string;
  rememberedNoMatch: string;
  rememberedCount: (count: number) => string;
  rememberedLegacy: string;
  rememberedEdit: (value: string) => string;
  rememberedEditLabel: string;
  rememberedSave: string;
  rememberedCancel: string;
  rememberedDelete: (value: string) => string;
  /** Rotulo corto del boton que confirma borrar una etiqueta. */
  rememberedDeleteAction: string;
  rememberedDeleteTag: (tag: string) => string;
  rememberedDeleteTagConfirm: (tag: string, count: number) => string;
  rememberedClearAll: string;
  rememberedClearTitle: string;
  rememberedClearBody: string;
  rememberedClearConfirm: string;
  rememberedClosed: string;
  rememberedRenameTag: (tag: string) => string;
  rememberedRenameLabel: string;
  rememberedSaved: string;
  rememberedInvalidValue: string;
  rememberedStatusDeleted: string;
  rememberedStatusCleared: string;
  rememberedMore: (tag: string) => string;
  rememberedPrivacy: string;
  /** Parrafo del aviso de privacidad de Firmar sobre la memoria por etiqueta y el autorrelleno. */
  privacyMemoryNote: string;
  /** Tarjeta de Ajustes. */
  settingsTitle: string;
  settingsBody: string;
};

const es: TagStrings = {
  pickerLabel: "Etiqueta del campo",
  pillNoTag: "Etiquetar",
  pillSuggest: (tag) => `Etiquetar: ${tag}`,
  pillTagged: (tag) => `Etiqueta: ${tag}. Cambiar`,
  chipOther: "Otra…",
  chipNone: "Sin etiqueta",
  chipClose: "Cerrar etiquetas",
  barTag: (tag) => (tag ? `Etiqueta: ${tag}. Cambiar` : "Poner etiqueta"),
  tagSet: (field, tag) => `${field}: etiqueta ${tag}.`,
  tagCleared: (field) => `${field}: sin etiqueta.`,
  fieldTagged: (tag) => `etiqueta ${tag}`,

  customTitle: "Etiqueta nueva",
  customBody: "Los campos con la misma etiqueta se rellenan solos con el mismo dato.",
  customNameLabel: "Nombre de la etiqueta",
  customNamePlaceholder: "Ej. Código de zona",
  customCreate: "Crear etiqueta",
  customCancel: "Cancelar",
  customEmpty: "Escribe un nombre para la etiqueta.",
  customFull: (max) => `Ya tienes ${max} etiquetas propias. Borra alguna en «Datos recordados» para crear otra.`,

  barLabel: (tag) => (tag ? `Valores guardados para ${tag}` : "Valores guardados"),
  suggestionHint: "Toca para usarlo. Mantén pulsado para fijarlo u olvidarlo.",
  suggestionPinned: "fijado",
  manageOn: "Gestionar valores guardados",
  manageOff: "Dejar de gestionar",
  manageTitle: (value) => `«${value}»`,
  pin: "Fijar arriba",
  unpin: "Quitar de fijados",
  forget: "Olvidar",
  forgetNamed: (value) => `Olvidar «${value}»`,
  manageClose: "Cerrar",
  forgotten: (value) => `«${value}» olvidado.`,
  pinnedNotice: (value) => `«${value}» fijado arriba.`,
  unpinnedNotice: (value) => `«${value}» ya no está fijado.`,
  pinFull: (max) => `Solo se pueden fijar ${max} valores por etiqueta.`,
  pinNamed: (value) => `Fijar «${value}» arriba`,
  unpinNamed: (value) => `Quitar «${value}» de fijados`,

  autoFilledMark: "Rellenado automáticamente",
  autoFilledToast: (count, tag) =>
    `${tag}: rellenado en ${count} ${count === 1 ? "campo" : "campos"}`,
  autoFilledGeneric: (count) => `Rellenado en ${count} ${count === 1 ? "campo" : "campos"}`,
  autoFillUndo: "Deshacer",
  autoFillDismiss: "Cerrar aviso",
  autoFillUndone: (count) => `Deshecho en ${count} ${count === 1 ? "campo" : "campos"}`,
  autoFillRegion: "Avisos de autorrelleno",

  rememberedButton: "Datos recordados",
  rememberedButtonHint: "Lo que ya escribiste, por etiqueta",
  rememberedTitle: "Datos recordados",
  rememberedIntro:
    "Lo que escribes en los campos se recuerda para sugerírtelo en otros documentos. Se guarda solo en este dispositivo y puedes corregirlo o borrarlo aquí.",
  rememberedSearch: "Buscar",
  rememberedSearchLabel: "Buscar en los datos recordados",
  rememberedEmpty: "Todavía no hay datos recordados. Se guardan al rellenar campos con etiqueta.",
  rememberedNoMatch: "Nada coincide con tu búsqueda.",
  rememberedCount: (count) => `${count} ${count === 1 ? "valor" : "valores"}`,
  rememberedLegacy: "Rótulo anterior",
  rememberedEdit: (value) => `Editar «${value}»`,
  rememberedEditLabel: "Texto del valor",
  rememberedSave: "Guardar",
  rememberedCancel: "Cancelar",
  rememberedDelete: (value) => `Borrar «${value}»`,
  rememberedDeleteAction: "Borrar",
  rememberedDeleteTag: (tag) => `Borrar la etiqueta ${tag}`,
  rememberedDeleteTagConfirm: (tag, count) =>
    `Se borran ${count} ${count === 1 ? "valor" : "valores"} de «${tag}».`,
  rememberedClearAll: "Borrar todo",
  rememberedClearTitle: "¿Borrar todos los datos recordados?",
  rememberedClearBody:
    "Se borran los valores guardados y tus etiquetas propias de este dispositivo. Los campos de tus documentos no cambian.",
  rememberedClearConfirm: "Borrar todo",
  rememberedClosed: "Cerrar",
  rememberedRenameTag: (tag) => `Cambiar el nombre de ${tag}`,
  rememberedRenameLabel: "Nombre de la etiqueta",
  rememberedSaved: "Cambio guardado.",
  rememberedInvalidValue: "El valor debe tener entre 2 y 500 caracteres.",
  rememberedStatusDeleted: "Borrado.",
  rememberedStatusCleared: "Datos recordados borrados.",
  rememberedMore: (tag) => `Más acciones de ${tag}`,
  rememberedPrivacy: "Solo en este dispositivo. Nada de esto sale de él.",
  privacyMemoryNote:
    "Lo que escribes en un campo con etiqueta (nombre, dirección, póliza…) se recuerda en este dispositivo para sugerírtelo en otros documentos, y dentro de esta ronda rellena solo los demás campos con la misma etiqueta (con aviso para deshacer). Lo ves, lo corriges y lo borras en «Datos recordados».",
  settingsTitle: "Datos recordados",
  settingsBody:
    "Los valores que escribes en los campos (nombres, direcciones, números de póliza…) se recuerdan por etiqueta para sugerírtelos. Aquí los ves, los corriges o los borras.",
};

const en: TagStrings = {
  pickerLabel: "Field tag",
  pillNoTag: "Tag",
  pillSuggest: (tag) => `Tag as: ${tag}`,
  pillTagged: (tag) => `Tag: ${tag}. Change`,
  chipOther: "Other…",
  chipNone: "No tag",
  chipClose: "Close tags",
  barTag: (tag) => (tag ? `Tag: ${tag}. Change` : "Set tag"),
  tagSet: (field, tag) => `${field}: tag ${tag}.`,
  tagCleared: (field) => `${field}: no tag.`,
  fieldTagged: (tag) => `tag ${tag}`,

  customTitle: "New tag",
  customBody: "Fields with the same tag fill themselves with the same data.",
  customNameLabel: "Tag name",
  customNamePlaceholder: "E.g. Zone code",
  customCreate: "Create tag",
  customCancel: "Cancel",
  customEmpty: "Type a name for the tag.",
  customFull: (max) => `You already have ${max} custom tags. Delete one in "Remembered data" to create another.`,

  barLabel: (tag) => (tag ? `Saved values for ${tag}` : "Saved values"),
  suggestionHint: "Tap to use it. Press and hold to pin or forget it.",
  suggestionPinned: "pinned",
  manageOn: "Manage saved values",
  manageOff: "Stop managing",
  manageTitle: (value) => `"${value}"`,
  pin: "Pin to top",
  unpin: "Unpin",
  forget: "Forget",
  forgetNamed: (value) => `Forget "${value}"`,
  manageClose: "Close",
  forgotten: (value) => `"${value}" forgotten.`,
  pinnedNotice: (value) => `"${value}" pinned to the top.`,
  unpinnedNotice: (value) => `"${value}" is no longer pinned.`,
  pinFull: (max) => `You can pin up to ${max} values per tag.`,
  pinNamed: (value) => `Pin "${value}" to the top`,
  unpinNamed: (value) => `Unpin "${value}"`,

  autoFilledMark: "Filled automatically",
  autoFilledToast: (count, tag) => `${tag}: filled in ${count} ${count === 1 ? "field" : "fields"}`,
  autoFilledGeneric: (count) => `Filled in ${count} ${count === 1 ? "field" : "fields"}`,
  autoFillUndo: "Undo",
  autoFillDismiss: "Dismiss notice",
  autoFillUndone: (count) => `Undone in ${count} ${count === 1 ? "field" : "fields"}`,
  autoFillRegion: "Auto-fill notices",

  rememberedButton: "Remembered data",
  rememberedButtonHint: "What you already typed, by tag",
  rememberedTitle: "Remembered data",
  rememberedIntro:
    "What you type in fields is remembered so it can be suggested in other documents. It is stored only on this device and you can correct or delete it here.",
  rememberedSearch: "Search",
  rememberedSearchLabel: "Search remembered data",
  rememberedEmpty: "Nothing remembered yet. Values are saved when you fill in tagged fields.",
  rememberedNoMatch: "Nothing matches your search.",
  rememberedCount: (count) => `${count} ${count === 1 ? "value" : "values"}`,
  rememberedLegacy: "Earlier label",
  rememberedEdit: (value) => `Edit "${value}"`,
  rememberedEditLabel: "Value text",
  rememberedSave: "Save",
  rememberedCancel: "Cancel",
  rememberedDelete: (value) => `Delete "${value}"`,
  rememberedDeleteAction: "Delete",
  rememberedDeleteTag: (tag) => `Delete the ${tag} tag`,
  rememberedDeleteTagConfirm: (tag, count) =>
    `${count} ${count === 1 ? "value" : "values"} of "${tag}" will be deleted.`,
  rememberedClearAll: "Delete everything",
  rememberedClearTitle: "Delete all remembered data?",
  rememberedClearBody:
    "Saved values and your own tags are deleted from this device. The fields in your documents do not change.",
  rememberedClearConfirm: "Delete everything",
  rememberedClosed: "Close",
  rememberedRenameTag: (tag) => `Rename ${tag}`,
  rememberedRenameLabel: "Tag name",
  rememberedSaved: "Change saved.",
  rememberedInvalidValue: "The value must be 2 to 500 characters long.",
  rememberedStatusDeleted: "Deleted.",
  rememberedStatusCleared: "Remembered data deleted.",
  rememberedMore: (tag) => `More actions for ${tag}`,
  rememberedPrivacy: "Only on this device. None of this leaves it.",
  privacyMemoryNote:
    "What you type in a tagged field (name, address, policy…) is remembered on this device to suggest it in other documents, and within this round it fills the other fields with the same tag by itself (with a notice to undo). You can see, correct and delete it in \"Remembered data\".",
  settingsTitle: "Remembered data",
  settingsBody:
    "The values you type in fields (names, addresses, policy numbers…) are remembered by tag so they can be suggested to you. Here you can see, correct or delete them.",
};

export const TAG_STRINGS: Record<Language, TagStrings> = { es, en };

export function useTagStrings(): TagStrings {
  return TAG_STRINGS[useOptionalLanguage()];
}
