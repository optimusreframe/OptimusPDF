import type { Language } from "@/lib/i18n";
import type { CameraErrorCode } from "@/lib/pdf/scanToPdf";
import type { FrameVerdict, ScanFilterMode, ScanMode } from "@/lib/scan/types";
import type { QualityChipKind } from "@/app/scan-to-pdf/scanState";
import type { ImportProblemKind } from "@/app/scan-to-pdf/importProblems";
import type { ScanBuildWarning } from "@/lib/scan/types";

/** Tamaño aproximado (MB) de los datos de idioma español + inglés que baja tesseract.js la primera vez. */
export const OCR_MODEL_MB = 25;

/** Textos propios de «Escanear a PDF» (copy original ES/EN). Las funciones resuelven plurales y numeros. */
export type ScanToPdfStrings = {
  /* Inicio */
  startTitle: string;
  startBody: string;
  startButton: string;
  starting: string;
  pickPhotos: string;
  pickPhotosHint: string;
  nativeCamera: string;
  nativeCameraHint: string;
  modeLabel: string;
  modes: Record<ScanMode, { label: string; hint: string }>;
  privacy: string;
  /* Retomar */
  resumeTitle: string;
  resumeMeta: (count: number, when: string) => string;
  resumeAction: string;
  resumeDiscard: string;
  resumeDiscardTitle: string;
  resumeDiscardBody: string;
  resumeDiscardConfirm: string;
  resumeKeep: string;
  resumeGone: string;
  resumeLoading: string;
  resumeFailed: string;
  /* Camara */
  cameraRegion: string;
  liveTitle: string;
  closeCamera: string;
  shutter: string;
  shutterAuto: string;
  review: (count: number) => string;
  reviewEmpty: string;
  pagesBadge: (count: number) => string;
  lastShotAlt: (n: number) => string;
  undoLast: string;
  undoLastDone: string;
  autoOn: string;
  autoOff: string;
  burstOn: string;
  burstOff: string;
  torchOn: string;
  torchOff: string;
  zoomLabel: (x: string) => string;
  switchCamera: string;
  importPhotos: string;
  toolsLabel: string;
  hints: Record<FrameVerdict["hint"], string>;
  hintPhoto: string;
  hintBook: string;
  hintReceipt: string;
  hintBoard: string;
  autoRing: string;
  idFront: string;
  idBack: string;
  idStep: (side: string, n: number) => string;
  idDone: string;
  idCombining: string;
  bookSplit: string;
  cameraErrorTitle: string;
  cameraErrors: Record<CameraErrorCode, string>;
  cameraFallbackTitle: string;
  cameraFallbackBody: string;
  retryCamera: string;
  focusRing: string;
  /* Revisar */
  reviewTitle: string;
  reviewHelp: string;
  statusSaved: string;
  statusSaving: string;
  statusUnsaved: string;
  statusQuota: string;
  statusUnavailable: string;
  statusTooBig: string;
  statusStalled: string;
  /** Aviso del banner de almacenamiento segun el motivo (cada uno con su punto final; no repite el estado de la cabecera). */
  storageBanner: Record<"unavailable" | "quota" | "tooBig" | "stalled", string>;
  addCamera: string;
  addPhotos: string;
  select: string;
  selectDone: string;
  selectedCount: (count: number) => string;
  selectAll: string;
  undo: string;
  redo: string;
  removeBlanks: (count: number) => string;
  blanksBanner: (count: number) => string;
  /** Aviso de hojas «casi vacias» (muy poco contenido, no en blanco) y la hoja de confirmacion para quitarlas. */
  sparseBanner: (count: number) => string;
  reviewSparse: (count: number) => string;
  blanksReview: {
    title: string;
    intro: string;
    blankList: (count: number) => string;
    sparseList: (count: number) => string;
    sparseHint: string;
    pageLabel: (n: number) => string;
    confirm: (count: number) => string;
    cancel: string;
    removedNotice: (count: number) => string;
    undo: string;
    dismiss: string;
  };
  /** «Giramos 3 páginas: 2 de lado y 1 cabeza abajo.» Distingue un cuarto de vuelta (de lado) de media vuelta (cabeza abajo). */
  /** Sufijo del nombre de un escaneo que otra pestaña ya había modificado («Contrato (copia)»). */
  forkSuffix: string;
  orientationNotice: (counts: { side: number; flipped: number }) => string;
  /** Fotos que no se pudieron anadir: por nombre y con el motivo; el resto de la lista sigue. */
  importProblems: {
    title: (count: number) => string;
    kinds: Record<ImportProblemKind, string>;
    camera: string;
    more: (count: number) => string;
    rest: string;
    dismiss: string;
    /** El escaner no se pudo CARGAR (sin red): no es un defecto de las fotos. */
    engineUnavailable: string;
    retry: string;
    /** Tras un reintento que tambien falla: el navegador puede guardar el fallo de carga hasta recargar la pagina. */
    reload: string;
    /** Que hacer tras recargar: las paginas ya añadidas se conservan; las fotos sin procesar hay que volver a elegirlas. */
    engineReload: (count: number) => string;
  };
  orientationUndo: string;
  lostPages: (count: number) => string;
  save: (count: number) => string;
  saveBlocked: string;
  emptyTitle: string;
  emptyBody: string;
  gridLabel: string;
  tileLabel: (n: number, total: number, flags: string[]) => string;
  /** `visibleAction`: version corta de la accion para la miniatura (el nombre accesible y el `title` llevan la completa). */
  quality: Record<QualityChipKind, { label: string; action: string; tip: string; visibleAction?: string }>;
  chipAction: (n: number, label: string, action: string) => string;
  thumbAlt: (n: number) => string;
  processing: string;
  rotate: (n: number) => string;
  remove: (n: number) => string;
  more: (n: number) => string;
  edit: string;
  retake: string;
  duplicate: string;
  insertBefore: string;
  insertAfter: string;
  moveTo: string;
  viewSheet: string;
  moveUp: string;
  moveDown: string;
  insertSourceTitle: string;
  insertCamera: string;
  insertLibrary: string;
  dragHandle: (n: number) => string;
  dragHandleHint: string;
  dragStart: (n: number) => string;
  dragMoved: (n: number, pos: number) => string;
  dragCancel: string;
  moveModeTitle: (count: number) => string;
  moveHere: string;
  moveToEnd: string;
  moveCancel: string;
  moveDone: (pos: number) => string;
  bulkFilter: string;
  bulkRotate: string;
  bulkDelete: string;
  bulkMove: string;
  bulkFilterTitle: string;
  actionsLabel: string;
  moreTitle: (n: number) => string;
  close: string;
  /* Anuncios */
  said: {
    added: (count: number) => string;
    captured: (n: number) => string;
    removed: (count: number) => string;
    rotated: (count: number) => string;
    duplicated: (count: number) => string;
    undone: (label: string) => string;
    redone: (label: string) => string;
    blanksRemoved: (count: number) => string;
    createFailed: string;
    photoFailed: (name: string, kind: ImportProblemKind) => string;
    forked: string;
    saved: string;
    retaken: (n: number) => string;
    inserted: (n: number) => string;
    filterAll: string;
    cancelled: string;
  };
  labels: {
    add: string;
    remove: string;
    rotate: string;
    duplicate: string;
    move: string;
    filter: string;
    adjust: string;
    crop: string;
    retake: string;
    insert: string;
    blanks: string;
    orientation: string;
    applyAll: string;
    clear: string;
  };
  /* Editor */
  editorTitle: (n: number, total: number) => string;
  editorPrev: string;
  editorNext: string;
  editorCrop: string;
  editorRotate: string;
  editorFilter: string;
  editorAdjust: string;
  editorApplyAll: string;
  editorApplyAllDone: string;
  brightness: string;
  contrast: string;
  resetAdjust: string;
  filterLabel: string;
  filters: Record<ScanFilterMode, string>;
  editorDone: string;
  editorPreviewAlt: (n: number) => string;
  sheetTitle: (n: number, total: number) => string;
  sheetFit: string;
  sheetActual: string;
  sheetHint: string;
  cornersTitle: string;
  cornersHint: string;
  cornersLoading: string;
  cornersApply: string;
  cornersReset: string;
  cornersCancel: string;
  cornersInvalid: string;
  /* Guardar */
  saveTitle: string;
  saveBack: string;
  nameLabel: string;
  nameHint: string;
  nameReset: string;
  pageSizeLabel: string;
  pageSizeA4: string;
  pageSizeLetter: string;
  pageSizeFit: string;
  marginLabel: string;
  marginNone: string;
  marginSmall: string;
  marginLarge: string;
  searchable: string;
  searchableHint: string;
  /** Aviso de que el texto buscable necesita bajar el modelo (una vez); `mb` = tamaño aproximado. */
  searchableDownloadNote: (mb: number) => string;
  downloadModel: (mb: number) => string;
  downloadModelCancel: string;
  modelDownloading: string;
  modelReady: string;
  modelFailed: Record<"offline" | "network" | "engine", string>;
  /** Sustituye a «≈ X MB» bajo «Crear PDF» mientras falte el modelo: el PDF saldra normal. */
  createMetaNoModel: string;
  /** Calidad elegida pesa casi lo mismo que Original: sin comparativa inventada. */
  alreadyOptimized: (size: string) => string;
  searchableFailed: string;
  createWithoutText: string;
  /** Texto del aviso de `buildPdf` (`onWarning`): lo que el PDF NO lleva y por que. NO es un error. */
  searchableWarning: (warning: ScanBuildWarning) => string;
  searchableNoticeTitle: string;
  create: string;
  createMeta: (count: number, size: string) => string;
  sizeBig: string;
  sizeHuge: string;
  buildProgress: (n: number, total: number) => string;
  buildCancelled: string;
  buildFailed: string;
  share: string;
  shareDone: string;
  shareFailed: string;
  backToReview: string;
  newScan: string;
  newScanHint: string;
  /* Salir */
  leaveTitle: string;
  leaveBodySaved: (count: number) => string;
  leaveBodyUnsaved: (count: number) => string;
  leaveStay: string;
  leaveLeave: string;
  /* Errores */
  noFiles: string;
  /* Entradas de archivo ocultas */
  inputFiles: string;
  inputCamera: string;
};

const ES: ScanToPdfStrings = {
  startTitle: "Escanea con la cámara, sin perder nada",
  startBody:
    "Apunta al documento y la página se captura sola cuando se ve nítida. Revisa, ordena y guarda un PDF. Todo se queda en tu dispositivo y se guarda mientras escaneas.",
  startButton: "Activar cámara",
  starting: "Abriendo la cámara…",
  pickPhotos: "Elegir fotos",
  pickPhotosHint: "Varias a la vez, de tu fototeca o de archivos.",
  nativeCamera: "Usar la app de Cámara del sistema",
  nativeCameraHint: "Con flash y enfoque reales; te pide confirmar cada foto.",
  modeLabel: "Qué vas a escanear",
  modes: {
    document: { label: "Documento", hint: "Hojas y contratos: se recorta y se endereza solo." },
    "id-card": { label: "Identificación", hint: "Anverso y reverso en una sola hoja." },
    receipt: { label: "Recibo", hint: "Tickets largos y estrechos: encuádralo entero." },
    book: { label: "Libro", hint: "Una foto de las dos páginas; se parte por el lomo." },
    whiteboard: { label: "Pizarra", hint: "Alto contraste para pizarras y carteles." },
    photo: { label: "Foto", hint: "Sin recorte ni filtro: para daños y fotos." },
  },
  privacy: "El vídeo y las páginas no salen de tu dispositivo.",
  resumeTitle: "Tienes un escaneo sin terminar",
  resumeMeta: (count, when) => `${count} ${count === 1 ? "página" : "páginas"} · ${when}`,
  resumeAction: "Retomar escaneo",
  resumeDiscard: "Empezar de nuevo",
  resumeDiscardTitle: "¿Empezar de nuevo?",
  resumeDiscardBody: "Se borrará el escaneo guardado en este dispositivo. No se puede deshacer.",
  resumeDiscardConfirm: "Borrar y empezar",
  resumeKeep: "Conservarlo",
  resumeGone: "Ese escaneo ya no está disponible: se borra a los 14 días o al descartarlo.",
  resumeLoading: "Recuperando tu escaneo…",
  resumeFailed: "No se pudo recuperar el escaneo guardado.",
  cameraRegion: "Cámara",
  liveTitle: "Vista de la cámara",
  closeCamera: "Cerrar la cámara",
  shutter: "Capturar página",
  shutterAuto: "Captura automática en curso",
  review: (count) => `Revisar (${count})`,
  reviewEmpty: "Revisar",
  pagesBadge: (count) => `${count} ${count === 1 ? "página" : "páginas"}`,
  lastShotAlt: (n) => `Última captura: página ${n}`,
  undoLast: "Deshacer",
  undoLastDone: "Última captura deshecha",
  autoOn: "Captura automática: activada",
  autoOff: "Captura automática: desactivada",
  burstOn: "Ráfaga: seguir en la cámara tras cada página",
  burstOff: "Ráfaga desactivada: revisar tras cada página",
  torchOn: "Apagar la linterna",
  torchOff: "Encender la linterna",
  zoomLabel: (x) => `Zoom ${x}×`,
  switchCamera: "Cambiar de cámara",
  importPhotos: "Importar fotos",
  toolsLabel: "Controles de la cámara",
  hints: {
    ok: "Listo",
    move_closer: "Acércate",
    move_away: "Aléjate un poco",
    hold_steady: "Mantén firme",
    too_dark: "Más luz",
    glare: "Hay brillo",
    no_document: "No veo el documento",
    unknown: "Buscando el encuadre…",
  },
  hintPhoto: "Encuadra y toca el botón",
  hintBook: "Abre el libro y encuadra las dos páginas",
  hintReceipt: "Encuadra el recibo entero",
  hintBoard: "Encuadra la pizarra",
  autoRing: "Captura automática",
  idFront: "Anverso",
  idBack: "Reverso",
  idStep: (side, n) => `Identificación · ${side} (${n} de 2)`,
  idDone: "Identificación guardada en una sola hoja",
  idCombining: "Juntando anverso y reverso…",
  bookSplit: "Libro partido en dos páginas",
  cameraErrorTitle: "La cámara no está disponible",
  cameraErrors: {
    denied: "Has bloqueado el acceso a la cámara. Permítelo en los ajustes del navegador o elige fotos.",
    notFound: "No hemos encontrado ninguna cámara conectada a este equipo.",
    busy: "Otra aplicación está usando la cámara. Ciérrala e inténtalo otra vez.",
    insecure: "El navegador solo abre la cámara en conexiones seguras (HTTPS).",
    unsupported: "Este navegador no permite abrir la cámara desde una web.",
    unknown: "No se ha podido abrir la cámara. Vuelve a intentarlo.",
  },
  cameraFallbackTitle: "Sigue con tus fotos",
  cameraFallbackBody: "Elige varias fotos de tu fototeca o de archivos y las convertimos en un PDF igual de bien.",
  retryCamera: "Volver a intentarlo",
  focusRing: "Enfocando",
  reviewTitle: "Revisar páginas",
  reviewHelp: "Toca una página para editarla. Arrastra el asa para ordenar.",
  statusSaved: "Guardado ✓",
  statusSaving: "Guardando…",
  statusUnsaved: "No guardado",
  statusQuota: "No guardado: no hay espacio",
  statusUnavailable: "No guardado: sin almacenamiento",
  statusTooBig: "No guardado: demasiado grande",
  statusStalled: "No guardado: sin respuesta",
  storageBanner: {
    unavailable: "Este navegador no deja guardar el escaneo (¿modo privado?). Crea el PDF antes de salir.",
    quota: "No queda espacio en este dispositivo para guardar el escaneo. Crea el PDF antes de salir.",
    tooBig: "El escaneo es demasiado grande para guardarlo en este dispositivo. Crea el PDF antes de salir.",
    stalled: "No se pudo guardar en este dispositivo; descarga el PDF para no perder el trabajo.",
  },
  addCamera: "Cámara",
  addPhotos: "Fotos",
  select: "Seleccionar",
  selectDone: "Terminar",
  selectedCount: (count) => `${count} ${count === 1 ? "seleccionada" : "seleccionadas"}`,
  selectAll: "Todas",
  undo: "Deshacer",
  redo: "Rehacer",
  removeBlanks: (count) => `Quitar hojas en blanco (${count})`,
  blanksBanner: (count) => `${count} ${count === 1 ? "hoja parece estar en blanco" : "hojas parecen estar en blanco"}`,
  sparseBanner: (count) => `${count} ${count === 1 ? "hoja está casi vacía" : "hojas están casi vacías"}: tienen muy poco contenido. Revísalas antes de quitarlas.`,
  reviewSparse: (count) => `Revisar hojas casi vacías (${count})`,
  blanksReview: {
    title: "Quitar hojas en blanco",
    intro: "Mira las hojas antes de quitarlas. Solo se quitan las que dejes marcadas, y luego puedes deshacerlo.",
    blankList: (count) => `En blanco (${count})`,
    sparseList: (count) => `Casi vacías (${count})`,
    sparseHint: "Tienen muy poco contenido (una firma, un número, una línea). Vienen SIN marcar: márcalas solo si quieres quitarlas.",
    pageLabel: (n) => `Página ${n}`,
    confirm: (count) => `Quitar ${count} ${count === 1 ? "hoja" : "hojas"}`,
    cancel: "Cancelar",
    removedNotice: (count) => `Quitamos ${count} ${count === 1 ? "hoja" : "hojas"}.`,
    undo: "Deshacer",
    dismiss: "Cerrar el aviso",
  },
  forkSuffix: "(copia)",
  orientationNotice: ({ side, flipped }) => {
    const total = side + flipped;
    const lead = `Giramos ${total} ${total === 1 ? "página" : "páginas"}`;
    if (flipped === 0) return `${lead} que ${side === 1 ? "estaba" : "estaban"} de lado.`;
    if (side === 0) return `${lead} que ${flipped === 1 ? "estaba" : "estaban"} cabeza abajo.`;
    return `${lead}: ${side} de lado y ${flipped} cabeza abajo.`;
  },
  importProblems: {
    title: (count) => (count === 1 ? "No se pudo añadir 1 foto" : `No se pudieron añadir ${count} fotos`),
    kinds: {
      notImage: "no es una imagen",
      heic: "formato HEIC, que este navegador no lee (expórtala como JPG)",
      damaged: "está dañada o incompleta",
      engine: "el escáner no se pudo cargar",
    },
    engineUnavailable: "No se pudo cargar el escáner. Revisa tu conexión y vuelve a intentarlo.",
    retry: "Reintentar",
    reload: "Recargar la página",
    engineReload: (count) =>
      count > 0
        ? `Recarga la página para cargar el escáner: las páginas ya añadidas se conservan. Después vuelve a elegir ${count === 1 ? "la foto que no se procesó" : `las ${count} fotos que no se procesaron`}.`
        : "Recarga la página para cargar el escáner: las páginas ya añadidas se conservan.",
    camera: "Foto de la cámara",
    more: (count) => `y ${count} más`,
    rest: "Las demás siguen en la lista.",
    dismiss: "Cerrar el aviso de fotos no añadidas",
  },
  orientationUndo: "Deshacer giro",
  lostPages: (count) => `${count} ${count === 1 ? "página no se pudo recuperar" : "páginas no se pudieron recuperar"} del escaneo guardado.`,
  save: (count) => `Guardar PDF (${count})`,
  saveBlocked: "Espera a que terminen de procesarse las páginas.",
  emptyTitle: "No quedan páginas",
  emptyBody: "Añade páginas con la cámara o desde tus fotos.",
  gridLabel: "Páginas del escaneo",
  tileLabel: (n, total, flags) => `Página ${n} de ${total}${flags.length ? `, ${flags.join(", ")}` : ""}`,
  quality: {
    blank: { label: "En blanco", action: "Revisar", tip: "Parece una hoja en blanco: revísala antes de quitarla" },
    blurry: { label: "Borrosa", action: "Repetir", tip: "Se ve borrosa" },
    glare: { label: "Brillo", action: "Repetir", tip: "Tiene reflejos" },
    dark: { label: "Oscura", action: "Repetir", tip: "Está muy oscura" },
    duplicate: { label: "Repetida", action: "Quitar", tip: "Parece repetida" },
    sparse: { label: "Casi vacía", action: "Revisar", tip: "Tiene muy poco contenido: revísala antes de quitarla." },
    noDocument: { label: "Sin documento detectado", action: "Ajusta el recorte", visibleAction: "Ajustar", tip: "No se detectó el documento: la página está entera, sin recortar. Ajusta el recorte o deja la página completa." },
  },
  chipAction: (n, label, action) => `Página ${n}: ${label}. ${action}`,
  thumbAlt: (n) => `Página ${n}`,
  processing: "Procesando…",
  rotate: (n) => `Girar la página ${n}`,
  remove: (n) => `Borrar la página ${n}`,
  more: (n) => `Más acciones de la página ${n}`,
  edit: "Editar página",
  retake: "Repetir captura",
  duplicate: "Duplicar",
  insertBefore: "Insertar página antes",
  insertAfter: "Insertar página después",
  moveTo: "Mover a otro sitio",
  viewSheet: "Ver hoja completa",
  moveUp: "Mover antes",
  moveDown: "Mover después",
  insertSourceTitle: "Insertar página",
  insertCamera: "Con la cámara",
  insertLibrary: "Desde mis fotos",
  dragHandle: (n) => `Mover la página ${n}`,
  dragHandleHint: "Arrastra, o pulsa Espacio y usa las flechas",
  dragStart: (n) => `Moviendo la página ${n}. Usa las flechas y suelta con Espacio.`,
  dragMoved: (n, pos) => `Página ${n} ahora en la posición ${pos}`,
  dragCancel: "Movimiento cancelado",
  moveModeTitle: (count) => `Elige dónde poner ${count === 1 ? "la página" : `las ${count} páginas`}`,
  moveHere: "Mover aquí",
  moveToEnd: "Al final",
  moveCancel: "Cancelar",
  moveDone: (pos) => `Movida a la posición ${pos}`,
  bulkFilter: "Filtro",
  bulkRotate: "Girar",
  bulkDelete: "Borrar",
  bulkMove: "Mover",
  bulkFilterTitle: "Filtro para las páginas elegidas",
  actionsLabel: "Acciones de las páginas elegidas",
  moreTitle: (n) => `Página ${n}`,
  close: "Cerrar",
  said: {
    added: (count) => `${count} ${count === 1 ? "página añadida" : "páginas añadidas"}`,
    captured: (n) => `Página ${n} capturada`,
    removed: (count) => `${count} ${count === 1 ? "página borrada" : "páginas borradas"}. Puedes deshacerlo.`,
    rotated: (count) => `${count} ${count === 1 ? "página girada" : "páginas giradas"}`,
    duplicated: (count) => `${count} ${count === 1 ? "página duplicada" : "páginas duplicadas"}`,
    undone: (label) => `Deshecho: ${label}`,
    redone: (label) => `Rehecho: ${label}`,
    blanksRemoved: (count) => `${count} ${count === 1 ? "hoja en blanco quitada" : "hojas en blanco quitadas"}. Puedes deshacerlo.`,
    createFailed: "No se pudo procesar la foto. No se añadió.",
    forked: "Otra pestaña había cambiado este escaneo: tus cambios se guardaron aparte, como una copia.",
    photoFailed: (name, kind) => `No se añadió ${name || "una foto"}: ${kind === "notImage" ? "no es una imagen" : kind === "heic" ? "formato HEIC no compatible" : kind === "engine" ? "no se pudo cargar el escáner (revisa tu conexión)" : "está dañada o incompleta"}.`,
    saved: "Escaneo guardado",
    retaken: (n) => `Página ${n} sustituida`,
    inserted: (n) => `Página insertada en la posición ${n}`,
    filterAll: "Ajustes aplicados a todas las páginas",
    cancelled: "Cancelado",
  },
  labels: {
    add: "añadir páginas",
    remove: "borrar páginas",
    rotate: "girar",
    duplicate: "duplicar",
    move: "mover",
    filter: "filtro",
    adjust: "brillo y contraste",
    crop: "recorte",
    retake: "repetir captura",
    insert: "insertar página",
    blanks: "quitar hojas en blanco",
    orientation: "orientación automática",
    applyAll: "aplicar a todas",
    clear: "quitar aviso",
  },
  editorTitle: (n, total) => `Editar página ${n} de ${total}`,
  editorPrev: "Página anterior",
  editorNext: "Página siguiente",
  editorCrop: "Recortar",
  editorRotate: "Girar",
  editorFilter: "Filtro",
  editorAdjust: "Brillo y contraste",
  editorApplyAll: "Aplicar a todas",
  editorApplyAllDone: "Filtro y ajustes aplicados a todas las páginas",
  brightness: "Brillo",
  contrast: "Contraste",
  resetAdjust: "Restablecer",
  filterLabel: "Filtro",
  filters: {
    auto: "Auto",
    color: "Color",
    grayscale: "Grises",
    bw: "B/N",
    enhance: "Mejorado",
    original: "Original",
  },
  editorDone: "Listo",
  editorPreviewAlt: (n) => `Vista de la página ${n}`,
  sheetTitle: (n, total) => `Hoja completa · página ${n} de ${total}`,
  sheetFit: "Ajustar",
  sheetActual: "Tamaño real",
  sheetHint: "Amplía para revisar la nitidez del texto.",
  cornersTitle: "Ajusta las esquinas",
  cornersHint:
    "Arrastra cada esquina hasta los bordes del documento; la lupa te ayuda a afinar. Con el teclado: tabula hasta una esquina y muévela con las flechas.",
  cornersLoading: "Preparando el editor…",
  cornersApply: "Aplicar recorte",
  cornersReset: "Toda la foto",
  cornersCancel: "Cerrar sin cambios",
  cornersInvalid: "Las esquinas se cruzan",
  saveTitle: "Guardar el PDF",
  saveBack: "Volver a revisar",
  nameLabel: "Nombre del archivo",
  nameHint: "Lo propone el escáner; cámbialo si quieres.",
  nameReset: "Usar el nombre propuesto",
  pageSizeLabel: "Tamaño de hoja",
  pageSizeA4: "A4",
  pageSizeLetter: "Carta",
  pageSizeFit: "Ajustar",
  marginLabel: "Margen",
  marginNone: "Sin margen",
  marginSmall: "Pequeño",
  marginLarge: "Grande",
  searchable: "PDF con texto buscable",
  searchableHint: "Reconoce el texto en tu dispositivo y lo deja seleccionable y buscable. Es más lento. Desactivado por defecto.",
  searchableDownloadNote: (mb) => `El texto buscable necesita un modelo de reconocimiento (≈ ${mb} MB). Se descarga una sola vez, con tu permiso, y después funciona sin conexión. Hasta entonces el PDF sale normal, sin texto buscable. Tus páginas no salen de tu dispositivo.`,
  downloadModel: (mb) => `Descargar el modelo de texto (≈ ${mb} MB)`,
  downloadModelCancel: "Cancelar la descarga",
  modelDownloading: "Descargando el modelo de texto…",
  modelReady: "Modelo de texto listo en este dispositivo.",
  modelFailed: {
    offline: "Sin conexión: no se pudo descargar el modelo. Conéctate y vuelve a intentarlo; mientras, el PDF sale sin texto buscable.",
    network: "No se pudo descargar el modelo (la conexión falló o está bloqueada). Puedes reintentarlo; mientras, el PDF sale sin texto buscable.",
    engine: "El reconocimiento de texto no arrancó en este navegador. El PDF saldrá sin texto buscable.",
  },
  createMetaNoModel: "Sin el modelo de texto, el PDF saldrá sin texto buscable.",
  alreadyOptimized: (size) => `Ya está optimizado: el tamaño no cambia con este ajuste (≈ ${size}).`,
  searchableFailed: "No se pudo reconocer el texto (la primera vez el modelo necesita conexión). Tus páginas siguen aquí: prueba con conexión o crea el PDF sin texto buscable.",
  createWithoutText: "Crear el PDF sin texto buscable",
  searchableWarning: ({ reason, pagesWithText, total }) => {
    const why = { "model-missing": "falta el modelo de texto", offline: "no había conexión para descargar el modelo", network: "falló la descarga del modelo", engine: "el reconocimiento de texto no funcionó en este navegador" }[reason];
    const what = pagesWithText === 0 ? "sin texto buscable" : `solo ${pagesWithText} de ${total} ${total === 1 ? "página lleva" : "páginas llevan"} texto buscable`;
    return `El PDF está bien, pero ${what}: ${why}.`;
  },
  searchableNoticeTitle: "Texto buscable",
  create: "Crear PDF",
  createMeta: (count, size) => `${count} ${count === 1 ? "página" : "páginas"} · ${size}`,
  sizeBig: "Pesa más de ~20 MB: algunos correos no lo aceptarán. Prueba la calidad «Compacta».",
  sizeHuge: "Pesa más de ~100 MB: WhatsApp y la mayoría de correos no lo aceptarán. Usa «Compacta» o divídelo después.",
  buildProgress: (n, total) => `Creando la página ${n} de ${total}…`,
  buildCancelled: "Creación cancelada. Tus páginas siguen aquí.",
  buildFailed: "No se pudo crear el PDF. Tus páginas siguen guardadas; inténtalo de nuevo.",
  share: "Compartir",
  shareDone: "PDF compartido",
  shareFailed: "No se pudo compartir; usa Descargar.",
  backToReview: "Volver a revisar",
  newScan: "Escanear otro documento",
  newScanHint: "Cierra este escaneo y empieza uno nuevo.",
  leaveTitle: "¿Salir del escaneo?",
  leaveBodySaved: (count) =>
    `Tus páginas (${count}) quedan guardadas en este dispositivo para retomarlas: al volver podrás continuar durante 14 días.`,
  leaveBodyUnsaved: (count) =>
    `No se pudo guardar este escaneo en el dispositivo. Si sales, se perderán ${count} ${count === 1 ? "página" : "páginas"}.`,
  leaveStay: "Seguir escaneando",
  leaveLeave: "Salir",
  noFiles: "Elige al menos una foto.",
  inputFiles: "Selector de fotos y archivos de imagen",
  inputCamera: "Captura con la cámara del sistema",
};

const EN: ScanToPdfStrings = {
  startTitle: "Scan with your camera, lose nothing",
  startBody:
    "Point at the document and the page is captured on its own once it looks sharp. Review, reorder and save a PDF. Everything stays on your device and is saved as you scan.",
  startButton: "Turn camera on",
  starting: "Opening the camera…",
  pickPhotos: "Choose photos",
  pickPhotosHint: "Several at once, from your photo library or files.",
  nativeCamera: "Use the system Camera app",
  nativeCameraHint: "With real flash and focus; it asks you to confirm each photo.",
  modeLabel: "What are you scanning",
  modes: {
    document: { label: "Document", hint: "Sheets and contracts: cropped and straightened automatically." },
    "id-card": { label: "ID card", hint: "Front and back on a single sheet." },
    receipt: { label: "Receipt", hint: "Long, narrow tickets: frame the whole thing." },
    book: { label: "Book", hint: "One photo of both pages; split at the spine." },
    whiteboard: { label: "Whiteboard", hint: "High contrast for boards and posters." },
    photo: { label: "Photo", hint: "No crop or filter: for damage and pictures." },
  },
  privacy: "The video and the pages never leave your device.",
  resumeTitle: "You have an unfinished scan",
  resumeMeta: (count, when) => `${count} ${count === 1 ? "page" : "pages"} · ${when}`,
  resumeAction: "Resume scan",
  resumeDiscard: "Start over",
  resumeDiscardTitle: "Start over?",
  resumeDiscardBody: "The scan saved on this device will be deleted. This cannot be undone.",
  resumeDiscardConfirm: "Delete and start",
  resumeKeep: "Keep it",
  resumeGone: "That scan is no longer available: it is deleted after 14 days or when discarded.",
  resumeLoading: "Recovering your scan…",
  resumeFailed: "The saved scan could not be recovered.",
  cameraRegion: "Camera",
  liveTitle: "Camera view",
  closeCamera: "Close the camera",
  shutter: "Capture page",
  shutterAuto: "Automatic capture in progress",
  review: (count) => `Review (${count})`,
  reviewEmpty: "Review",
  pagesBadge: (count) => `${count} ${count === 1 ? "page" : "pages"}`,
  lastShotAlt: (n) => `Last capture: page ${n}`,
  undoLast: "Undo",
  undoLastDone: "Last capture undone",
  autoOn: "Automatic capture: on",
  autoOff: "Automatic capture: off",
  burstOn: "Burst: stay on the camera after each page",
  burstOff: "Burst off: review after each page",
  torchOn: "Turn the flashlight off",
  torchOff: "Turn the flashlight on",
  zoomLabel: (x) => `Zoom ${x}×`,
  switchCamera: "Switch camera",
  importPhotos: "Import photos",
  toolsLabel: "Camera controls",
  hints: {
    ok: "Ready",
    move_closer: "Move closer",
    move_away: "Move back a little",
    hold_steady: "Hold steady",
    too_dark: "More light",
    glare: "There is glare",
    no_document: "I can't see the document",
    unknown: "Looking for the frame…",
  },
  hintPhoto: "Frame it and tap the button",
  hintBook: "Open the book and frame both pages",
  hintReceipt: "Frame the whole receipt",
  hintBoard: "Frame the whiteboard",
  autoRing: "Automatic capture",
  idFront: "Front",
  idBack: "Back",
  idStep: (side, n) => `ID card · ${side} (${n} of 2)`,
  idDone: "ID card saved on a single sheet",
  idCombining: "Joining front and back…",
  bookSplit: "Book split into two pages",
  cameraErrorTitle: "The camera is not available",
  cameraErrors: {
    denied: "Camera access is blocked. Allow it in your browser settings or choose photos.",
    notFound: "We could not find any camera attached to this device.",
    busy: "Another app is using the camera. Close it and try again.",
    insecure: "Browsers only open the camera over a secure connection (HTTPS).",
    unsupported: "This browser cannot open the camera from a web page.",
    unknown: "The camera could not be opened. Please try again.",
  },
  cameraFallbackTitle: "Carry on with your photos",
  cameraFallbackBody: "Choose several photos from your library or files and we turn them into a PDF just as well.",
  retryCamera: "Try again",
  focusRing: "Focusing",
  reviewTitle: "Review pages",
  reviewHelp: "Tap a page to edit it. Drag the handle to reorder.",
  statusSaved: "Saved ✓",
  statusSaving: "Saving…",
  statusUnsaved: "Not saved",
  statusQuota: "Not saved: no space left",
  statusUnavailable: "Not saved: no storage",
  statusTooBig: "Not saved: too large",
  statusStalled: "Not saved: no response",
  storageBanner: {
    unavailable: "This browser cannot save the scan (private mode?). Create the PDF before leaving.",
    quota: "There is no space left on this device to save the scan. Create the PDF before leaving.",
    tooBig: "The scan is too large to save on this device. Create the PDF before leaving.",
    stalled: "Could not save on this device; download the PDF so you do not lose your work.",
  },
  addCamera: "Camera",
  addPhotos: "Photos",
  select: "Select",
  selectDone: "Done",
  selectedCount: (count) => `${count} selected`,
  selectAll: "All",
  undo: "Undo",
  redo: "Redo",
  removeBlanks: (count) => `Remove blank sheets (${count})`,
  blanksBanner: (count) => `${count} ${count === 1 ? "sheet looks" : "sheets look"} blank`,
  sparseBanner: (count) => `${count} ${count === 1 ? "sheet is" : "sheets are"} almost empty: very little content. Check ${count === 1 ? "it" : "them"} before removing.`,
  reviewSparse: (count) => `Check almost-empty sheets (${count})`,
  blanksReview: {
    title: "Remove blank sheets",
    intro: "Look at the sheets before removing them. Only the ones you leave ticked are removed, and you can undo it afterwards.",
    blankList: (count) => `Blank (${count})`,
    sparseList: (count) => `Almost empty (${count})`,
    sparseHint: "They have very little content (a signature, a number, a line). They start UNTICKED: tick them only if you want them removed.",
    pageLabel: (n) => `Page ${n}`,
    confirm: (count) => `Remove ${count} ${count === 1 ? "sheet" : "sheets"}`,
    cancel: "Cancel",
    removedNotice: (count) => `Removed ${count} ${count === 1 ? "sheet" : "sheets"}.`,
    undo: "Undo",
    dismiss: "Close the notice",
  },
  forkSuffix: "(copy)",
  orientationNotice: ({ side, flipped }) => {
    const total = side + flipped;
    const lead = `We rotated ${total} ${total === 1 ? "page" : "pages"}`;
    if (flipped === 0) return `${lead} that ${side === 1 ? "was" : "were"} sideways.`;
    if (side === 0) return `${lead} that ${flipped === 1 ? "was" : "were"} upside down.`;
    return `${lead}: ${side} sideways and ${flipped} upside down.`;
  },
  importProblems: {
    title: (count) => (count === 1 ? "1 photo could not be added" : `${count} photos could not be added`),
    kinds: {
      notImage: "not an image",
      heic: "HEIC format, which this browser cannot read (export it as JPG)",
      damaged: "damaged or incomplete",
      engine: "the scanner could not be loaded",
    },
    engineUnavailable: "The scanner could not be loaded. Check your connection and try again.",
    retry: "Try again",
    reload: "Reload the page",
    engineReload: (count) =>
      count > 0
        ? `Reload the page to load the scanner: the pages you already added are kept. Then choose ${count === 1 ? "the photo that was not processed" : `the ${count} photos that were not processed`} again.`
        : "Reload the page to load the scanner: the pages you already added are kept.",
    camera: "Camera photo",
    more: (count) => `and ${count} more`,
    rest: "The rest are still in the list.",
    dismiss: "Close the notice about photos that were not added",
  },
  orientationUndo: "Undo rotation",
  lostPages: (count) => `${count} ${count === 1 ? "page" : "pages"} of the saved scan could not be recovered.`,
  save: (count) => `Save PDF (${count})`,
  saveBlocked: "Wait for the pages to finish processing.",
  emptyTitle: "No pages left",
  emptyBody: "Add pages with the camera or from your photos.",
  gridLabel: "Scan pages",
  tileLabel: (n, total, flags) => `Page ${n} of ${total}${flags.length ? `, ${flags.join(", ")}` : ""}`,
  quality: {
    blank: { label: "Blank", action: "Check", tip: "Looks like a blank sheet: check it before removing it" },
    blurry: { label: "Blurry", action: "Retake", tip: "It looks blurry" },
    glare: { label: "Glare", action: "Retake", tip: "It has reflections" },
    dark: { label: "Dark", action: "Retake", tip: "It is too dark" },
    duplicate: { label: "Repeated", action: "Remove", tip: "Looks like a repeat" },
    sparse: { label: "Almost empty", action: "Check", tip: "It has very little content: check it before removing it." },
    noDocument: { label: "No document detected", action: "Adjust the crop", visibleAction: "Adjust", tip: "The document was not detected: the page is whole, uncropped. Adjust the crop or keep the whole page." },
  },
  chipAction: (n, label, action) => `Page ${n}: ${label}. ${action}`,
  thumbAlt: (n) => `Page ${n}`,
  processing: "Processing…",
  rotate: (n) => `Rotate page ${n}`,
  remove: (n) => `Delete page ${n}`,
  more: (n) => `More actions for page ${n}`,
  edit: "Edit page",
  retake: "Retake",
  duplicate: "Duplicate",
  insertBefore: "Insert page before",
  insertAfter: "Insert page after",
  moveTo: "Move elsewhere",
  viewSheet: "View full sheet",
  moveUp: "Move earlier",
  moveDown: "Move later",
  insertSourceTitle: "Insert page",
  insertCamera: "With the camera",
  insertLibrary: "From my photos",
  dragHandle: (n) => `Move page ${n}`,
  dragHandleHint: "Drag, or press Space and use the arrow keys",
  dragStart: (n) => `Moving page ${n}. Use the arrow keys and drop with Space.`,
  dragMoved: (n, pos) => `Page ${n} now at position ${pos}`,
  dragCancel: "Move cancelled",
  moveModeTitle: (count) => `Choose where to put ${count === 1 ? "the page" : `the ${count} pages`}`,
  moveHere: "Move here",
  moveToEnd: "To the end",
  moveCancel: "Cancel",
  moveDone: (pos) => `Moved to position ${pos}`,
  bulkFilter: "Filter",
  bulkRotate: "Rotate",
  bulkDelete: "Delete",
  bulkMove: "Move",
  bulkFilterTitle: "Filter for the chosen pages",
  actionsLabel: "Actions for the chosen pages",
  moreTitle: (n) => `Page ${n}`,
  close: "Close",
  said: {
    added: (count) => `${count} ${count === 1 ? "page added" : "pages added"}`,
    captured: (n) => `Page ${n} captured`,
    removed: (count) => `${count} ${count === 1 ? "page deleted" : "pages deleted"}. You can undo it.`,
    rotated: (count) => `${count} ${count === 1 ? "page rotated" : "pages rotated"}`,
    duplicated: (count) => `${count} ${count === 1 ? "page duplicated" : "pages duplicated"}`,
    undone: (label) => `Undone: ${label}`,
    redone: (label) => `Redone: ${label}`,
    blanksRemoved: (count) => `${count} ${count === 1 ? "blank sheet removed" : "blank sheets removed"}. You can undo it.`,
    createFailed: "The photo could not be processed. It was not added.",
    forked: "Another tab had changed this scan: your changes were saved separately, as a copy.",
    photoFailed: (name, kind) => `${name || "A photo"} was not added: ${kind === "notImage" ? "not an image" : kind === "heic" ? "unsupported HEIC format" : kind === "engine" ? "the scanner could not be loaded (check your connection)" : "damaged or incomplete"}.`,
    saved: "Scan saved",
    retaken: (n) => `Page ${n} replaced`,
    inserted: (n) => `Page inserted at position ${n}`,
    filterAll: "Settings applied to every page",
    cancelled: "Cancelled",
  },
  labels: {
    add: "add pages",
    remove: "delete pages",
    rotate: "rotate",
    duplicate: "duplicate",
    move: "move",
    filter: "filter",
    adjust: "brightness and contrast",
    crop: "crop",
    retake: "retake",
    insert: "insert page",
    blanks: "remove blank sheets",
    orientation: "automatic orientation",
    applyAll: "apply to all",
    clear: "dismiss notice",
  },
  editorTitle: (n, total) => `Edit page ${n} of ${total}`,
  editorPrev: "Previous page",
  editorNext: "Next page",
  editorCrop: "Crop",
  editorRotate: "Rotate",
  editorFilter: "Filter",
  editorAdjust: "Brightness and contrast",
  editorApplyAll: "Apply to all",
  editorApplyAllDone: "Filter and settings applied to every page",
  brightness: "Brightness",
  contrast: "Contrast",
  resetAdjust: "Reset",
  filterLabel: "Filter",
  filters: {
    auto: "Auto",
    color: "Colour",
    grayscale: "Greys",
    bw: "B/W",
    enhance: "Enhanced",
    original: "Original",
  },
  editorDone: "Done",
  editorPreviewAlt: (n) => `View of page ${n}`,
  sheetTitle: (n, total) => `Full sheet · page ${n} of ${total}`,
  sheetFit: "Fit",
  sheetActual: "Actual size",
  sheetHint: "Zoom in to check how sharp the text is.",
  cornersTitle: "Adjust the corners",
  cornersHint:
    "Drag each corner onto the edges of the document; the magnifier helps you fine-tune. With a keyboard: tab to a corner and move it with the arrow keys.",
  cornersLoading: "Getting the editor ready…",
  cornersApply: "Apply crop",
  cornersReset: "Whole photo",
  cornersCancel: "Close without changes",
  cornersInvalid: "The corners cross over",
  saveTitle: "Save the PDF",
  saveBack: "Back to review",
  nameLabel: "File name",
  nameHint: "Suggested by the scanner; change it if you like.",
  nameReset: "Use the suggested name",
  pageSizeLabel: "Sheet size",
  pageSizeA4: "A4",
  pageSizeLetter: "Letter",
  pageSizeFit: "Fit",
  marginLabel: "Margin",
  marginNone: "No margin",
  marginSmall: "Small",
  marginLarge: "Large",
  searchable: "Searchable PDF",
  searchableHint: "Recognises the text on your device and makes it selectable and searchable. It is slower. Off by default.",
  searchableDownloadNote: (mb) => `Searchable text needs a recognition model (≈ ${mb} MB). It is downloaded once, with your permission, and works offline afterwards. Until then the PDF comes out normal, without searchable text. Your pages never leave your device.`,
  downloadModel: (mb) => `Download the text model (≈ ${mb} MB)`,
  downloadModelCancel: "Cancel the download",
  modelDownloading: "Downloading the text model…",
  modelReady: "Text model ready on this device.",
  modelFailed: {
    offline: "No connection: the model could not be downloaded. Connect and try again; meanwhile the PDF comes out without searchable text.",
    network: "The model could not be downloaded (the connection failed or is blocked). You can try again; meanwhile the PDF comes out without searchable text.",
    engine: "Text recognition did not start in this browser. The PDF will come out without searchable text.",
  },
  createMetaNoModel: "Without the text model, the PDF will come out without searchable text.",
  alreadyOptimized: (size) => `Already optimised: the size does not change with this setting (≈ ${size}).`,
  searchableFailed: "The text could not be recognised (the first time the model needs a connection). Your pages are still here: try again online or create the PDF without searchable text.",
  createWithoutText: "Create the PDF without searchable text",
  searchableWarning: ({ reason, pagesWithText, total }) => {
    const why = { "model-missing": "the text model is missing", offline: "there was no connection to download the model", network: "the model download failed", engine: "text recognition did not work in this browser" }[reason];
    const what = pagesWithText === 0 ? "without searchable text" : `only ${pagesWithText} of ${total} ${total === 1 ? "page has" : "pages have"} searchable text`;
    return `The PDF is fine, but ${what}: ${why}.`;
  },
  searchableNoticeTitle: "Searchable text",
  create: "Create PDF",
  createMeta: (count, size) => `${count} ${count === 1 ? "page" : "pages"} · ${size}`,
  sizeBig: "Over ~20 MB: some email services will reject it. Try the “Compact” quality.",
  sizeHuge: "Over ~100 MB: WhatsApp and most email services will not accept it. Use “Compact” or split it afterwards.",
  buildProgress: (n, total) => `Creating page ${n} of ${total}…`,
  buildCancelled: "Creation cancelled. Your pages are still here.",
  buildFailed: "The PDF could not be created. Your pages are still saved; try again.",
  share: "Share",
  shareDone: "PDF shared",
  shareFailed: "Could not share; use Download.",
  backToReview: "Back to review",
  newScan: "Scan another document",
  newScanHint: "Closes this scan and starts a new one.",
  leaveTitle: "Leave the scan?",
  leaveBodySaved: (count) =>
    `Your pages (${count}) stay saved on this device so you can pick them up again: you can continue for 14 days.`,
  leaveBodyUnsaved: (count) =>
    `This scan could not be saved on the device. If you leave, ${count} ${count === 1 ? "page" : "pages"} will be lost.`,
  leaveStay: "Keep scanning",
  leaveLeave: "Leave",
  noFiles: "Choose at least one photo.",
  inputFiles: "Photo and image file picker",
  inputCamera: "Capture with the system camera",
};

export const STRINGS: Record<Language, ScanToPdfStrings> = { es: ES, en: EN };
