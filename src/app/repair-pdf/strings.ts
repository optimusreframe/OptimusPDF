import type { Language } from "@/lib/i18n";
import type {
  DamageSignal,
  RepairAction,
  RepairFailure,
} from "@/lib/pdf/repair";

/**
 * Copy propio de Reparar PDF (ES/EN).
 *
 * REGLA DE ESTA HERRAMIENTA: ningun texto de aqui puede prometer mas de
 * lo que el motor midio. No existe un "¡reparado!" a secas: todos los
 * mensajes de exito se construyen a partir del `RepairReport`, y cuando
 * se pierde contenido el texto lo dice con numeros.
 */
export type RepairStrings = {
  /** Aviso permanente sobre el alcance real, visible antes de procesar. */
  scopeTitle: string;
  scopeBody: string;

  /** Estados del analisis. */
  idleTitle: string;
  idleBody: string;
  analyzing: string;

  /** Diagnostico. */
  damageTitle: string;
  damageNone: string;
  damageIntro: string;
  damage: Record<DamageSignal, string>;

  /** Que se pudo hacer. */
  planTitle: string;
  /** Sin danos detectados: no hizo falta tocar ni un byte. */
  actionsNone: string;
  actions: Record<RepairAction, string>;

  /** Resultado medido. */
  resultTitle: string;
  /** "6 páginas recuperadas" (sin denominador fiable). */
  pagesRecovered: (pages: number) => string;
  /** "4 de 6 páginas recuperadas" (con denominador declarado). */
  pagesRecoveredOf: (pages: number, declared: number) => string;
  /** Aviso destacado cuando se perdieron paginas. */
  pagesLost: (lost: number) => string;
  /** Confirmacion de que no falta ninguna pagina. */
  pagesComplete: string;
  /** Bytes del original que hubo que tirar. */
  bytesDiscarded: (formatted: string) => string;
  /** El texto sigue siendo texto. */
  textPreserved: string;
  /** Modo rasterizado: se pierde el texto seleccionable. */
  textLost: string;
  /** Paginas que ni siquiera pdf.js pudo rescatar. */
  failedPages: (list: string) => string;

  /** Errores. */
  errorTitle: string;
  /** Aviso de «Listo» cuando el PDF solo restringia editar/imprimir y se reparo una copia sin esas restricciones. */
  restrictedCopyTitle: string;
  restrictedCopyNotice: string;
  errors: Record<RepairFailure, string>;

  /** Sufijo del archivo descargado. */
  filenameSuffix: string;
  /** Aviso de archivo grande. */
  largeFile: string;
};

const ES: RepairStrings = {
  scopeTitle: "Qué puede y qué no puede hacer",
  scopeBody:
    "Esta herramienta reconstruye la estructura interna del PDF: índice de objetos (xref), trailer, cabecera y colas cortadas. No puede inventar bytes que ya no están en el archivo: si el documento se truncó, las páginas que se perdieron no vuelven. Siempre verás abajo, con números, qué se recuperó y qué no.",

  idleTitle: "Sin archivo todavía",
  idleBody:
    "Elige un PDF dañado. Se analizará y se reparará aquí mismo, en tu navegador: ningún byte sale de tu dispositivo.",
  analyzing: "Analizando y reparando el documento…",

  damageTitle: "Diagnóstico",
  damageNone:
    "No se detectó ningún daño estructural en el archivo original.",
  damageIntro: "Se encontró esto roto en el archivo original:",
  damage: {
    header: "La cabecera %PDF- no está al principio del archivo.",
    eof: "Falta la marca de fin de archivo (%%EOF): el PDF está cortado.",
    startxref: "No aparece la referencia al índice de objetos (startxref).",
    startxrefOffset:
      "La referencia al índice de objetos apunta a un sitio que no es un índice.",
    xrefEntries:
      "El índice de objetos (xref) existe, pero sus entradas están corruptas: los offsets no apuntan a donde deberían.",
    danglingObject:
      "El último objeto del archivo quedó abierto, sin cerrar con endobj.",
  },

  planTitle: "Qué se hizo",
  actionsNone:
    "Nada: el archivo original ya abría bien, así que se devuelve tal cual, byte por byte. Reescribirlo sin necesidad podría invalidar una firma digital que ya tuviera.",
  actions: {
    reindexed:
      "Se reindexaron todos los objetos y se escribieron un índice (xref) y un trailer nuevos.",
    headerRestored: "Se restauró la cabecera %PDF-.",
    tailTrimmed:
      "Se descartó la cola incompleta del archivo para poder leer todo lo anterior.",
    prunedPageTree:
      "El índice de páginas mencionaba páginas que ya no existían: se reconstruyó el documento copiando solo las que se pudieron leer de verdad, para que el PDF resultante no tenga referencias rotas.",
    rasterized:
      "No se pudo reconstruir la estructura, así que cada página se rescató como imagen.",
  },

  resultTitle: "Resultado",
  pagesRecovered: (pages) =>
    pages === 1 ? "1 página recuperada." : `${pages} páginas recuperadas.`,
  pagesRecoveredOf: (pages, declared) =>
    `${pages} de ${declared} páginas recuperadas.`,
  pagesLost: (lost) =>
    lost === 1
      ? "1 página no se pudo recuperar: sus datos ya no estaban en el archivo."
      : `${lost} páginas no se pudieron recuperar: sus datos ya no estaban en el archivo.`,
  pagesComplete: "No se perdió ninguna página.",
  bytesDiscarded: (formatted) =>
    `Se descartaron ${formatted} de datos ilegibles del final del archivo.`,
  textPreserved:
    "El texto, las fuentes y los gráficos vectoriales se conservan tal cual: el documento sigue siendo seleccionable y buscable.",
  textLost:
    "Aviso importante: las páginas se guardaron como imágenes. Se recupera lo que se ve, pero el texto deja de ser seleccionable y se pierden formularios y capas vectoriales.",
  failedPages: (list) => `Páginas que no se pudieron rescatar: ${list}.`,

  errorTitle: "No se pudo reparar",
  restrictedCopyTitle: "Copia sin restricciones",
  restrictedCopyNotice:
    "Este PDF tenía restricciones de edición o impresión (cifrado de solo propietario): se ha reparado una copia sin ellas.",
  errors: {
    unreadable:
      "No se reconoció ningún PDF dentro de este archivo. No hay nada que reconstruir: puede que el contenido se haya perdido por completo o que no sea un PDF.",
    encrypted:
      "El documento está cifrado y no se puede reparar sin la contraseña. Quítale la protección primero con Desbloquear PDF y vuelve a intentarlo.",
    noPagesRecovered:
      "El documento se pudo abrir, pero no se logró rescatar ni una sola página legible.",
    empty: "El archivo está vacío (0 bytes).",
  },

  filenameSuffix: "reparado",
  largeFile:
    "El archivo es muy grande: la reparación puede tardar y consumir bastante memoria.",
};

const EN: RepairStrings = {
  scopeTitle: "What this can and cannot do",
  scopeBody:
    "This tool rebuilds the PDF's internal structure: object index (xref), trailer, header and truncated tails. It cannot invent bytes that are no longer in the file: if the document was cut short, the lost pages do not come back. You will always see below, with numbers, what was recovered and what was not.",

  idleTitle: "No file yet",
  idleBody:
    "Pick a damaged PDF. It will be analysed and repaired right here, in your browser: not a single byte leaves your device.",
  analyzing: "Analysing and repairing the document…",

  damageTitle: "Diagnosis",
  damageNone: "No structural damage was detected in the original file.",
  damageIntro: "This was found broken in the original file:",
  damage: {
    header: "The %PDF- header is not at the start of the file.",
    eof: "The end-of-file marker (%%EOF) is missing: the PDF is cut short.",
    startxref: "The reference to the object index (startxref) is missing.",
    startxrefOffset:
      "The reference to the object index points somewhere that is not an index.",
    xrefEntries:
      "The object index (xref) is there, but its entries are corrupt: the offsets do not point where they should.",
    danglingObject:
      "The last object in the file was left open, never closed with endobj.",
  },

  planTitle: "What was done",
  actionsNone:
    "Nothing: the original file already opened fine, so it's returned as-is, byte for byte. Rewriting it unnecessarily could invalidate a digital signature it might carry.",
  actions: {
    reindexed:
      "All objects were re-indexed and a fresh index (xref) and trailer were written.",
    headerRestored: "The %PDF- header was restored.",
    tailTrimmed:
      "The incomplete tail of the file was discarded so everything before it could be read.",
    prunedPageTree:
      "The page index referred to pages that no longer existed: the document was rebuilt copying only the pages that could actually be read, so the resulting PDF has no broken references.",
    rasterized:
      "The structure could not be rebuilt, so each page was salvaged as an image.",
  },

  resultTitle: "Result",
  pagesRecovered: (pages) =>
    pages === 1 ? "1 page recovered." : `${pages} pages recovered.`,
  pagesRecoveredOf: (pages, declared) =>
    `${pages} of ${declared} pages recovered.`,
  pagesLost: (lost) =>
    lost === 1
      ? "1 page could not be recovered: its data was no longer in the file."
      : `${lost} pages could not be recovered: their data was no longer in the file.`,
  pagesComplete: "No pages were lost.",
  bytesDiscarded: (formatted) =>
    `${formatted} of unreadable data was discarded from the end of the file.`,
  textPreserved:
    "Text, fonts and vector graphics are kept as they were: the document is still selectable and searchable.",
  textLost:
    "Important: pages were saved as images. What you can see is recovered, but text is no longer selectable and forms and vector layers are lost.",
  failedPages: (list) => `Pages that could not be salvaged: ${list}.`,

  errorTitle: "Could not repair",
  restrictedCopyTitle: "Copy without restrictions",
  restrictedCopyNotice:
    "This PDF had editing or printing restrictions (owner-only encryption): a copy without them has been repaired.",
  errors: {
    unreadable:
      "No PDF was recognised inside this file. There is nothing to rebuild: the content may be lost entirely, or this may not be a PDF.",
    encrypted:
      "The document is encrypted and cannot be repaired without the password. Remove the protection first with Unlock PDF and try again.",
    noPagesRecovered:
      "The document could open, but not a single readable page could be salvaged.",
    empty: "The file is empty (0 bytes).",
  },

  filenameSuffix: "repaired",
  largeFile:
    "This file is very large: repairing it may take a while and use a lot of memory.",
};

export const REPAIR_STRINGS: Record<Language, RepairStrings> = { es: ES, en: EN };
