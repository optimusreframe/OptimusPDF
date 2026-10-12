import type { Language } from "@/lib/i18n";
import type { ProSignatureState } from "@/app/pdf-pro/proTypes";

/**
 * Textos de las herramientas de documento de PDF Pro (Wave 7 · U5), es/en. Cuelgan de
 * `PRO_STRINGS[lang].docTools`. Los paneles que ya existian como herramienta suelta (marca de agua,
 * numerar, comprimir, proteger, reparar, OCR, rotar) conservan SU texto propio: aqui solo vive lo nuevo.
 */

export type DocToolId =
  | "watermark"
  | "page-numbers"
  | "header-footer"
  | "compress"
  | "crop"
  | "rotate"
  | "metadata"
  | "repair"
  | "ocr"
  | "unlock";

export const DOC_TOOL_IDS: readonly DocToolId[] = [
  "watermark",
  "page-numbers",
  "header-footer",
  "compress",
  "crop",
  "rotate",
  "metadata",
  "repair",
  "ocr",
  "unlock",
] as const;

export type DocToolsStrings = {
  summary: {
    title: string;
    name: string;
    pages: string;
    size: string;
    signatures: string;
    signaturesValue: Record<ProSignatureState, string>;
    encryption: string;
    encryptedValue: string;
    plainValue: string;
    metadataTitle: string;
    metadataAuthor: string;
    metadataNone: string;
    metadataLoading: string;
    history: string;
    historyValue: (steps: number) => string;
  };
  launcher: {
    title: string;
    hint: string;
    open: (tool: string) => string;
    back: string;
    looseTitle: string;
    looseHint: string;
    looseNewTab: (tool: string) => string;
  };
  tools: Record<DocToolId, { title: string; description: string }>;
  runner: {
    apply: string;
    applying: string;
    cancel: string;
    previewTitle: string;
    previewAlt: (page: number) => string;
    previewLoading: string;
    previewUnavailable: string;
    previewOutOfRange: string;
    networkBadge: string;
    networkBody: string;
    appliedTitle: string;
    unchangedTitle: string;
    resultCompressTitle: string;
    rangeBeyond: string;
  };
  labels: {
    watermarkText: (text: string) => string;
    watermarkImage: string;
    pageNumbers: string;
    headerFooter: string;
    bates: string;
    compress: (level: string) => string;
    levels: { extreme: string; recommended: string; low: string };
    flattened: string;
    crop: string;
    rotate: (angle: number, scope: string) => string;
    rotateScopeAll: string;
    rotateScopeRange: (from: number, to: number) => string;
    metadataSet: string;
    metadataStrip: string;
    repair: string;
    ocr: (language: string) => string;
    unlock: string;
  };
  crop: {
    marginsTitle: string;
    top: string;
    right: string;
    bottom: string;
    left: string;
    linked: string;
    linkedHint: string;
    pageSize: (width: string, height: string) => string;
    scopeLabel: string;
    scopeAll: string;
    scopeRange: string;
    from: string;
    to: string;
    rangeHint: string;
    proportionalNote: string;
    nothingToCrop: string;
    tooSmall: string;
  };
  rotate: {
    scopeLabel: string;
    scopeAll: string;
    scopeRange: string;
    parityLabel: string;
    parityAll: string;
    parityOdd: string;
    parityEven: string;
    from: string;
    to: string;
    rangeHint: string;
    nothingSelected: string;
  };
  headerFooter: {
    headerTitle: string;
    footerTitle: string;
    left: string;
    center: string;
    right: string;
    tokensHint: string;
    nothingToStamp: string;
    batesTitle: string;
    batesToggle: string;
    batesHint: string;
    batesPrefix: string;
    batesStart: string;
    batesDigits: string;
    batesPreview: string;
    firstNumber: string;
    previewLabel: string;
  };
  metadata: {
    modeLabel: string;
    modeSet: string;
    modeStrip: string;
    loading: string;
    loadFailed: string;
    fieldTitle: string;
    fieldAuthor: string;
    fieldSubject: string;
    fieldKeywords: string;
    fieldKeywordsHint: string;
    fieldCreator: string;
    fieldProducer: string;
    fieldCreated: string;
    fieldModified: string;
    clearDate: string;
    xmpNote: string;
    keepXmp: string;
    customNote: (count: number) => string;
    stripTitle: string;
    stripBody: string;
    stripNothing: string;
    nothingChanged: string;
    xmpRemovedNote: string;
  };
  repair: {
    analysisTitle: string;
    healthy: string;
    nothingToRepair: string;
    resultTitle: string;
  };
  unlock: {
    title: string;
    checking: string;
    inspectFailed: string;
    noRestrictions: string;
    restrictionsFound: string;
    consent: string;
    consentHint: string;
    consentRequired: string;
    decryptedTitle: string;
    decryptedBody: string;
    reprotectHint: string;
  };
  protect: {
    title: string;
    intro: string;
    saveTitle: string;
    saveButton: string;
    saving: string;
    saved: (name: string) => string;
    notAStep: string;
    legacyIgnored: string;
    failed: string;
    encryptedOriginTitle: string;
    encryptedOriginBody: string;
    signaturesWarning: string;
    unlockSection: string;
  };
  convert: {
    title: string;
    intro: string;
    imagesTitle: string;
    imagesBody: string;
    textTitle: string;
    textBody: string;
    comingSoon: string;
    openTool: (tool: string) => string;
    requiresNetwork: string;
    localOnly: string;
  };
};

const es: DocToolsStrings = {
  summary: {
    title: "Resumen del documento",
    name: "Archivo",
    pages: "Páginas",
    size: "Tamaño",
    signatures: "Firmas digitales",
    signaturesValue: { none: "Sin firmas", active: "Con firmas activas", unknown: "No se pudo comprobar" },
    encryption: "Cifrado",
    encryptedValue: "Abierto con copia sin contraseña",
    plainValue: "Sin contraseña",
    metadataTitle: "Título",
    metadataAuthor: "Autor",
    metadataNone: "Sin datos",
    metadataLoading: "Leyendo…",
    history: "Historial",
    historyValue: (steps) => (steps === 0 ? "Sin cambios" : steps === 1 ? "1 cambio" : `${steps} cambios`),
  },
  launcher: {
    title: "Herramientas del documento",
    hint: "Cada una actúa sobre todo el documento y se puede deshacer con Ctrl+Z.",
    open: (tool) => `Abrir ${tool}`,
    back: "Volver a herramientas",
    looseTitle: "Otras herramientas",
    looseHint: "Se abren en otra pestaña: este documento sigue aquí.",
    looseNewTab: (tool) => `${tool} (se abre en otra pestaña)`,
  },
  tools: {
    watermark: { title: "Marca de agua", description: "Estampa un texto o una imagen en las páginas." },
    "page-numbers": { title: "Numerar páginas", description: "Añade el número de página con el formato que elijas." },
    "header-footer": { title: "Encabezado, pie y Bates", description: "Texto a izquierda, centro y derecha, con fecha, nombre y numeración Bates." },
    compress: { title: "Comprimir", description: "Reduce el peso del archivo y muestra el ahorro real." },
    crop: { title: "Recortar", description: "Quita márgenes de las páginas con medidas exactas." },
    rotate: { title: "Rotar", description: "Gira todas las páginas o solo un rango." },
    metadata: { title: "Metadatos", description: "Lee y edita título, autor y más; o elimínalos todos." },
    repair: { title: "Reparar", description: "Comprueba la estructura del PDF y reconstruye lo que esté dañado." },
    ocr: { title: "Reconocer texto (OCR)", description: "Hace buscable y copiable el texto de un escaneo." },
    unlock: { title: "Quitar protección", description: "Retira las restricciones de firma o confirma que no hay contraseña." },
  },
  runner: {
    apply: "Aplicar",
    applying: "Aplicando…",
    cancel: "Cancelar",
    previewTitle: "Vista previa de la página 1",
    previewAlt: (page) => `Vista previa del resultado en la página ${page}`,
    previewLoading: "Preparando la vista previa…",
    previewUnavailable: "No se pudo generar la vista previa; aun así puedes aplicar.",
    previewOutOfRange: "La página 1 no entra en el rango elegido, así que no cambia.",
    networkBadge: "Requiere conexión",
    networkBody:
      "La primera vez descarga el motor de reconocimiento y el idioma desde una red pública (unos megabytes). Tu documento no se envía a ninguna parte; sin conexión no funcionará.",
    appliedTitle: "Aplicado",
    unchangedTitle: "Sin cambios",
    resultCompressTitle: "Ahorro conseguido",
    rangeBeyond: "El rango empieza después de la última página del documento.",
  },
  labels: {
    watermarkText: (text) => `Marca de agua “${text}”`,
    watermarkImage: "Marca de agua (imagen)",
    pageNumbers: "Numerar páginas",
    headerFooter: "Encabezado y pie",
    bates: "Numeración Bates",
    compress: (level) => `Comprimir (${level})`,
    levels: { extreme: "extrema", recommended: "recomendada", low: "baja" },
    flattened: "aplanado",
    crop: "Recortar márgenes",
    rotate: (angle, scope) => `Rotar ${angle}° (${scope})`,
    rotateScopeAll: "todas las páginas",
    rotateScopeRange: (from, to) => (from === to ? `página ${from}` : `páginas ${from}–${to}`),
    metadataSet: "Editar metadatos",
    metadataStrip: "Eliminar metadatos",
    repair: "Reparar el PDF",
    ocr: (language) => `Reconocer texto (${language})`,
    unlock: "Quitar restricciones de firma",
  },
  crop: {
    marginsTitle: "Márgenes que se quitan",
    top: "Arriba",
    right: "Derecha",
    bottom: "Abajo",
    left: "Izquierda",
    linked: "Igual en todas",
    linkedHint: "Un solo valor para los cuatro lados.",
    pageSize: (width, height) => `Medidas de la página 1: ${width} × ${height} mm`,
    scopeLabel: "Aplicar a",
    scopeAll: "Todas las páginas",
    scopeRange: "Un rango",
    from: "Desde",
    to: "Hasta",
    rangeHint: "Deja «Hasta» en 0 para llegar a la última página.",
    proportionalNote: "El recorte es proporcional: si las páginas tienen tamaños distintos, cada una se recorta en la misma proporción.",
    nothingToCrop: "Indica algún margen mayor que 0 para recortar.",
    tooSmall: "Los márgenes dejan una página demasiado pequeña: reduce alguno.",
  },
  rotate: {
    scopeLabel: "Qué se gira",
    scopeAll: "Todo",
    scopeRange: "Un rango",
    parityLabel: "Páginas del rango",
    parityAll: "Todas",
    parityOdd: "Impares",
    parityEven: "Pares",
    from: "Desde",
    to: "Hasta",
    rangeHint: "Deja «Hasta» en 0 para llegar a la última página.",
    nothingSelected: "El rango elegido no incluye ninguna página.",
  },
  headerFooter: {
    headerTitle: "Encabezado",
    footerTitle: "Pie de página",
    left: "Izquierda",
    center: "Centro",
    right: "Derecha",
    tokensHint: "Marcadores: {n} número de página, {p} total, {fecha}, {nombre} del archivo y {bates}.",
    nothingToStamp: "Escribe algún texto en el encabezado o en el pie.",
    batesTitle: "Numeración Bates",
    batesToggle: "Activar Bates",
    batesHint: "Un número único por página (p. ej. CASO-000123). Úsalo con el marcador {bates}.",
    batesPrefix: "Prefijo",
    batesStart: "Primer número",
    batesDigits: "Cifras",
    batesPreview: "Primera página",
    firstNumber: "Primer número de página",
    previewLabel: "Se verá así en la primera página",
  },
  metadata: {
    modeLabel: "Qué hacer",
    modeSet: "Editar datos",
    modeStrip: "Eliminar todos",
    loading: "Leyendo los metadatos…",
    loadFailed: "No se pudieron leer los metadatos de este PDF.",
    fieldTitle: "Título",
    fieldAuthor: "Autor",
    fieldSubject: "Asunto",
    fieldKeywords: "Palabras clave",
    fieldKeywordsHint: "Separadas por comas.",
    fieldCreator: "Creador (aplicación)",
    fieldProducer: "Productor (motor PDF)",
    fieldCreated: "Fecha de creación",
    fieldModified: "Fecha de modificación",
    clearDate: "Quitar fecha",
    xmpNote:
      "Este PDF trae también metadatos XMP. Si cambias algún dato se eliminan para que no contradigan los nuevos.",
    keepXmp: "Conservar los metadatos XMP",
    customNote: (count) =>
      count === 1 ? "Además tiene 1 dato personalizado, que no se toca." : `Además tiene ${count} datos personalizados, que no se tocan.`,
    stripTitle: "Eliminar todos los metadatos",
    stripBody:
      "Borra título, autor, asunto, palabras clave, creador, productor, fechas, datos personalizados y el XMP incrustado. El contenido de las páginas no cambia.",
    stripNothing: "Este documento no tiene metadatos que eliminar.",
    nothingChanged: "Cambia algún dato para poder aplicar.",
    xmpRemovedNote: "Se eliminaron también los metadatos XMP.",
  },
  repair: {
    analysisTitle: "Estado del documento",
    healthy: "No se detectaron daños en la estructura del archivo.",
    nothingToRepair: "No se detectaron daños: no hay nada que reparar.",
    resultTitle: "Informe de la reparación",
  },
  unlock: {
    title: "Protección del documento",
    checking: "Comprobando la protección…",
    inspectFailed: "No se pudo comprobar la protección de este PDF con seguridad.",
    noRestrictions: "Este documento no tiene restricciones de firma que quitar.",
    restrictionsFound: "Este documento tiene firmas que restringen cambios. Puedes quitar esas restricciones, pero las firmas dejarán de ser válidas.",
    consent: "Entiendo que las firmas dejarán de ser válidas",
    consentHint: "Es necesario para quitar las restricciones.",
    consentRequired: "Marca la confirmación para quitar las restricciones de firma.",
    decryptedTitle: "El documento de trabajo no tiene contraseña",
    decryptedBody:
      "El archivo que abriste estaba cifrado; trabajas con una copia descifrada en memoria que no se guarda como borrador. Los cambios se hacen sobre esa copia y, al exportar, saldrá sin contraseña.",
    reprotectHint: "Si quieres volver a protegerlo, hazlo al guardar desde la pestaña Proteger.",
  },
  protect: {
    title: "Proteger y exportar",
    intro:
      "La contraseña se aplica al guardar una copia: el documento de trabajo sigue editable y nunca se guarda cifrado en el historial ni en los borradores.",
    saveTitle: "Guardar con contraseña",
    saveButton: "Guardar con contraseña…",
    saving: "Cifrando…",
    saved: (name) => `Guardado: ${name}`,
    notAStep: "Es una opción de guardado: no añade ningún paso al historial.",
    legacyIgnored:
      "Este PDF usa un cifrado antiguo y no admite restringir rellenar formularios ni ensamblar el documento: esas restricciones no tendrán efecto.",
    failed: "No se pudo guardar la copia protegida.",
    encryptedOriginTitle: "Abriste un PDF con contraseña",
    encryptedOriginBody:
      "Trabajas con una copia sin contraseña. Si quieres que el resultado siga protegido, guárdalo con contraseña aquí.",
    signaturesWarning: "Este PDF tiene firmas digitales: cifrarlo cambia el archivo y las dejará de hacer válidas.",
    unlockSection: "Quitar protección",
  },
  convert: {
    title: "Convertir y exportar",
    intro: "Convierte el documento actual, con todos tus cambios, a otro formato. Todo ocurre en tu navegador y el documento no cambia.",
    imagesTitle: "A imágenes",
    imagesBody: "Cada página como PNG o JPG.",
    textTitle: "A texto",
    textBody: "El texto del documento en un archivo de texto.",
    comingSoon: "Próximamente en PDF Pro",
    openTool: (tool) => `Abrir «${tool}» en otra pestaña`,
    requiresNetwork: "Requiere conexión",
    localOnly: "Sin conexión",
  },
};

const en: DocToolsStrings = {
  summary: {
    title: "Document summary",
    name: "File",
    pages: "Pages",
    size: "Size",
    signatures: "Digital signatures",
    signaturesValue: { none: "No signatures", active: "Has active signatures", unknown: "Couldn't check" },
    encryption: "Encryption",
    encryptedValue: "Opened as a copy without password",
    plainValue: "No password",
    metadataTitle: "Title",
    metadataAuthor: "Author",
    metadataNone: "No data",
    metadataLoading: "Reading…",
    history: "History",
    historyValue: (steps) => (steps === 0 ? "No changes" : steps === 1 ? "1 change" : `${steps} changes`),
  },
  launcher: {
    title: "Document tools",
    hint: "Each one acts on the whole document and can be undone with Ctrl+Z.",
    open: (tool) => `Open ${tool}`,
    back: "Back to tools",
    looseTitle: "Other tools",
    looseHint: "They open in another tab: this document stays here.",
    looseNewTab: (tool) => `${tool} (opens in another tab)`,
  },
  tools: {
    watermark: { title: "Watermark", description: "Stamp a text or an image on the pages." },
    "page-numbers": { title: "Number pages", description: "Add the page number with the format you choose." },
    "header-footer": { title: "Header, footer & Bates", description: "Left, centre and right text, with date, name and Bates numbering." },
    compress: { title: "Compress", description: "Shrink the file and show the real saving." },
    crop: { title: "Crop", description: "Trim page margins with exact measurements." },
    rotate: { title: "Rotate", description: "Turn all pages or just a range." },
    metadata: { title: "Metadata", description: "Read and edit title, author and more; or remove them all." },
    repair: { title: "Repair", description: "Check the PDF structure and rebuild what is damaged." },
    ocr: { title: "Recognise text (OCR)", description: "Make the text of a scan searchable and copyable." },
    unlock: { title: "Remove protection", description: "Remove signature restrictions or confirm there is no password." },
  },
  runner: {
    apply: "Apply",
    applying: "Applying…",
    cancel: "Cancel",
    previewTitle: "Preview of page 1",
    previewAlt: (page) => `Preview of the result on page ${page}`,
    previewLoading: "Preparing the preview…",
    previewUnavailable: "The preview couldn't be generated; you can still apply.",
    previewOutOfRange: "Page 1 is outside the chosen range, so it doesn't change.",
    networkBadge: "Needs a connection",
    networkBody:
      "The first time it downloads the recognition engine and the language from a public network (a few megabytes). Your document is not sent anywhere; offline it won't work.",
    appliedTitle: "Applied",
    unchangedTitle: "No changes",
    resultCompressTitle: "Saving achieved",
    rangeBeyond: "The range starts after the last page of the document.",
  },
  labels: {
    watermarkText: (text) => `Watermark “${text}”`,
    watermarkImage: "Watermark (image)",
    pageNumbers: "Number pages",
    headerFooter: "Header and footer",
    bates: "Bates numbering",
    compress: (level) => `Compress (${level})`,
    levels: { extreme: "extreme", recommended: "recommended", low: "low" },
    flattened: "flattened",
    crop: "Crop margins",
    rotate: (angle, scope) => `Rotate ${angle}° (${scope})`,
    rotateScopeAll: "all pages",
    rotateScopeRange: (from, to) => (from === to ? `page ${from}` : `pages ${from}–${to}`),
    metadataSet: "Edit metadata",
    metadataStrip: "Remove metadata",
    repair: "Repair the PDF",
    ocr: (language) => `Recognise text (${language})`,
    unlock: "Remove signature restrictions",
  },
  crop: {
    marginsTitle: "Margins to remove",
    top: "Top",
    right: "Right",
    bottom: "Bottom",
    left: "Left",
    linked: "Same on all sides",
    linkedHint: "A single value for the four sides.",
    pageSize: (width, height) => `Page 1 size: ${width} × ${height} mm`,
    scopeLabel: "Apply to",
    scopeAll: "Every page",
    scopeRange: "A range",
    from: "From",
    to: "To",
    rangeHint: "Leave “To” at 0 to reach the last page.",
    proportionalNote: "The crop is proportional: if pages have different sizes, each one is cropped by the same ratio.",
    nothingToCrop: "Enter a margin greater than 0 to crop.",
    tooSmall: "The margins leave a page that is too small: reduce one of them.",
  },
  rotate: {
    scopeLabel: "What to rotate",
    scopeAll: "Everything",
    scopeRange: "A range",
    parityLabel: "Pages in the range",
    parityAll: "All",
    parityOdd: "Odd",
    parityEven: "Even",
    from: "From",
    to: "To",
    rangeHint: "Leave “To” at 0 to reach the last page.",
    nothingSelected: "The chosen range includes no pages.",
  },
  headerFooter: {
    headerTitle: "Header",
    footerTitle: "Footer",
    left: "Left",
    center: "Centre",
    right: "Right",
    tokensHint: "Tokens: {n} page number, {p} total, {fecha} date, {nombre} file name and {bates}.",
    nothingToStamp: "Type some text in the header or the footer.",
    batesTitle: "Bates numbering",
    batesToggle: "Turn on Bates",
    batesHint: "A unique number per page (e.g. CASE-000123). Use it with the {bates} token.",
    batesPrefix: "Prefix",
    batesStart: "First number",
    batesDigits: "Digits",
    batesPreview: "First page",
    firstNumber: "First page number",
    previewLabel: "It will read like this on the first page",
  },
  metadata: {
    modeLabel: "What to do",
    modeSet: "Edit data",
    modeStrip: "Remove all",
    loading: "Reading the metadata…",
    loadFailed: "The metadata of this PDF couldn't be read.",
    fieldTitle: "Title",
    fieldAuthor: "Author",
    fieldSubject: "Subject",
    fieldKeywords: "Keywords",
    fieldKeywordsHint: "Separated by commas.",
    fieldCreator: "Creator (application)",
    fieldProducer: "Producer (PDF engine)",
    fieldCreated: "Creation date",
    fieldModified: "Modification date",
    clearDate: "Clear date",
    xmpNote:
      "This PDF also carries XMP metadata. If you change any data it is removed so it doesn't contradict the new values.",
    keepXmp: "Keep the XMP metadata",
    customNote: (count) =>
      count === 1 ? "It also has 1 custom entry, which is left alone." : `It also has ${count} custom entries, which are left alone.`,
    stripTitle: "Remove all metadata",
    stripBody:
      "Deletes title, author, subject, keywords, creator, producer, dates, custom entries and the embedded XMP. The page content doesn't change.",
    stripNothing: "This document has no metadata to remove.",
    nothingChanged: "Change some data to be able to apply.",
    xmpRemovedNote: "The XMP metadata was removed too.",
  },
  repair: {
    analysisTitle: "Document status",
    healthy: "No damage was detected in the file structure.",
    nothingToRepair: "No damage detected: there is nothing to repair.",
    resultTitle: "Repair report",
  },
  unlock: {
    title: "Document protection",
    checking: "Checking the protection…",
    inspectFailed: "The protection of this PDF couldn't be checked safely.",
    noRestrictions: "This document has no signature restrictions to remove.",
    restrictionsFound: "This document has signatures that restrict changes. You can remove those restrictions, but the signatures will stop being valid.",
    consent: "I understand the signatures will stop being valid",
    consentHint: "Required to remove the restrictions.",
    consentRequired: "Tick the confirmation to remove the signature restrictions.",
    decryptedTitle: "The working document has no password",
    decryptedBody:
      "The file you opened was encrypted; you are working with a decrypted copy in memory that is never saved as a draft. Changes are made on that copy and it will be exported without a password.",
    reprotectHint: "If you want to protect it again, do it when saving from the Protect tab.",
  },
  protect: {
    title: "Protect and export",
    intro:
      "The password is applied when saving a copy: the working document stays editable and is never stored encrypted in the history or in drafts.",
    saveTitle: "Save with password",
    saveButton: "Save with password…",
    saving: "Encrypting…",
    saved: (name) => `Saved: ${name}`,
    notAStep: "This is a save option: it adds no step to the history.",
    legacyIgnored:
      "This PDF uses an older encryption that can't restrict form filling or document assembly: those restrictions won't take effect.",
    failed: "The protected copy couldn't be saved.",
    encryptedOriginTitle: "You opened a password-protected PDF",
    encryptedOriginBody:
      "You are working with a copy without a password. If you want the result to stay protected, save it with a password here.",
    signaturesWarning: "This PDF has digital signatures: encrypting it changes the file and will make them invalid.",
    unlockSection: "Remove protection",
  },
  convert: {
    title: "Convert and export",
    intro: "Converts the current document, with all your changes, to another format. Everything happens in your browser and the document doesn't change.",
    imagesTitle: "To images",
    imagesBody: "Each page as PNG or JPG.",
    textTitle: "To text",
    textBody: "The text of the document in a text file.",
    comingSoon: "Coming soon to PDF Pro",
    openTool: (tool) => `Open “${tool}” in another tab`,
    requiresNetwork: "Needs a connection",
    localOnly: "Works offline",
  },
};

export const DOC_TOOLS_STRINGS: Record<Language, DocToolsStrings> = { es, en };

export function getDocToolsStrings(language: Language): DocToolsStrings {
  return DOC_TOOLS_STRINGS[language] ?? es;
}
