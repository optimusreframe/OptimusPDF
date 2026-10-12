/*
 * Textos del visor continuo, la paleta de comandos y el shell de la suite (Wave 7 · U3), es/en. Viven aqui y
 * `proStrings.ts` los cuelga de `ProStrings.viewer` / `.palette` / `.shell` (la paridad es/en la comprueba
 * `proStrings.test.ts` recorriendo todas las claves).
 */

export type ViewerStrings = {
  /** Etiqueta del contenedor de paginas (patron «feed»). */
  feedLabel: string;
  /** «Pagina 3 de 500»: etiqueta de cada hoja y anuncio de los saltos. */
  pageOf: (page: number, total: number) => string;
  /** Medidas de la hoja en milimetros. */
  pageSize: (widthMm: number, heightMm: number) => string;
  pageRotated: (degrees: number) => string;
  pageMeasuring: string;
  pageSelected: string;
  pageFailed: string;
  loading: string;
  noPages: string;
  errorTitle: string;
  errorBody: string;
  retry: string;
  /* Barra del visor */
  toolbarLabel: string;
  pageInputLabel: string;
  pageTotal: (total: number) => string;
  zoomGroup: string;
  zoomIn: string;
  zoomOut: string;
  fitWidth: string;
  zoomLevel: (percent: number) => string;
  showThumbs: string;
  hideThumbs: string;
  openThumbs: string;
  showPanel: string;
  hidePanel: string;
  selectedCount: (count: number) => string;
  clearSelection: string;
  /* Miniaturas */
  thumbsListLabel: (count: number) => string;
  thumbLabel: (page: number) => string;
};

export type PaletteStrings = {
  title: string;
  label: string;
  placeholder: string;
  resultsLabel: string;
  empty: string;
  hint: string;
  resultsCount: (count: number) => string;
  groups: Record<"operations" | "tabs" | "view" | "document" | "tools" | "other", string>;
  goToPage: (page: number) => string;
  goToTab: (name: string) => string;
  openTool: (name: string) => string;
  nextPage: string;
  prevPage: string;
  firstPage: string;
  lastPage: string;
  zoomIn: string;
  zoomOut: string;
  fitWidth: string;
  selectAll: string;
  clearSelection: string;
  undo: string;
  redo: string;
  download: string;
  exportDoc: string;
  closeDoc: string;
  toggleThumbs: string;
  togglePanel: string;
  shortcuts: string;
};

export type ShortcutId =
  | "palette"
  | "save"
  | "saveAs"
  | "undo"
  | "redo"
  | "nextRegion"
  | "prevRegion"
  | "pageStep"
  | "firstLast"
  | "scroll"
  | "zoomStep"
  | "fit"
  | "wheelZoom"
  | "toggleSelect"
  | "rangeSelect"
  | "selectAll"
  | "clearSelect"
  | "thumbMove"
  | "thumbGo"
  | "thumbToggle"
  | "thumbExtend"
  | "openEdit"
  | "openAnnotate"
  | "openSign"
  | "openFill";

export type ShortcutGroupId = "document" | "viewer" | "thumbs";

/**
 * Atajos que se listan en la hoja «Atajos de teclado»: las teclas no se traducen salvo `Shift`/`Mayús` y los
 * nombres de Av Pág/Re Pág (por eso `keys` puede llevar las dos lenguas); el texto de la accion si.
 */
export const SHORTCUT_LAYOUT: readonly {
  id: ShortcutGroupId;
  items: readonly { id: ShortcutId; keys: string | { es: string; en: string } }[];
}[] = [
  {
    id: "document",
    items: [
      { id: "palette", keys: "Ctrl/⌘ K" },
      { id: "save", keys: "Ctrl/⌘ S" },
      { id: "saveAs", keys: { es: "Ctrl/⌘ Mayús S", en: "Ctrl/⌘ Shift S" } },
      { id: "undo", keys: "Ctrl/⌘ Z" },
      { id: "redo", keys: { es: "Ctrl/⌘ Mayús Z", en: "Ctrl/⌘ Shift Z" } },
      { id: "nextRegion", keys: "F6" },
      { id: "prevRegion", keys: { es: "Mayús F6", en: "Shift F6" } },
      { id: "openEdit", keys: "E" },
      { id: "openAnnotate", keys: "A" },
      { id: "openSign", keys: "S" },
      { id: "openFill", keys: "F" },
    ],
  },
  {
    id: "viewer",
    items: [
      { id: "pageStep", keys: { es: "Av Pág / Re Pág", en: "Page Down / Page Up" } },
      { id: "firstLast", keys: { es: "Inicio / Fin", en: "Home / End" } },
      { id: "scroll", keys: "↑ ↓ ← →" },
      { id: "zoomStep", keys: "+ / −" },
      { id: "fit", keys: "0" },
      { id: "wheelZoom", keys: { es: "Ctrl/⌘ + rueda", en: "Ctrl/⌘ + wheel" } },
      { id: "toggleSelect", keys: { es: "Ctrl/⌘ clic", en: "Ctrl/⌘ click" } },
      { id: "rangeSelect", keys: { es: "Mayús clic", en: "Shift click" } },
      { id: "selectAll", keys: "Ctrl/⌘ A" },
      { id: "clearSelect", keys: "Esc" },
    ],
  },
  {
    id: "thumbs",
    items: [
      { id: "thumbMove", keys: "↑ ↓" },
      { id: "thumbGo", keys: { es: "Intro", en: "Enter" } },
      { id: "thumbToggle", keys: { es: "Espacio", en: "Space" } },
      { id: "thumbExtend", keys: { es: "Mayús ↑ ↓", en: "Shift ↑ ↓" } },
    ],
  },
];

export type ShellStrings = {
  skipLabel: string;
  skipViewer: string;
  skipThumbs: string;
  skipPanel: string;
  more: string;
  paletteItem: string;
  exportItem: string;
  shortcutsItem: string;
  thumbsItem: string;
  panelItem: string;
  resetLayout: string;
  closeItem: string;
  shortcutsTitle: string;
  shortcutGroups: Record<ShortcutGroupId, string>;
  shortcutActions: Record<ShortcutId, string>;
  dockLabel: string;
  resizeThumbs: string;
  resizeContext: string;
  thumbsSheetTitle: string;
  panelSheetTitle: string;
  panelHiddenHint: string;
};

export const VIEWER_STRINGS_ES: ViewerStrings = {
  feedLabel: "Páginas del documento",
  pageOf: (page, total) => `Página ${page} de ${total}`,
  pageSize: (widthMm, heightMm) => `${widthMm} × ${heightMm} mm`,
  pageRotated: (degrees) => `girada ${degrees}°`,
  pageMeasuring: "Midiendo la página",
  pageSelected: "Seleccionada",
  pageFailed: "No se pudo dibujar esta página",
  loading: "Preparando el documento…",
  noPages: "Este documento no tiene páginas.",
  errorTitle: "No se pudo mostrar el documento",
  errorBody: "El archivo se abrió, pero no pudimos dibujarlo. Puedes volver a intentarlo.",
  retry: "Reintentar",
  toolbarLabel: "Controles del visor",
  pageInputLabel: "Ir a la página",
  pageTotal: (total) => `de ${total}`,
  zoomGroup: "Nivel de zoom",
  zoomIn: "Acercar",
  zoomOut: "Alejar",
  fitWidth: "Ajustar al ancho",
  zoomLevel: (percent) => `Zoom ${percent} %`,
  showThumbs: "Mostrar miniaturas",
  hideThumbs: "Ocultar miniaturas",
  openThumbs: "Abrir miniaturas",
  showPanel: "Mostrar el panel de herramienta",
  hidePanel: "Ocultar el panel de herramienta",
  selectedCount: (count) => (count === 1 ? "1 página seleccionada" : `${count} páginas seleccionadas`),
  clearSelection: "Quitar la selección",
  thumbsListLabel: (count) => `Miniaturas de las ${count} páginas`,
  thumbLabel: (page) => `Página ${page}`,
};

export const VIEWER_STRINGS_EN: ViewerStrings = {
  feedLabel: "Document pages",
  pageOf: (page, total) => `Page ${page} of ${total}`,
  pageSize: (widthMm, heightMm) => `${widthMm} × ${heightMm} mm`,
  pageRotated: (degrees) => `rotated ${degrees}°`,
  pageMeasuring: "Measuring the page",
  pageSelected: "Selected",
  pageFailed: "This page could not be drawn",
  loading: "Preparing the document…",
  noPages: "This document has no pages.",
  errorTitle: "The document could not be shown",
  errorBody: "The file opened, but we couldn't draw it. You can try again.",
  retry: "Try again",
  toolbarLabel: "Viewer controls",
  pageInputLabel: "Go to page",
  pageTotal: (total) => `of ${total}`,
  zoomGroup: "Zoom level",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fitWidth: "Fit to width",
  zoomLevel: (percent) => `Zoom ${percent}%`,
  showThumbs: "Show thumbnails",
  hideThumbs: "Hide thumbnails",
  openThumbs: "Open thumbnails",
  showPanel: "Show the tool panel",
  hidePanel: "Hide the tool panel",
  selectedCount: (count) => (count === 1 ? "1 page selected" : `${count} pages selected`),
  clearSelection: "Clear the selection",
  thumbsListLabel: (count) => `Thumbnails of the ${count} pages`,
  thumbLabel: (page) => `Page ${page}`,
};

export const PALETTE_STRINGS_ES: PaletteStrings = {
  title: "Paleta de comandos",
  label: "Buscar un comando",
  placeholder: "Busca una acción, una página o una herramienta…",
  resultsLabel: "Comandos",
  empty: "Ningún comando coincide.",
  hint: "↑ ↓ para moverte · Intro para ejecutar · Esc para cerrar",
  resultsCount: (count) => (count === 1 ? "1 resultado" : `${count} resultados`),
  groups: {
    operations: "Operación",
    tabs: "Pestaña",
    view: "Vista",
    document: "Documento",
    tools: "Herramienta",
    other: "Otro",
  },
  goToPage: (page) => `Ir a la página ${page}`,
  goToTab: (name) => `Ir a la pestaña ${name}`,
  openTool: (name) => `Abrir herramienta suelta: ${name}`,
  nextPage: "Página siguiente",
  prevPage: "Página anterior",
  firstPage: "Primera página",
  lastPage: "Última página",
  zoomIn: "Acercar",
  zoomOut: "Alejar",
  fitWidth: "Ajustar al ancho",
  selectAll: "Seleccionar todas las páginas",
  clearSelection: "Quitar la selección de páginas",
  undo: "Deshacer",
  redo: "Rehacer",
  download: "Descargar PDF",
  exportDoc: "Exportar como…",
  closeDoc: "Cerrar el documento",
  toggleThumbs: "Mostrar u ocultar las miniaturas",
  togglePanel: "Mostrar u ocultar el panel de herramienta",
  shortcuts: "Ver los atajos de teclado",
};

export const PALETTE_STRINGS_EN: PaletteStrings = {
  title: "Command palette",
  label: "Search for a command",
  placeholder: "Search for an action, a page or a tool…",
  resultsLabel: "Commands",
  empty: "No command matches.",
  hint: "↑ ↓ to move · Enter to run · Esc to close",
  resultsCount: (count) => (count === 1 ? "1 result" : `${count} results`),
  groups: {
    operations: "Operation",
    tabs: "Tab",
    view: "View",
    document: "Document",
    tools: "Tool",
    other: "Other",
  },
  goToPage: (page) => `Go to page ${page}`,
  goToTab: (name) => `Go to the ${name} tab`,
  openTool: (name) => `Open standalone tool: ${name}`,
  nextPage: "Next page",
  prevPage: "Previous page",
  firstPage: "First page",
  lastPage: "Last page",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fitWidth: "Fit to width",
  selectAll: "Select all pages",
  clearSelection: "Clear the page selection",
  undo: "Undo",
  redo: "Redo",
  download: "Download PDF",
  exportDoc: "Export as…",
  closeDoc: "Close the document",
  toggleThumbs: "Show or hide the thumbnails",
  togglePanel: "Show or hide the tool panel",
  shortcuts: "View the keyboard shortcuts",
};

export const SHELL_STRINGS_ES: ShellStrings = {
  skipLabel: "Atajos de navegación de PDF Pro",
  skipViewer: "Ir al documento",
  skipThumbs: "Ir a las miniaturas",
  skipPanel: "Ir al panel de herramienta",
  more: "Más acciones",
  paletteItem: "Paleta de comandos",
  exportItem: "Exportar como…",
  shortcutsItem: "Atajos de teclado",
  thumbsItem: "Miniaturas",
  panelItem: "Panel de herramienta",
  resetLayout: "Restablecer la distribución",
  closeItem: "Cerrar documento",
  shortcutsTitle: "Atajos de teclado",
  shortcutGroups: { document: "Documento", viewer: "Visor", thumbs: "Miniaturas" },
  shortcutActions: {
    palette: "Abrir la paleta de comandos",
    save: "Descargar el PDF",
    saveAs: "Abrir el menú Guardar como",
    undo: "Deshacer",
    redo: "Rehacer",
    nextRegion: "Pasar a la siguiente zona de la pantalla",
    prevRegion: "Volver a la zona anterior",
    openEdit: "Abrir el modo Editar",
    openAnnotate: "Abrir el modo Anotar",
    openSign: "Abrir el modo Firmar",
    openFill: "Abrir Rellenar formulario",
    pageStep: "Página siguiente o anterior",
    firstLast: "Primera o última página",
    scroll: "Desplazarse por el documento",
    zoomStep: "Acercar o alejar",
    fit: "Ajustar al ancho",
    wheelZoom: "Acercar o alejar bajo el cursor",
    toggleSelect: "Añadir o quitar una página de la selección",
    rangeSelect: "Seleccionar un rango de páginas",
    selectAll: "Seleccionar todas las páginas",
    clearSelect: "Quitar la selección",
    thumbMove: "Moverte entre miniaturas",
    thumbGo: "Ir a esa página",
    thumbToggle: "Añadir o quitar de la selección",
    thumbExtend: "Ampliar la selección",
  },
  dockLabel: "Herramientas",
  resizeThumbs: "Cambiar el ancho de las miniaturas",
  resizeContext: "Cambiar el ancho del panel de herramienta",
  thumbsSheetTitle: "Páginas",
  panelSheetTitle: "Herramienta",
  panelHiddenHint: "El panel se plegó por falta de espacio. Ábrelo con el botón del visor.",
};

export const SHELL_STRINGS_EN: ShellStrings = {
  skipLabel: "PDF Pro navigation shortcuts",
  skipViewer: "Go to the document",
  skipThumbs: "Go to the thumbnails",
  skipPanel: "Go to the tool panel",
  more: "More actions",
  paletteItem: "Command palette",
  exportItem: "Export as…",
  shortcutsItem: "Keyboard shortcuts",
  thumbsItem: "Thumbnails",
  panelItem: "Tool panel",
  resetLayout: "Reset the layout",
  closeItem: "Close document",
  shortcutsTitle: "Keyboard shortcuts",
  shortcutGroups: { document: "Document", viewer: "Viewer", thumbs: "Thumbnails" },
  shortcutActions: {
    palette: "Open the command palette",
    save: "Download the PDF",
    saveAs: "Open the Save as menu",
    undo: "Undo",
    redo: "Redo",
    nextRegion: "Move to the next area of the screen",
    prevRegion: "Go back to the previous area",
    openEdit: "Open Edit mode",
    openAnnotate: "Open Annotate mode",
    openSign: "Open Sign mode",
    openFill: "Open Fill in form",
    pageStep: "Next or previous page",
    firstLast: "First or last page",
    scroll: "Scroll the document",
    zoomStep: "Zoom in or out",
    fit: "Fit to width",
    wheelZoom: "Zoom in or out under the cursor",
    toggleSelect: "Add or remove a page from the selection",
    rangeSelect: "Select a range of pages",
    selectAll: "Select all pages",
    clearSelect: "Clear the selection",
    thumbMove: "Move between thumbnails",
    thumbGo: "Go to that page",
    thumbToggle: "Add or remove from the selection",
    thumbExtend: "Extend the selection",
  },
  dockLabel: "Tools",
  resizeThumbs: "Resize the thumbnails panel",
  resizeContext: "Resize the tool panel",
  thumbsSheetTitle: "Pages",
  panelSheetTitle: "Tool",
  panelHiddenHint: "The panel was folded away for lack of space. Open it with the viewer button.",
};
