import type { Language } from "@/lib/i18n";
import type { EditElementType } from "@/lib/pdf/editPdf";

/** Copy propio de Editar PDF (ES/EN). */
export type EditStrings = {
  canvasTitle: string;
  toolbarLabel: string;
  typeLabels: Record<EditElementType, string>;
  typeHints: Record<EditElementType, string>;

  loadingPreview: string;
  previousPage: string;
  nextPage: string;
  pageOf: (current: number, total: number) => string;
  thumbsTitle: string;
  goToPage: (page: number) => string;

  elementsOnPage: (count: number) => string;
  totalElements: (count: number) => string;
  removeElement: string;
  moveElement: string;
  resizeElement: string;
  lineStart: string;
  lineEnd: string;
  undo: string;
  clearPage: string;
  clearAll: string;
  noElements: string;

  textPlaceholder: string;
  textBoxLabel: string;
  textEditorTitle: string;
  textEditorHint: string;
  closeEditor: string;

  imagePick: string;
  imageReplace: string;
  imagePending: string;
  imageRejected: string;

  styleTitle: string;
  styleAppliesTo: string;
  fontLabel: string;
  fontHelvetica: string;
  fontTimes: string;
  fontCourier: string;
  sizeLabel: string;
  bold: string;
  italic: string;
  textColorLabel: string;
  strokeColorLabel: string;
  strokeWidthLabel: string;
  fillLabel: string;
  fillColorLabel: string;
  fillOpacityLabel: string;
  highlightColorLabel: string;
  highlightOpacityLabel: string;
  checkMarkLabel: string;
  checkMarkCheck: string;
  checkMarkCross: string;

  howItWorksTitle: string;
  howItWorksBody: string;
  scopeWarning: string;
  fontWarning: string;

  progressMessage: string;
  largeFile: string;
  filenameSuffix: string;
};

const es: EditStrings = {
  canvasTitle: "Lienzo de la página",
  toolbarLabel: "Qué quieres añadir",
  typeLabels: {
    text: "Texto",
    image: "Imagen",
    rect: "Rectángulo",
    ellipse: "Elipse",
    line: "Línea",
    highlight: "Resaltado",
    check: "Marca",
  },
  typeHints: {
    text: "Haz clic donde quieras empezar a escribir. Arrastra la caja para moverla y tira de la esquina para darle más ancho: el alto lo marca el propio texto.",
    image: "Elige un PNG o un JPG y luego haz clic en la página para soltarlo. Se coloca conservando su proporción; tira de la esquina para cambiarle el tamaño.",
    rect: "Arrastra sobre la página para dibujar el rectángulo. Puedes darle borde, relleno o las dos cosas.",
    ellipse: "Arrastra para definir la caja que contiene la elipse, igual que con un rectángulo.",
    line: "Arrastra de un punto al otro. Después puedes mover la línea entera o cada extremo por separado.",
    highlight: "Arrastra por encima del texto que quieras marcar. Se pinta translúcido, así que lo de debajo se sigue leyendo y se sigue pudiendo seleccionar.",
    check: "Haz clic sobre la casilla para dejar el símbolo, o arrastra si quieres darle otro tamaño. Elige entre visto ✓ y aspa ✗ en el panel de estilo.",
  },

  loadingPreview: "Preparando la vista previa",
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  pageOf: (current, total) => `Página ${current} de ${total}`,
  thumbsTitle: "Páginas",
  goToPage: (page) => `Ir a la página ${page}`,

  elementsOnPage: (count) =>
    count === 1
      ? "1 elemento en esta página"
      : `${count} elementos en esta página`,
  totalElements: (count) =>
    count === 1
      ? "1 elemento en el documento"
      : `${count} elementos en el documento`,
  removeElement: "Quitar este elemento",
  moveElement: "Mover el elemento",
  resizeElement: "Cambiar el tamaño",
  lineStart: "Mover el primer extremo",
  lineEnd: "Mover el segundo extremo",
  undo: "Deshacer el último",
  clearPage: "Vaciar esta página",
  clearAll: "Vaciar todo",
  noElements: "Añade al menos un elemento antes de procesar.",

  textPlaceholder: "Escribe aquí",
  textBoxLabel: "Cuadro de texto",
  textEditorTitle: "Texto del cuadro",
  textEditorHint:
    "Los saltos de línea se respetan. Las líneas más largas que el ancho del cuadro se parten solas.",
  closeEditor: "Cerrar el editor",

  imagePick: "Elegir imagen",
  imageReplace: "Cambiar imagen",
  imagePending: "Imagen lista. Haz clic en la página para colocarla.",
  imageRejected: "Solo se aceptan imágenes PNG o JPG.",

  styleTitle: "Estilo",
  styleAppliesTo:
    "Se aplica a lo próximo que dibujes y, si hay algo seleccionado, también a ello.",
  fontLabel: "Tipografía",
  fontHelvetica: "Helvetica",
  fontTimes: "Times",
  fontCourier: "Courier",
  sizeLabel: "Cuerpo",
  bold: "Negrita",
  italic: "Cursiva",
  textColorLabel: "Color del texto",
  strokeColorLabel: "Color del trazo",
  strokeWidthLabel: "Grosor",
  fillLabel: "Rellenar la forma",
  fillColorLabel: "Color del relleno",
  fillOpacityLabel: "Opacidad del relleno",
  highlightColorLabel: "Color del resaltado",
  highlightOpacityLabel: "Intensidad",
  checkMarkLabel: "Símbolo",
  checkMarkCheck: "Visto ✓",
  checkMarkCross: "Aspa ✗",

  howItWorksTitle: "Añade encima, no reescribe lo que ya hay",
  howItWorksBody:
    "Cada elemento se pinta como contenido vectorial nuevo sobre la página original, que se conserva byte a byte. Nada se convierte en imagen: el texto que ya traía el documento sigue siendo texto, se puede seleccionar y se puede buscar.",
  scopeWarning:
    "Por lo mismo, esto no reescribe el texto que ya está en el PDF: no puedes corregir una palabra del documento original. Lo que puedes hacer es taparla con una forma y escribir la nueva encima.",
  fontWarning:
    "El texto usa las tipografías estándar del formato PDF, así que pesa muy poco y se ve igual en cualquier lector. Los caracteres fuera del alfabeto latino se sustituyen por «?».",

  progressMessage: "Aplicando los elementos",
  largeFile:
    "El archivo pasa de 100 MB. La vista previa de un documento así puede ir lenta en el navegador.",
  filenameSuffix: "editado",
};

const en: EditStrings = {
  canvasTitle: "Page canvas",
  toolbarLabel: "What do you want to add",
  typeLabels: {
    text: "Text",
    image: "Image",
    rect: "Rectangle",
    ellipse: "Ellipse",
    line: "Line",
    highlight: "Highlight",
    check: "Mark",
  },
  typeHints: {
    text: "Click where you want to start writing. Drag the box to move it and pull the corner to widen it: the height follows the text itself.",
    image: "Pick a PNG or a JPG, then click on the page to drop it. It lands keeping its proportions; pull the corner to resize it.",
    rect: "Drag across the page to draw the rectangle. Give it a border, a fill, or both.",
    ellipse: "Drag to define the box that holds the ellipse, exactly like a rectangle.",
    line: "Drag from one point to the other. Afterwards you can move the whole line or each end on its own.",
    highlight: "Drag over the text you want to mark. It is painted translucent, so what sits underneath stays readable and stays selectable.",
    check: "Click on the box to drop the symbol, or drag if you want another size. Pick between tick ✓ and cross ✗ in the style panel.",
  },

  loadingPreview: "Preparing the preview",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageOf: (current, total) => `Page ${current} of ${total}`,
  thumbsTitle: "Pages",
  goToPage: (page) => `Go to page ${page}`,

  elementsOnPage: (count) =>
    count === 1 ? "1 element on this page" : `${count} elements on this page`,
  totalElements: (count) =>
    count === 1
      ? "1 element in the document"
      : `${count} elements in the document`,
  removeElement: "Remove this element",
  moveElement: "Move the element",
  resizeElement: "Resize",
  lineStart: "Move the first end",
  lineEnd: "Move the second end",
  undo: "Undo the last one",
  clearPage: "Clear this page",
  clearAll: "Clear everything",
  noElements: "Add at least one element before processing.",

  textPlaceholder: "Type here",
  textBoxLabel: "Text box",
  textEditorTitle: "Text of the box",
  textEditorHint:
    "Line breaks are kept. Lines wider than the box wrap on their own.",
  closeEditor: "Close the editor",

  imagePick: "Pick an image",
  imageReplace: "Change image",
  imagePending: "Image ready. Click on the page to place it.",
  imageRejected: "Only PNG or JPG images are accepted.",

  styleTitle: "Style",
  styleAppliesTo:
    "Applies to whatever you draw next and, if something is selected, to it as well.",
  fontLabel: "Typeface",
  fontHelvetica: "Helvetica",
  fontTimes: "Times",
  fontCourier: "Courier",
  sizeLabel: "Size",
  bold: "Bold",
  italic: "Italic",
  textColorLabel: "Text colour",
  strokeColorLabel: "Stroke colour",
  strokeWidthLabel: "Thickness",
  fillLabel: "Fill the shape",
  fillColorLabel: "Fill colour",
  fillOpacityLabel: "Fill opacity",
  highlightColorLabel: "Highlight colour",
  highlightOpacityLabel: "Strength",
  checkMarkLabel: "Symbol",
  checkMarkCheck: "Tick ✓",
  checkMarkCross: "Cross ✗",

  howItWorksTitle: "It adds on top, it does not rewrite what is there",
  howItWorksBody:
    "Every element is painted as new vector content over the original page, which is kept byte for byte. Nothing turns into an image: the text the document already carried stays text, stays selectable and stays searchable.",
  scopeWarning:
    "For the same reason, this does not rewrite the text already inside the PDF: you cannot fix a word of the original document. What you can do is cover it with a shape and write the new one on top.",
  fontWarning:
    "Text uses the standard PDF typefaces, so it weighs almost nothing and looks the same in any reader. Characters outside the Latin alphabet are replaced with “?”.",

  progressMessage: "Applying the elements",
  largeFile:
    "The file is over 100 MB. Previewing a document that size may feel slow in the browser.",
  filenameSuffix: "edited",
};

export const EDIT_STRINGS: Record<Language, EditStrings> = { es, en };
