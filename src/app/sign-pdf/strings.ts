import type { Language } from "@/lib/i18n";

/** Copy propio de la herramienta de firma (ES/EN). */
export type SignStrings = {
  createTitle: string;
  createSignature: string;
  changeSignature: string;
  modeDraw: string;
  modeType: string;
  modeUpload: string;
  drawHint: string;
  clear: string;
  /** Boton "no, cancelar" de un `ConfirmSheet` -- generico, cualquier confirmacion lo reutiliza. */
  confirmCancel: string;
  /** Aria-label del boton "X" de cerrar de un `ConfirmSheet` -- distinto de `confirmCancel` para no repetir el mismo texto en dos botones del mismo dialogo. */
  confirmClose: string;
  typeLabel: string;
  typePlaceholder: string;
  styleLabel: string;
  styleNames: [string, string, string, string];
  uploadPick: string;
  uploadHint: string;
  inkLabel: string;
  strokeLabel: string;
  rotateHint: string;
  save: string;
  emptyWarning: string;
  noSignature: string;
  previousPage: string;
  nextPage: string;
  pageOf: (current: number, total: number) => string;
  loadingPreview: string;
  legalNote: string;
  filenameSuffix: string;

  /* --- Certificado de finalizacion (pagina final opcional) --- */
  certificateTitle: string;
  certificateHashLabel: string;
  certificateTimestampLabel: string;
  certificateSignersLabel: string;
  certificateNoSignerName: string;
  certificateDisclaimer: string;

  /* --- Eleccion de flujo --- */
  modeLabel: string;
  modeSingle: string;
  modeSingleHint: string;
  modeMulti: string;
  modeMultiHint: string;

  /* --- Pasos del flujo con varios firmantes --- */
  stepSigners: string;
  stepDocument: string;
  stepSign: string;
  back: string;
  next: string;

  /* --- Paso "Documento": lienzo unico de huecos y campos (W2-A) --- */
  documentTitle: string;
  documentHint: string;
  /** Sin firmantes solo se pueden colocar campos de texto. */
  slotsNeedSigners: string;
  canvasEmptyHint: string;
  /** "En esta página: 1 hueco · 3 campos". */
  canvasPageSummary: (slots: number, textFields: number) => string;
  /** "En este documento: 2 huecos · 5 campos". */
  canvasTotalSummary: (slots: number, textFields: number) => string;
  /** Estado en el nombre accesible de cada elemento del lienzo ("Nombre, pendiente"). */
  a11yPending: string;
  a11yFilled: string;
  a11ySlot: string;

  /* --- Paleta de herramientas y barra flotante (W2-B) --- */
  paletteLabel: string;
  toolSelect: string;
  /** Estado de la herramienta activa (region viva): "Herramienta: Firma. Toca o arrastra sobre la pagina." */
  toolArmedStatus: (tool: string) => string;
  toolSelectStatus: string;
  /** "Se asignará a Ana" bajo la herramienta Firma/Iniciales. */
  toolAssignedTo: (name: string) => string;
  prevField: string;
  nextField: string;
  noMorePendingFields: string;
  /** Anuncio al saltar de campo: "Nombre, campo 3 de 12". */
  fieldNavAnnounce: (label: string, position: number, total: number) => string;
  /** "Acciones de «Nombre, pendiente»": el grupo de la barra nombra el elemento al que afecta. */
  selectionBarLabel: (target: string) => string;
  /** "Duplicar «Nombre, pendiente»": nombre accesible de cada accion de la barra. */
  elementAction: (action: string, target: string) => string;
  duplicateElement: string;
  elementDuplicated: string;
  signerOfSlotLabel: string;
  slotChangedTo: (name: string, type: string) => string;
  fieldChangedTo: (type: string) => string;
  clearPageAll: string;
  clearAllAll: string;
  confirmClearAllEverythingTitle: string;
  confirmClearAllEverythingBody: string;

  /* --- Modo "Solo yo" sobre el mismo lienzo (W2-C) --- */
  /** Nombre de la firma propia colocada sobre la pagina. */
  soloSignatureLabel: string;
  /** Su rol en el nombre accesible ("Mi firma, firma colocada"). */
  soloSignatureA11y: string;
  soloRemoveSignature: string;
  /** Alta sin puntero con la herramienta Firma armada. */
  soloPlaceHere: string;
  soloResizeSignature: string;
  soloSignatureDeletedNotice: string;
  /** Anuncio al colocar la firma por defecto tras crearla. */
  soloSignaturePlaced: (page: number) => string;
  soloDocumentHint: string;
  soloCanvasEmptyHint: string;
  /** "En esta página: 1 firma · 3 campos". */
  soloPageSummary: (signatures: number, textFields: number) => string;
  /** "En este documento: 1 firma · 5 campos". */
  soloTotalSummary: (signatures: number, textFields: number) => string;

  /* --- Firmantes --- */
  signersTitle: string;
  signersHint: string;
  addSigner: string;
  signerNameLabel: (position: number) => string;
  defaultSignerName: (position: number) => string;
  removeSigner: (name: string) => string;
  signerLimit: string;
  noSigners: string;
  signerFieldCount: (count: number) => string;
  activeSignerLabel: string;
  activeSignerHint: string;
  /** Anuncio del snackbar tras borrar un firmante con "Deshacer" activo. */
  signerDeletedNotice: string;
  undoRemoveSigner: string;
  /** El deshacer ya no cabe: se dio de alta otro firmante y la ronda esta en el maximo. */
  undoRemoveSignerUnavailable: string;

  /* --- Huecos de firma / iniciales --- */
  fieldTypeLabel: string;
  fieldSignature: string;
  fieldInitials: string;
  addFieldHere: string;
  fieldOwnerLabel: (name: string, type: string) => string;
  removeField: string;
  resizeField: string;
  /** Anuncio del snackbar tras borrar un hueco con "Deshacer" activo. */
  fieldDeletedNotice: string;
  undoRemoveField: string;
  totalFields: (count: number) => string;
  clearPageFields: string;
  clearAllFields: string;
  confirmClearAllFieldsTitle: string;
  confirmClearAllFieldsBody: string;
  thumbsTitle: string;
  goToPage: (page: number) => string;
  needSigner: string;

  /* --- Campos de texto (deteccion + relleno) --- */
  detectingFields: string;
  detectionFailedHint: string;
  detectedFieldsSummary: (count: number) => string;
  addTextFieldHere: string;
  /** Vuelve el lienzo a 1x tras un pellizco (Ajustes > Zoom con pellizco). */
  resetZoomButton: string;
  zoomGroupLabel: string;
  zoomIn: string;
  zoomOut: string;
  /** Selector de tipo compacto de la barra flotante (un solo boton que abre las opciones). */
  changeFieldType: (current: string) => string;
  closeTypePicker: string;
  /** Aviso al cambiar de tipo cuando el valor tecleado no vale para el tipo nuevo y se borra. */
  typeChangeClearedNotice: (type: string) => string;
  undoTypeChange: string;
  textFieldFallbackLabel: (position: number) => string;
  textFieldPlaceholder: string;
  initialsFieldPlaceholder: string;
  /** Segmentado "Texto / Casilla / Fecha / Inicial" del campo seleccionado. */
  textFieldTypeLabel: string;
  fieldTypeText: string;
  fieldTypeCheckbox: string;
  fieldTypeDate: string;
  fieldTypeInitials: string;
  removeTextField: string;
  resizeTextField: string;
  clearPageTextFields: string;
  clearAllTextFields: string;
  confirmClearAllTextFieldsTitle: string;
  confirmClearAllTextFieldsBody: string;
  lowConfidenceHint: string;
  /** Aviso NO bloqueante antes de firmar/descargar si quedan campos vacios. */
  pendingTextFieldsWarning: (missing: number) => string;
  /** Anuncio del snackbar tras borrar un campo con "Deshacer" activo. */
  textFieldDeletedNotice: string;
  undoRemoveTextField: string;
  reuseValuesPrompt: string;
  reuseValuesAccept: string;
  reuseValuesDecline: string;
  /** Aria-label del boton "x" para olvidar una sugerencia guardada, ej. "Olvidar «Ana Perez»". */
  forgetSuggestion: (value: string) => string;

  /* --- Ceremonia por turnos --- */
  ceremonyTitle: string;
  checkingDocument: string;
  turnOf: (current: number, total: number) => string;
  handoffTitle: (name: string) => string;
  handoffBody: (name: string) => string;
  handoffReady: string;
  captureTitle: (name: string) => string;
  captureBody: string;
  captureSignature: string;
  captureInitials: string;
  captureRedo: string;
  capturePending: string;
  captureContinue: string;
  reviewTitle: (name: string) => string;
  reviewBody: (count: number) => string;
  reviewRedo: string;
  reviewNext: string;
  reviewFinish: string;
  statusPending: string;
  statusSigned: string;
  allSignedTitle: string;
  allSignedBody: string;
  pendingBody: (count: number) => string;
  applyAndDownload: string;
  restartCeremony: string;
  textOnlyReadyTitle: string;
  textOnlyReadyBody: string;
  finishAndDownload: string;

  /* --- Prefijo de firmantes en el nombre de archivo --- */
  filenamePrefixTitle: string;
  filenamePrefixBody: string;
  filenamePrefixYes: string;
  filenamePrefixNo: string;

  /* --- Compositor con contexto --- */
  composerFor: (name: string) => string;
  composerInitialsFor: (name: string) => string;
  initialsHint: string;
  initialsPlaceholder: string;

  /* --- Avisos --- */
  noFieldsError: string;
  notAllSignedError: string;
  progressMessage: string;

  /* --- Privacidad del historial de valores (localStorage) --- */
  privacyNoticeToggle: string;
  privacyNoticeBody: string;
  /** Solo se muestra con el baul de firmas encendido: habla de una casilla que, apagado, no existe. */
  privacyNoticeVaultNote: string;
  privacyClearData: string;
  privacyClearDataTitle: string;
  privacyClearDataBody: string;
  privacyDataCleared: string;

  /* --- "Firmar otro documento con los mismos datos?" --- */
  signAgainTitle: string;
  signAgainBody: string;
  signAgainAccept: string;

  /* --- Borradores locales (IndexedDB) --- */
  draftsButton: string;
  draftsTitle: string;
  draftsEmpty: string;
  draftsResume: string;
  draftsDelete: (fileName: string) => string;
  draftsSavedAt: (date: string) => string;
  draftsConfirmDeleteTitle: string;
  draftsConfirmDeleteBody: string;
  /** Una sesion (varias documentos) se muestra como UNA fila. */
  draftsDocuments: (count: number) => string;
  draftsConfirmDeleteSessionBody: (count: number) => string;
  /** La ronda pesa demasiado para guardarse como borrador (tope por sesion). */
  draftsTooBig: string;
  /** Al retomar: bloques que reclamaban un mismo documento y se normalizaron. */
  draftsResumeNormalized: (count: number) => string;
  /** Al retomar: documentos cuyo contenido ya no coincide con el guardado. */
  draftsResumeStale: (count: number) => string;
  /** Al retomar una sesion mas grande de lo que admite una ronda: solo los primeros que caben. */
  draftsResumeTrimmed: (kept: number, total: number) => string;
  /** Con «varios documentos» apagado en Ajustes no se carga una ronda de varios. */
  multiDocOffNotice: string;

  /* --- Exportar/importar configuracion --- */
  exportConfigButton: string;
  importConfigButton: string;
  /** Aviso bajo el boton de exportar: el .zip contiene los documentos. */
  exportConfigNote: string;

  /* --- Plantillas de disposicion reutilizables (localStorage) --- */
  templatesButton: string;
  templatesTitle: string;
  templatesEmpty: string;
  templatesApply: string;
  templatesDelete: (name: string) => string;
  templatesSavedAt: (date: string) => string;
  /** "2 firmantes · 3 huecos · 1 campo de texto". */
  templatesSummary: (
    signers: number,
    fields: number,
    textFields: number,
  ) => string;
  templatesConfirmDeleteTitle: string;
  templatesConfirmDeleteBody: string;
  saveAsTemplateButton: string;
  saveTemplateTitle: string;
  saveTemplateBody: string;
  saveTemplateNameLabel: string;
  saveTemplateNamePlaceholder: string;
  saveTemplateConfirm: string;
  saveTemplateLimitError: string;
  saveTemplateUnavailableError: string;
  saveTemplateSuccess: string;
  applyTemplateConfirmTitle: string;
  applyTemplateConfirmBody: string;
  applyTemplateConfirm: string;
  /** Se aplico, pero algunos campos no encajaban en el documento actual. */
  applyTemplateDropped: (dropped: number) => string;
  /** «Aplicar a todos los documentos» (varios documentos). */
  templatesApplyAll: string;
  applyTemplateAllConfirmBody: string;
  applyTemplateAllDone: (documents: number, dropped: number) => string;
  applyTemplateNothingFits: string;

  /* --- Baul de firmas guardadas (IndexedDB, W3) --- */
  vaultButton: string;
  vaultTitle: string;
  vaultIntro: string;
  vaultLoading: string;
  vaultEmpty: string;
  vaultUnavailable: string;
  vaultCreateNew: string;
  vaultUse: string;
  vaultUseFor: (name: string) => string;
  vaultUseSaved: string;
  vaultUseSavedFor: (typeLabel: string) => string;
  vaultMatchesSigner: string;
  vaultLacksSignature: string;
  vaultLacksInitials: string;
  vaultSignatureAlt: (name: string) => string;
  vaultInitialsAlt: (name: string) => string;
  vaultUsedIn: (document: string) => string;
  vaultLastUsed: (date: string) => string;
  vaultEditLabel: (name: string) => string;
  vaultEditNameLabel: string;
  vaultEditRoleLabel: string;
  vaultEditSave: string;
  vaultEditCancel: string;
  vaultEditInvalid: string;
  vaultEdited: string;
  vaultDeleteLabel: (name: string) => string;
  vaultDeleted: string;
  vaultDeleteAll: string;
  vaultDeleteAllTitle: string;
  vaultDeleteAllBody: string;
  vaultDeletedAll: string;
  vaultOpFailed: string;
  vaultExport: string;
  vaultExportFor: (name: string) => string;
  vaultImport: string;
  vaultExportTitle: string;
  vaultExportBody: string;
  vaultExportPasswordLabel: string;
  vaultExportPasswordConfirmLabel: string;
  vaultExportPasswordHint: string;
  vaultExportPasswordUnavailable: string;
  vaultExportPasswordMismatch: string;
  vaultExportIncludeDocument: string;
  vaultExportIncludeDocumentHint: string;
  vaultExportPlainWarning: string;
  vaultExportConfirm: string;
  vaultExportWorking: string;
  vaultExportDone: (filename: string, encrypted: boolean) => string;
  vaultExportFailed: string;
  vaultImportWorking: string;
  vaultImportPasswordTitle: string;
  vaultImportPasswordBody: string;
  vaultImportPasswordLabel: string;
  vaultImportPasswordConfirm: string;
  vaultImportWrongPassword: string;
  vaultImported: (name: string) => string;
  vaultImportedDuplicate: (name: string) => string;
  vaultImportInvalid: string;
  vaultImportTooLarge: string;
  vaultImportUnsupportedVersion: string;
  vaultImportNoEncryption: string;
  vaultSaveLimit: string;
  vaultSaveTooLarge: string;
  vaultSaveUnavailable: string;
  vaultSaveInvalid: string;
  vaultSaved: string;
  vaultSavedDuplicate: string;
  vaultSavedInitials: string;
  vaultSavedDuplicateInitials: string;
  vaultRemember: string;
  vaultRememberHint: string;
  vaultRememberFor: (name: string) => string;
  vaultRememberNameLabel: string;
  vaultRememberNamePlaceholder: string;
  vaultRememberNeedsName: string;
  vaultApplied: (name: string) => string;
  vaultAppliedPartial: (
    name: string,
    missing: readonly ("signature" | "initials")[],
  ) => string;
  vaultClearFailed: (stores: readonly ("vault" | "drafts" | "editDrafts")[]) => string;

  /* --- Varios documentos (W4-U1) --- */
  documentsLabel: string;
  /** Texto del selector de documentos: «2. Contrato B». */
  documentTab: (index: number, name: string) => string;
  /** Region viva al cambiar de documento: «Documento 2 de 3: Contrato B». */
  documentLive: (index: number, count: number, name: string) => string;
  documentSwitchHint: string;
  /* --- Vista continua y «Solo yo» con varios documentos (W4-U4) --- */
  /** Nombre del grupo del paginador global (`role=group`). */
  sequenceBarLabel: string;
  /** Etiqueta discreta del documento visible: «Contrato B · p. 2/3». */
  sequenceDocPage: (name: string, local: number, total: number | null) => string;
  /** Region viva al cambiar de documento: «Documento 2 de 3: Contrato B, página 2 de 3». */
  sequenceLive: (
    docIndex: number,
    docCount: number,
    name: string,
    local: number,
    total: number | null,
  ) => string;
  /** Tira de miniaturas de todos los documentos. */
  sequenceThumbsTitle: string;
  sequenceThumbsHint: string;
  /** Un grupo de la tira: «2. Contrato B (3 páginas)». */
  sequenceDocGroup: (index: number, name: string, pages: number | null) => string;
  sequenceGoToPage: (page: number, name: string) => string;
  /** Indicador por documento en «Solo yo». */
  docBadgePlaced: string;
  docBadgePending: string;
  /** «Aplicar a todos los documentos» (firma de «Solo yo»). */
  soloAllTitle: string;
  soloAllSummary: (placed: number, total: number) => string;
  soloApplyAll: string;
  soloApplyAllBusy: string;
  soloApplyAllDone: (count: number) => string;
  soloApplyAllFailed: string;
  soloApplyAllUndo: string;
  soloApplyAllUndone: string;
  soloApplyAllHint: string;
  /** Copias identicas en la cola: informativo, no bloquea. */
  duplicateDocsNotice: (names: readonly string[]) => string;
  /** Con varios documentos la descarga conjunta aun no esta conectada: motivo visible del boton desactivado. */
  docLimitCount: (max: number, names: readonly string[]) => string;
  docLimitSize: (maxMb: number, names: readonly string[]) => string;
  docLimitTotal: (maxMb: number, names: readonly string[]) => string;

  /* --- Bloques por firmante, ceremonia y entrega (W4-U3) --- */
  /** Control global «mismas firmas / firmas distintas por documento». */
  signModeLabel: string;
  signModeSame: string;
  signModeIndependent: string;
  signModeSameHint: string;
  signModeIndependentHint: string;
  /** Anuncio del cambio de modo (region viva). */
  signModeChangedSame: string;
  signModeChangedIndependent: string;
  /** Distintas -> Mismas descarto trazos de N bloques: ofrece deshacer. */
  signModeMergedNotice: (discarded: number) => string;
  undoSignMode: string;
  signModeRestored: string;
  /** Bloques de un firmante. */
  signerBlocksLabel: (name: string) => string;
  blockName: (position: number) => string;
  blockScopeAll: (count: number) => string;
  /** Nombres de documento; `more` = cuantos mas no se nombran. */
  blockScopeSome: (names: readonly string[], more: number) => string;
  blockAppliesTo: (summary: string) => string;
  blockChangeScope: string;
  blockChangeScopeFor: (block: string, signer: string) => string;
  blockAdd: string;
  blockAddFor: (signer: string) => string;
  blockAddFull: string;
  blockRemove: string;
  blockRemoveFor: (block: string, signer: string) => string;
  blockAdded: (signer: string, position: number) => string;
  blockRemoved: (position: number) => string;
  blockScopeMoved: (doc: string, from: number, to: number) => string;
  blockScopeUpdated: (block: string, summary: string) => string;
  /** Hoja de alcance. */
  scopeSheetTitle: (block: string, signer: string) => string;
  scopeSheetIntro: string;
  scopeDocsLabel: string;
  scopeAllLabel: string;
  scopeEmpty: string;
  scopeMovePreview: (doc: string, fromBlock: number) => string;
  scopeApply: string;
  /** Cobertura: un firmante con huecos en un documento sin bloque que lo cubra. */
  coverageMissing: (signer: string, doc: string) => string;
  coverageAddBlock: (doc: string) => string;
  /** Ceremonia por bloques. */
  blockCaptureBody: string;
  blockReviewBody: (blocks: number, documents: number) => string;
  vaultApplyAll: string;
  vaultApplyAllHint: string;
  vaultAppliedAll: (name: string, others: number) => string;
  vaultSourceMany: (count: number) => string;
  /** Entrega conjunta. */
  deliveryBlockedTitle: string;
  batchSoloUnplaced: (doc: string) => string;
  batchPendingBlocks: (signer: string, count: number) => string;
  batchDocEmpty: (doc: string) => string;
  batchReadyBody: (documents: number) => string;
  batchSummary: (documents: number, slots: number) => string;
  batchDocsCount: (documents: number) => string;
};

/** «Contrato» · «Contrato y 2 más»: nombres de archivo para los avisos de limite. */
function quotedNames(names: readonly string[], and: string, more: (n: number) => string): string {
  if (names.length === 0) return "";
  const first = `«${names[0]}»`;
  if (names.length === 1) return first;
  return `${first} ${and} ${more(names.length - 1)}`;
}

const es: SignStrings = {
  createTitle: "Tu firma",
  createSignature: "Crear firma",
  changeSignature: "Rehacer firma",
  modeDraw: "Dibujar",
  modeType: "Escribir",
  modeUpload: "Subir",
  drawHint: "Traza la firma con el dedo o el ratón dentro del recuadro.",
  clear: "Borrar trazo",
  confirmCancel: "Cancelar",
  confirmClose: "Cerrar",
  typeLabel: "Nombre",
  typePlaceholder: "Escribe tu nombre",
  styleLabel: "Estilo de letra",
  styleNames: ["Manuscrita", "Caligráfica", "Clásica", "Sobria"],
  uploadPick: "Elegir imagen de la firma",
  uploadHint:
    "Un PNG con fondo transparente da el mejor resultado. También se admite JPG.",
  inkLabel: "Color de la tinta",
  strokeLabel: "Grosor del trazo",
  rotateHint: "Gira el teléfono para firmar con más espacio.",
  save: "Usar esta firma",
  emptyWarning: "Todavía no hay nada que guardar.",
  noSignature: "Crea tu firma para poder colocarla sobre el documento.",
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  pageOf: (current, total) => `Página ${current} de ${total}`,
  loadingPreview: "Preparando la vista previa",
  legalNote:
    "Es una firma visual: se dibuja sobre la página. No sustituye a una firma electrónica cualificada con certificado.",
  filenameSuffix: "firmado",

  certificateTitle: "Certificado de finalización",
  certificateHashLabel: "Hash SHA-256 del documento firmado",
  certificateTimestampLabel: "Fecha y hora",
  certificateSignersLabel: "Firmantes",
  certificateNoSignerName: "Sin nombre",
  certificateDisclaimer:
    "Esta página es solo trazabilidad informal: el hash permite comprobar que el documento no cambió después de firmarse. No es una firma electrónica cualificada ni certificada.",

  modeLabel: "¿Quién firma?",
  modeSingle: "Solo yo",
  modeSingleHint:
    "Creas tu firma, la colocas donde quieras y, si el documento tiene campos, los rellenas ahí mismo. Después descargas. Es el camino rápido.",
  modeMulti: "Varios firmantes",
  modeMultiHint:
    "Reserva un hueco para cada persona y firmad por turnos en este mismo dispositivo, pasándooslo de mano en mano.",

  stepSigners: "Firmantes",
  stepDocument: "Documento",
  stepSign: "Firmar",
  back: "Atrás",
  next: "Continuar",

  documentTitle: "Prepara el documento",
  documentHint:
    "Elige una herramienta (firma, iniciales, texto, casilla o fecha) y toca la página para colocarla, o arrastra para dibujarla. Toca un campo para escribir ahí mismo; con Seleccionar puedes moverlos y ajustarlos.",
  slotsNeedSigners:
    "Para reservar huecos de firma, añade antes a alguien en el paso 1. Mientras tanto puedes colocar campos de texto.",
  canvasEmptyHint:
    "Todavía no hay nada sobre el documento: elige una herramienta y toca la página. Los campos de texto son opcionales; para firmar hace falta al menos un hueco de firma o un campo relleno.",
  canvasPageSummary: (slots, textFields) =>
    `En esta página: ${slots} hueco${slots === 1 ? "" : "s"} · ${textFields} campo${textFields === 1 ? "" : "s"}`,
  canvasTotalSummary: (slots, textFields) =>
    `En este documento: ${slots} hueco${slots === 1 ? "" : "s"} · ${textFields} campo${textFields === 1 ? "" : "s"}`,
  a11yPending: "pendiente",
  a11yFilled: "rellenado",
  a11ySlot: "hueco de firma",

  paletteLabel: "Herramientas del documento",
  toolSelect: "Seleccionar",
  toolArmedStatus: (tool) =>
    `Herramienta activa: ${tool}. Toca la página para colocar uno o arrastra para dibujarlo. Escape vuelve a Seleccionar.`,
  toolSelectStatus:
    "Seleccionar: toca un elemento para moverlo o editarlo. Elige otra herramienta para añadir.",
  toolAssignedTo: (name) => `Se asignará a ${name}`,
  prevField: "Campo anterior",
  nextField: "Campo siguiente",
  noMorePendingFields: "No quedan más campos pendientes.",
  fieldNavAnnounce: (label, position, total) =>
    `${label}, campo ${position} de ${total}`,
  selectionBarLabel: (target) => `Acciones de «${target}»`,
  elementAction: (action, target) => `${action} «${target}»`,
  duplicateElement: "Duplicar",
  elementDuplicated: "Elemento duplicado.",
  signerOfSlotLabel: "Firmante del hueco",
  slotChangedTo: (name, type) => `Hueco de ${name}: ${type}.`,
  fieldChangedTo: (type) => `Tipo de campo: ${type}.`,
  clearPageAll: "Quitar todo de esta página",
  clearAllAll: "Borrar todo el documento",
  confirmClearAllEverythingTitle: "¿Borrar huecos y campos?",
  confirmClearAllEverythingBody:
    "Se van a quitar todos los huecos de firma y todos los campos del documento, en todas las páginas, junto con lo que hayas escrito en ellos. Esta acción no se puede deshacer.",

  soloSignatureLabel: "Mi firma",
  soloSignatureA11y: "firma colocada",
  soloRemoveSignature: "Quitar la firma",
  soloPlaceHere: "Colocar mi firma en esta página",
  soloResizeSignature: "Cambiar el tamaño de la firma",
  soloSignatureDeletedNotice: "Firma quitada del documento.",
  soloSignaturePlaced: (page) =>
    `Firma colocada en la página ${page}. Arrástrala para moverla.`,
  soloDocumentHint:
    "Coloca tu firma y rellena los campos del documento ahí mismo. Elige una herramienta (firma, texto, casilla o fecha) y toca la página, o arrastra para dibujarla. Toca un campo para escribir en él; con Seleccionar puedes moverlos y ajustarlos.",
  soloCanvasEmptyHint:
    "Todavía no hay nada sobre el documento. Crea tu firma y se colocará en la página; también puedes añadir campos de texto, casillas o fechas con la paleta.",
  soloPageSummary: (signatures, textFields) =>
    `En esta página: ${signatures} firma${signatures === 1 ? "" : "s"} · ${textFields} campo${textFields === 1 ? "" : "s"}`,
  soloTotalSummary: (signatures, textFields) =>
    `En este documento: ${signatures} firma${signatures === 1 ? "" : "s"} · ${textFields} campo${textFields === 1 ? "" : "s"}`,

  signersTitle: "¿Quién tiene que firmar?",
  signersHint:
    "Añade a cada persona. El color sirve para reconocer sus huecos sobre el documento.",
  addSigner: "Añadir firmante",
  signerNameLabel: (position) => `Nombre del firmante ${position}`,
  defaultSignerName: (position) => `Firmante ${position}`,
  removeSigner: (name) => `Quitar a ${name}`,
  signerLimit: "Puedes añadir hasta 2 firmantes.",
  noSigners: "Añade al menos un firmante para continuar.",
  signerFieldCount: (count) =>
    count === 1 ? "1 hueco" : `${count} huecos`,
  activeSignerLabel: "Firmante activo",
  activeSignerHint:
    "Los huecos nuevos se asignan al firmante activo. Cámbialo antes de marcar los suyos.",
  signerDeletedNotice: "Firmante eliminado, junto con sus huecos y su firma.",
  undoRemoveSigner: "Deshacer",
  undoRemoveSignerUnavailable:
    "Ya no se puede deshacer: la ronda ya tiene el máximo de firmantes.",

  fieldTypeLabel: "Tipo de hueco",
  fieldSignature: "Firma",
  fieldInitials: "Iniciales",
  addFieldHere: "Añadir hueco en esta página",
  fieldOwnerLabel: (name, type) => `${name} — ${type}`,
  removeField: "Quitar el hueco",
  fieldDeletedNotice: "Hueco eliminado.",
  undoRemoveField: "Deshacer",
  resizeField: "Cambiar el tamaño del hueco",
  totalFields: (count) =>
    count === 1 ? "1 hueco en total" : `${count} huecos en total`,
  clearPageFields: "Quitar los huecos de esta página",
  clearAllFields: "Borrar todos los huecos del documento",
  confirmClearAllFieldsTitle: "¿Borrar todos los huecos?",
  confirmClearAllFieldsBody:
    "Se van a quitar todos los huecos de firma/iniciales reservados en el documento, en todas las páginas. Esta acción no se puede deshacer.",
  thumbsTitle: "Páginas",
  goToPage: (page) => `Ir a la página ${page}`,
  needSigner: "Elige antes a quién pertenece el hueco",

  detectingFields: "Buscando campos rellenables en el documento",
  detectionFailedHint:
    "No se pudieron detectar campos automáticamente, pero puedes añadirlos a mano arrastrando sobre la página.",
  detectedFieldsSummary: (count) =>
    count === 1
      ? "Se detectó 1 campo. Revísalo antes de firmar."
      : `Se detectaron ${count} campos. Revísalos antes de firmar.`,
  addTextFieldHere: "Añadir campo en esta página",
  resetZoomButton: "Restablecer zoom",
  zoomGroupLabel: "Zoom del documento",
  zoomIn: "Acercar",
  zoomOut: "Alejar",
  changeFieldType: (current) => `Cambiar el tipo de campo (ahora: ${current})`,
  closeTypePicker: "Volver a las acciones",
  typeChangeClearedNotice: (type) =>
    `Se borró el valor porque no vale como «${type}».`,
  undoTypeChange: "Deshacer",
  textFieldFallbackLabel: (position) => `Campo ${position}`,
  textFieldPlaceholder: "Escribe el valor",
  initialsFieldPlaceholder: "Iniciales",
  textFieldTypeLabel: "Tipo de campo",
  fieldTypeText: "Texto",
  fieldTypeCheckbox: "Casilla",
  fieldTypeDate: "Fecha",
  fieldTypeInitials: "Inicial",
  removeTextField: "Quitar el campo",
  resizeTextField: "Cambiar el tamaño del campo",
  clearPageTextFields: "Quitar los campos de esta página",
  clearAllTextFields: "Borrar todos los campos del documento",
  confirmClearAllTextFieldsTitle: "¿Borrar todos los campos?",
  confirmClearAllTextFieldsBody:
    "Se van a quitar todos los campos de texto detectados o añadidos a mano, en todas las páginas, junto con lo que hayas escrito en ellos. Esta acción no se puede deshacer.",
  lowConfidenceHint:
    "Contorno discontinuo = detección experimental sobre una imagen escaneada. Revísala antes de firmar; si no es un campo real, bórrala.",
  pendingTextFieldsWarning: (missing) =>
    `Queda${missing === 1 ? "" : "n"} ${missing} campo${missing === 1 ? "" : "s"} de texto sin rellenar. Puedes continuar igual.`,
  textFieldDeletedNotice: "Campo eliminado.",
  undoRemoveTextField: "Deshacer",
  reuseValuesPrompt: "¿Usar los mismos datos que en tu último documento?",
  reuseValuesAccept: "Sí, rellenar",
  reuseValuesDecline: "No, empezar en blanco",
  forgetSuggestion: (value) => `Olvidar «${value}»`,

  ceremonyTitle: "Firmad por turnos",
  checkingDocument: "Comprobando el documento antes de firmar",
  turnOf: (current, total) => `Turno ${current} de ${total}`,
  handoffTitle: (name) => `Pásale el dispositivo a ${name}`,
  handoffBody: (name) =>
    `${name} verá solo sus huecos y firmará aquí mismo. Nada sale de este dispositivo.`,
  handoffReady: "Listo, es mi turno",
  captureTitle: (name) => `Firma de ${name}`,
  captureBody:
    "Dibuja, escribe o sube tu firma. Se colocará automáticamente en los huecos reservados para ti.",
  captureSignature: "Crear mi firma",
  captureInitials: "Crear mis iniciales",
  captureRedo: "Rehacer",
  capturePending: "Pendiente",
  captureContinue: "Ver cómo queda",
  reviewTitle: (name) => `Así queda la firma de ${name}`,
  reviewBody: (count) =>
    count === 1
      ? "Se rellenará 1 hueco con lo que acabas de crear."
      : `Se rellenarán ${count} huecos con lo que acabas de crear.`,
  reviewRedo: "Rehacer mi firma",
  reviewNext: "Pasar al siguiente firmante",
  reviewFinish: "He terminado",
  statusPending: "Sin firmar",
  statusSigned: "Firmado",
  allSignedTitle: "Ya han firmado todos",
  allSignedBody:
    "Aplica las firmas para generar el PDF definitivo y descargarlo.",
  pendingBody: (count) =>
    count === 1
      ? "Falta 1 firmante por firmar."
      : `Faltan ${count} firmantes por firmar.`,
  applyAndDownload: "Firmar y descargar",
  restartCeremony: "Empezar la ronda de nuevo",
  textOnlyReadyTitle: "Listo para descargar",
  textOnlyReadyBody:
    "Este documento no tiene firmas por recoger: aplica los campos de texto rellenos y genera el PDF final.",
  finishAndDownload: "Aplicar y descargar",

  filenamePrefixTitle: "Nombre del archivo",
  filenamePrefixBody:
    "¿Agregamos los nombres de los firmantes al principio del nombre del archivo? Por ejemplo: ana-perez_and_luis-gomez_contrato-firmado.pdf.",
  filenamePrefixYes: "Sí, agregarlos",
  filenamePrefixNo: "No, dejar el nombre como está",

  composerFor: (name) => `Firma de ${name}`,
  composerInitialsFor: (name) => `Iniciales de ${name}`,
  initialsHint:
    "Con dos o tres trazos basta: las iniciales van en un hueco pequeño y casi cuadrado.",
  initialsPlaceholder: "Tus iniciales",

  noFieldsError: "No hay ningún hueco reservado sobre el documento.",
  notAllSignedError: "Todavía falta gente por firmar.",
  progressMessage: "Aplicando las firmas",

  privacyNoticeToggle: "Cómo usamos tus datos",
  privacyNoticeBody:
    "OptimusPDF no guarda datos en la nube ni en un servidor. Los datos únicamente existen y se manejan en su dispositivo y tu navegador. Si deseas eliminar completamente los datos, solo cierra la pestaña, borra los datos de navegación de tu navegador o haz clic en el botón 'Borrar datos'. Los datos que se guardan en tu navegador solo sirven para usarlos en otros documentos que abras en tu navegador, puedes borrarlos cuando lo desees. Mientras trabajas con varios firmantes, el borrador guarda la sesión completa en este dispositivo (los documentos, los firmantes y las firmas ya hechas) para que puedas retomarla, y si exportas la configuración, el archivo .zip contiene tus documentos. El borrador se guarda unas décimas de segundo después de cada cambio; si el navegador se cierra a la fuerza (o la pestaña se descarta) justo después de un cambio, lo último podría no guardarse. Todo se elimina con «Borrar datos» (o «Borrar datos locales» en Ajustes).",
  privacyNoticeVaultNote:
    "Las firmas e iniciales solo se guardan en este dispositivo si marcas «Recordar en este dispositivo»; nunca se suben. Si exportas una firma, el archivo contiene la firma en claro a menos que le pongas contraseña.",
  privacyClearData: "Borrar datos",
  privacyClearDataTitle: "¿Borrar los datos guardados?",
  privacyClearDataBody:
    "Se van a borrar todos los valores de campos que se recordaron para sugerirlos en otros documentos (nombres, direcciones, números y demás texto que hayas escrito), además de los borradores (con todos los documentos, firmantes y firmas de cada sesión guardada), las plantillas de disposición y las firmas e iniciales guardadas en este dispositivo. Esta acción no se puede deshacer.",
  privacyDataCleared: "Datos borrados.",

  signAgainTitle: "¿Firmar otro documento?",
  signAgainBody:
    "Vuelve al paso de firmantes con la misma lista de personas ya cargada, para no tener que añadirlas de nuevo.",
  signAgainAccept: "Sí, firmar otro con los mismos firmantes",

  draftsButton: "Ver borradores",
  draftsTitle: "Borradores guardados",
  draftsEmpty: "Todavía no hay ningún borrador guardado en este dispositivo.",
  draftsResume: "Reanudar",
  draftsDelete: (fileName) => `Borrar el borrador de ${fileName}`,
  draftsSavedAt: (date) => `Guardado el ${date}`,
  draftsConfirmDeleteTitle: "¿Borrar este borrador?",
  draftsConfirmDeleteBody:
    "Se va a borrar el documento y todo lo configurado en él. Esta acción no se puede deshacer.",
  draftsDocuments: (count) => `${count} documento${count === 1 ? "" : "s"}`,
  draftsConfirmDeleteSessionBody: (count) =>
    `Se van a borrar los ${count} documentos de esta ronda, sus firmantes y las firmas ya hechas. Esta acción no se puede deshacer.`,
  draftsTooBig:
    "Esta ronda pesa demasiado para guardarse como borrador (máximo 150 MB entre todos los documentos). Puedes seguir firmando con normalidad, pero no se podrá retomar si cierras la pestaña.",
  draftsResumeNormalized: (count) =>
    `Se ajustaron ${count} bloque${count === 1 ? "" : "s"} que reclamaban un mismo documento a la vez: se conservó el primero.`,
  draftsResumeStale: (count) =>
    `El contenido de ${count} documento${count === 1 ? "" : "s"} no coincide con lo guardado: se descartaron sus firmas ya hechas y habrá que volver a firmarlos.`,

  draftsResumeTrimmed: (kept, total) =>
    `Se restauraron los primeros ${kept} de ${total} documentos: el resto no cabe en una ronda (máximo 10 documentos y 200 MB en total).`,
  multiDocOffNotice:
    "Esta ronda tiene varios documentos, pero «Varios documentos a la vez» está desactivado en Ajustes. Actívalo para cargarla; no se ha borrado nada.",
  exportConfigButton: "Exportar configuración",
  importConfigButton: "Importar configuración",
  exportConfigNote:
    "El .zip incluye tus documentos, los firmantes y los huecos, pero no las firmas dibujadas. Quien lo reciba tendrá los documentos.",

  templatesButton: "Plantillas",
  templatesTitle: "Plantillas de disposición",
  templatesEmpty:
    "Todavía no has guardado ninguna plantilla en este navegador.",
  templatesApply: "Aplicar",
  templatesDelete: (name) => `Borrar la plantilla «${name}»`,
  templatesSavedAt: (date) => `Guardada el ${date}`,
  templatesSummary: (signers, fields, textFields) =>
    `${signers} firmante${signers === 1 ? "" : "s"} · ${fields} hueco${fields === 1 ? "" : "s"} · ${textFields} campo${textFields === 1 ? "" : "s"} de texto`,
  templatesConfirmDeleteTitle: "¿Borrar esta plantilla?",
  templatesConfirmDeleteBody:
    "Esta acción no se puede deshacer. Los documentos donde ya se aplicó no se ven afectados.",
  saveAsTemplateButton: "Guardar como plantilla",
  saveTemplateTitle: "Guardar como plantilla",
  saveTemplateBody:
    "Guarda la disposición de firmantes, huecos y campos de texto (sin lo que hayas escrito) para reutilizarla en otro documento. Solo se guarda en este navegador.",
  saveTemplateNameLabel: "Nombre de la plantilla",
  saveTemplateNamePlaceholder: "Ej. Contrato estándar",
  saveTemplateConfirm: "Guardar plantilla",
  saveTemplateLimitError:
    "Ya tienes el máximo de plantillas guardadas. Borra alguna antes de guardar una nueva.",
  saveTemplateUnavailableError:
    "No se pudo guardar la plantilla en este navegador.",
  saveTemplateSuccess: "Plantilla guardada.",
  applyTemplateConfirmTitle: "¿Aplicar esta plantilla?",
  applyTemplateConfirmBody:
    "Reemplaza los firmantes, huecos y campos de texto actuales por los de la plantilla. Lo que ya hayas escrito o firmado en este documento se pierde.",
  applyTemplateConfirm: "Sí, aplicar plantilla",
  applyTemplateDropped: (dropped) =>
    `Aplicada. ${dropped} campo${dropped === 1 ? "" : "s"} de la plantilla no ${dropped === 1 ? "se pudo" : "se pudieron"} aplicar (su página no existe en este documento, o su firmante sobraba por el máximo de 2) y ${dropped === 1 ? "se descartó" : "se descartaron"}.`,
  templatesApplyAll: "Aplicar a todos los documentos",
  applyTemplateAllConfirmBody:
    "Se reemplazarán los firmantes, los huecos y los campos de TODOS los documentos de la ronda por los de la plantilla, y se perderán las firmas ya hechas. Esta acción no se puede deshacer.",
  applyTemplateAllDone: (documents, dropped) =>
    `Plantilla aplicada a ${documents} documentos.${dropped > 0 ? ` ${dropped} hueco${dropped === 1 ? "" : "s"} o campo${dropped === 1 ? "" : "s"} no ${dropped === 1 ? "se pudo" : "se pudieron"} aplicar (su página no existe en ese documento, o su firmante sobraba por el máximo de 2) y ${dropped === 1 ? "se descartó" : "se descartaron"}.` : ""}`,
  applyTemplateNothingFits:
    "Esta plantilla no encaja en este documento: todos sus campos caen en páginas que este documento no tiene.",

  vaultButton: "Firmas guardadas",
  vaultTitle: "Firmas guardadas",
  vaultIntro:
    "Firmas e iniciales que decidiste recordar en este dispositivo. Nunca se suben a ningún servidor.",
  vaultLoading: "Cargando las firmas guardadas",
  vaultEmpty:
    "Todavía no hay ninguna firma guardada. Al crear una, marca «Recordar en este dispositivo» y aparecerá aquí.",
  vaultUnavailable:
    "Este navegador no permite guardar firmas ahora mismo (por ejemplo, en una ventana privada o con el almacenamiento bloqueado). Puedes seguir firmando con normalidad. En un navegador que sí lo permita, exportar e importar sirve de respaldo.",
  vaultCreateNew: "Crear una firma nueva",
  vaultUse: "Usar",
  vaultUseFor: (name) => `Usar la firma de ${name}`,
  vaultUseSaved: "Usar una guardada",
  vaultUseSavedFor: (typeLabel) => `Usar una guardada para: ${typeLabel}`,
  vaultMatchesSigner: "Coincide con el firmante",
  vaultLacksSignature: "Solo tiene iniciales: no sirve para una firma.",
  vaultLacksInitials: "Solo tiene firma: no sirve para unas iniciales.",
  vaultSignatureAlt: (name) => `Firma de ${name}`,
  vaultInitialsAlt: (name) => `Iniciales de ${name}`,
  vaultUsedIn: (document) => `Documento: ${document}`,
  vaultLastUsed: (date) => `Último uso: ${date}`,
  vaultEditLabel: (name) => `Editar los datos de ${name}`,
  vaultEditNameLabel: "Nombre del firmante",
  vaultEditRoleLabel: "Cargo (opcional)",
  vaultEditSave: "Guardar cambios",
  vaultEditCancel: "Cancelar",
  vaultEditInvalid: "El nombre no puede quedar vacío ni pasar de 200 caracteres.",
  vaultEdited: "Cambios guardados.",
  vaultDeleteLabel: (name) => `Borrar la firma de ${name}`,
  vaultDeleted: "Firma borrada.",
  vaultDeleteAll: "Borrar todas",
  vaultDeleteAllTitle: "¿Borrar todas las firmas guardadas?",
  vaultDeleteAllBody:
    "Se van a borrar de este dispositivo todas las firmas e iniciales guardadas. Los archivos que ya hayas exportado no se ven afectados. Esta acción no se puede deshacer.",
  vaultDeletedAll: "Todas las firmas guardadas se han borrado.",
  vaultOpFailed: "No se pudo completar la operación en este navegador.",
  vaultExport: "Exportar",
  vaultExportFor: (name) => `Exportar ${name}`,
  vaultImport: "Importar",
  vaultExportTitle: "Exportar un archivo",
  vaultExportBody:
    "Se descargará un archivo .zip con esta firma para llevarla a otro dispositivo o tenerla de respaldo.",
  vaultExportPasswordLabel: "Contraseña (opcional)",
  vaultExportPasswordConfirmLabel: "Repite la contraseña",
  vaultExportPasswordHint:
    "Con contraseña el archivo se cifra y solo se abre con ella. Si la olvidas, no se puede recuperar.",
  vaultExportPasswordUnavailable:
    "Este navegador no puede cifrar el archivo (hace falta una conexión segura, https). Solo se puede exportar sin contraseña.",
  vaultExportPasswordMismatch: "Las dos contraseñas no coinciden.",
  vaultExportIncludeDocument:
    "Incluir el nombre del documento en el nombre del archivo",
  vaultExportIncludeDocumentHint:
    "El nombre del archivo es visible para cualquiera, aunque el contenido vaya cifrado.",
  vaultExportPlainWarning:
    "Sin contraseña, el archivo contiene la firma en claro: cualquiera que lo tenga puede usarla.",
  vaultExportConfirm: "Exportar",
  vaultExportWorking: "Preparando el archivo. Con contraseña puede tardar unos segundos.",
  vaultExportDone: (filename, encrypted) =>
    `Descargado «${filename}»${encrypted ? " (cifrado con contraseña)" : " (sin cifrar)"}.`,
  vaultExportFailed: "No se pudo crear el archivo. Inténtalo de nuevo.",
  vaultImportWorking: "Leyendo el archivo",
  vaultImportPasswordTitle: "Archivo con contraseña",
  vaultImportPasswordBody:
    "Este archivo está cifrado. Escribe la contraseña para abrirlo.",
  vaultImportPasswordLabel: "Contraseña",
  vaultImportPasswordConfirm: "Abrir archivo",
  vaultImportWrongPassword:
    "La contraseña no es correcta, o el archivo está dañado.",
  vaultImported: (name) => `Importada la firma de ${name}.`,
  vaultImportedDuplicate: (name) =>
    `La firma de ${name} ya estaba guardada en este dispositivo.`,
  vaultImportInvalid: "El archivo no es válido o está dañado.",
  vaultImportTooLarge: "El archivo es demasiado grande para ser uno de firmas.",
  vaultImportUnsupportedVersion:
    "Este archivo es de una versión que esta aplicación no entiende. Prueba a actualizar la página.",
  vaultImportNoEncryption:
    "Este navegador no puede abrir archivos cifrados (hace falta una conexión segura, https).",
  vaultSaveLimit:
    "No cabe una firma más en este dispositivo (hay un máximo de 30 o se llenó el espacio). Borra alguna guardada e inténtalo de nuevo.",
  vaultSaveTooLarge: "La imagen es demasiado grande para guardarla.",
  vaultSaveUnavailable:
    "Este navegador no permite guardar firmas ahora mismo. La firma sí se ha usado en el documento.",
  vaultSaveInvalid: "No se pudo guardar: faltan datos de la firma.",
  vaultSaved: "Firma guardada en este dispositivo.",
  vaultSavedDuplicate: "Esa firma ya estaba guardada en este dispositivo.",
  vaultSavedInitials: "Iniciales guardadas en este dispositivo.",
  vaultSavedDuplicateInitials:
    "Esas iniciales ya estaban guardadas en este dispositivo.",
  vaultRemember: "Recordar en este dispositivo",
  vaultRememberHint:
    "Se guarda solo en este navegador y nunca se sube. Puedes borrarla cuando quieras.",
  vaultRememberFor: (name) => `Se recordará a nombre de ${name}.`,
  vaultRememberNameLabel: "Nombre del firmante",
  vaultRememberNamePlaceholder: "Ej. Ana Pérez",
  vaultRememberNeedsName:
    "Escribe el nombre del firmante para recordar esta firma, o desmarca la casilla.",
  vaultApplied: (name) => `Aplicada la firma guardada de ${name}.`,
  vaultAppliedPartial: (name, missing) => {
    const both = missing.length > 1;
    const initialsOnly = !both && missing[0] === "initials";
    const what = both
      ? "la firma ni las iniciales"
      : initialsOnly
        ? "las iniciales"
        : "la firma";
    const create = both || initialsOnly ? "créalas" : "créala";
    return `Aplicado lo guardado de ${name}. No incluye ${what}: ${create} aparte.`;
  },
  vaultClearFailed: (stores) =>
    `No se pudo borrar todo (${stores
      .map((store) =>
        store === "vault"
          ? "firmas guardadas"
          : store === "editDrafts"
            ? "borradores del editor"
            : "borradores",
      )
      .join(" y ")}). Cierra las demás pestañas de OptimusPDF e inténtalo de nuevo.`,

  documentsLabel: "Documentos",
  documentTab: (index, name) => `${index}. ${name}`,
  documentLive: (index, count, name) => `Documento ${index} de ${count}: ${name}`,
  documentSwitchHint: "Cambia de documento con Alt + Re Pág / Av Pág.",
  sequenceBarLabel: "Páginas de todos los documentos",
  sequenceDocPage: (name, local, total) =>
    `${name} · p. ${local}${total === null ? "" : `/${total}`}`,
  sequenceLive: (docIndex, docCount, name, local, total) =>
    `Documento ${docIndex} de ${docCount}: ${name}, página ${local}${total === null ? "" : ` de ${total}`}`,
  sequenceThumbsTitle: "Páginas de todos los documentos",
  sequenceThumbsHint:
    "Recorre las páginas con las flechas; Inicio y Fin van a la primera y la última.",
  sequenceDocGroup: (index, name, pages) =>
    pages === null
      ? `${index}. ${name}`
      : `${index}. ${name} (${pages} ${pages === 1 ? "página" : "páginas"})`,
  sequenceGoToPage: (page, name) => `Ir a la página ${page} de ${name}`,
  docBadgePlaced: "Colocada",
  docBadgePending: "Pendiente",
  soloAllTitle: "Tu firma en cada documento",
  soloAllSummary: (placed, total) =>
    `Firma colocada en ${placed} de ${total} documentos.`,
  soloApplyAll: "Aplicar a todos los documentos",
  soloApplyAllBusy: "Colocando la firma…",
  soloApplyAllDone: (count) => `Firma colocada en ${count} documentos.`,
  soloApplyAllFailed:
    "No se pudo leer alguna página: la firma se colocó con el tamaño por defecto.",
  soloApplyAllUndo: "Deshacer",
  soloApplyAllUndone: "Se restauró la colocación anterior.",
  soloApplyAllHint:
    "Usa la posición de la firma de este documento en todos los demás; después puedes ajustarla en cada uno.",
  duplicateDocsNotice: (names) =>
    `${quotedNames(names, "y", (n) => `${n} más`)} tienen exactamente el mismo contenido. Se firmarán todos igualmente.`,
  docLimitCount: (max, names) =>
    `En cada ronda caben hasta ${max} documentos: ${quotedNames(names, "y", (n) => `${n} más`)} se ha quedado fuera.`,
  docLimitSize: (maxMb, names) =>
    `${quotedNames(names, "y", (n) => `${n} más`)} pesa${names.length > 1 ? "n" : ""} más de ${maxMb} MB y no se ha añadido.`,
  docLimitTotal: (maxMb, names) =>
    `Con ${quotedNames(names, "y", (n) => `${n} más`)} se superarían los ${maxMb} MB en total, así que se ha dejado fuera.`,

  signModeLabel: "Firmas en cada documento",
  signModeSame: "Mismas firmas",
  signModeIndependent: "Firmas distintas por documento",
  signModeSameHint:
    "Cada firmante firma una vez y su firma vale para todos los documentos. Cada documento lleva su propio sello.",
  signModeIndependentHint:
    "Cada firmante firma por separado en cada documento. Puedes agrupar documentos en un mismo bloque cuando quieras.",
  signModeChangedSame: "Modo cambiado: mismas firmas para todos los documentos.",
  signModeChangedIndependent: "Modo cambiado: firmas distintas por documento.",
  signModeMergedNotice: (discarded) =>
    discarded === 1
      ? "Se han unido las firmas. Se ha descartado 1 bloque con un trazo distinto."
      : `Se han unido las firmas. Se han descartado ${discarded} bloques con trazos distintos.`,
  undoSignMode: "Deshacer",
  signModeRestored: "Se han recuperado las firmas por documento.",
  signerBlocksLabel: (name) => `Bloques de ${name}`,
  blockName: (position) => `Bloque ${position}`,
  blockScopeAll: (count) => `Todos (${count})`,
  blockScopeSome: (names, more) =>
    `${names.join(", ")}${more > 0 ? ` +${more}` : ""}`,
  blockAppliesTo: (summary) => `Aplica a: ${summary}`,
  blockChangeScope: "Cambiar",
  blockChangeScopeFor: (block, signer) =>
    `Cambiar los documentos del ${block.toLowerCase()} de ${signer}`,
  blockAdd: "Añadir bloque",
  blockAddFor: (signer) => `Añadir bloque a ${signer}`,
  blockAddFull: "Cada documento ya tiene su propio bloque.",
  blockRemove: "Quitar bloque",
  blockRemoveFor: (block, signer) =>
    `Quitar el ${block.toLowerCase()} de ${signer}`,
  blockAdded: (signer, position) =>
    `Bloque ${position} añadido a ${signer}.`,
  blockRemoved: (position) =>
    `Bloque quitado. Sus documentos pasan al bloque ${position}.`,
  blockScopeMoved: (doc, from, to) =>
    `${doc} pasa del bloque ${from} al bloque ${to}.`,
  blockScopeUpdated: (block, summary) => `${block}: aplica a ${summary}.`,
  scopeSheetTitle: (block, signer) => `${block} de ${signer}`,
  scopeSheetIntro:
    "Elige a qué documentos aplica este bloque. Un documento solo puede estar en un bloque de cada firmante: si lo marcas aquí, sale del otro.",
  scopeDocsLabel: "Documentos del bloque",
  scopeAllLabel: "Todos los documentos",
  scopeEmpty: "Marca al menos un documento.",
  scopeMovePreview: (doc, fromBlock) =>
    `${doc} saldrá del bloque ${fromBlock}.`,
  scopeApply: "Aplicar",
  coverageMissing: (signer, doc) => `Falta el bloque de ${signer} para ${doc}.`,
  coverageAddBlock: (doc) => `Añadir bloque para ${doc}`,
  blockCaptureBody:
    "Crea la firma y las iniciales de cada bloque. Puedes usar una guardada y, con «Aplicar a todos mis bloques», rellenar de una vez los que aún están vacíos.",
  blockReviewBody: (blocks, documents) =>
    `Estas firmas se aplicarán en ${blocks} bloque${blocks === 1 ? "" : "s"} y ${documents} documento${documents === 1 ? "" : "s"}.`,
  vaultApplyAll: "Aplicar a todos mis bloques",
  vaultApplyAllHint: "Rellena solo los bloques que aún están vacíos.",
  vaultAppliedAll: (name, others) =>
    others === 0
      ? `Aplicada la firma guardada de ${name}. No había más bloques vacíos.`
      : `Aplicada la firma guardada de ${name} a este bloque y a ${others} más.`,
  vaultSourceMany: (count) => `${count} documentos`,
  deliveryBlockedTitle: "Antes de descargar",
  batchSoloUnplaced: (doc) => `Falta colocar tu firma en ${doc}.`,
  batchPendingBlocks: (signer, count) =>
    count === 1
      ? `A ${signer} le queda 1 bloque por firmar.`
      : `A ${signer} le quedan ${count} bloques por firmar.`,
  batchDocEmpty: (doc) =>
    `${doc} no tiene huecos de firma ni campos rellenos.`,
  batchReadyBody: (documents) =>
    `Todo listo: se descargará un .zip con ${documents} documentos firmados.`,
  batchSummary: (documents, slots) =>
    `${documents} documentos · ${slots} hueco${slots === 1 ? "" : "s"} de firma`,
  batchDocsCount: (documents) => `${documents} documentos`,
};

const en: SignStrings = {
  createTitle: "Your signature",
  createSignature: "Create signature",
  changeSignature: "Redo signature",
  modeDraw: "Draw",
  modeType: "Type",
  modeUpload: "Upload",
  drawHint: "Trace your signature with a finger or the mouse inside the box.",
  clear: "Clear stroke",
  confirmCancel: "Cancel",
  confirmClose: "Close",
  typeLabel: "Name",
  typePlaceholder: "Type your name",
  styleLabel: "Lettering style",
  styleNames: ["Handwritten", "Calligraphic", "Classic", "Plain"],
  uploadPick: "Choose signature image",
  uploadHint:
    "A PNG with a transparent background gives the best result. JPG also works.",
  inkLabel: "Ink colour",
  strokeLabel: "Stroke weight",
  rotateHint: "Turn your phone sideways to sign with more room.",
  save: "Use this signature",
  emptyWarning: "There is nothing to save yet.",
  noSignature: "Create your signature to place it on the document.",
  previousPage: "Previous page",
  nextPage: "Next page",
  pageOf: (current, total) => `Page ${current} of ${total}`,
  loadingPreview: "Preparing the preview",
  legalNote:
    "This is a visual signature drawn onto the page. It does not replace a qualified electronic signature backed by a certificate.",
  filenameSuffix: "signed",

  certificateTitle: "Completion certificate",
  certificateHashLabel: "SHA-256 hash of the signed document",
  certificateTimestampLabel: "Date and time",
  certificateSignersLabel: "Signers",
  certificateNoSignerName: "No name",
  certificateDisclaimer:
    "This page is informal traceability only: the hash lets you check the document didn't change after signing. It is not a qualified or certified electronic signature.",

  modeLabel: "Who is signing?",
  modeSingle: "Just me",
  modeSingleHint:
    "Create your signature, place it wherever you want and, if the document has fields, fill them in right there. Then download. The quick path.",
  modeMulti: "Several signers",
  modeMultiHint:
    "Reserve a slot for each person and sign in turns on this same device, passing it around.",

  stepSigners: "Signers",
  stepDocument: "Document",
  stepSign: "Sign",
  back: "Back",
  next: "Continue",

  documentTitle: "Prepare the document",
  documentHint:
    "Pick a tool (signature, initials, text, checkbox or date) and tap the page to place it, or drag to draw it. Tap a field to type right there; with Select you can move and resize them.",
  slotsNeedSigners:
    "To reserve signature slots, add someone in step 1 first. In the meantime you can place text fields.",
  canvasEmptyHint:
    "Nothing on the document yet: pick a tool and tap the page. Text fields are optional; to sign you need at least one signature slot or one filled field.",
  canvasPageSummary: (slots, textFields) =>
    `This page: ${slots} slot${slots === 1 ? "" : "s"} · ${textFields} field${textFields === 1 ? "" : "s"}`,
  canvasTotalSummary: (slots, textFields) =>
    `In this document: ${slots} slot${slots === 1 ? "" : "s"} · ${textFields} field${textFields === 1 ? "" : "s"}`,
  a11yPending: "pending",
  a11yFilled: "filled in",
  a11ySlot: "signature slot",

  paletteLabel: "Document tools",
  toolSelect: "Select",
  toolArmedStatus: (tool) =>
    `Active tool: ${tool}. Tap the page to place one, or drag to draw it. Escape goes back to Select.`,
  toolSelectStatus:
    "Select: tap an element to move or edit it. Pick another tool to add something.",
  toolAssignedTo: (name) => `Will be assigned to ${name}`,
  prevField: "Previous field",
  nextField: "Next field",
  noMorePendingFields: "No more pending fields.",
  fieldNavAnnounce: (label, position, total) =>
    `${label}, field ${position} of ${total}`,
  selectionBarLabel: (target) => `Actions for “${target}”`,
  elementAction: (action, target) => `${action} “${target}”`,
  duplicateElement: "Duplicate",
  elementDuplicated: "Element duplicated.",
  signerOfSlotLabel: "Slot signer",
  slotChangedTo: (name, type) => `${name}'s slot: ${type}.`,
  fieldChangedTo: (type) => `Field type: ${type}.`,
  clearPageAll: "Remove everything on this page",
  clearAllAll: "Delete everything in the document",
  confirmClearAllEverythingTitle: "Delete slots and fields?",
  confirmClearAllEverythingBody:
    "This removes every signature slot and every field in the document, on all pages, along with anything you typed in them. This cannot be undone.",

  soloSignatureLabel: "My signature",
  soloSignatureA11y: "placed signature",
  soloRemoveSignature: "Remove the signature",
  soloPlaceHere: "Place my signature on this page",
  soloResizeSignature: "Resize the signature",
  soloSignatureDeletedNotice: "Signature removed from the document.",
  soloSignaturePlaced: (page) =>
    `Signature placed on page ${page}. Drag it to move it.`,
  soloDocumentHint:
    "Place your signature and fill in the document's fields right there. Pick a tool (signature, text, checkbox or date) and tap the page, or drag to draw it. Tap a field to type in it; with Select you can move and adjust them.",
  soloCanvasEmptyHint:
    "There is nothing on the document yet. Create your signature and it will be placed on the page; you can also add text fields, checkboxes or dates with the palette.",
  soloPageSummary: (signatures, textFields) =>
    `On this page: ${signatures} signature${signatures === 1 ? "" : "s"} · ${textFields} field${textFields === 1 ? "" : "s"}`,
  soloTotalSummary: (signatures, textFields) =>
    `In this document: ${signatures} signature${signatures === 1 ? "" : "s"} · ${textFields} field${textFields === 1 ? "" : "s"}`,

  signersTitle: "Who has to sign?",
  signersHint:
    "Add every person. The colour is what tells their slots apart on the document.",
  addSigner: "Add signer",
  signerNameLabel: (position) => `Name of signer ${position}`,
  defaultSignerName: (position) => `Signer ${position}`,
  removeSigner: (name) => `Remove ${name}`,
  signerLimit: "You can add up to 2 signers.",
  noSigners: "Add at least one signer to continue.",
  signerFieldCount: (count) => (count === 1 ? "1 slot" : `${count} slots`),
  activeSignerLabel: "Active signer",
  activeSignerHint:
    "New slots go to the active signer. Switch first, then mark their slots.",
  signerDeletedNotice: "Signer deleted, along with their slots and signature.",
  undoRemoveSigner: "Undo",
  undoRemoveSignerUnavailable:
    "This can no longer be undone: the round already has the maximum number of signers.",

  fieldTypeLabel: "Slot type",
  fieldSignature: "Signature",
  fieldInitials: "Initials",
  addFieldHere: "Add a slot on this page",
  fieldOwnerLabel: (name, type) => `${name} — ${type}`,
  removeField: "Remove the slot",
  fieldDeletedNotice: "Slot deleted.",
  undoRemoveField: "Undo",
  resizeField: "Resize the slot",
  totalFields: (count) =>
    count === 1 ? "1 slot in total" : `${count} slots in total`,
  clearPageFields: "Remove slots on this page",
  clearAllFields: "Delete all slots in this document",
  confirmClearAllFieldsTitle: "Delete all slots?",
  confirmClearAllFieldsBody:
    "This removes every signature/initials slot reserved in the document, on every page. This cannot be undone.",
  thumbsTitle: "Pages",
  goToPage: (page) => `Go to page ${page}`,
  needSigner: "Pick who the slot belongs to first",

  detectingFields: "Looking for fillable fields in the document",
  detectionFailedHint:
    "Fields couldn't be detected automatically, but you can still add them by hand by dragging on the page.",
  detectedFieldsSummary: (count) =>
    count === 1
      ? "1 field was detected. Review it before signing."
      : `${count} fields were detected. Review them before signing.`,
  addTextFieldHere: "Add a field on this page",
  resetZoomButton: "Reset zoom",
  zoomGroupLabel: "Document zoom",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  changeFieldType: (current) => `Change field type (now: ${current})`,
  closeTypePicker: "Back to actions",
  typeChangeClearedNotice: (type) =>
    `The value was cleared because it is not valid as “${type}”.`,
  undoTypeChange: "Undo",
  textFieldFallbackLabel: (position) => `Field ${position}`,
  textFieldPlaceholder: "Type the value",
  initialsFieldPlaceholder: "Initials",
  textFieldTypeLabel: "Field type",
  fieldTypeText: "Text",
  fieldTypeCheckbox: "Checkbox",
  fieldTypeDate: "Date",
  fieldTypeInitials: "Initials",
  removeTextField: "Remove the field",
  resizeTextField: "Resize the field",
  clearPageTextFields: "Remove fields on this page",
  clearAllTextFields: "Delete all fields in this document",
  confirmClearAllTextFieldsTitle: "Delete all fields?",
  confirmClearAllTextFieldsBody:
    "This removes every text field, detected or added by hand, on every page, along with whatever you typed into them. This cannot be undone.",
  lowConfidenceHint:
    "Dashed outline = experimental detection on a scanned image. Review it before signing; delete it if it isn't a real field.",
  pendingTextFieldsWarning: (missing) =>
    `${missing} text field${missing === 1 ? "" : "s"} still empty. You can continue anyway.`,
  textFieldDeletedNotice: "Field deleted.",
  undoRemoveTextField: "Undo",
  reuseValuesPrompt: "Use the same data as your last document?",
  reuseValuesAccept: "Yes, fill it in",
  reuseValuesDecline: "No, start blank",
  forgetSuggestion: (value) => `Forget "${value}"`,

  ceremonyTitle: "Sign in turns",
  checkingDocument: "Checking the document before signing",
  turnOf: (current, total) => `Turn ${current} of ${total}`,
  handoffTitle: (name) => `Hand the device to ${name}`,
  handoffBody: (name) =>
    `${name} will see only their own slots and sign right here. Nothing leaves this device.`,
  handoffReady: "Ready, it's my turn",
  captureTitle: (name) => `${name}'s signature`,
  captureBody:
    "Draw, type or upload your signature. It will drop into the slots reserved for you.",
  captureSignature: "Create my signature",
  captureInitials: "Create my initials",
  captureRedo: "Redo",
  capturePending: "Pending",
  captureContinue: "See how it looks",
  reviewTitle: (name) => `How ${name}'s signature looks`,
  reviewBody: (count) =>
    count === 1
      ? "1 slot will be filled with what you just created."
      : `${count} slots will be filled with what you just created.`,
  reviewRedo: "Redo my signature",
  reviewNext: "Pass to the next signer",
  reviewFinish: "I'm done",
  statusPending: "Not signed",
  statusSigned: "Signed",
  allSignedTitle: "Everyone has signed",
  allSignedBody: "Apply the signatures to build the final PDF and download it.",
  pendingBody: (count) =>
    count === 1
      ? "1 signer still has to sign."
      : `${count} signers still have to sign.`,
  applyAndDownload: "Sign and download",
  restartCeremony: "Start the round again",
  textOnlyReadyTitle: "Ready to download",
  textOnlyReadyBody:
    "This document has no signatures to collect: apply the filled text fields and generate the final PDF.",
  finishAndDownload: "Apply and download",

  filenamePrefixTitle: "File name",
  filenamePrefixBody:
    "Should we add the signers' names at the start of the file name? For example: ana-perez_and_luis-gomez_contract-signed.pdf.",
  filenamePrefixYes: "Yes, add them",
  filenamePrefixNo: "No, leave the name as is",

  composerFor: (name) => `${name}'s signature`,
  composerInitialsFor: (name) => `${name}'s initials`,
  initialsHint:
    "Two or three strokes are enough: initials go in a small, almost square slot.",
  initialsPlaceholder: "Your initials",

  noFieldsError: "There is no slot reserved on the document.",
  notAllSignedError: "Some people still have to sign.",
  progressMessage: "Applying the signatures",

  privacyNoticeToggle: "How we use your data",
  privacyNoticeBody:
    "OptimusPDF does not store data in the cloud or on a server. Data only exists and is handled on your own device and browser. If you want to fully remove it, just close the tab, clear your browser's browsing data, or click the 'Clear data' button. Whatever is stored in your browser is only used to fill in other documents you open in this browser, and you can clear it whenever you want. While you work with several signers, the draft saves the whole session on this device (the documents, the signers and the signatures already made) so you can pick it up again, and if you export the configuration, the .zip file contains your documents. The draft is saved a fraction of a second after each change; if the browser is force-closed (or the tab is discarded) right after a change, the latest edit may not be saved. Everything is removed with 'Clear data' (or 'Clear local data' in Settings).",
  privacyNoticeVaultNote:
    "Signatures and initials are only stored on this device if you tick \"Remember on this device\"; they are never uploaded. If you export a signature, the file contains the signature in the clear unless you add a password.",
  privacyClearData: "Clear data",
  privacyClearDataTitle: "Clear the stored data?",
  privacyClearDataBody:
    "This deletes every field value remembered to suggest it in other documents (names, addresses, numbers and any other text you typed), plus saved drafts (with all the documents, signers and signatures of each saved session), layout templates, and the signatures and initials saved on this device. This cannot be undone.",
  privacyDataCleared: "Data cleared.",

  signAgainTitle: "Sign another document?",
  signAgainBody:
    "Go back to the signers step with the same list of people already loaded, so you don't have to add them again.",
  signAgainAccept: "Yes, sign another with the same signers",

  draftsButton: "View drafts",
  draftsTitle: "Saved drafts",
  draftsEmpty: "There are no drafts saved on this device yet.",
  draftsResume: "Resume",
  draftsDelete: (fileName) => `Delete the draft for ${fileName}`,
  draftsSavedAt: (date) => `Saved on ${date}`,
  draftsConfirmDeleteTitle: "Delete this draft?",
  draftsConfirmDeleteBody:
    "This deletes the document and everything configured in it. This cannot be undone.",
  draftsDocuments: (count) => `${count} document${count === 1 ? "" : "s"}`,
  draftsConfirmDeleteSessionBody: (count) =>
    `This deletes the ${count} documents of this round, its signers and the signatures already made. This cannot be undone.`,
  draftsTooBig:
    "This round is too large to be saved as a draft (150 MB maximum across all documents). You can keep signing as usual, but it will not be resumable if you close the tab.",
  draftsResumeNormalized: (count) =>
    `${count} block${count === 1 ? "" : "s"} claimed the same document at once and ${count === 1 ? "was" : "were"} adjusted: the first one was kept.`,
  draftsResumeStale: (count) =>
    `The content of ${count} document${count === 1 ? "" : "s"} no longer matches what was saved: the signatures already made on ${count === 1 ? "it were" : "them were"} discarded and will need to be signed again.`,

  draftsResumeTrimmed: (kept, total) =>
    `The first ${kept} of ${total} documents were restored: the rest do not fit in one round (maximum 10 documents and 200 MB in total).`,
  multiDocOffNotice:
    "This round has several documents, but \"Several documents at once\" is turned off in Settings. Turn it on to load it; nothing has been deleted.",
  exportConfigButton: "Export configuration",
  importConfigButton: "Import configuration",
  exportConfigNote:
    "The .zip includes your documents, the signers and the slots, but not the drawn signatures. Whoever receives it will have the documents.",

  templatesButton: "Templates",
  templatesTitle: "Layout templates",
  templatesEmpty: "You haven't saved any template in this browser yet.",
  templatesApply: "Apply",
  templatesDelete: (name) => `Delete the "${name}" template`,
  templatesSavedAt: (date) => `Saved on ${date}`,
  templatesSummary: (signers, fields, textFields) =>
    `${signers} signer${signers === 1 ? "" : "s"} · ${fields} field${fields === 1 ? "" : "s"} · ${textFields} text field${textFields === 1 ? "" : "s"}`,
  templatesConfirmDeleteTitle: "Delete this template?",
  templatesConfirmDeleteBody:
    "This cannot be undone. Documents it was already applied to are not affected.",
  saveAsTemplateButton: "Save as template",
  saveTemplateTitle: "Save as template",
  saveTemplateBody:
    "Saves the layout of signers, fields and text fields (not what you typed in) to reuse on another document. Only saved in this browser.",
  saveTemplateNameLabel: "Template name",
  saveTemplateNamePlaceholder: "E.g. Standard contract",
  saveTemplateConfirm: "Save template",
  saveTemplateLimitError:
    "You already have the maximum number of templates saved. Delete one before saving a new one.",
  saveTemplateUnavailableError: "Couldn't save the template in this browser.",
  saveTemplateSuccess: "Template saved.",
  applyTemplateConfirmTitle: "Apply this template?",
  applyTemplateConfirmBody:
    "Replaces the current signers, fields and text fields with the ones from the template. Anything you already typed or signed on this document is lost.",
  applyTemplateConfirm: "Yes, apply template",
  applyTemplateDropped: (dropped) =>
    `Applied. ${dropped} field${dropped === 1 ? "" : "s"} from the template could not be applied (its page does not exist in this document, or its signer was beyond the maximum of 2) and ${dropped === 1 ? "was" : "were"} dropped.`,
  templatesApplyAll: "Apply to all documents",
  applyTemplateAllConfirmBody:
    "This replaces the signers, slots and fields of ALL the documents in the round with the template's, and the signatures already made are lost. This cannot be undone.",
  applyTemplateAllDone: (documents, dropped) =>
    `Template applied to ${documents} documents.${dropped > 0 ? ` ${dropped} slot${dropped === 1 ? "" : "s"} or field${dropped === 1 ? "" : "s"} could not be applied (the page does not exist in that document, or the signer was beyond the maximum of 2) and ${dropped === 1 ? "was" : "were"} dropped.` : ""}`,
  applyTemplateNothingFits:
    "This template doesn't fit this document: all of its fields fall on pages this document doesn't have.",

  vaultButton: "Saved signatures",
  vaultTitle: "Saved signatures",
  vaultIntro:
    "Signatures and initials you chose to remember on this device. They are never uploaded to any server.",
  vaultLoading: "Loading saved signatures",
  vaultEmpty:
    "No signatures saved yet. When you create one, tick \"Remember on this device\" and it will show up here.",
  vaultUnavailable:
    "This browser doesn't let us save signatures right now (for example in a private window, or with storage blocked). You can keep signing as usual. In a browser that does allow it, exporting and importing works as a backup.",
  vaultCreateNew: "Create a new signature",
  vaultUse: "Use",
  vaultUseFor: (name) => `Use the signature of ${name}`,
  vaultUseSaved: "Use a saved one",
  vaultUseSavedFor: (typeLabel) => `Use a saved one for: ${typeLabel}`,
  vaultMatchesSigner: "Matches the signer",
  vaultLacksSignature: "Initials only: it can't be used as a signature.",
  vaultLacksInitials: "Signature only: it can't be used as initials.",
  vaultSignatureAlt: (name) => `Signature of ${name}`,
  vaultInitialsAlt: (name) => `Initials of ${name}`,
  vaultUsedIn: (document) => `Document: ${document}`,
  vaultLastUsed: (date) => `Last used: ${date}`,
  vaultEditLabel: (name) => `Edit the details of ${name}`,
  vaultEditNameLabel: "Signer name",
  vaultEditRoleLabel: "Job title (optional)",
  vaultEditSave: "Save changes",
  vaultEditCancel: "Cancel",
  vaultEditInvalid: "The name can't be empty or longer than 200 characters.",
  vaultEdited: "Changes saved.",
  vaultDeleteLabel: (name) => `Delete the signature of ${name}`,
  vaultDeleted: "Signature deleted.",
  vaultDeleteAll: "Delete all",
  vaultDeleteAllTitle: "Delete all saved signatures?",
  vaultDeleteAllBody:
    "Every saved signature and set of initials will be deleted from this device. Files you already exported are not affected. This cannot be undone.",
  vaultDeletedAll: "All saved signatures have been deleted.",
  vaultOpFailed: "The operation couldn't be completed in this browser.",
  vaultExport: "Export",
  vaultExportFor: (name) => `Export ${name}`,
  vaultImport: "Import",
  vaultExportTitle: "Export a file",
  vaultExportBody:
    "Downloads a .zip file with this signature, to move it to another device or keep it as a backup.",
  vaultExportPasswordLabel: "Password (optional)",
  vaultExportPasswordConfirmLabel: "Repeat the password",
  vaultExportPasswordHint:
    "With a password the file is encrypted and only opens with it. If you forget it, it can't be recovered.",
  vaultExportPasswordUnavailable:
    "This browser can't encrypt the file (a secure connection, https, is required). It can only be exported without a password.",
  vaultExportPasswordMismatch: "The two passwords don't match.",
  vaultExportIncludeDocument: "Include the document name in the file name",
  vaultExportIncludeDocumentHint:
    "The file name is visible to anyone, even when the contents are encrypted.",
  vaultExportPlainWarning:
    "Without a password the file contains the signature in the clear: anyone who has it can use it.",
  vaultExportConfirm: "Export",
  vaultExportWorking: "Preparing the file. With a password it can take a few seconds.",
  vaultExportDone: (filename, encrypted) =>
    `Downloaded "${filename}"${encrypted ? " (password-encrypted)" : " (not encrypted)"}.`,
  vaultExportFailed: "Couldn't create the file. Try again.",
  vaultImportWorking: "Reading the file",
  vaultImportPasswordTitle: "Password-protected file",
  vaultImportPasswordBody: "This file is encrypted. Type the password to open it.",
  vaultImportPasswordLabel: "Password",
  vaultImportPasswordConfirm: "Open file",
  vaultImportWrongPassword: "The password is wrong, or the file is damaged.",
  vaultImported: (name) => `Imported the signature of ${name}.`,
  vaultImportedDuplicate: (name) =>
    `The signature of ${name} was already saved on this device.`,
  vaultImportInvalid: "The file is not valid or is damaged.",
  vaultImportTooLarge: "The file is too large to be a signature file.",
  vaultImportUnsupportedVersion:
    "This file is from a version this app doesn't understand. Try refreshing the page.",
  vaultImportNoEncryption:
    "This browser can't open encrypted files (a secure connection, https, is required).",
  vaultSaveLimit:
    "There's no room for another signature on this device (the maximum is 30, or the space is full). Delete a saved one and try again.",
  vaultSaveTooLarge: "The image is too large to save.",
  vaultSaveUnavailable:
    "This browser doesn't let us save signatures right now. The signature was still used on the document.",
  vaultSaveInvalid: "Couldn't save it: the signature data is incomplete.",
  vaultSaved: "Signature saved on this device.",
  vaultSavedDuplicate: "That signature was already saved on this device.",
  vaultSavedInitials: "Initials saved on this device.",
  vaultSavedDuplicateInitials: "Those initials were already saved on this device.",
  vaultRemember: "Remember on this device",
  vaultRememberHint:
    "Only stored in this browser and never uploaded. You can delete it whenever you like.",
  vaultRememberFor: (name) => `It will be remembered under the name ${name}.`,
  vaultRememberNameLabel: "Signer name",
  vaultRememberNamePlaceholder: "E.g. Ana Pérez",
  vaultRememberNeedsName:
    "Type the signer's name to remember this signature, or untick the box.",
  vaultApplied: (name) => `Applied the saved signature of ${name}.`,
  vaultAppliedPartial: (name, missing) => {
    const both = missing.length > 1;
    const initialsOnly = !both && missing[0] === "initials";
    const what = both
      ? "the signature or the initials"
      : initialsOnly
        ? "initials"
        : "the signature";
    const create = both || initialsOnly ? "create them" : "create it";
    return `Applied what was saved for ${name}. It doesn't include ${what}: ${create} separately.`;
  },
  vaultClearFailed: (stores) =>
    `Couldn't clear everything (${stores
      .map((store) =>
        store === "vault"
          ? "saved signatures"
          : store === "editDrafts"
            ? "editor drafts"
            : "drafts",
      )
      .join(" and ")}). Close the other OptimusPDF tabs and try again.`,

  documentsLabel: "Documents",
  documentTab: (index, name) => `${index}. ${name}`,
  documentLive: (index, count, name) => `Document ${index} of ${count}: ${name}`,
  documentSwitchHint: "Switch document with Alt + Page Up / Page Down.",
  sequenceBarLabel: "Pages of all documents",
  sequenceDocPage: (name, local, total) =>
    `${name} · p. ${local}${total === null ? "" : `/${total}`}`,
  sequenceLive: (docIndex, docCount, name, local, total) =>
    `Document ${docIndex} of ${docCount}: ${name}, page ${local}${total === null ? "" : ` of ${total}`}`,
  sequenceThumbsTitle: "Pages of all documents",
  sequenceThumbsHint:
    "Move through the pages with the arrow keys; Home and End go to the first and last.",
  sequenceDocGroup: (index, name, pages) =>
    pages === null
      ? `${index}. ${name}`
      : `${index}. ${name} (${pages} ${pages === 1 ? "page" : "pages"})`,
  sequenceGoToPage: (page, name) => `Go to page ${page} of ${name}`,
  docBadgePlaced: "Placed",
  docBadgePending: "Pending",
  soloAllTitle: "Your signature in every document",
  soloAllSummary: (placed, total) =>
    `Signature placed in ${placed} of ${total} documents.`,
  soloApplyAll: "Apply to all documents",
  soloApplyAllBusy: "Placing the signature…",
  soloApplyAllDone: (count) => `Signature placed in ${count} documents.`,
  soloApplyAllFailed:
    "Some page could not be read: the signature was placed at its default size.",
  soloApplyAllUndo: "Undo",
  soloApplyAllUndone: "The previous placement was restored.",
  soloApplyAllHint:
    "Uses this document's signature position in all the others; you can then adjust it in each one.",
  duplicateDocsNotice: (names) =>
    `${quotedNames(names, "and", (n) => `${n} more`)} have exactly the same content. They will all be signed anyway.`,
  docLimitCount: (max, names) =>
    `Each round fits up to ${max} documents: ${quotedNames(names, "and", (n) => `${n} more`)} didn't make it in.`,
  docLimitSize: (maxMb, names) =>
    `${quotedNames(names, "and", (n) => `${n} more`)} ${names.length > 1 ? "are" : "is"} over ${maxMb} MB and wasn't added.`,
  docLimitTotal: (maxMb, names) =>
    `Adding ${quotedNames(names, "and", (n) => `${n} more`)} would go over ${maxMb} MB in total, so it was left out.`,

  signModeLabel: "Signatures in each document",
  signModeSame: "Same signatures",
  signModeIndependent: "Different signatures per document",
  signModeSameHint:
    "Each signer signs once and that signature works for every document. Each document carries its own seal.",
  signModeIndependentHint:
    "Each signer signs separately in each document. You can group documents into one block whenever you like.",
  signModeChangedSame: "Mode changed: same signatures for all documents.",
  signModeChangedIndependent: "Mode changed: different signatures per document.",
  signModeMergedNotice: (discarded) =>
    discarded === 1
      ? "Signatures merged. 1 block with a different stroke was discarded."
      : `Signatures merged. ${discarded} blocks with different strokes were discarded.`,
  undoSignMode: "Undo",
  signModeRestored: "The per-document signatures were restored.",
  signerBlocksLabel: (name) => `${name}'s blocks`,
  blockName: (position) => `Block ${position}`,
  blockScopeAll: (count) => `All (${count})`,
  blockScopeSome: (names, more) =>
    `${names.join(", ")}${more > 0 ? ` +${more}` : ""}`,
  blockAppliesTo: (summary) => `Applies to: ${summary}`,
  blockChangeScope: "Change",
  blockChangeScopeFor: (block, signer) =>
    `Change the documents of ${signer}'s ${block.toLowerCase()}`,
  blockAdd: "Add block",
  blockAddFor: (signer) => `Add a block for ${signer}`,
  blockAddFull: "Every document already has its own block.",
  blockRemove: "Remove block",
  blockRemoveFor: (block, signer) =>
    `Remove ${signer}'s ${block.toLowerCase()}`,
  blockAdded: (signer, position) => `Block ${position} added for ${signer}.`,
  blockRemoved: (position) =>
    `Block removed. Its documents move to block ${position}.`,
  blockScopeMoved: (doc, from, to) =>
    `${doc} moves from block ${from} to block ${to}.`,
  blockScopeUpdated: (block, summary) => `${block}: applies to ${summary}.`,
  scopeSheetTitle: (block, signer) => `${signer}'s ${block.toLowerCase()}`,
  scopeSheetIntro:
    "Choose which documents this block applies to. A document can only be in one block per signer: if you tick it here, it leaves the other one.",
  scopeDocsLabel: "Documents in this block",
  scopeAllLabel: "All documents",
  scopeEmpty: "Tick at least one document.",
  scopeMovePreview: (doc, fromBlock) =>
    `${doc} will leave block ${fromBlock}.`,
  scopeApply: "Apply",
  coverageMissing: (signer, doc) => `${signer}'s block for ${doc} is missing.`,
  coverageAddBlock: (doc) => `Add a block for ${doc}`,
  blockCaptureBody:
    "Create the signature and initials of each block. You can use a saved one and, with “Apply to all my blocks”, fill every empty block at once.",
  blockReviewBody: (blocks, documents) =>
    `These signatures will be applied across ${blocks} block${blocks === 1 ? "" : "s"} and ${documents} document${documents === 1 ? "" : "s"}.`,
  vaultApplyAll: "Apply to all my blocks",
  vaultApplyAllHint: "Only fills the blocks that are still empty.",
  vaultAppliedAll: (name, others) =>
    others === 0
      ? `Applied the saved signature of ${name}. There were no other empty blocks.`
      : `Applied the saved signature of ${name} to this block and ${others} more.`,
  vaultSourceMany: (count) => `${count} documents`,
  deliveryBlockedTitle: "Before downloading",
  batchSoloUnplaced: (doc) => `Your signature isn't placed in ${doc} yet.`,
  batchPendingBlocks: (signer, count) =>
    count === 1
      ? `${signer} still has 1 block to sign.`
      : `${signer} still has ${count} blocks to sign.`,
  batchDocEmpty: (doc) => `${doc} has no signature slots or filled fields.`,
  batchReadyBody: (documents) =>
    `All set: you will download a .zip with ${documents} signed documents.`,
  batchSummary: (documents, slots) =>
    `${documents} documents · ${slots} signature slot${slots === 1 ? "" : "s"}`,
  batchDocsCount: (documents) => `${documents} documents`,
};

export const SIGN_STRINGS: Record<Language, SignStrings> = { es, en };
