import type { Language } from "@/lib/i18n";
import type { ProWarning } from "@/app/pdf-pro/proTypes";
import {
  PALETTE_STRINGS_EN,
  PALETTE_STRINGS_ES,
  SHELL_STRINGS_EN,
  SHELL_STRINGS_ES,
  VIEWER_STRINGS_EN,
  VIEWER_STRINGS_ES,
  type PaletteStrings,
  type ShellStrings,
  type ViewerStrings,
} from "@/app/pdf-pro/viewer/viewerStrings";
import { DOC_TOOLS_STRINGS, type DocToolsStrings } from "@/app/pdf-pro/tabs/docToolsStrings";
import { PAGES_STRINGS, type PagesStrings } from "@/app/pdf-pro/pages/pagesStrings";
import { EXPORT_STRINGS, type ExportStrings } from "@/app/pdf-pro/export/exportStrings";
import { SAVE_STRINGS, type SaveStrings } from "@/app/pdf-pro/save/saveStrings";
import { CREATE_STRINGS, type CreateStrings } from "@/app/pdf-pro/create/createStrings";
import { SESSION_STRINGS, type SessionStrings } from "@/app/pdf-pro/session/sessionStrings";

/**
 * Textos de PDF Pro (Wave 7), es/en. Mismo patron que el `strings.ts` de cada herramienta.
 * Las unidades siguientes AÑADEN sus claves aqui (las etiquetas de operaciones van en `operations`).
 */
export type ProStrings = {
  /** Anuncios de la region viva unica del documento de trabajo. */
  announce: {
    opened: (name: string) => string;
    applied: (label: string) => string;
    undone: (label: string) => string;
    redone: (label: string) => string;
    wentTo: (label: string) => string;
    closed: string;
    historyTrimmed: string;
    nothingToUndo: string;
    nothingToRedo: string;
    /** Wave 8: no se pudo recuperar de disco un paso al deshacer/rehacer: se retira del historial. */
    historyStepLost: (label: string) => string;
    /** Wave 8: el volcado del historial a disco fallo; se recorta por bytes como antes. */
    historyOffloadFailed: string;
  };
  labels: {
    original: string;
    restored: string;
  };
  /** Avisos (`ProWarning`); `{n}` se sustituye con `params`. */
  warnings: Record<ProWarning["code"], string>;
  /** Etiquetas de las operaciones registradas, por `labelKey`. */
  operations: Record<string, string>;
  suite: {
    regionLabel: string;
    topBarLabel: string;
    undo: string;
    redo: string;
    download: string;
    close: string;
    closeConfirmBody: string;
    unsaved: string;
    saved: string;
    pageCount: (count: number) => string;
    tabsLabel: string;
    tabs: Record<"home" | "pages" | "edit" | "annotate" | "sign" | "protect" | "convert", string>;
    thumbsTitle: string;
    thumbsPlaceholder: (count: number) => string;
    viewerTitle: string;
    viewerPlaceholder: string;
    contextTitle: string;
    comingSoon: Record<"pages" | "edit" | "annotate" | "sign" | "protect" | "convert", string>;
    quickTitle: string;
    historyTitle: string;
    historyEmpty: string;
    historyCurrent: string;
    historyGoTo: (label: string) => string;
    historyTrimmed: string;
    historyRestoredTitle: (date: string) => string;
    historyRestoredBody: string;
    running: string;
    cancel: string;
    cancelled: string;
    openedFrom: (tool: string) => string;
    /** Se abrio solo el primero de varios PDF de la herramienta de origen. */
    openedFromMany: (tool: string, total: number) => string;
    warningsTitle: string;
    /** (B1) Linea resumen cuando «Antes de guardar» tiene DOS o mas avisos: «2 avisos». */
    warningsCount: (count: number) => string;
    encryptedKeep: string;
    openAnother: string;
  };
  empty: {
    title: string;
    subtitle: string;
    recentTitle: string;
    recentEmpty: string;
    recentOpen: (name: string) => string;
    recentDraftNote: (count: number, date: string) => string;
    toolsTitle: string;
    toolsHint: string;
    privacy: string;
    checking: string;
    draftsUnavailable: string;
  };
  /** Herramientas de documento, Proteger y Convertir (Wave 7 · U5). */
  docTools: DocToolsStrings;
  /** Visor continuo y miniaturas (Wave 7 · U3). */
  viewer: ViewerStrings;
  /** Organizador de paginas (Wave 7 · U4). */
  pages: PagesStrings;
  /** Paleta de comandos Cmd/Ctrl+K (Wave 7 · U3). */
  palette: PaletteStrings;
  /** Shell: enlaces de salto, menu «Mas», atajos, paneles (Wave 7 · U3). */
  shell: ShellStrings;
  /** Exportar como imagenes, texto, Word, Excel, CSV, Markdown, JSON y PowerPoint (Wave 7 · U8). */
  export: ExportStrings;
  /** Descargar, guardar como y guardar con contraseña (Wave 7 · U8). */
  save: SaveStrings;
  /** Nuevo desde imagenes, en blanco e insertar desde Word, Excel o HTML (Wave 7 · U8). */
  create: CreateStrings;
  /** Cambiar de documento, recientes y acciones del estado vacio (Wave 7 · U8). */
  session: SessionStrings;
  drafts: {
    foundTitle: string;
    foundBody: (steps: number, date: string) => string;
    restore: string;
    discard: string;
    restoring: string;
    failed: string;
    saveFailed: string;
    saveTooBig: string;
    saveQuota: string;
  };
};

const es: ProStrings = {
  announce: {
    opened: (name) => `Documento abierto: ${name}`,
    applied: (label) => `Aplicado: ${label}`,
    undone: (label) => `Deshecho: ${label}`,
    redone: (label) => `Rehecho: ${label}`,
    wentTo: (label) => `Vuelto a: ${label}`,
    closed: "Documento cerrado",
    historyTrimmed: "El historial más antiguo se descartó para liberar memoria.",
    nothingToUndo: "No hay nada que deshacer",
    nothingToRedo: "No hay nada que rehacer",
    historyStepLost: (label) => `No se pudo recuperar el paso «${label}»: se retiró del historial.`,
    historyOffloadFailed:
      "No se pudo guardar el historial en el disco del navegador: vive solo en memoria y los pasos más antiguos se descartarán.",
  },
  labels: { original: "Original", restored: "Borrador recuperado" },
  warnings: {
    signaturesInvalidated:
      "Este PDF tiene firmas digitales: al guardarlo con cambios dejarán de ser válidas.",
    signaturesUnknown:
      "No pudimos comprobar si este PDF tiene firmas digitales; si las tuviera, los cambios las invalidarían.",
    decryptedCopy:
      "Trabajas con una copia sin contraseña: la contraseña no se guardará y el resultado saldrá sin cifrar.",
    historyTrimmed: "El historial más antiguo se descartó para liberar memoria.",
    unchanged: "El resultado es igual que el documento de partida: no hubo nada que cambiar.",
    largeDocument:
      "Este documento pesa {size}. Las operaciones pueden tardar y usar mucha memoria: descarga el PDF a menudo.",
    noDraftTooBig:
      "Por su tamaño ({size}) no se guardará un borrador automático: descarga el PDF para no perder el trabajo.",
    memoryHigh:
      "El historial ocupa {size} de memoria. Si hace falta, los pasos más antiguos se descartarán para liberarla.",
    historyOffloadUnavailable:
      "No se pudo guardar el historial en el disco del navegador (sin espacio o sin IndexedDB): vive solo en memoria y los pasos más antiguos se descartarán al llenarse.",
  },
  operations: {
    rotateAll90: "Rotar todas las páginas 90°",
    pagesApply: "Cambios en las páginas",
    compress: "Comprimir el PDF",
    watermark: "Marca de agua",
    pageNumbers: "Numerar páginas",
    headerFooter: "Encabezado y pie",
    crop: "Recortar márgenes",
    rotate: "Rotar páginas",
    metadata: "Editar metadatos",
    repair: "Reparar el PDF",
    ocr: "Reconocer texto (OCR)",
    unlock: "Quitar restricciones de firma",
    insertConverted: "Insertar páginas convertidas",
  },
  suite: {
    regionLabel: "PDF Pro",
    topBarLabel: "Barra del documento",
    undo: "Deshacer",
    redo: "Rehacer",
    download: "Descargar",
    close: "Cerrar documento",
    closeConfirmBody:
      "Tienes cambios sin descargar. Si cierras, solo quedará el borrador automático de este navegador (si está activado) para retomarlo.",
    unsaved: "Cambios sin guardar",
    saved: "Sin cambios pendientes",
    pageCount: (count) => (count === 1 ? "1 página" : `${count} páginas`),
    tabsLabel: "Herramientas de PDF Pro",
    tabs: {
      home: "Inicio",
      pages: "Páginas",
      edit: "Editar",
      annotate: "Anotar",
      sign: "Firmar",
      protect: "Proteger",
      convert: "Convertir",
    },
    thumbsTitle: "Páginas",
    thumbsPlaceholder: (count) => `Miniaturas de las ${count} páginas`,
    viewerTitle: "Documento",
    viewerPlaceholder: "Aquí se mostrará el documento, página a página.",
    contextTitle: "Panel de herramienta",
    comingSoon: {
      pages: "Próximamente en PDF Pro: reordenar, girar, eliminar, dividir y unir páginas.",
      edit: "Próximamente en PDF Pro: editar el texto, las imágenes y las formas del documento.",
      annotate: "Próximamente en PDF Pro: resaltar, comentar y dibujar sobre el documento.",
      sign: "Próximamente en PDF Pro: firmar y rellenar formularios sobre el documento.",
      protect: "Próximamente en PDF Pro: proteger con contraseña, censurar y desbloquear.",
      convert: "Próximamente en PDF Pro: exportar a imágenes, texto y otros formatos.",
    },
    quickTitle: "Acciones rápidas",
    historyTitle: "Historial de cambios",
    historyEmpty: "Aún no hay cambios: el documento está como lo abriste.",
    historyCurrent: "Actual",
    historyGoTo: (label) => `Volver a: ${label}`,
    historyTrimmed: "Los pasos más antiguos se descartaron para liberar memoria.",
    historyRestoredTitle: (date) => `Borrador recuperado (${date})`,
    historyRestoredBody: "El historial anterior no se puede deshacer; los cambios nuevos sí.",
    running: "Aplicando…",
    cancel: "Cancelar",
    cancelled: "Operación cancelada.",
    openedFrom: (tool) => `Abierto desde ${tool}`,
    openedFromMany: (tool, total) =>
      `Abierto desde ${tool}: se abrió el primero de ${total} PDF. Para unirlos, usa Páginas → Insertar desde PDF.`,
    warningsTitle: "Antes de guardar",
    warningsCount: (count) => (count === 1 ? "1 aviso" : `${count} avisos`),
    encryptedKeep: "Trabajas con una copia sin contraseña.",
    openAnother: "Abrir otro PDF",
  },
  empty: {
    title: "Abre un PDF para trabajar en él",
    subtitle:
      "Organiza, edita, firma, protege y convierte el mismo documento sin salir de la página. Todo ocurre en tu navegador y nada se sube.",
    recentTitle: "Documentos recientes",
    recentEmpty: "Aquí aparecerán los documentos con cambios sin guardar.",
    recentOpen: (name) => `Abrir ${name}`,
    recentDraftNote: (count, date) =>
      `${count === 1 ? "1 cambio" : `${count} cambios`} guardados · ${date}`,
    toolsTitle: "O usa una herramienta suelta",
    toolsHint: "Cada herramienta sigue disponible por separado.",
    privacy: "Los borradores se guardan solo en este navegador.",
    checking: "Comprobando el archivo…",
    draftsUnavailable: "Este navegador no permite guardar borradores.",
  },
  docTools: DOC_TOOLS_STRINGS.es,
  viewer: VIEWER_STRINGS_ES,
  pages: PAGES_STRINGS.es,
  palette: PALETTE_STRINGS_ES,
  shell: SHELL_STRINGS_ES,
  export: EXPORT_STRINGS.es,
  save: SAVE_STRINGS.es,
  create: CREATE_STRINGS.es,
  session: SESSION_STRINGS.es,
  drafts: {
    foundTitle: "Tienes un borrador de este documento",
    foundBody: (steps, date) =>
      `Guardado el ${date}, con ${steps === 1 ? "1 cambio" : `${steps} cambios`} sin descargar. ¿Quieres retomarlo?`,
    restore: "Retomar borrador",
    discard: "Descartar borrador",
    restoring: "Recuperando…",
    failed: "No se pudo recuperar el borrador.",
    saveFailed: "No se pudo guardar el borrador automático.",
    saveTooBig: "El documento es demasiado grande para guardarlo como borrador.",
    saveQuota: "No queda espacio en el navegador para guardar el borrador.",
  },
};

const en: ProStrings = {
  announce: {
    opened: (name) => `Document opened: ${name}`,
    applied: (label) => `Applied: ${label}`,
    undone: (label) => `Undone: ${label}`,
    redone: (label) => `Redone: ${label}`,
    wentTo: (label) => `Went back to: ${label}`,
    closed: "Document closed",
    historyTrimmed: "The oldest history was dropped to free memory.",
    nothingToUndo: "Nothing to undo",
    nothingToRedo: "Nothing to redo",
    historyStepLost: (label) => `The step "${label}" could not be recovered: it was removed from the history.`,
    historyOffloadFailed:
      "The history could not be stored on the browser's disk: it lives only in memory and the oldest steps will be dropped.",
  },
  labels: { original: "Original", restored: "Recovered draft" },
  warnings: {
    signaturesInvalidated:
      "This PDF has digital signatures: saving it with changes will make them invalid.",
    signaturesUnknown:
      "We couldn't check whether this PDF has digital signatures; if it does, changes would invalidate them.",
    decryptedCopy:
      "You are working with a copy without a password: the password won't be kept and the result will be unencrypted.",
    historyTrimmed: "The oldest history was dropped to free memory.",
    unchanged: "The result is the same as the starting document: there was nothing to change.",
    largeDocument:
      "This document weighs {size}. Operations may be slow and use a lot of memory: download the PDF often.",
    noDraftTooBig:
      "Because of its size ({size}) no automatic draft will be saved: download the PDF so you don't lose your work.",
    memoryHigh:
      "The history takes up {size} of memory. If needed, the oldest steps will be dropped to free it.",
    historyOffloadUnavailable:
      "The history could not be stored on the browser's disk (no space or no IndexedDB): it lives only in memory and the oldest steps will be dropped when it fills up.",
  },
  operations: {
    rotateAll90: "Rotate all pages 90°",
    pagesApply: "Page changes",
    compress: "Compress the PDF",
    watermark: "Watermark",
    pageNumbers: "Number pages",
    headerFooter: "Header and footer",
    crop: "Crop margins",
    rotate: "Rotate pages",
    metadata: "Edit metadata",
    repair: "Repair the PDF",
    ocr: "Recognise text (OCR)",
    unlock: "Remove signature restrictions",
    insertConverted: "Insert converted pages",
  },
  suite: {
    regionLabel: "PDF Pro",
    topBarLabel: "Document bar",
    undo: "Undo",
    redo: "Redo",
    download: "Download",
    close: "Close document",
    closeConfirmBody:
      "You have changes you haven't downloaded. If you close, only this browser's automatic draft (if enabled) will remain so you can pick it up.",
    unsaved: "Unsaved changes",
    saved: "No pending changes",
    pageCount: (count) => (count === 1 ? "1 page" : `${count} pages`),
    tabsLabel: "PDF Pro tools",
    tabs: {
      home: "Home",
      pages: "Pages",
      edit: "Edit",
      annotate: "Annotate",
      sign: "Sign",
      protect: "Protect",
      convert: "Convert",
    },
    thumbsTitle: "Pages",
    thumbsPlaceholder: (count) => `Thumbnails of the ${count} pages`,
    viewerTitle: "Document",
    viewerPlaceholder: "The document will be shown here, page by page.",
    contextTitle: "Tool panel",
    comingSoon: {
      pages: "Coming soon to PDF Pro: reorder, rotate, delete, split and merge pages.",
      edit: "Coming soon to PDF Pro: edit the text, images and shapes of the document.",
      annotate: "Coming soon to PDF Pro: highlight, comment and draw on the document.",
      sign: "Coming soon to PDF Pro: sign and fill in forms on the document.",
      protect: "Coming soon to PDF Pro: password-protect, redact and unlock.",
      convert: "Coming soon to PDF Pro: export to images, text and other formats.",
    },
    quickTitle: "Quick actions",
    historyTitle: "Change history",
    historyEmpty: "No changes yet: the document is as you opened it.",
    historyCurrent: "Current",
    historyGoTo: (label) => `Go back to: ${label}`,
    historyTrimmed: "The oldest steps were dropped to free memory.",
    historyRestoredTitle: (date) => `Recovered draft (${date})`,
    historyRestoredBody: "The earlier history can't be undone; new changes can.",
    running: "Applying…",
    cancel: "Cancel",
    cancelled: "Operation cancelled.",
    openedFrom: (tool) => `Opened from ${tool}`,
    openedFromMany: (tool, total) =>
      `Opened from ${tool}: the first of ${total} PDFs was opened. To merge them, use Pages → Insert from PDF.`,
    warningsTitle: "Before saving",
    warningsCount: (count) => (count === 1 ? "1 notice" : `${count} notices`),
    encryptedKeep: "You are working with a copy without a password.",
    openAnother: "Open another PDF",
  },
  empty: {
    title: "Open a PDF to work on it",
    subtitle:
      "Organize, edit, sign, protect and convert the same document without leaving the page. Everything happens in your browser and nothing is uploaded.",
    recentTitle: "Recent documents",
    recentEmpty: "Documents with unsaved changes will show up here.",
    recentOpen: (name) => `Open ${name}`,
    recentDraftNote: (count, date) =>
      `${count === 1 ? "1 change" : `${count} changes`} saved · ${date}`,
    toolsTitle: "Or use a single tool",
    toolsHint: "Every tool is still available on its own.",
    privacy: "Drafts are saved only in this browser.",
    checking: "Checking the file…",
    draftsUnavailable: "This browser can't save drafts.",
  },
  docTools: DOC_TOOLS_STRINGS.en,
  viewer: VIEWER_STRINGS_EN,
  pages: PAGES_STRINGS.en,
  palette: PALETTE_STRINGS_EN,
  shell: SHELL_STRINGS_EN,
  export: EXPORT_STRINGS.en,
  save: SAVE_STRINGS.en,
  create: CREATE_STRINGS.en,
  session: SESSION_STRINGS.en,
  drafts: {
    foundTitle: "You have a draft of this document",
    foundBody: (steps, date) =>
      `Saved on ${date}, with ${steps === 1 ? "1 change" : `${steps} changes`} not downloaded. Do you want to pick it up?`,
    restore: "Resume draft",
    discard: "Discard draft",
    restoring: "Recovering…",
    failed: "The draft couldn't be recovered.",
    saveFailed: "The automatic draft couldn't be saved.",
    saveTooBig: "The document is too large to be saved as a draft.",
    saveQuota: "There isn't enough browser space left to save the draft.",
  },
};

export const PRO_STRINGS: Record<Language, ProStrings> = { es, en };

export function getProStrings(language: Language): ProStrings {
  return PRO_STRINGS[language] ?? es;
}

/** Texto de un aviso con sus parametros sustituidos. */
export function proWarningText(language: Language, warning: ProWarning): string {
  const template = getProStrings(language).warnings[warning.code];
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    warning.params && key in warning.params ? String(warning.params[key]) : match,
  );
}

/** Etiqueta de una operacion (`labelKey`); si falta la clave se devuelve la propia clave. */
export function proOperationLabel(language: Language, labelKey: string): string {
  return getProStrings(language).operations[labelKey] ?? labelKey;
}

/** Fecha corta y local para borradores («11 oct, 14:32»). */
export function formatProDate(value: string | number, language: Language): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-US", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}
