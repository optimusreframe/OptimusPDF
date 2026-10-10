import type { Language } from "@/lib/i18n";
import type { EditElementType } from "@/lib/pdf/editPdf";
import type { BlockReadOnlyReason } from "@/lib/pdf/editTypes";
import type { ResizeHandle } from "@/app/edit-pdf/editCanvasMath";

/** Copy del editor inline de texto existente (Wave 5 · U4a). */
export type EditInlineStrings = {
  stageLabel: string;
  paletteLabel: string;
  toolSelect: string;
  toolText: string;
  undo: string;
  redo: string;
  zoomGroupLabel: string;
  zoomIn: string;
  zoomOut: string;
  zoomValue: (percent: number) => string;
  loadingPage: string;
  pageFailed: string;
  analyzing: string;
  scanned: string;
  analysisFailed: string;
  nonEditableCount: (count: number) => string;
  layerLabel: string;
  blockHint: string;
  blockName: (text: string) => string;
  newTextName: (text: string) => string;
  emptyTextName: string;
  blockLive: (index: number, total: number, text: string) => string;
  notEditable: (reason: string) => string;
  reasons: Record<BlockReadOnlyReason, string>;
  editorLabel: string;
  editorHint: string;
  resizeHandle: (corner: string) => string;
  corners: Record<ResizeHandle, string>;
  barLabel: string;
  /** Descripcion accesible de las barras (se lee una vez al entrar): atajos de mover y redimensionar. */
  barShortcuts: string;
  fontLabel: string;
  fontSubstituted: (label: string) => string;
  glyphFallback: (from: string, to: string) => string;
  glyphUnsupported: (chars: string) => string;
  sizeLabel: string;
  sizeDecrease: string;
  sizeIncrease: string;
  colorLabel: string;
  colorOpen: string;
  colorOption: (name: string) => string;
  colorCustom: string;
  colorNames: Record<string, string>;
  bold: string;
  italic: string;
  variantUnavailable: (variant: string) => string;
  alignLabel: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  duplicate: string;
  remove: string;
  coverColorLabel: string;
  backgroundNotUniform: string;
  originalRemains: string;
  /** (W5-U5) El bloque mezcla estilos (color, negrita, fuente...): redibujarlo los unifica. */
  mixedStyleNotice: string;
  /** (W5-U5) Aviso en vivo: el texto que se escribe invade a otro bloque. */
  overlapNotice: string;
  /** (W5-U5) El texto girado cruza a un vecino: parte del original queda visible. */
  coverCrossesNotice: string;
  /* ---- Barra compacta (pantallas estrechas y puntero grueso) ---- */
  alignCycle: (name: string) => string;
  alignNames: { left: string; center: string; right: string };
  moreOptions: (noticeCount: number) => string;
  moreTitle: string;
  noticesTitle: string;
  moreClose: string;
  /* ---- Anuncios de la region viva ---- */
  undone: (what: string) => string;
  redone: (what: string) => string;
  historyOps: Record<"add" | "update" | "remove" | "move" | "resize" | "restyle" | "reshape", string>;
  /** Frases de deshacer/rehacer para textos: «cambio de texto en “…”», «texto nuevo», «borrado de “…”». */
  historyText: {
    added: string;
    changed: (excerpt: string) => string;
    removed: (excerpt: string) => string;
  };
  historyFlatten: string;
  sizeAnnounce: (width: number, height: number) => string;
  flatten: string;
  deleted: string;
  duplicated: string;

  /* ---- Imagen, formas, resaltado y marca (W5-U4b) ---- */
  /** Pista de cada herramienta armada (region viva `role=status`); «select» va vacia. */
  toolHints: Record<"select" | "text" | "image" | "rect" | "ellipse" | "line" | "highlight" | "check", string>;
  imagePick: string;
  imageTooLarge: (maxMb: number) => string;
  imageTooManyPixels: (maxMegapixels: number) => string;
  imageWrongType: string;
  imageUnreadable: string;
  imageEmpty: string;
  imageMultiple: string;
  imagePlaced: string;
  elementLabel: (name: string, index: number, total: number) => string;
  elementHint: string;
  elementAdded: (name: string) => string;
  elementDeleted: (name: string) => string;
  elementDuplicated: (name: string) => string;
  elementBarLabel: string;
  strokeColorLabel: string;
  strokeColorOpen: string;
  strokeWidthLabel: string;
  widthDecrease: string;
  widthIncrease: string;
  fillLabel: string;
  fillColorLabel: string;
  fillColorOpen: string;
  fillOpacityLabel: string;
  opacityOption: (percent: number) => string;
  highlightColorLabel: string;
  highlightColorOpen: string;
  highlightOpacityLabel: string;
  markLabel: string;
  markCheck: string;
  markCross: string;

  /* ---- Navegacion del documento ---- */
  goToPageLabel: string;
  pageTotal: (total: number) => string;
  pageStatus: (current: number, total: number, changes: number) => string;
  thumbsShow: string;
  thumbsHide: string;
  thumbsLabel: string;
  thumbLabel: (page: number, changes: number) => string;
};

/** Copy propio de Editar PDF (ES/EN). */
export type EditStrings = {
  typeLabels: Record<EditElementType, string>;
  previousPage: string;
  nextPage: string;
  pageOf: (current: number, total: number) => string;
  progressMessage: string;
  filenameSuffix: string;

  inline: EditInlineStrings;
};

const es: EditStrings = {
  typeLabels: {
    text: "Texto",
    image: "Imagen",
    rect: "Rectángulo",
    ellipse: "Elipse",
    line: "Línea",
    highlight: "Resaltado",
    check: "Marca",
  },
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  pageOf: (current, total) => `Página ${current} de ${total}`,
  progressMessage: "Aplicando los elementos",
  filenameSuffix: "editado",

  inline: {
    stageLabel: "Lienzo de edición de la página",
    paletteLabel: "Herramientas de edición",
    toolSelect: "Seleccionar",
    toolText: "Añadir texto",
    undo: "Deshacer",
    redo: "Rehacer",
    zoomGroupLabel: "Zoom",
    zoomIn: "Acercar",
    zoomOut: "Alejar",
    zoomValue: (percent) => `${percent} %`,
    loadingPage: "Preparando la página",
    pageFailed: "No se pudo dibujar esta página. Prueba con otra página o con otro archivo.",
    analyzing: "Analizando el texto de la página…",
    scanned:
      "Esta página parece un escaneo: no tiene texto que editar. Puedes añadir texto, imágenes y formas encima.",
    analysisFailed:
      "No se pudo analizar el texto de esta página. Puedes seguir añadiendo texto nuevo.",
    nonEditableCount: (count) =>
      count === 1
        ? "1 bloque de esta página no se puede editar (pasa el cursor para ver el motivo)."
        : `${count} bloques de esta página no se pueden editar (pasa el cursor para ver el motivo).`,
    layerLabel: "Bloques de texto de la página",
    blockHint:
      "Flechas, Inicio, Fin, Re Pág y Av Pág pasan de un bloque a otro. Intro edita y Espacio selecciona; con el bloque seleccionado, las flechas lo mueven (Mayús, más lejos) y Alt más flechas cambian su tamaño. Supr borra.",
    blockName: (text) => `Texto: ${text}`,
    newTextName: (text) => `Texto añadido: ${text}`,
    emptyTextName: "Texto vacío",
    blockLive: (index, total, text) => `Bloque ${index} de ${total}: ${text}`,
    notEditable: (reason) => `No editable: ${reason}`,
    reasons: {
      "no-unicode": "sin mapa de caracteres",
      type3: "la fuente es de tipo 3",
      invisible: "es texto invisible (capa de reconocimiento)",
      symbolic: "es una fuente de símbolos",
      vertical: "es texto vertical",
    },
    editorLabel: "Editando el texto del bloque",
    editorHint: "Esc o clic fuera para terminar. Mayús+Intro también termina.",
    resizeHandle: (corner) => `Cambiar el tamaño (${corner})`,
    corners: {
      nw: "esquina superior izquierda",
      ne: "esquina superior derecha",
      sw: "esquina inferior izquierda",
      se: "esquina inferior derecha",
    },
    barLabel: "Opciones del texto",
    barShortcuts:
      "Con el elemento seleccionado, las flechas lo mueven (Mayús, más lejos) y Alt más flechas cambian su tamaño.",
    fontLabel: "Fuente",
    fontSubstituted: (label) => `Se usará ${label} (parecida)`,
    glyphFallback: (from, to) =>
      `Algunos caracteres no existen en ${from}: se dibujarán con ${to}.`,
    glyphUnsupported: (chars) =>
      `Estos caracteres no se pueden dibujar y saldrán como «?»: ${chars}`,
    sizeLabel: "Tamaño en puntos",
    sizeDecrease: "Reducir el tamaño",
    sizeIncrease: "Aumentar el tamaño",
    colorLabel: "Color del texto",
    colorOpen: "Elegir el color",
    colorOption: (name) => `Color ${name}`,
    colorCustom: "Otro color",
    colorNames: {
      "#000000": "negro",
      "#5b6470": "gris",
      "#c0c6cf": "gris claro",
      "#0d4bff": "azul",
      "#0f9d68": "verde",
      "#e11d48": "rojo",
      "#f59e0b": "ámbar",
      "#ffffff": "blanco",
      "#fff176": "amarillo",
      "#a5f3a0": "verde claro",
      "#9ad9ff": "azul claro",
      "#ffb4d1": "rosa",
      "#ffd08a": "naranja",
    },
    bold: "Negrita",
    italic: "Cursiva",
    variantUnavailable: (variant) => `Esta fuente no tiene ${variant}`,
    alignLabel: "Alineación",
    alignLeft: "Alinear a la izquierda",
    alignCenter: "Centrar",
    alignRight: "Alinear a la derecha",
    duplicate: "Duplicar",
    remove: "Borrar",
    coverColorLabel: "Color del fondo",
    backgroundNotUniform:
      "El fondo no es de un solo color: si se nota un borde, elige el color del fondo.",
    originalRemains: "El texto original puede seguir existiendo bajo la edición.",
    mixedStyleNotice:
      "Este bloque mezcla estilos (color, negrita, fuente…): al editarlo se unifican con el estilo dominante.",
    overlapNotice: "Este texto invade a otro.",
    coverCrossesNotice: "El texto girado cruza otro texto: parte del original puede quedar visible.",
    alignCycle: (name) => `Alineación: ${name}. Pulsa para cambiarla`,
    alignNames: { left: "izquierda", center: "centrada", right: "derecha" },
    moreOptions: (count) => (count > 0 ? `Más opciones y avisos (${count})` : "Más opciones"),
    moreTitle: "Más opciones del texto",
    noticesTitle: "Avisos",
    moreClose: "Cerrar",
    undone: (what) => `Deshecho: ${what}.`,
    redone: (what) => `Rehecho: ${what}.`,
    historyOps: {
      add: "añadir",
      update: "cambiar el texto de",
      remove: "borrar",
      move: "mover",
      resize: "cambiar el tamaño de",
      restyle: "cambiar el estilo de",
      reshape: "mover un extremo de",
    },
    historyText: {
      added: "texto nuevo",
      changed: (excerpt) => `cambio de texto en “${excerpt}”`,
      removed: (excerpt) => `borrado de “${excerpt}”`,
    },
    historyFlatten: "aplanar página",
    sizeAnnounce: (width, height) => `Tamaño: ${width} × ${height} pt.`,
    flatten: "Aplanar página",
    deleted: "Texto borrado. Puedes deshacerlo.",
    duplicated: "Texto duplicado.",

    toolHints: {
      select: "",
      text: "Haz clic o arrastra en la página para añadir un cuadro de texto. Esc cancela.",
      image: "Elige un PNG o un JPG para colocarlo; también puedes soltarlo sobre la página. Esc cancela.",
      rect: "Arrastra sobre la página para dibujar el rectángulo, o toca para soltar uno. Esc cancela.",
      ellipse: "Arrastra para dibujar la elipse, o toca para soltar una. Esc cancela.",
      line: "Arrastra de un punto al otro, o toca para soltar una línea. Esc cancela.",
      highlight: "Arrastra por encima del texto que quieras resaltar. Esc cancela.",
      check: "Toca la casilla para dejar el símbolo, o arrastra para darle otro tamaño. Esc cancela.",
    },
    imagePick: "Elegir imagen",
    imageTooLarge: (maxMb) => `Esa imagen pesa demasiado. El máximo son ${maxMb} MB: prueba con una más ligera.`,
    imageTooManyPixels: (maxMegapixels) =>
      `Esa imagen es demasiado grande en píxeles (máximo ${maxMegapixels} megapíxeles). Redúcela y vuelve a probar.`,
    imageWrongType: "Solo se aceptan imágenes PNG o JPG.",
    imageUnreadable: "No se pudo leer esa imagen: parece dañada. Prueba con otra.",
    imageEmpty: "Ese archivo está vacío.",
    imageMultiple: "Se colocó solo la primera imagen.",
    imagePlaced: "Imagen colocada. Arrástrala o tira de una esquina para ajustarla.",
    elementLabel: (name, index, total) => `${name} (${index} de ${total})`,
    elementHint:
      "Flechas, Inicio y Fin pasan de un elemento a otro. Espacio o Intro seleccionan; con el elemento seleccionado, las flechas lo mueven (Mayús, más lejos) y Alt más flechas cambian su tamaño. Supr borra.",
    elementAdded: (name) => `${name} añadido.`,
    elementDeleted: (name) => `${name} borrado. Puedes deshacerlo.`,
    elementDuplicated: (name) => `${name} duplicado.`,
    elementBarLabel: "Opciones del elemento",
    strokeColorLabel: "Color del trazo",
    strokeColorOpen: "Elegir el color del trazo",
    strokeWidthLabel: "Grosor",
    widthDecrease: "Reducir el grosor",
    widthIncrease: "Aumentar el grosor",
    fillLabel: "Rellenar la forma",
    fillColorLabel: "Color del relleno",
    fillColorOpen: "Elegir el color del relleno",
    fillOpacityLabel: "Opacidad del relleno",
    opacityOption: (percent) => `Opacidad ${percent} %`,
    highlightColorLabel: "Color del resaltado",
    highlightColorOpen: "Elegir el color del resaltado",
    highlightOpacityLabel: "Intensidad",
    markLabel: "Símbolo",
    markCheck: "Visto",
    markCross: "Aspa",

    goToPageLabel: "Ir a la página",
    pageTotal: (total) => `/ ${total}`,
    pageStatus: (current, total, changes) =>
      `Página ${current} de ${total}. ${
        changes === 0 ? "Sin cambios." : changes === 1 ? "1 cambio." : `${changes} cambios.`
      }`,
    thumbsShow: "Mostrar las miniaturas",
    thumbsHide: "Ocultar las miniaturas",
    thumbsLabel: "Miniaturas de las páginas",
    thumbLabel: (page, changes) =>
      changes === 0
        ? `Ir a la página ${page}`
        : `Ir a la página ${page} (${changes === 1 ? "1 cambio" : `${changes} cambios`})`,
  },
};

const en: EditStrings = {
  typeLabels: {
    text: "Text",
    image: "Image",
    rect: "Rectangle",
    ellipse: "Ellipse",
    line: "Line",
    highlight: "Highlight",
    check: "Mark",
  },
  previousPage: "Previous page",
  nextPage: "Next page",
  pageOf: (current, total) => `Page ${current} of ${total}`,
  progressMessage: "Applying the elements",
  filenameSuffix: "edited",

  inline: {
    stageLabel: "Page editing canvas",
    paletteLabel: "Editing tools",
    toolSelect: "Select",
    toolText: "Add text",
    undo: "Undo",
    redo: "Redo",
    zoomGroupLabel: "Zoom",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomValue: (percent) => `${percent}%`,
    loadingPage: "Preparing the page",
    pageFailed: "This page could not be drawn. Try another page or another file.",
    analyzing: "Analysing the text on the page…",
    scanned:
      "This page looks like a scan: it has no text to edit. You can add text, images and shapes on top.",
    analysisFailed:
      "The text of this page could not be analysed. You can still add new text.",
    nonEditableCount: (count) =>
      count === 1
        ? "1 block on this page cannot be edited (hover it to see why)."
        : `${count} blocks on this page cannot be edited (hover them to see why).`,
    layerLabel: "Text blocks of the page",
    blockHint:
      "Arrow keys, Home, End, Page Up and Page Down move between blocks. Enter edits and Space selects; with the block selected, arrow keys move it (Shift, further) and Alt plus arrows resize it. Delete removes it.",
    blockName: (text) => `Text: ${text}`,
    newTextName: (text) => `Added text: ${text}`,
    emptyTextName: "Empty text",
    blockLive: (index, total, text) => `Block ${index} of ${total}: ${text}`,
    notEditable: (reason) => `Not editable: ${reason}`,
    reasons: {
      "no-unicode": "no character map",
      type3: "the font is a Type 3 font",
      invisible: "it is invisible text (recognition layer)",
      symbolic: "it is a symbol font",
      vertical: "it is vertical text",
    },
    editorLabel: "Editing the text of the block",
    editorHint: "Esc or click outside to finish. Shift+Enter also finishes.",
    resizeHandle: (corner) => `Resize (${corner})`,
    corners: {
      nw: "top left corner",
      ne: "top right corner",
      sw: "bottom left corner",
      se: "bottom right corner",
    },
    barLabel: "Text options",
    barShortcuts:
      "With the element selected, arrow keys move it (Shift, further) and Alt plus arrows resize it.",
    fontLabel: "Font",
    fontSubstituted: (label) => `${label} will be used (similar)`,
    glyphFallback: (from, to) =>
      `Some characters do not exist in ${from}: they will be drawn with ${to}.`,
    glyphUnsupported: (chars) =>
      `These characters cannot be drawn and will come out as “?”: ${chars}`,
    sizeLabel: "Size in points",
    sizeDecrease: "Decrease the size",
    sizeIncrease: "Increase the size",
    colorLabel: "Text colour",
    colorOpen: "Pick the colour",
    colorOption: (name) => `Colour ${name}`,
    colorCustom: "Other colour",
    colorNames: {
      "#000000": "black",
      "#5b6470": "grey",
      "#c0c6cf": "light grey",
      "#0d4bff": "blue",
      "#0f9d68": "green",
      "#e11d48": "red",
      "#f59e0b": "amber",
      "#ffffff": "white",
      "#fff176": "yellow",
      "#a5f3a0": "light green",
      "#9ad9ff": "light blue",
      "#ffb4d1": "pink",
      "#ffd08a": "orange",
    },
    bold: "Bold",
    italic: "Italic",
    variantUnavailable: (variant) => `This font has no ${variant}`,
    alignLabel: "Alignment",
    alignLeft: "Align left",
    alignCenter: "Align centre",
    alignRight: "Align right",
    duplicate: "Duplicate",
    remove: "Delete",
    coverColorLabel: "Background colour",
    backgroundNotUniform:
      "The background is not a single colour: if an edge shows, pick the background colour.",
    originalRemains: "The original text may still exist under the edit.",
    mixedStyleNotice:
      "This block mixes styles (colour, bold, font…): editing it unifies them to the dominant style.",
    overlapNotice: "This text overlaps another one.",
    coverCrossesNotice: "The rotated text crosses another text: part of the original may stay visible.",
    alignCycle: (name) => `Alignment: ${name}. Press to change it`,
    alignNames: { left: "left", center: "centred", right: "right" },
    moreOptions: (count) => (count > 0 ? `More options and notices (${count})` : "More options"),
    moreTitle: "More text options",
    noticesTitle: "Notices",
    moreClose: "Close",
    undone: (what) => `Undone: ${what}.`,
    redone: (what) => `Redone: ${what}.`,
    historyOps: {
      add: "add",
      update: "change the text of",
      remove: "delete",
      move: "move",
      resize: "resize",
      restyle: "change the style of",
      reshape: "move an end of",
    },
    historyText: {
      added: "new text",
      changed: (excerpt) => `text change in “${excerpt}”`,
      removed: (excerpt) => `deletion of “${excerpt}”`,
    },
    historyFlatten: "flatten page",
    sizeAnnounce: (width, height) => `Size: ${width} × ${height} pt.`,
    flatten: "Flatten page",
    deleted: "Text deleted. You can undo it.",
    duplicated: "Text duplicated.",

    toolHints: {
      select: "",
      text: "Click or drag on the page to add a text box. Esc cancels.",
      image: "Pick a PNG or a JPG to place it; you can also drop it onto the page. Esc cancels.",
      rect: "Drag across the page to draw the rectangle, or tap to drop one. Esc cancels.",
      ellipse: "Drag to draw the ellipse, or tap to drop one. Esc cancels.",
      line: "Drag from one point to the other, or tap to drop a line. Esc cancels.",
      highlight: "Drag over the text you want to highlight. Esc cancels.",
      check: "Tap the box to leave the symbol, or drag to give it another size. Esc cancels.",
    },
    imagePick: "Pick an image",
    imageTooLarge: (maxMb) => `That image is too heavy. The limit is ${maxMb} MB: try a lighter one.`,
    imageTooManyPixels: (maxMegapixels) =>
      `That image is too large in pixels (limit ${maxMegapixels} megapixels). Shrink it and try again.`,
    imageWrongType: "Only PNG or JPG images are accepted.",
    imageUnreadable: "That image could not be read: it looks damaged. Try another one.",
    imageEmpty: "That file is empty.",
    imageMultiple: "Only the first image was placed.",
    imagePlaced: "Image placed. Drag it or pull a corner to adjust it.",
    elementLabel: (name, index, total) => `${name} (${index} of ${total})`,
    elementHint:
      "Arrow keys, Home and End move between elements. Space or Enter select; with the element selected, arrow keys move it (Shift, further) and Alt plus arrows resize it. Delete removes it.",
    elementAdded: (name) => `${name} added.`,
    elementDeleted: (name) => `${name} deleted. You can undo it.`,
    elementDuplicated: (name) => `${name} duplicated.`,
    elementBarLabel: "Element options",
    strokeColorLabel: "Stroke colour",
    strokeColorOpen: "Pick the stroke colour",
    strokeWidthLabel: "Thickness",
    widthDecrease: "Decrease the thickness",
    widthIncrease: "Increase the thickness",
    fillLabel: "Fill the shape",
    fillColorLabel: "Fill colour",
    fillColorOpen: "Pick the fill colour",
    fillOpacityLabel: "Fill opacity",
    opacityOption: (percent) => `Opacity ${percent}%`,
    highlightColorLabel: "Highlight colour",
    highlightColorOpen: "Pick the highlight colour",
    highlightOpacityLabel: "Strength",
    markLabel: "Symbol",
    markCheck: "Check",
    markCross: "Cross",

    goToPageLabel: "Go to page",
    pageTotal: (total) => `/ ${total}`,
    pageStatus: (current, total, changes) =>
      `Page ${current} of ${total}. ${
        changes === 0 ? "No changes." : changes === 1 ? "1 change." : `${changes} changes.`
      }`,
    thumbsShow: "Show thumbnails",
    thumbsHide: "Hide thumbnails",
    thumbsLabel: "Page thumbnails",
    thumbLabel: (page, changes) =>
      changes === 0
        ? `Go to page ${page}`
        : `Go to page ${page} (${changes === 1 ? "1 change" : `${changes} changes`})`,
  },
};

export const EDIT_STRINGS: Record<Language, EditStrings> = { es, en };
