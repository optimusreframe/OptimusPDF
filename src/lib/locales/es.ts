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
    description: "Convierte el PDF en una presentación PPTX editable.",
  },
  "pdf-to-excel": {
    name: "PDF a Excel",
    description: "Extrae las tablas del PDF a una hoja de cálculo XLSX.",
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
    brandFirst: "OPTIMUS",
    brandSecond: "PDF",
    live: "LIVE",
    soon: "PRÓXIMAMENTE",
    localBadge: "100% LOCAL",
    zeroUploads: "0 SUBIDAS",
    localAndZeroUploads: "100% LOCAL · 0 SUBIDAS",
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
    tools: "Herramientas",
    recent: "Recientes",
    settings: "Ajustes",
    pricing: "Precios",
    about: "Proyecto",
    allTools: "Ver todas las herramientas",
  },
  categories,
  home: {
    badge: "LIVE · 100% LOCAL",
    title: "Todas las herramientas PDF.",
    titleAccent: "Cero subidas.",
    subtitle:
      "Unir, dividir, comprimir, convertir, firmar y proteger documentos sin que ni un byte salga de tu dispositivo. El motor corre entero en tu navegador.",
    ctaPrimary: "Empezar a trabajar",
    ctaSecondary: "Cómo funciona",
    statTools: "Herramientas",
    statUploads: "Archivos subidos",
    statAccounts: "Cuentas necesarias",
    statAccountsValue: "Ninguna",
    toolsTitle: "El catálogo completo",
    toolsSubtitle:
      "Herramientas organizadas por lo que necesitas hacer, no por lo que vende el sector.",
    privacyTitle: "Tus archivos nunca salen de tu dispositivo",
    privacySubtitle:
      "No es una promesa comercial: es una consecuencia de la arquitectura. No hay servidor al que subir nada.",
    privacyPoints: [
      {
        title: "Procesado en el navegador",
        body: "El motor PDF se descarga una vez y trabaja con la memoria de tu pestaña. El archivo se queda donde está.",
      },
      {
        title: "Sin cuentas ni rastreo",
        body: "No pedimos correo, no ponemos cookies de seguimiento y no guardamos historial de documentos.",
      },
      {
        title: "Funciona sin conexión",
        body: "Una vez cargada la aplicación puedes desconectarte del wifi y seguir trabajando igual.",
      },
    ],
    ctaTitle: "Abre un documento y compruébalo",
    ctaBody:
      "Sin registro, sin límite de archivos por día, sin marcas de agua escondidas.",
    ctaButton: "Unir mi primer PDF",
  },
  toolsPage: {
    title: "Herramientas",
    subtitle:
      "Todo el catálogo, agrupado por tarea. Las marcadas como próximamente aún no funcionan y lo decimos claramente.",
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
    errors: {
      title: "No se pudo completar",
      invalidType: "Ese formato no sirve para esta herramienta.",
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
    },
  },
  soon: {
    badge: "PRÓXIMAMENTE",
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
      "Lo único que OptimusPDF guarda en tu navegador es el idioma elegido y la lista de trabajos recientes.",
    clearData: "Borrar datos locales",
    cleared: "Datos locales borrados.",
    aboutTitle: "Sobre la aplicación",
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
