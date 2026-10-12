import type { Language } from "@/lib/i18n";
import type { PageAssemblyWarning } from "@/lib/pdf/pageAssembly";
import type { PlanSummary } from "@/lib/pdf/pageAssemblyPlan";

/**
 * Textos del organizador de paginas de PDF Pro (Wave 7 · U4), es/en. Se cuelgan de
 * `PRO_STRINGS[lang].pages` (ver `proStrings.ts`).
 */
export type PagesStrings = {
  panelTitle: string;
  intro: string;
  /** Etiqueta del listbox de paginas. */
  gridLabel: (total: number) => string;
  /** `aria-label` de una tarjeta: «Página 3 de 12 (original 5), girada 90°». */
  cardLabel: (number: number, total: number, detail: string, rotation: number) => string;
  card: {
    original: (n: number) => string;
    copyOf: (n: number) => string;
    blank: string;
    image: (name: string) => string;
    external: (name: string, n: number) => string;
    pageNumber: (n: number) => string;
    loading: string;
    dragHandle: string;
  };
  status: {
    changes: (n: number) => string;
    noChanges: string;
    selected: (n: number, total: number) => string;
    none: string;
    undo: string;
    redo: string;
    apply: string;
    discard: string;
    applying: string;
    cancel: string;
    discardTitle: string;
    discardBody: string;
    discardConfirm: string;
    keep: string;
    cannotApplyReading: string;
    noChangesToApply: string;
    warningsTitle: string;
    dismissWarnings: string;
    errorTitle: string;
    resultPages: (n: number) => string;
  };
  actions: {
    select: string;
    selectAll: string;
    selectNone: string;
    selectEven: string;
    selectOdd: string;
    selectRange: string;
    rotateLeft: string;
    rotateRight: string;
    remove: string;
    duplicate: string;
    moveBefore: string;
    moveAfter: string;
    insertBlank: string;
    insertFromPdf: string;
    insertImages: string;
    mergePdfs: string;
    extract: string;
    split: string;
    more: string;
    moreTitle: string;
    groupSelection: string;
    groupPages: string;
    groupInsert: string;
    groupExport: string;
    cannotRemoveAll: string;
  };
  announce: {
    selected: (n: number) => string;
    selectionCleared: string;
    moved: (n: number, position: number) => string;
    rotated: (n: number, degrees: number) => string;
    removed: (n: number) => string;
    duplicated: (n: number) => string;
    inserted: (n: number, position: number) => string;
    undone: (label: string) => string;
    redone: (label: string) => string;
    nothingToUndo: string;
    nothingToRedo: string;
    discarded: string;
    documentChanged: string;
    dragStart: (n: number) => string;
    dragCancel: string;
    cannotRemoveAll: string;
    focusPosition: (n: number, total: number) => string;
    reading: (name: string) => string;
    ready: (name: string, pages: number) => string;
    failed: (name: string) => string;
    limitReached: string;
    /** Aviso VISIBLE de los PDF que no cupieron (maximo de documentos añadidos). */
    omittedTitle: (count: number, max: number) => string;
    omittedBody: (names: string[], hidden: number) => string;
    omittedDismiss: string;
    exported: (name: string) => string;
    couldNotApply: string;
  };
  /** Descripcion del paso (snapshot y deshacer). */
  label: {
    move: (n: number) => string;
    rotate: (n: number) => string;
    remove: (n: number) => string;
    duplicate: (n: number) => string;
    blank: (n: number) => string;
    fromPdf: (n: number) => string;
    images: (n: number) => string;
    merge: (n: number) => string;
    /** Etiqueta del snapshot cuando el plan no encaja en las anteriores. */
    generic: string;
    /** Une los trozos («Reordenar 3 páginas, eliminar 2»): el primero ya viene en mayuscula. */
    join: (parts: string[]) => string;
  };
  sheets: {
    close: string;
    selectRangeTitle: string;
    selectRangeLabel: string;
    selectRangeHint: string;
    selectRangeInvalid: string;
    selectRangeSubmit: string;
    position: string;
    positionStart: string;
    positionBefore: string;
    positionAfter: string;
    positionEnd: string;
    blankTitle: string;
    blankSize: string;
    blankSizeNeighbour: string;
    blankSizeA4: string;
    blankSizeLetter: string;
    blankCount: string;
    blankSubmit: string;
    pdfTitle: string;
    pdfPick: string;
    pdfChoose: string;
    pdfReading: string;
    pdfPages: (n: number) => string;
    pdfSelectAll: string;
    pdfSelectNone: string;
    pdfPagesChosen: (n: number, total: number) => string;
    pdfSubmit: (n: number) => string;
    pdfNoneChosen: string;
    imagesTitle: string;
    imagesChoose: string;
    imagesSize: string;
    imagesSizeA4: string;
    imagesSizeLetter: string;
    imagesSizeFit: string;
    imagesSubmit: (n: number) => string;
    mergeTitle: string;
    mergeChoose: string;
    mergeHint: string;
    mergeSubmit: (n: number, pages: number) => string;
    removeFile: (name: string) => string;
    fileReading: string;
    fileReady: (pages: number) => string;
    fileError: string;
    filePassword: string;
    extractTitle: string;
    extractBody: (n: number) => string;
    extractDownload: string;
    extractOpen: string;
    extractOpenConfirmTitle: string;
    extractOpenConfirmBody: string;
    extractOpenConfirm: string;
    extractName: string;
    splitTitle: string;
    splitModeRanges: string;
    splitModeEvery: string;
    splitModeBookmarks: string;
    splitModeLabel: string;
    splitRangesLabel: string;
    splitRangesHint: string;
    splitEveryLabel: string;
    splitBookmarksHint: string;
    splitNoBookmarks: string;
    splitPreview: (parts: number) => string;
    splitInvalid: string;
    splitSubmit: string;
    splitPending: string;
    splitAppliedFirst: string;
    splitDone: (parts: number) => string;
    working: string;
    password: string;
  };
  warnings: Record<PageAssemblyWarning["code"], string>;
  errors: {
    tooManyDocuments: string;
    notPdf: string;
    notImage: string;
  };
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? `1 ${one}` : `${n} ${many}`);

const es: PagesStrings = {
  panelTitle: "Organizar páginas",
  intro:
    "Reordena, gira, elimina, duplica o inserta páginas. Los cambios se ven al instante y solo se guardan cuando pulsas «Aplicar».",
  gridLabel: (total) => `Páginas del documento, ${plural(total, "página", "páginas")}`,
  cardLabel: (number, total, detail, rotation) =>
    `Página ${number} de ${total}${detail ? ` (${detail})` : ""}${rotation ? `, girada ${rotation}°` : ""}`,
  card: {
    original: (n) => `original ${n}`,
    copyOf: (n) => `copia de ${n}`,
    blank: "en blanco",
    image: (name) => `imagen ${name}`,
    external: (name, n) => `${name}, página ${n}`,
    pageNumber: (n) => String(n),
    loading: "Cargando miniatura",
    dragHandle: "Arrastrar para reordenar",
  },
  status: {
    changes: (n) => (n === 1 ? "1 cambio sin aplicar" : `${n} cambios sin aplicar`),
    noChanges: "Sin cambios pendientes",
    selected: (n, total) => `${n} de ${total} seleccionadas`,
    none: "Ninguna página seleccionada",
    undo: "Deshacer",
    redo: "Rehacer",
    apply: "Aplicar cambios",
    discard: "Descartar cambios",
    applying: "Aplicando…",
    cancel: "Cancelar",
    discardTitle: "¿Descartar los cambios?",
    discardBody: "Se perderán los cambios de páginas que todavía no has aplicado.",
    discardConfirm: "Descartar",
    keep: "Seguir editando",
    cannotApplyReading: "Espera a que terminen de leerse los documentos añadidos.",
    noChangesToApply: "Haz algún cambio para poder aplicarlo.",
    warningsTitle: "Avisos de la última operación",
    dismissWarnings: "Cerrar avisos",
    errorTitle: "No se pudieron aplicar los cambios",
    resultPages: (n) => `Resultado: ${plural(n, "página", "páginas")}`,
  },
  actions: {
    select: "Seleccionar",
    selectAll: "Todas",
    selectNone: "Ninguna",
    selectEven: "Pares",
    selectOdd: "Impares",
    selectRange: "Rango…",
    rotateLeft: "Girar a la izquierda",
    rotateRight: "Girar a la derecha",
    remove: "Eliminar",
    duplicate: "Duplicar",
    moveBefore: "Mover antes",
    moveAfter: "Mover después",
    insertBlank: "Página en blanco…",
    insertFromPdf: "Insertar desde PDF…",
    insertImages: "Insertar imágenes…",
    mergePdfs: "Unir PDFs…",
    extract: "Extraer páginas…",
    split: "Dividir…",
    more: "Más",
    moreTitle: "Acciones de páginas",
    groupSelection: "Selección",
    groupPages: "Páginas seleccionadas",
    groupInsert: "Insertar y unir",
    groupExport: "Sacar páginas",
    cannotRemoveAll: "Un PDF necesita al menos una página: no se pueden eliminar todas.",
  },
  announce: {
    selected: (n) => (n === 1 ? "1 página seleccionada" : `${n} páginas seleccionadas`),
    selectionCleared: "Selección borrada",
    moved: (n, position) => `${plural(n, "página movida", "páginas movidas")}; ahora desde la posición ${position}`,
    rotated: (n, degrees) =>
      `${plural(n, "página girada", "páginas giradas")} ${Math.abs(degrees)}° a la ${degrees < 0 ? "izquierda" : "derecha"}`,
    removed: (n) => `${plural(n, "página eliminada", "páginas eliminadas")}`,
    duplicated: (n) => `${plural(n, "página duplicada", "páginas duplicadas")}`,
    inserted: (n, position) => `${plural(n, "página insertada", "páginas insertadas")} desde la posición ${position}`,
    undone: (label) => `Deshecho en páginas: ${label}`,
    redone: (label) => `Rehecho en páginas: ${label}`,
    nothingToUndo: "No hay cambios de páginas que deshacer",
    nothingToRedo: "No hay cambios de páginas que rehacer",
    discarded: "Cambios de páginas descartados",
    documentChanged: "El documento cambió: se descartaron los cambios de páginas sin aplicar.",
    dragStart: (n) => `Arrastrando ${plural(n, "página", "páginas")}. Suelta para colocarlas; Escape cancela.`,
    dragCancel: "Arrastre cancelado",
    cannotRemoveAll: "Un PDF necesita al menos una página: no se pueden eliminar todas.",
    focusPosition: (n, total) => `Página ${n} de ${total}`,
    reading: (name) => `Leyendo ${name}…`,
    ready: (name, pages) => `${name} listo: ${plural(pages, "página", "páginas")}`,
    failed: (name) => `No se pudo usar ${name}`,
    limitReached: "Se alcanzó el máximo de 10 documentos PDF añadidos. Aplica o descarta los cambios para seguir.",
    omittedTitle: (count, max) =>
      count === 1 ? `Se omitió 1 PDF: el máximo es ${max} documentos añadidos` : `Se omitieron ${count} PDF: el máximo es ${max} documentos añadidos`,
    omittedBody: (names, hidden) =>
      `No se añadió: ${names.join(", ")}${hidden > 0 ? ` y ${hidden} más` : ""}. Aplica o descarta los cambios y vuelve a añadirlos.`,
    omittedDismiss: "Entendido",
    exported: (name) => `Descargado: ${name}`,
    couldNotApply: "No se pudieron aplicar los cambios de páginas.",
  },
  label: {
    move: (n) => `reordenar ${plural(n, "página", "páginas")}`,
    rotate: (n) => `girar ${plural(n, "página", "páginas")}`,
    remove: (n) => `eliminar ${plural(n, "página", "páginas")}`,
    duplicate: (n) => `duplicar ${plural(n, "página", "páginas")}`,
    blank: (n) => `insertar ${plural(n, "página en blanco", "páginas en blanco")}`,
    fromPdf: (n) => `insertar ${plural(n, "página de otro PDF", "páginas de otros PDF")}`,
    images: (n) => `insertar ${plural(n, "imagen", "imágenes")}`,
    merge: (n) => `unir ${plural(n, "documento", "documentos")}`,
    generic: "Cambios en las páginas",
    join: (parts) => {
      const text = parts.join(", ");
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
  },
  sheets: {
    close: "Cerrar",
    selectRangeTitle: "Seleccionar un rango",
    selectRangeLabel: "Páginas",
    selectRangeHint: "Por ejemplo: 1-3, 7, 10-12 (posiciones tal como se ven ahora).",
    selectRangeInvalid: "Escribe páginas entre 1 y {total}, como 1-3, 7.",
    selectRangeSubmit: "Seleccionar",
    position: "Dónde colocarlas",
    positionStart: "Al principio",
    positionBefore: "Antes de la selección",
    positionAfter: "Después de la selección",
    positionEnd: "Al final",
    blankTitle: "Insertar página en blanco",
    blankSize: "Tamaño",
    blankSizeNeighbour: "Igual que la página vecina",
    blankSizeA4: "A4 (210 × 297 mm)",
    blankSizeLetter: "Carta (216 × 279 mm)",
    blankCount: "Cuántas",
    blankSubmit: "Insertar",
    pdfTitle: "Insertar páginas de otro PDF",
    pdfPick: "Elige el PDF del que quieres tomar páginas.",
    pdfChoose: "Elegir PDF…",
    pdfReading: "Leyendo el PDF…",
    pdfPages: (n) => plural(n, "página", "páginas"),
    pdfSelectAll: "Todas",
    pdfSelectNone: "Ninguna",
    pdfPagesChosen: (n, total) => `${n} de ${total} elegidas`,
    pdfSubmit: (n) => `Insertar ${plural(n, "página", "páginas")}`,
    pdfNoneChosen: "Elige al menos una página.",
    imagesTitle: "Insertar imágenes como páginas",
    imagesChoose: "Elegir imágenes…",
    imagesSize: "Tamaño de página",
    imagesSizeA4: "A4 (210 × 297 mm)",
    imagesSizeLetter: "Carta (216 × 279 mm)",
    imagesSizeFit: "Ajustado a la imagen",
    imagesSubmit: (n) => `Insertar ${plural(n, "imagen", "imágenes")}`,
    mergeTitle: "Unir PDFs",
    mergeChoose: "Elegir PDFs…",
    mergeHint: "Se añaden todas las páginas de cada documento, en este orden.",
    mergeSubmit: (n, pages) => `Añadir ${plural(n, "documento", "documentos")} (${plural(pages, "página", "páginas")})`,
    removeFile: (name) => `Quitar ${name}`,
    fileReading: "Leyendo…",
    fileReady: (pages) => plural(pages, "página", "páginas"),
    fileError: "No se pudo usar este archivo",
    filePassword: "Cifrado: introduce la contraseña",
    extractTitle: "Extraer páginas",
    extractBody: (n) => `Se creará un PDF nuevo con ${plural(n, "página seleccionada", "páginas seleccionadas")}. El documento actual no cambia.`,
    extractDownload: "Descargar PDF",
    extractOpen: "Abrir como documento nuevo",
    extractOpenConfirmTitle: "¿Reemplazar el documento actual?",
    extractOpenConfirmBody:
      "El documento nuevo sustituye al que tienes abierto y su historial. Descarga antes lo que quieras conservar.",
    extractOpenConfirm: "Reemplazar",
    extractName: "Nombre del archivo",
    splitTitle: "Dividir el documento",
    splitModeRanges: "Rangos",
    splitModeEvery: "Cada N páginas",
    splitModeBookmarks: "Marcadores",
    splitModeLabel: "Cómo dividir",
    splitRangesLabel: "Rangos",
    splitRangesHint: "Cada elemento es un archivo: 1-3, 5, 7-9 crea tres archivos.",
    splitEveryLabel: "Páginas por archivo",
    splitBookmarksHint: "Un archivo por cada marcador de primer nivel; las primeras páginas sin marcador forman un archivo propio.",
    splitNoBookmarks: "Este documento no tiene marcadores: saldría un solo archivo.",
    splitPreview: (parts) => (parts === 1 ? "Se creará 1 archivo" : `Se crearán ${parts} archivos (ZIP)`),
    splitInvalid: "Revisa los rangos: usa números entre 1 y {total}.",
    splitSubmit: "Dividir y descargar",
    splitPending: "Hay cambios sin aplicar: se dividirá el documento tal como lo ves ahora.",
    splitAppliedFirst: "Se dividirá con los cambios sin aplicar incluidos.",
    splitDone: (parts) => (parts === 1 ? "Descargado 1 archivo" : `Descargados ${parts} archivos en un ZIP`),
    working: "Trabajando…",
    password: "Contraseña",
  },
  warnings: {
    outlinesRemoved: "Se quitaron {n} marcadores que apuntaban a páginas eliminadas.",
    linksRemoved: "Se quitaron {n} enlaces internos que ya no llevan a ninguna página.",
    namedDestinationsRemoved: "Se quitaron {n} destinos con nombre de páginas eliminadas.",
    pageLabelsRemoved: "La numeración de páginas del documento (i, ii, 1…) se quitó porque ya no coincide con el orden.",
    structureRemoved: "Se quitó la estructura de accesibilidad (PDF etiquetado) al eliminar páginas.",
    formFieldsRemoved: "Se quitaron {n} campos de formulario de las páginas eliminadas.",
    fieldsRenamed: "{n} campos de formulario cambiaron de nombre porque ese nombre ya existía.",
    signatureFieldsRemoved: "{n} campos de firma no se copian a otro documento.",
    largeInsert: "Se añadieron {n} páginas de golpe; puede tardar.",
  },
  errors: {
    tooManyDocuments: "Se alcanzó el máximo de 10 documentos PDF añadidos.",
    notPdf: "Este archivo no es un PDF.",
    notImage: "Este archivo no es una imagen.",
  },
};

const en: PagesStrings = {
  panelTitle: "Organize pages",
  intro:
    "Reorder, rotate, delete, duplicate or insert pages. Changes show instantly and are only saved when you press “Apply”.",
  gridLabel: (total) => `Document pages, ${plural(total, "page", "pages")}`,
  cardLabel: (number, total, detail, rotation) =>
    `Page ${number} of ${total}${detail ? ` (${detail})` : ""}${rotation ? `, rotated ${rotation}°` : ""}`,
  card: {
    original: (n) => `original ${n}`,
    copyOf: (n) => `copy of ${n}`,
    blank: "blank",
    image: (name) => `image ${name}`,
    external: (name, n) => `${name}, page ${n}`,
    pageNumber: (n) => String(n),
    loading: "Loading thumbnail",
    dragHandle: "Drag to reorder",
  },
  status: {
    changes: (n) => (n === 1 ? "1 unapplied change" : `${n} unapplied changes`),
    noChanges: "No pending changes",
    selected: (n, total) => `${n} of ${total} selected`,
    none: "No page selected",
    undo: "Undo",
    redo: "Redo",
    apply: "Apply changes",
    discard: "Discard changes",
    applying: "Applying…",
    cancel: "Cancel",
    discardTitle: "Discard the changes?",
    discardBody: "You will lose the page changes you haven't applied yet.",
    discardConfirm: "Discard",
    keep: "Keep editing",
    cannotApplyReading: "Wait until the added documents have been read.",
    noChangesToApply: "Make a change to be able to apply it.",
    warningsTitle: "Notices from the last operation",
    dismissWarnings: "Dismiss notices",
    errorTitle: "The changes couldn't be applied",
    resultPages: (n) => `Result: ${plural(n, "page", "pages")}`,
  },
  actions: {
    select: "Select",
    selectAll: "All",
    selectNone: "None",
    selectEven: "Even",
    selectOdd: "Odd",
    selectRange: "Range…",
    rotateLeft: "Rotate left",
    rotateRight: "Rotate right",
    remove: "Delete",
    duplicate: "Duplicate",
    moveBefore: "Move before",
    moveAfter: "Move after",
    insertBlank: "Blank page…",
    insertFromPdf: "Insert from PDF…",
    insertImages: "Insert images…",
    mergePdfs: "Merge PDFs…",
    extract: "Extract pages…",
    split: "Split…",
    more: "More",
    moreTitle: "Page actions",
    groupSelection: "Selection",
    groupPages: "Selected pages",
    groupInsert: "Insert and merge",
    groupExport: "Take pages out",
    cannotRemoveAll: "A PDF needs at least one page: you can't delete them all.",
  },
  announce: {
    selected: (n) => (n === 1 ? "1 page selected" : `${n} pages selected`),
    selectionCleared: "Selection cleared",
    moved: (n, position) => `${plural(n, "page moved", "pages moved")}; now starting at position ${position}`,
    rotated: (n, degrees) =>
      `${plural(n, "page rotated", "pages rotated")} ${Math.abs(degrees)}° ${degrees < 0 ? "left" : "right"}`,
    removed: (n) => plural(n, "page deleted", "pages deleted"),
    duplicated: (n) => plural(n, "page duplicated", "pages duplicated"),
    inserted: (n, position) => `${plural(n, "page inserted", "pages inserted")} from position ${position}`,
    undone: (label) => `Undone in pages: ${label}`,
    redone: (label) => `Redone in pages: ${label}`,
    nothingToUndo: "No page changes to undo",
    nothingToRedo: "No page changes to redo",
    discarded: "Page changes discarded",
    documentChanged: "The document changed: unapplied page changes were discarded.",
    dragStart: (n) => `Dragging ${plural(n, "page", "pages")}. Release to place them; Escape cancels.`,
    dragCancel: "Drag cancelled",
    cannotRemoveAll: "A PDF needs at least one page: you can't delete them all.",
    focusPosition: (n, total) => `Page ${n} of ${total}`,
    reading: (name) => `Reading ${name}…`,
    ready: (name, pages) => `${name} ready: ${plural(pages, "page", "pages")}`,
    failed: (name) => `Couldn't use ${name}`,
    limitReached: "The maximum of 10 added PDF documents was reached. Apply or discard the changes to continue.",
    omittedTitle: (count, max) =>
      count === 1 ? `1 PDF was left out: the maximum is ${max} added documents` : `${count} PDFs were left out: the maximum is ${max} added documents`,
    omittedBody: (names, hidden) =>
      `Not added: ${names.join(", ")}${hidden > 0 ? ` and ${hidden} more` : ""}. Apply or discard the changes and add them again.`,
    omittedDismiss: "Got it",
    exported: (name) => `Downloaded: ${name}`,
    couldNotApply: "The page changes couldn't be applied.",
  },
  label: {
    move: (n) => `reorder ${plural(n, "page", "pages")}`,
    rotate: (n) => `rotate ${plural(n, "page", "pages")}`,
    remove: (n) => `delete ${plural(n, "page", "pages")}`,
    duplicate: (n) => `duplicate ${plural(n, "page", "pages")}`,
    blank: (n) => `insert ${plural(n, "blank page", "blank pages")}`,
    fromPdf: (n) => `insert ${plural(n, "page from another PDF", "pages from other PDFs")}`,
    images: (n) => `insert ${plural(n, "image", "images")}`,
    merge: (n) => `merge ${plural(n, "document", "documents")}`,
    generic: "Page changes",
    join: (parts) => {
      const text = parts.join(", ");
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
  },
  sheets: {
    close: "Close",
    selectRangeTitle: "Select a range",
    selectRangeLabel: "Pages",
    selectRangeHint: "For example: 1-3, 7, 10-12 (positions as they look now).",
    selectRangeInvalid: "Type pages between 1 and {total}, like 1-3, 7.",
    selectRangeSubmit: "Select",
    position: "Where to place them",
    positionStart: "At the start",
    positionBefore: "Before the selection",
    positionAfter: "After the selection",
    positionEnd: "At the end",
    blankTitle: "Insert a blank page",
    blankSize: "Size",
    blankSizeNeighbour: "Same as the neighbouring page",
    blankSizeA4: "A4 (8.3 × 11.7 in)",
    blankSizeLetter: "Letter (8.5 × 11 in)",
    blankCount: "How many",
    blankSubmit: "Insert",
    pdfTitle: "Insert pages from another PDF",
    pdfPick: "Choose the PDF you want to take pages from.",
    pdfChoose: "Choose PDF…",
    pdfReading: "Reading the PDF…",
    pdfPages: (n) => plural(n, "page", "pages"),
    pdfSelectAll: "All",
    pdfSelectNone: "None",
    pdfPagesChosen: (n, total) => `${n} of ${total} chosen`,
    pdfSubmit: (n) => `Insert ${plural(n, "page", "pages")}`,
    pdfNoneChosen: "Choose at least one page.",
    imagesTitle: "Insert images as pages",
    imagesChoose: "Choose images…",
    imagesSize: "Page size",
    imagesSizeA4: "A4 (8.3 × 11.7 in)",
    imagesSizeLetter: "Letter (8.5 × 11 in)",
    imagesSizeFit: "Fit to the image",
    imagesSubmit: (n) => `Insert ${plural(n, "image", "images")}`,
    mergeTitle: "Merge PDFs",
    mergeChoose: "Choose PDFs…",
    mergeHint: "All the pages of each document are added, in this order.",
    mergeSubmit: (n, pages) => `Add ${plural(n, "document", "documents")} (${plural(pages, "page", "pages")})`,
    removeFile: (name) => `Remove ${name}`,
    fileReading: "Reading…",
    fileReady: (pages) => plural(pages, "page", "pages"),
    fileError: "This file can't be used",
    filePassword: "Encrypted: enter the password",
    extractTitle: "Extract pages",
    extractBody: (n) => `A new PDF will be created with the ${plural(n, "selected page", "selected pages")}. The current document doesn't change.`,
    extractDownload: "Download PDF",
    extractOpen: "Open as a new document",
    extractOpenConfirmTitle: "Replace the current document?",
    extractOpenConfirmBody:
      "The new document replaces the one you have open and its history. Download first whatever you want to keep.",
    extractOpenConfirm: "Replace",
    extractName: "File name",
    splitTitle: "Split the document",
    splitModeRanges: "Ranges",
    splitModeEvery: "Every N pages",
    splitModeBookmarks: "Bookmarks",
    splitModeLabel: "How to split",
    splitRangesLabel: "Ranges",
    splitRangesHint: "Each item is one file: 1-3, 5, 7-9 creates three files.",
    splitEveryLabel: "Pages per file",
    splitBookmarksHint: "One file per top-level bookmark; the first pages without a bookmark form their own file.",
    splitNoBookmarks: "This document has no bookmarks: it would produce a single file.",
    splitPreview: (parts) => (parts === 1 ? "1 file will be created" : `${parts} files will be created (ZIP)`),
    splitInvalid: "Check the ranges: use numbers between 1 and {total}.",
    splitSubmit: "Split and download",
    splitPending: "You have unapplied changes: the document will be split as you see it now.",
    splitAppliedFirst: "It will be split with the unapplied changes included.",
    splitDone: (parts) => (parts === 1 ? "Downloaded 1 file" : `Downloaded ${parts} files in a ZIP`),
    working: "Working…",
    password: "Password",
  },
  warnings: {
    outlinesRemoved: "{n} bookmarks that pointed to deleted pages were removed.",
    linksRemoved: "{n} internal links that no longer lead to any page were removed.",
    namedDestinationsRemoved: "{n} named destinations of deleted pages were removed.",
    pageLabelsRemoved: "The document's page numbering (i, ii, 1…) was removed because it no longer matches the order.",
    structureRemoved: "The accessibility structure (tagged PDF) was removed when deleting pages.",
    formFieldsRemoved: "{n} form fields of deleted pages were removed.",
    fieldsRenamed: "{n} form fields were renamed because that name already existed.",
    signatureFieldsRemoved: "{n} signature fields aren't copied into another document.",
    largeInsert: "{n} pages were added at once; it may take a while.",
  },
  errors: {
    tooManyDocuments: "The maximum of 10 added PDF documents was reached.",
    notPdf: "This file isn't a PDF.",
    notImage: "This file isn't an image.",
  },
};

export const PAGES_STRINGS: Record<Language, PagesStrings> = { es, en };

/** Texto de un aviso del motor con su cantidad. */
export function pagesWarningText(strings: PagesStrings, warning: PageAssemblyWarning): string {
  return strings.warnings[warning.code].replace("{n}", String(warning.count));
}

/** Descripcion del snapshot a partir de lo que hace el plan («Reordenar 3 páginas, eliminar 2»). */
export function describePlanLabel(strings: PagesStrings, summary: PlanSummary): string {
  const parts: string[] = [];
  if (summary.moved > 0) parts.push(strings.label.move(summary.moved));
  if (summary.rotated > 0) parts.push(strings.label.rotate(summary.rotated));
  if (summary.deleted > 0) parts.push(strings.label.remove(summary.deleted));
  if (summary.duplicated > 0) parts.push(strings.label.duplicate(summary.duplicated));
  if (summary.blanks > 0) parts.push(strings.label.blank(summary.blanks));
  if (summary.external > 0) parts.push(strings.label.fromPdf(summary.external));
  if (summary.images > 0) parts.push(strings.label.images(summary.images));
  return parts.length === 0 ? strings.label.generic : strings.label.join(parts);
}
