import type { ToolCategory, ToolSlug } from "@/lib/tools-registry";

export type ToolCopy = {
  name: string;
  description: string;
};

const tools: Record<ToolSlug, ToolCopy> = {
  "merge-pdf": {
    name: "Unir PDF",
    description:
      "Combina varios PDF en un solo documento y decide el orden exacto de cada archivo.",
  },
  "split-pdf": {
    name: "Dividir PDF",
    description:
      "Parte un documento por rangos, cada N páginas o extrae secciones sueltas en un ZIP.",
  },
  "remove-pages": {
    name: "Eliminar páginas",
    description:
      "Quita las páginas que sobran marcándolas sobre las miniaturas del documento.",
  },
  "extract-pages": {
    name: "Extraer páginas",
    description:
      "Crea un PDF nuevo solo con las páginas que selecciones del original.",
  },
  "organize-pdf": {
    name: "Organizar PDF",
    description:
      "Reordena, gira y elimina páginas en una sola vista de miniaturas.",
  },
  "rotate-pdf": {
    name: "Rotar PDF",
    description:
      "Gira páginas sueltas o el documento entero en múltiplos de 90 grados.",
  },
  "pdfs-to-zip": {
    name: "PDFs a ZIP",
    description:
      "Empaqueta varios PDF en un solo archivo ZIP sin fusionar ni reprocesar su contenido.",
  },
  "compress-pdf": {
    name: "Comprimir PDF",
    description:
      "Reduce el peso reprocesando imágenes y limpiando objetos, sin destrozar la lectura.",
  },
  "repair-pdf": {
    name: "Reparar PDF",
    description:
      "Recupera documentos dañados reconstruyendo su estructura interna.",
  },
  "ocr-pdf": {
    name: "OCR de PDF",
    description:
      "Reconoce el texto de documentos escaneados para poder buscarlo y copiarlo.",
  },
  "jpg-to-pdf": {
    name: "Imagen a PDF",
    description:
      "Convierte JPG, PNG o WEBP en un PDF eligiendo tamaño de página, margen y orientación.",
  },
  "word-to-pdf": {
    name: "Word a PDF",
    description:
      "Pasa documentos DOC y DOCX a PDF conservando el formato original.",
  },
  "powerpoint-to-pdf": {
    name: "PowerPoint a PDF",
    description:
      "Convierte presentaciones PPT y PPTX en un PDF listo para enviar.",
  },
  "excel-to-pdf": {
    name: "Excel a PDF",
    description: "Convierte hojas de cálculo XLS y XLSX en un PDF paginado.",
  },
  "html-to-pdf": {
    name: "HTML a PDF",
    description: "Captura una página web o un archivo HTML como documento PDF.",
  },
  "scan-to-pdf": {
    name: "Escanear a PDF",
    description:
      "Usa la cámara del móvil como escáner y guarda las capturas en un PDF.",
  },
  "pdf-to-jpg": {
    name: "PDF a JPG",
    description:
      "Convierte cada página en una imagen JPG y descárgalas juntas en un ZIP.",
  },
  "pdf-to-word": {
    name: "PDF a Word",
    description: "Convierte el PDF en un documento DOCX editable.",
  },
  "pdf-to-powerpoint": {
    name: "PDF a PowerPoint",
    description: "Convierte el PDF en una presentación PPTX con una imagen de página por diapositiva (no es texto editable).",
  },
  "pdf-to-excel": {
    name: "PDF a Excel",
    description: "Extrae las tablas del PDF a una hoja de cálculo XLSX.",
  },
  "pdf-to-csv": {
    name: "Extraer tablas",
    description: "Extrae solo las tablas de un PDF a un archivo CSV o JSON.",
  },
  "pdf-to-pdfa": {
    name: "Verificar PDF/A",
    description:
      "Revisa si tu PDF cumple los requisitos de PDF/A y qué le falta para lograrlo. No convierte el archivo.",
  },
  "pdf-to-markdown": {
    name: "PDF a Markdown",
    description:
      "Extrae el texto del PDF como Markdown: títulos, listas, código y tablas regulares. Con OCR para páginas escaneadas.",
  },
  "pdf-to-text": {
    name: "PDF a Texto",
    description:
      "Extrae todo el texto del PDF a un archivo .txt plano, página por página, sin formato. Con OCR para páginas escaneadas.",
  },
  "pdf-to-json": {
    name: "PDF a JSON",
    description:
      "Serializa el PDF completo como JSON estructurado: títulos, párrafos, listas, tablas y bloques de código. Con OCR para páginas escaneadas.",
  },
  "add-page-numbers": {
    name: "Numerar páginas",
    description:
      "Añade numeración eligiendo posición, formato, tipografía y página de inicio.",
  },
  "add-watermark": {
    name: "Marca de agua",
    description:
      "Superpone texto o imagen con control de opacidad, rotación y mosaico.",
  },
  "crop-pdf": {
    name: "Recortar PDF",
    description:
      "Ajusta los márgenes del documento dibujando el área útil sobre la vista previa.",
  },
  "edit-pdf": {
    name: "Editar PDF",
    description:
      "Añade texto, imágenes, formas y resaltados sobre las páginas del documento.",
  },
  "sign-pdf": {
    name: "Firmar PDF",
    description:
      "Dibuja, escribe o sube tu firma y colócala donde la necesites.",
  },
  "compare-pdf": {
    name: "Comparar PDF",
    description:
      "Enfrenta dos versiones del mismo documento y resalta las diferencias de texto.",
  },
  "pdf-summarizer": {
    name: "Resumir PDF",
    description: "Obtén un resumen del documento con los puntos clave.",
  },
  "translate-pdf": {
    name: "Informe de traducción",
    description:
      "Traduce el texto del PDF con un modelo local y genera un informe bilingüe, página a página. No devuelve un PDF traducido.",
  },
  "protect-pdf": {
    name: "Proteger PDF",
    description:
      "Cifra el documento con contraseña para que solo lo abra quien tú decidas.",
  },
  "unlock-pdf": {
    name: "Desbloquear PDF",
    description:
      "Quita lo que bloquea el documento: la contraseña o la certificación de una firma digital.",
  },
  "redact-pdf": {
    name: "Censurar PDF",
    description:
      "Tapa datos sensibles con cajas opacas y aplana la página para que no se recuperen.",
  },
};

/**
 * Nombre base del archivo de salida por herramienta. Es parcial a
 * proposito: cada workstream anade el suyo y, si falta, la UI recurre al
 * nombre de la herramienta.
 */
const filenames: Partial<Record<ToolSlug, string>> = {
  "merge-pdf": "documento-unido",
  "split-pdf": "documento-dividido",
  "remove-pages": "documento-sin-paginas",
  "extract-pages": "paginas-extraidas",
  "organize-pdf": "documento-organizado",
  "rotate-pdf": "documento-girado",
  "jpg-to-pdf": "documento-convertido",
  "pdf-to-jpg": "paginas-imagen",
  "scan-to-pdf": "documento-escaneado",
  "add-watermark": "documento-con-marca",
  "add-page-numbers": "documento-numerado",
  "crop-pdf": "documento-recortado",
  "sign-pdf": "documento-firmado",
  "compare-pdf": "documento-comparado",
  "compress-pdf": "documento-comprimido",
  "protect-pdf": "documento-protegido",
  "unlock-pdf": "documento-desbloqueado",
  "redact-pdf": "documento-censurado",
  "ocr-pdf": "documento-ocr",
};

const categories: Record<
  ToolCategory,
  { label: string; description: string }
> = {
  organize: {
    label: "Organizar",
    description: "Une, divide, reordena y limpia páginas.",
  },
  optimize: {
    label: "Optimizar",
    description: "Reduce peso y recupera el texto de tus escaneos.",
  },
  "convert-to": {
    label: "Convertir a PDF",
    description: "Lleva imágenes y documentos al formato PDF.",
  },
  "convert-from": {
    label: "Convertir desde PDF",
    description: "Saca de tu PDF imágenes, tablas y otros formatos.",
  },
  edit: {
    label: "Editar y analizar",
    description: "Anota, firma, numera y compara documentos.",
  },
  security: {
    label: "Seguridad",
    description: "Cifra, desbloquea y censura información sensible.",
  },
};

export const es = {
  common: {
    brandFirst: "Optimus",
    brandSecond: "PDF",
    live: "Disponible",
    soon: "Próximamente",
    localBadge: "100% local",
    zeroUploads: "0 subidas",
    localAndZeroUploads: "100% local · 0 subidas",
    cancel: "Cancelar",
    close: "Cerrar",
    back: "Volver",
    continueLabel: "Continuar",
    loading: "Cargando",
    language: "Idioma",
    spanish: "Español",
    english: "Inglés",
    light: "Claro",
    dark: "Oscuro",
    system: "Sistema",
    skipToContent: "Ir al contenido",
    openMenu: "Abrir menú",
    closeMenu: "Cerrar menú",
  },
  nav: {
    home: "Inicio",
    primaryNav: "Navegación principal",
    recent: "Recientes",
    settings: "Ajustes",
    pricing: "Precios",
    about: "Proyecto",
    allTools: "Ver todas las herramientas",
    searchPlaceholder: "Buscar herramienta…",
    searchEmpty: "Sin resultados",
    collapseSidebar: "Colapsar barra lateral",
    expandSidebar: "Expandir barra lateral",
    categoriesLabel: "Categorías",
  },
  categories,
  home: {
    title: "Herramientas",
    searchPlaceholder: "Buscar herramienta",
    clearSearch: "Borrar búsqueda",
    resultOne: "resultado",
    resultMany: "resultados",
    searchEmptyTitle: "Nada coincide con tu búsqueda",
    searchEmptyHint: "Prueba con lo que quieres hacer: unir, comprimir, firmar, convertir…",
    mostUsedTitle: "Más usadas",
    mostUsedSeeAll: "Ver historial",
    liveCount: "disponibles ahora",
    soonCount: "en camino",
  },
  tool: {
    dropTitle: "Suelta tu archivo aquí",
    dropTitleMultiple: "Suelta tus archivos aquí",
    dropSubtitle: "o pulsa para elegirlo desde el dispositivo",
    dropButton: "Seleccionar archivo",
    dropButtonMultiple: "Seleccionar archivos",
    addMore: "Añadir más archivos",
    filesTitle: "Archivos",
    remove: "Quitar",
    moveUp: "Subir",
    moveDown: "Bajar",
    optionsTitle: "Opciones",
    openOptions: "Opciones",
    run: "Procesar",
    processingTitle: "Procesando",
    processingHint: "Todo ocurre en tu dispositivo. No cierres esta pestaña.",
    doneTitle: "Listo",
    doneSubtitle: "Tu documento está preparado para descargar.",
    download: "Descargar",
    startOver: "Empezar de nuevo",
    resultSize: "Peso del resultado",
    relatedTitle: "Sigue con estas",
    pagesPreview: "Vista previa de páginas",
    dragToReorder: "Arrastra para reordenar",
    selectAll: "Seleccionar todo",
    clearSelection: "Quitar selección",
    rotate: "Girar",
    page: "Página",
    localNotice: "Este archivo no se sube a ningún servidor.",
    accepts: "Acepta",
    upTo: "hasta",
    dropActive: "Suelta para añadir",
    skippedOne: "Se omitió {names}: formato no admitido.",
    skippedMany: "Se omitieron {count} archivos ({names}): formato no admitido.",
    // Entrega por lotes con fallos parciales (`ProcessResult.report`).
    partialReportTitle: "{ok} de {total} documentos firmados",
    partialReportIntro: "No se pudo firmar:",
    partialReportItem: "{name} ({reason})",
    errors: {
      title: "No se pudo completar",
      invalidType: "Ese formato no sirve para esta herramienta.",
      encryptedAction: "Abrir Desbloquear PDF",
      encrypted:
        "El PDF está protegido con contraseña. Quítala primero con Desbloquear PDF.",
      corrupt: "El archivo parece dañado y no se puede leer.",
      empty: "Necesitas añadir al menos un archivo.",
      needTwo: "Esta herramienta necesita al menos dos archivos.",
      tooLarge:
        "El archivo supera los 100 MB: el navegador puede quedarse sin memoria.",
      unknown: "Algo ha fallado durante el proceso. Vuelve a intentarlo.",
      cancelled: "Proceso cancelado.",
      wrongPassword: "Esa contraseña no abre el documento.",
      notProtected: "Este documento no tiene ninguna protección que quitar.",
      certificateEncryption:
        "Este PDF usa cifrado por certificado digital: no es compatible con esta herramienta.",
      unsupportedSecurityHandler:
        "Este PDF usa un método de cifrado que no reconocemos.",
      consentRequired:
        "Esta operación invalidaría las firmas del documento: hace falta confirmarlo antes.",
      inspectionIncomplete:
        "No pudimos comprobar con seguridad las restricciones de este PDF, así que no vamos a crear una copia que podría conservar protecciones sin avisarte.",
      nothingSelected: "Selecciona o marca algo antes de procesar.",
      ocrNetworkFailure:
        "No se pudieron descargar los archivos del motor de OCR. Comprueba tu conexión y vuelve a intentarlo.",
      ocrEngineFailure:
        "El motor de OCR falló al leer este documento. Vuelve a intentarlo; si persiste, puede que esas páginas escaneadas no se puedan reconocer.",
      modelDownloadFailure:
        "No se pudo descargar el modelo de resumen. Comprueba tu conexión y vuelve a intentarlo.",
      deviceLost:
        "El modelo no ha podido completar el resumen. Suele ser falta de memoria de vídeo: prueba con el modelo ligero, cierra otras pestañas y vuelve a intentarlo.",
      legacyOfficeFormat:
        "Solo soportamos el formato moderno (.docx/.xlsx/.pptx), no el antiguo (.doc/.xls/.ppt). Guarda el archivo en el formato nuevo desde Word, Excel o PowerPoint y vuelve a intentarlo.",
      unsupportedScript:
        "Este documento tiene texto (chino, japonés, coreano, árabe, hebreo, tailandés o emoji, por ejemplo) que esta herramienta todavía no puede dibujar en el PDF. Por ahora solo soportamos alfabetos latinos, cirílico y griego.",
      noTablesFound:
        "No encontramos ninguna tabla en este PDF. Esta herramienta solo extrae tablas con rejillas regulares detectadas en la capa de texto: si el documento son páginas escaneadas (imágenes), no las reconoce.",
      invalidConfig:
        "Este archivo no es una configuración de firma válida (o su versión no es compatible). Expórtala de nuevo desde «Firmar PDF» e inténtalo otra vez.",
    },
  },
  soon: {
    badge: "Próximamente",
    title: "Todavía no está lista",
    body: "Esta herramienta necesita conversión en servidor para dar un resultado fiel, y OptimusPDF hoy procesa todo en tu dispositivo. Preferimos no fingir que funciona.",
    alternativesTitle: "Mientras tanto puedes usar",
    backHome: "Volver al catálogo",
  },
  recent: {
    title: "Recientes",
    subtitle:
      "Solo guardamos el nombre del archivo, la herramienta y la fecha, en este dispositivo. Nunca el documento.",
    empty: "Aún no has procesado nada en este navegador.",
    emptyCta: "Ver herramientas",
    clear: "Borrar historial",
  },
  settings: {
    title: "Ajustes",
    themeTitle: "Apariencia",
    themeBody:
      "Elige el tema claro u oscuro. Con «Sistema» la app sigue lo que tenga configurado tu dispositivo, y cambia sola cuando él cambia.",
    languageTitle: "Idioma",
    languageBody: "Cambia el idioma de toda la interfaz.",
    dataTitle: "Datos locales",
    dataBody:
      "OptimusPDF guarda en tu navegador el idioma elegido, la lista de trabajos recientes y, si usaste «Firmar PDF» con varios firmantes, los valores de campos que escribiste para sugerirlos en otros documentos, además de los borradores que se guardan automáticamente mientras trabajas (con varios documentos, la sesión completa: documentos, firmantes y firmas; PDF completo y capturas de firma). Si exportas la configuración de una ronda, el .zip contiene tus documentos. «Borrar datos locales» elimina todo esto. Si marcas «Recordar en este dispositivo» al crear una firma o unas iniciales, también se guardan en tu navegador (IndexedDB) junto con el nombre que escribas, para reutilizarlas en otros documentos; nunca se suben a ningún servidor. Si exportas una firma, el archivo contiene la firma en claro salvo que le pongas contraseña.",
    clearData: "Borrar datos locales",
    cleared: "Datos locales borrados.",
    aboutTitle: "Sobre la aplicación",
    signPdfFeaturesTitle: "Firmar PDF: funciones nuevas",
    signPdfFeaturesBody:
      "Actívalas o desactívalas como prefieras. Esta preferencia es solo de este navegador: no se sincroniza a ninguna cuenta ni sale de tu dispositivo.",
    signPdfFeatures: {
      keyboardNav: {
        label: "Navegación por teclado",
        hint: "Tab o Enter salta al siguiente campo de texto vacío sin soltar el lienzo.",
      },
      fieldsCompleteNotice: {
        label: "Aviso de campos pendientes",
        hint: "Muestra un aviso, sin bloquear, si quedan campos sin rellenar antes de firmar o descargar.",
      },
      undoDelete: {
        label: "Deshacer en vez de confirmar",
        hint: "Al borrar un campo de texto individual aparece un botón «Deshacer» en vez de pedir confirmación. Borrar un firmante completo sigue pidiendo confirmación.",
      },
      reusableTemplates: {
        label: "Plantillas de disposición",
        hint: "Permite guardar la disposición de firmantes y campos como plantilla, para reutilizarla en otros documentos.",
      },
      richFieldTypes: {
        label: "Tipos de campo enriquecidos",
        hint: "Añade casilla, fecha e inicial como tipos de campo, además del texto libre.",
      },
      completionCertificate: {
        label: "Certificado de finalización",
        hint: "Añade una página final con el hash del documento, la fecha y la lista de firmantes.",
      },
      pinchZoom: {
        label: "Zoom con pellizco",
        hint: "Permite acercar el lienzo con dos dedos en formularios con campos pequeños y juntos.",
      },
      signatureVault: {
        label: "Firmas guardadas",
        hint: "Permite recordar tus firmas e iniciales en este dispositivo para reutilizarlas en otros documentos. Es opcional: solo se guarda lo que tú marques, y nunca sale del navegador.",
      },
      multiDocument: {
        label: "Varios documentos a la vez",
        hint: "Permite cargar varios PDF en Firmar PDF y firmarlos en una sola ronda. Apagado, la herramienta trabaja con un único documento, como antes.",
      },
    },
  },
  pricing: {
    title: "Precios",
    subtitle:
      "Todo lo que corre en tu navegador es gratis y lo será siempre. Lo que exige servidores todavía no existe.",
    freeName: "Local",
    freePrice: "0 €",
    freePeriod: "para siempre",
    freeTagline: "Todas las herramientas que funcionan en tu dispositivo.",
    freeFeatures: [
      "Todas las herramientas operativas, sin límite de uso",
      "Sin cuenta, sin correo, sin tarjeta",
      "Sin marca de agua ni recorte de calidad",
      "Sin límite de archivos por día",
      "Funciona sin conexión tras la primera carga",
    ],
    freeCta: "Usar ahora",
    proName: "Servidor",
    proPrice: "Aún sin precio",
    proPeriod: "no disponible",
    proTagline:
      "Para lo que un navegador no puede hacer solo: Office, PDF/A y modelos de lenguaje.",
    proFeatures: [
      "Conversión fiel de Word, Excel y PowerPoint",
      "Reparación de archivos dañados",
      "Exportación a PDF/A certificado",
      "Resumen y traducción con modelos de lenguaje",
    ],
    proCta: "Todavía no está disponible",
    honestyTitle: "Por qué no hay tabla de comparación",
    honestyBody:
      "Porque no hay dos planes compitiendo. Hay lo que ya funciona, que es gratis, y lo que requeriría infraestructura, que aún no hemos construido. Cuando exista, se dirá el precio aquí.",
    faqTitle: "Preguntas rápidas",
    faq: [
      {
        q: "¿Cómo puede ser gratis?",
        a: "No hay servidores que pagar. El coste de procesar tu PDF lo pone tu propio dispositivo.",
      },
      {
        q: "¿Hay límite de tamaño?",
        a: "El que soporte la memoria de tu navegador. Por encima de 100 MB avisamos antes de empezar.",
      },
      {
        q: "¿Guardáis mis documentos?",
        a: "No podemos: nunca llegan a salir de tu equipo. En este dispositivo solo queda el nombre si usas el historial reciente.",
      },
    ],
  },
  about: {
    title: "El proyecto",
    subtitle: "Una suite PDF construida al revés que las demás.",
    body: [
      "Casi todas las herramientas PDF de internet funcionan igual: subes tu documento, un servidor lo procesa y confías en que después lo borre. OptimusPDF invierte ese trato. El motor viaja hasta tu navegador y el archivo se queda quieto.",
      "El resultado es una suite sin cuentas, sin colas, sin límites diarios y sin la incomodidad de mandar una nómina o un contrato a una máquina ajena.",
      "Las herramientas que un navegador no puede resolver con honestidad aparecen marcadas como próximamente. No inventamos resultados a medias.",
    ],
    stackTitle: "Cómo está hecho",
    stackBody:
      "Next.js y TypeScript para la interfaz, pdf-lib para escribir documentos, pdf.js para leerlos y dibujarlos, y trabajo en segundo plano para que la pestaña no se congele.",
    valuesTitle: "Tres reglas",
    values: [
      {
        title: "Privacidad estructural",
        body: "No confíes en nuestra política: mira la red del navegador y comprueba que tu archivo no viaja.",
      },
      {
        title: "Honestidad de producto",
        body: "Si algo no se puede hacer bien en local, se dice. No hay funciones de adorno.",
      },
      {
        title: "Velocidad real",
        body: "Sin subida ni descarga, el tiempo total es solo el del proceso.",
      },
    ],
  },
  footer: {
    tagline:
      "Suite PDF que se ejecuta entera en tu navegador. Tus documentos no viajan.",
    product: "Producto",
    toolsColumn: "Herramientas",
    company: "Compañía",
    legal: "Legal",
    privacy: "Privacidad",
    terms: "Términos",
    cookies: "Cookies",
    licenses: "Licencias",
    rights: "Proyecto de Optimus Reframe.",
  },
  tools,
  filenames,
};

export type Dictionary = typeof es;
