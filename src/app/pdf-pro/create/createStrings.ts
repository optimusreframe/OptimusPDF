import type { Language } from "@/lib/i18n";

/** Textos de «crear e importar» de PDF Pro (Wave 7 · U8), es/en. */
export type CreateStrings = {
  menu: {
    newFromImages: string;
    newBlank: string;
    insertConvert: string;
    mergePdfs: string;
    openAnother: string;
    recents: string;
  };
  images: {
    title: string;
    body: string;
    pick: string;
    pickMore: string;
    listLabel: string;
    moveUp: (name: string) => string;
    moveDown: (name: string) => string;
    remove: (name: string) => string;
    count: (count: number) => string;
    none: string;
    create: string;
    creating: string;
    fileName: string;
    notImage: (name: string) => string;
    tooMany: (max: number) => string;
  };
  blank: {
    title: string;
    body: string;
    sizeLabel: string;
    a4: string;
    letter: string;
    orientationLabel: string;
    portrait: string;
    landscape: string;
    pagesLabel: string;
    pagesHint: (max: number) => string;
    create: string;
    fileName: string;
  };
  insert: {
    title: string;
    body: (name: string) => string;
    kind: { word: string; excel: string; html: string };
    unsupported: string;
    positionLabel: string;
    start: string;
    afterCurrent: (page: number) => string;
    end: string;
    insert: string;
    inserting: string;
    cancel: string;
    pendingOrganizer: string;
    label: (name: string) => string;
    done: (pages: number) => string;
    fidelityHtml: string;
  };
  cancel: string;
};

const es: CreateStrings = {
  menu: {
    newFromImages: "Nuevo PDF desde imágenes…",
    newBlank: "Nuevo documento en blanco…",
    insertConvert: "Insertar desde Word, Excel o HTML…",
    mergePdfs: "Unir PDFs…",
    openAnother: "Abrir otro PDF…",
    recents: "Documentos recientes",
  },
  images: {
    title: "Nuevo PDF desde imágenes",
    body: "Elige las imágenes, ordénalas y crea un PDF nuevo para seguir trabajando en él.",
    pick: "Elegir imágenes",
    pickMore: "Añadir más imágenes",
    listLabel: "Imágenes en orden",
    moveUp: (name) => `Subir ${name}`,
    moveDown: (name) => `Bajar ${name}`,
    remove: (name) => `Quitar ${name}`,
    count: (count) => (count === 1 ? "1 imagen" : `${count} imágenes`),
    none: "Aún no hay imágenes.",
    create: "Crear PDF",
    creating: "Creando el PDF…",
    fileName: "imagenes.pdf",
    notImage: (name) => `${name} no es una imagen y se ha omitido.`,
    tooMany: (max) => `Solo caben ${max} imágenes a la vez.`,
  },
  blank: {
    title: "Nuevo documento en blanco",
    body: "Crea un PDF con páginas en blanco y organiza, edita o firma desde ahí.",
    sizeLabel: "Tamaño de página",
    a4: "A4",
    letter: "Carta",
    orientationLabel: "Orientación",
    portrait: "Vertical",
    landscape: "Horizontal",
    pagesLabel: "Número de páginas",
    pagesHint: (max) => `Entre 1 y ${max}.`,
    create: "Crear documento",
    fileName: "documento-en-blanco.pdf",
  },
  insert: {
    title: "Insertar desde Word, Excel o HTML",
    body: (name) => `Se convierte ${name} a PDF y sus páginas se insertan en este documento. Se puede deshacer con Ctrl+Z.`,
    kind: { word: "Documento de Word", excel: "Hoja de Excel", html: "Archivo HTML" },
    unsupported:
      "Elige un archivo .docx, .xlsx o .html. Los formatos antiguos (.doc, .xls) no se pueden abrir: guárdalos como .docx o .xlsx desde Word o Excel.",
    positionLabel: "Dónde insertar",
    start: "Al principio",
    afterCurrent: (page) => `Después de la página ${page}`,
    end: "Al final",
    insert: "Insertar páginas",
    inserting: "Convirtiendo e insertando…",
    cancel: "Cancelar",
    pendingOrganizer:
      "Tienes cambios sin aplicar en Páginas. Aplícalos o descártalos antes de insertar.",
    label: (name) => `Insertar páginas de ${name}`,
    done: (pages) => (pages === 1 ? "Se insertó 1 página." : `Se insertaron ${pages} páginas.`),
    fidelityHtml:
      "El HTML se convierte en una imagen de cómo se ve: el texto de esas páginas no se podrá seleccionar.",
  },
  cancel: "Cancelar",
};

const en: CreateStrings = {
  menu: {
    newFromImages: "New PDF from images…",
    newBlank: "New blank document…",
    insertConvert: "Insert from Word, Excel or HTML…",
    mergePdfs: "Merge PDFs…",
    openAnother: "Open another PDF…",
    recents: "Recent documents",
  },
  images: {
    title: "New PDF from images",
    body: "Pick the images, put them in order and create a new PDF to keep working on.",
    pick: "Choose images",
    pickMore: "Add more images",
    listLabel: "Images in order",
    moveUp: (name) => `Move ${name} up`,
    moveDown: (name) => `Move ${name} down`,
    remove: (name) => `Remove ${name}`,
    count: (count) => (count === 1 ? "1 image" : `${count} images`),
    none: "No images yet.",
    create: "Create PDF",
    creating: "Creating the PDF…",
    fileName: "images.pdf",
    notImage: (name) => `${name} is not an image and was skipped.`,
    tooMany: (max) => `Only ${max} images fit at once.`,
  },
  blank: {
    title: "New blank document",
    body: "Create a PDF with blank pages and organise, edit or sign from there.",
    sizeLabel: "Page size",
    a4: "A4",
    letter: "Letter",
    orientationLabel: "Orientation",
    portrait: "Portrait",
    landscape: "Landscape",
    pagesLabel: "Number of pages",
    pagesHint: (max) => `Between 1 and ${max}.`,
    create: "Create document",
    fileName: "blank-document.pdf",
  },
  insert: {
    title: "Insert from Word, Excel or HTML",
    body: (name) => `${name} is converted to PDF and its pages are inserted into this document. You can undo it with Ctrl+Z.`,
    kind: { word: "Word document", excel: "Excel sheet", html: "HTML file" },
    unsupported:
      "Choose a .docx, .xlsx or .html file. Older formats (.doc, .xls) can't be opened: save them as .docx or .xlsx from Word or Excel.",
    positionLabel: "Where to insert",
    start: "At the start",
    afterCurrent: (page) => `After page ${page}`,
    end: "At the end",
    insert: "Insert pages",
    inserting: "Converting and inserting…",
    cancel: "Cancel",
    pendingOrganizer:
      "You have unapplied changes in Pages. Apply or discard them before inserting.",
    label: (name) => `Insert pages from ${name}`,
    done: (pages) => (pages === 1 ? "1 page inserted." : `${pages} pages inserted.`),
    fidelityHtml:
      "HTML is converted into a picture of how it looks: the text on those pages won't be selectable.",
  },
  cancel: "Cancel",
};

export const CREATE_STRINGS: Record<Language, CreateStrings> = { es, en };

export function getCreateStrings(language: Language): CreateStrings {
  return CREATE_STRINGS[language] ?? es;
}
