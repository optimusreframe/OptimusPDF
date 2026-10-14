import type { ToolCategory, ToolSlug } from "@/lib/tools-registry";

export type ToolCopy = {
  name: string;
  description: string;
};

const tools: Record<ToolSlug, ToolCopy> = {
  "pdf-pro": {
    name: "PDF Pro",
    description:
      "Todo en uno: organiza, edita, firma, protege y convierte tu PDF sin salir de la página",
  },
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
      "Edita el texto que ya trae el PDF y añade texto, imágenes y formas directamente sobre el documento.",
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
  "pdf-pro": "documento-pro",
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
    description: "Edita, firma, numera y compara documentos.",
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
    skipToContent: "Saltar al contenido",
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
    featuredBadge: "Nuevo",
    featuredCta: "Abrir PDF Pro",
    featuredLabel: "Destacada",
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
    // Archivo con problemas (Wave 6 · U1/U3): banner con acciones.
    fileProblemTitle: "No se puede usar este archivo",
    fileProblemFile: "Archivo: {name}",
    chooseAnother: "Elegir otro archivo",
    removeFile: "Quitar archivo",
    enterPassword: "Escribir la contraseña",
    openRepair: "Abrir Reparar PDF",
    openInPro: "Abrir en PDF Pro",
    continueInPro: "Seguir en PDF Pro",
    needPageSelected: "Deja marcada al menos una página para poder unir.",
    blockedRun: "{action} se activa cuando cambies o quites el archivo marcado.",
    largeFileTitle: "Archivo muy grande",
    encryptedSheetMessage:
      "Este PDF está protegido con contraseña. Escríbela para trabajar con una copia sin protección; la contraseña no se guarda.",
    restrictedNotice:
      "{name}: este PDF tenía restricciones de edición o impresión; trabajas con una copia sin ellas.",
    decryptedNotice:
      "{name}: trabajas con una copia sin contraseña. No se guardará la contraseña y el resultado saldrá sin cifrar.",
    password: {
      title: "PDF con contraseña",
      body: "Escríbela para abrirlo. Solo se usa en tu navegador y no se guarda. El resultado saldrá sin contraseña.",
      label: "Contraseña",
      show: "Mostrar la contraseña",
      hide: "Ocultar la contraseña",
      submit: "Abrir documento",
      opening: "Abriendo…",
      cancel: "Cancelar",
      wrong: "La contraseña no es correcta. Revísala e inténtalo de nuevo.",
      failed: "No se pudo abrir el documento con esa contraseña. Inténtalo de nuevo.",
      close: "Cerrar",
    },
    errorHints: {
      corrupt: "Prueba con «Reparar PDF» o elige otro archivo.",
      tooLarge: "Si falla, prueba con un archivo más pequeño.",
      tooLargeSplit: "Si falla, prueba con un archivo más pequeño: puedes dividirlo antes con «Dividir PDF».",
      unknown: "Si se repite, prueba con otro archivo.",
    },
    errors: {
      title: "No se pudo completar",
      emptyFile: "El archivo está vacío (0 bytes). Elige otro archivo.",
      notPdf:
        "Este archivo no es un PDF, aunque su nombre termine en .pdf (puede ser una imagen u otro formato renombrado). Elige un PDF de verdad.",
      invalidType: "Ese formato no sirve para esta herramienta.",
      encryptedAction: "Abrir Desbloquear PDF",
      reloadAction: "Recargar la página",
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
      offline:
        "No se pudo descargar un componente de la aplicación (sin conexión, o la red falló). Tu archivo está bien y no sale de tu dispositivo: conéctate y recarga la página (el borrador automático conserva tu trabajo).",
      ocrNetworkFailure:
        "No se pudo cargar el motor de OCR. Comprueba tu conexión e inténtalo de nuevo.",
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
      "Los trabajos sin terminar se guardan solo en este navegador, con el documento, para poder continuarlos.",
    empty: "Aún no has procesado nada en este navegador.",
    emptyCta: "Ver herramientas",
    clear: "Borrar historial",
    // U0.6: «Sin terminar» (borradores reales de Firmar, Editar y PDF Pro) e historial honesto.
    unfinishedTitle: "Sin terminar",
    unfinishedHint:
      "Trabajos que dejaste a medias. Al continuar, la herramienta recupera el documento y lo que habías hecho.",
    historyTitle: "Historial",
    historyHint:
      "Del historial solo guardamos el nombre del archivo, la herramienta y la fecha: no se puede continuar desde aquí.",
    openTool: "Abrir herramienta",
    documentsOne: "1 documento",
    documentsMany: "{n} documentos",
    changesOne: "1 cambio",
    changesMany: "{n} cambios",
    discard: "Descartar {name}",
    discardTitle: "¿Descartar «{name}»?",
    discardBody:
      "Se borrarán de este navegador el documento y todo lo que habías hecho con él. No se puede deshacer.",
    discardConfirm: "Descartar",
    discarded: "Trabajo descartado.",
  },
  // U0.6: lo que muestra una herramienta cuando «Continuar» apunta a un trabajo que ya no existe.
  resume: {
    gone: "Este trabajo ya no se puede recuperar en este navegador (se borró o caducó).",
    reopen: "Abrir de nuevo",
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
      "OptimusPDF guarda en tu navegador el idioma elegido, la lista de trabajos recientes y, si usaste «Firmar PDF» con varios firmantes, los valores de campos que escribiste para sugerirlos en otros documentos, además de los borradores que se guardan automáticamente mientras trabajas (con varios documentos, la sesión completa: documentos, firmantes y firmas; PDF completo y capturas de firma). Si exportas la configuración de una ronda, el .zip contiene tus documentos. «Borrar datos locales» elimina todo esto. Si marcas «Recordar en este dispositivo» al crear una firma o unas iniciales, también se guardan en tu navegador (IndexedDB) junto con el nombre que escribas, para reutilizarlas en otros documentos; nunca se suben a ningún servidor. Si exportas una firma, el archivo contiene la firma en claro salvo que le pongas contraseña. El editor de PDF también guarda un borrador automático (IndexedDB) con el documento completo y tus ediciones, para retomarlo si cierras la pestaña; tampoco sale del dispositivo y «Borrar datos locales» lo elimina (no se guarda borrador de los PDF protegidos con contraseña). PDF Pro hace lo mismo con su documento de trabajo (el PDF actual y la lista de cambios, en una base propia) y también lo elimina «Borrar datos locales».",
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
        label: "Registro de firmas (página final)",
        hint: "Añade al final del PDF una página «Registro de firmas» con la fecha, la lista de firmantes y el hash del documento. No es una firma certificada: solo registra quién firmó y cuándo. Apagado, el PDF firmado tiene exactamente las páginas del original.",
      },
      signingRecordFile: {
        label: "Incluir registro .json aparte",
        hint: "Al firmar, ofrece un archivo registro-firmas.json con el hash SHA-256 de cada PDF firmado, la fecha, los firmantes y el número de páginas. Con varios documentos va dentro del ZIP; con uno, como descarga aparte. Nunca dentro del PDF. No es una firma certificada.",
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
    proFeaturesTitle: "PDF Pro: funciones",
    proFeaturesBody:
      "Preferencias de la suite PDF Pro, guardadas solo en este navegador: no se sincronizan con ninguna cuenta ni salen de tu dispositivo.",
    proFeatures: {
      proAutosave: {
        label: "Guardar un borrador automático",
        hint: "Mientras trabajas, PDF Pro guarda en tu navegador (IndexedDB) el PDF actual y la lista de cambios, para retomarlo si recargas o cierras la pestaña. No se guarda nada de los PDF protegidos con contraseña. Apagado, un cierre accidental pierde el trabajo sin guardar.",
      },
    },
    editPdfFeaturesTitle: "Editor de PDF: funciones nuevas",
    editPdfFeaturesBody:
      "Estas opciones son solo de este navegador: no se sincronizan con ninguna cuenta ni salen de tu dispositivo.",
    editPdfFeatures: {
      editExistingText: {
        label: "Editar el texto que ya trae el PDF",
        hint: "Permite hacer clic en el texto existente y cambiarlo: al exportar, el texto original se elimina del archivo y se dibuja el nuevo; si no se puede quitar, se avisa. Apagado, el texto que ya trae el PDF no se puede tocar, pero el editor sigue permitiendo añadir texto, imágenes y formas.",
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
