"use client";

import { useOptionalLanguage, type Language } from "@/lib/i18n";

/*
 * Textos (ES/EN) del modo «Editar campos» a pantalla completa (W3-B1): la entrada, las barras, el inspector, las listas de
 * paginas y elementos y la ayuda. Un modulo propio, igual que `gestureStrings.ts` o `tagStrings.ts`: no se mezcla con
 * `strings.ts` ni con `locales/*`. Lo que ya existe en `SignStrings` (nombres de herramientas, paginas, zoom, Firma,
 * Iniciales...) se sigue leyendo de alli.
 */
export type EditModeStrings = {
  /* --- Entrada --- */
  entryButton: string;
  entryButtonTouch: string;
  entryHint: string;
  entryOpenAlways: string;
  entryOpenAlwaysHint: string;
  /** Lo que queda en la pagina mientras el modo esta abierto. */
  stub: string;

  /* --- Marco y barras --- */
  frameLabel: string;
  title: string;
  done: string;
  doneLabel: string;
  toolsLabel: string;
  undo: string;
  redo: string;
  undone: string;
  redone: string;
  nothingToUndo: string;
  nothingToRedo: string;
  elementsButton: string;
  pagesButton: string;
  helpButton: string;
  /** Abre el panel del elemento seleccionado. */
  inspectorOpen: string;

  /* --- Zoom y paginas --- */
  fitToWidth: string;
  fitToHeight: string;
  /** Boton que alterna el ajuste: dice a donde pasa. */
  fitSwitchTo: (mode: "width" | "height") => string;
  fitStatus: (mode: "width" | "height") => string;
  zoomValue: (percent: number) => string;
  zoomStatus: (percent: number) => string;
  pageBar: string;
  pagesToggle: (page: number, total: number) => string;
  nextWithFields: string;
  prevWithFields: string;
  noPageWithFields: string;
  pageStatus: (page: number, total: number, fields: number) => string;
  pageSwipeHint: string;

  /* --- Dock (inspector, elementos, paginas, ayuda) --- */
  dockLabel: string;
  tabElement: string;
  tabElements: string;
  tabPages: string;
  tabHelp: string;
  dockClose: string;
  dockExpand: string;
  dockCollapse: string;
  dockHandle: string;

  /* --- Inspector --- */
  inspectorTitle: (name: string) => string;
  signerLabel: string;
  typeLabel: string;
  tagSection: string;
  tagNone: string;
  requiredLabel: string;
  requiredOn: string;
  requiredOff: string;
  optionalMark: string;
  sizeSection: string;
  widthLabel: string;
  heightLabel: string;
  fontSizeLabel: string;
  fontSizeAuto: string;
  fontSizeAutoHint: string;
  fontSizeUseAuto: string;
  stepDown: (label: string) => string;
  stepUp: (label: string) => string;
  valueOf: (label: string) => string;
  alignSection: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  matchSize: string;
  alignNoNeighbor: string;
  alignedStatus: (mode: "left" | "center" | "right", other: string) => string;
  matchedStatus: (other: string) => string;
  actionsSection: string;
  duplicate: string;
  copy: string;
  paste: string;
  repeatAll: string;
  remove: string;
  copiedStatus: string;
  pastedStatus: (page: number) => string;
  repeatedStatus: (count: number) => string;
  nothingToRepeat: string;
  removedStatus: string;
  sizeStatus: (label: string, value: string) => string;

  /* --- Lista de elementos --- */
  elementsTitle: string;
  elementsEmpty: string;
  elementsPage: (page: number, count: number) => string;
  elementDone: string;
  elementPending: string;
  elementOpen: (name: string, page: number) => string;
  elementSelectedStatus: (name: string, page: number) => string;

  /* --- Paginas --- */
  pagesTitle: string;
  /** Varios documentos: selector del documento que se edita. */
  documentLabel: string;
  pageThumb: (page: number, count: number) => string;
  pageCurrent: string;
  pagesEmpty: string;

  /* --- Ayuda --- */
  helpTitle: string;
  helpGesturesTitle: string;
  helpGestures: readonly string[];
  helpShortcutsTitle: string;
  helpShortcuts: readonly (readonly [string, string])[];
  helpPrefsTitle: string;
  helpFitLabel: string;
  helpOpenAlways: string;
  helpOpenAlwaysHint: string;
};

const es: EditModeStrings = {
  entryButton: "Editar campos",
  entryButtonTouch: "Editar campos a pantalla completa",
  entryHint:
    "La página se queda fija y las herramientas quedan a mano. Un dedo o el lápiz dibujan; con dos dedos mueves y acercas.",
  entryOpenAlways: "Abrir así siempre en este dispositivo",
  entryOpenAlwaysHint: "Al entrar en este paso se abrirá solo a pantalla completa. Puedes salir con «Listo».",
  stub: "Editando los campos a pantalla completa…",

  frameLabel: "Editar campos a pantalla completa",
  title: "Editar campos",
  done: "Listo",
  doneLabel: "Listo: terminar de editar campos y volver al documento",
  toolsLabel: "Herramientas",
  undo: "Deshacer",
  redo: "Rehacer",
  undone: "Deshecho.",
  redone: "Rehecho.",
  nothingToUndo: "No hay nada que deshacer.",
  nothingToRedo: "No hay nada que rehacer.",
  elementsButton: "Elementos",
  pagesButton: "Páginas",
  helpButton: "Ayuda: gestos y atajos",
  inspectorOpen: "Propiedades del elemento seleccionado",

  fitToWidth: "Ajustar al ancho",
  fitToHeight: "Ajustar al alto",
  fitSwitchTo: (mode) => (mode === "width" ? "Ajustar al ancho" : "Ajustar al alto"),
  fitStatus: (mode) => (mode === "width" ? "La hoja se ajusta al ancho." : "La hoja se ajusta al alto: se ve entera."),
  zoomValue: (percent) => `${percent} %`,
  zoomStatus: (percent) => `Zoom ${percent} %`,
  pageBar: "Páginas y zoom",
  pagesToggle: (page, total) => `Páginas: ${page} de ${total}`,
  nextWithFields: "Siguiente página con campos",
  prevWithFields: "Página anterior con campos",
  noPageWithFields: "No hay más páginas con campos en esa dirección.",
  pageStatus: (page, total, fields) =>
    fields === 0
      ? `Página ${page} de ${total}, sin campos.`
      : fields === 1
        ? `Página ${page} de ${total}, 1 elemento.`
        : `Página ${page} de ${total}, ${fields} elementos.`,
  pageSwipeHint: "Arrastra con dos dedos hacia los lados para cambiar de página.",

  dockLabel: "Panel de edición",
  tabElement: "Elemento",
  tabElements: "Elementos",
  tabPages: "Páginas",
  tabHelp: "Ayuda",
  dockClose: "Cerrar el panel",
  dockExpand: "Ampliar el panel",
  dockCollapse: "Reducir el panel",
  dockHandle: "Arrastra para ampliar o reducir el panel",

  inspectorTitle: (name) => `Propiedades: ${name}`,
  signerLabel: "Firmante",
  typeLabel: "Tipo",
  tagSection: "Etiqueta del dato",
  tagNone: "Sin etiqueta",
  requiredLabel: "Obligatorio",
  requiredOn: "Obligatorio: hay que rellenarlo antes de continuar.",
  requiredOff: "Opcional: puede quedar vacío.",
  optionalMark: "opcional",
  sizeSection: "Tamaño",
  widthLabel: "Ancho",
  heightLabel: "Alto",
  fontSizeLabel: "Tamaño de letra",
  fontSizeAuto: "Automático",
  fontSizeAutoHint: "Automático: la letra se ajusta sola al alto del campo.",
  fontSizeUseAuto: "Letra automática",
  stepDown: (label) => `Reducir ${label.toLowerCase()}`,
  stepUp: (label) => `Aumentar ${label.toLowerCase()}`,
  valueOf: (label) => `${label}: valor`,
  alignSection: "Alinear",
  alignLeft: "A la izquierda",
  alignCenter: "Al centro",
  alignRight: "A la derecha",
  matchSize: "Igualar tamaño",
  alignNoNeighbor: "No hay otro elemento en la página para alinear.",
  alignedStatus: (mode, other) =>
    `Alineado ${mode === "left" ? "a la izquierda" : mode === "right" ? "a la derecha" : "al centro"} con ${other}.`,
  matchedStatus: (other) => `Mismo tamaño que ${other}.`,
  actionsSection: "Acciones",
  duplicate: "Duplicar",
  copy: "Copiar",
  paste: "Pegar aquí",
  repeatAll: "Repetir en todas las páginas",
  remove: "Eliminar",
  copiedStatus: "Copiado. Pégalo en esta u otra página.",
  pastedStatus: (page) => `Pegado en la página ${page}.`,
  repeatedStatus: (count) =>
    count === 1 ? "Repetido en 1 página más." : `Repetido en ${count} páginas más.`,
  nothingToRepeat: "Ya está en todas las páginas.",
  removedStatus: "Eliminado. Puedes deshacerlo.",
  sizeStatus: (label, value) => `${label}: ${value}`,

  elementsTitle: "Elementos del documento",
  elementsEmpty: "Aún no hay elementos. Elige una herramienta y toca o dibuja sobre la página.",
  elementsPage: (page, count) => `Página ${page} · ${count}`,
  elementDone: "Hecho",
  elementPending: "Pendiente",
  elementOpen: (name, page) => `Seleccionar ${name}, página ${page}`,
  elementSelectedStatus: (name, page) => `Seleccionado: ${name}, página ${page}.`,

  pagesTitle: "Páginas",
  documentLabel: "Documento",
  pageThumb: (page, count) =>
    count === 0 ? `Ir a la página ${page}` : `Ir a la página ${page}, ${count} ${count === 1 ? "elemento" : "elementos"}`,
  pageCurrent: "página actual",
  pagesEmpty: "El documento tiene una sola página.",

  helpTitle: "Gestos y atajos",
  helpGesturesTitle: "Con el dedo, el lápiz o el ratón",
  helpGestures: [
    "Una herramienta de creación activa (Firma, Iniciales, Texto, Casilla, Fecha): toca la hoja para colocar uno o arrastra para dibujarlo. Se queda activa hasta que elijas otra.",
    "Seleccionar: toca un elemento para ver sus propiedades, arrástralo para moverlo y estira el tirador de la esquina para cambiar su tamaño.",
    "Dos dedos: arrastra para mover la hoja y pellizca para acercar. Con la hoja ajustada, arrastrar dos dedos hacia los lados cambia de página.",
    "Con zoom y «Seleccionar», un dedo sobre un hueco vacío también mueve la hoja.",
    "Trackpad: Ctrl + rueda (o el pellizco) hace zoom; la rueda mueve la hoja.",
  ],
  helpShortcutsTitle: "Teclado",
  helpShortcuts: [
    ["V · F · I · T · C · D", "Seleccionar, Firma, Iniciales, Texto, Casilla, Fecha"],
    ["+ · − · 0", "Acercar, alejar, ajustar"],
    ["Flechas", "Mover el elemento seleccionado (con Mayús, más); sin selección, mover la hoja"],
    ["Re Pág · Av Pág", "Página anterior, página siguiente"],
    ["Ctrl/⌘ Z · Mayús+Ctrl/⌘ Z", "Deshacer, rehacer"],
    ["Ctrl/⌘ C · V · D", "Copiar, pegar, duplicar el elemento seleccionado"],
    ["Supr", "Eliminar el elemento seleccionado"],
    ["Esc", "Cierra lo abierto, suelta la herramienta, quita la selección y, al final, sale"],
    ["?", "Esta ayuda"],
  ],
  helpPrefsTitle: "Preferencias",
  helpFitLabel: "Ajuste de la hoja",
  helpOpenAlways: "Abrir así siempre en este dispositivo táctil",
  helpOpenAlwaysHint: "Al entrar en el paso del documento se abre solo a pantalla completa.",
};

const en: EditModeStrings = {
  entryButton: "Edit fields",
  entryButtonTouch: "Edit fields full screen",
  entryHint:
    "The page stays put and the tools stay at hand. One finger or the pencil draws; two fingers move and zoom.",
  entryOpenAlways: "Always open this way on this device",
  entryOpenAlwaysHint: "It will open full screen by itself when you reach this step. Leave with “Done”.",
  stub: "Editing the fields full screen…",

  frameLabel: "Edit fields full screen",
  title: "Edit fields",
  done: "Done",
  doneLabel: "Done: finish editing fields and go back to the document",
  toolsLabel: "Tools",
  undo: "Undo",
  redo: "Redo",
  undone: "Undone.",
  redone: "Redone.",
  nothingToUndo: "Nothing to undo.",
  nothingToRedo: "Nothing to redo.",
  elementsButton: "Elements",
  pagesButton: "Pages",
  helpButton: "Help: gestures and shortcuts",
  inspectorOpen: "Properties of the selected element",

  fitToWidth: "Fit to width",
  fitToHeight: "Fit to height",
  fitSwitchTo: (mode) => (mode === "width" ? "Fit to width" : "Fit to height"),
  fitStatus: (mode) => (mode === "width" ? "The sheet fits the width." : "The sheet fits the height: you see all of it."),
  zoomValue: (percent) => `${percent}%`,
  zoomStatus: (percent) => `Zoom ${percent}%`,
  pageBar: "Pages and zoom",
  pagesToggle: (page, total) => `Pages: ${page} of ${total}`,
  nextWithFields: "Next page with fields",
  prevWithFields: "Previous page with fields",
  noPageWithFields: "No more pages with fields that way.",
  pageStatus: (page, total, fields) =>
    fields === 0
      ? `Page ${page} of ${total}, no fields.`
      : fields === 1
        ? `Page ${page} of ${total}, 1 element.`
        : `Page ${page} of ${total}, ${fields} elements.`,
  pageSwipeHint: "Drag sideways with two fingers to change page.",

  dockLabel: "Editing panel",
  tabElement: "Element",
  tabElements: "Elements",
  tabPages: "Pages",
  tabHelp: "Help",
  dockClose: "Close the panel",
  dockExpand: "Expand the panel",
  dockCollapse: "Shrink the panel",
  dockHandle: "Drag to expand or shrink the panel",

  inspectorTitle: (name) => `Properties: ${name}`,
  signerLabel: "Signer",
  typeLabel: "Type",
  tagSection: "Data label",
  tagNone: "No label",
  requiredLabel: "Required",
  requiredOn: "Required: it must be filled in before continuing.",
  requiredOff: "Optional: it can stay empty.",
  optionalMark: "optional",
  sizeSection: "Size",
  widthLabel: "Width",
  heightLabel: "Height",
  fontSizeLabel: "Font size",
  fontSizeAuto: "Automatic",
  fontSizeAutoHint: "Automatic: the letters fit the height of the field by themselves.",
  fontSizeUseAuto: "Automatic font size",
  stepDown: (label) => `Decrease ${label.toLowerCase()}`,
  stepUp: (label) => `Increase ${label.toLowerCase()}`,
  valueOf: (label) => `${label}: value`,
  alignSection: "Align",
  alignLeft: "To the left",
  alignCenter: "To the center",
  alignRight: "To the right",
  matchSize: "Match size",
  alignNoNeighbor: "There is no other element on the page to align with.",
  alignedStatus: (mode, other) =>
    `Aligned ${mode === "left" ? "left" : mode === "right" ? "right" : "to the center"} with ${other}.`,
  matchedStatus: (other) => `Same size as ${other}.`,
  actionsSection: "Actions",
  duplicate: "Duplicate",
  copy: "Copy",
  paste: "Paste here",
  repeatAll: "Repeat on every page",
  remove: "Delete",
  copiedStatus: "Copied. Paste it on this or another page.",
  pastedStatus: (page) => `Pasted on page ${page}.`,
  repeatedStatus: (count) => (count === 1 ? "Repeated on 1 more page." : `Repeated on ${count} more pages.`),
  nothingToRepeat: "It is already on every page.",
  removedStatus: "Deleted. You can undo it.",
  sizeStatus: (label, value) => `${label}: ${value}`,

  elementsTitle: "Document elements",
  elementsEmpty: "No elements yet. Pick a tool and tap or draw on the page.",
  elementsPage: (page, count) => `Page ${page} · ${count}`,
  elementDone: "Done",
  elementPending: "Pending",
  elementOpen: (name, page) => `Select ${name}, page ${page}`,
  elementSelectedStatus: (name, page) => `Selected: ${name}, page ${page}.`,

  pagesTitle: "Pages",
  documentLabel: "Document",
  pageThumb: (page, count) =>
    count === 0 ? `Go to page ${page}` : `Go to page ${page}, ${count} ${count === 1 ? "element" : "elements"}`,
  pageCurrent: "current page",
  pagesEmpty: "The document has a single page.",

  helpTitle: "Gestures and shortcuts",
  helpGesturesTitle: "With a finger, the pencil or the mouse",
  helpGestures: [
    "With a creation tool on (Signature, Initials, Text, Checkbox, Date): tap the sheet to place one or drag to draw it. It stays on until you pick another.",
    "Select: tap an element to see its properties, drag it to move it and pull the corner handle to resize it.",
    "Two fingers: drag to move the sheet and pinch to zoom. With the sheet fitted, dragging two fingers sideways changes page.",
    "When zoomed in with “Select”, one finger on an empty spot also moves the sheet.",
    "Trackpad: Ctrl + wheel (or the pinch) zooms; the wheel moves the sheet.",
  ],
  helpShortcutsTitle: "Keyboard",
  helpShortcuts: [
    ["V · F · I · T · C · D", "Select, Signature, Initials, Text, Checkbox, Date"],
    ["+ · − · 0", "Zoom in, zoom out, fit"],
    ["Arrow keys", "Move the selected element (with Shift, more); with nothing selected, move the sheet"],
    ["Page Up · Page Down", "Previous page, next page"],
    ["Ctrl/⌘ Z · Shift+Ctrl/⌘ Z", "Undo, redo"],
    ["Ctrl/⌘ C · V · D", "Copy, paste, duplicate the selected element"],
    ["Delete", "Delete the selected element"],
    ["Esc", "Closes what is open, drops the tool, clears the selection and, last, leaves"],
    ["?", "This help"],
  ],
  helpPrefsTitle: "Preferences",
  helpFitLabel: "Sheet fit",
  helpOpenAlways: "Always open this way on this touch device",
  helpOpenAlwaysHint: "When you reach the document step it opens full screen by itself.",
};

export const EDIT_MODE_STRINGS: Record<Language, EditModeStrings> = { es, en };

export function useEditModeStrings(): EditModeStrings {
  return EDIT_MODE_STRINGS[useOptionalLanguage()];
}
