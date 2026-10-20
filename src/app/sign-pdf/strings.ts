import type { Language } from "@/lib/i18n";
import type { StaleReason } from "@/app/sign-pdf/captures";
import { templateEn, templateEs, type TemplateStrings } from "@/app/sign-pdf/templateStrings";

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
  /** Sufijo del archivo cuando solo se edito el texto original (sin ninguna firma estampada). */
  editedFilenameSuffix: string;

  /* --- Registro de firmas (pagina final OPCIONAL, apagada por defecto; las claves conservan el prefijo `certificate`) --- */
  certificateTitle: string;
  /** Aclaracion bajo el titulo: no es una firma certificada. */
  certificateNotice: string;
  certificateHashLabel: string;
  certificateTimestampLabel: string;
  certificateSignersLabel: string;
  certificateNoSignerName: string;
  certificateDisclaimer: string;
  /* --- Registro .json aparte (opcional, apagado por defecto) --- */
  /** Boton secundario bajo «Descargar», solo con el interruptor de Ajustes activo y un solo documento. */
  signingRecordDownload: string;

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
  /** Anuncio (region viva) al entrar a un paso: «Paso 2 de 3: Documento». */
  stepAnnounce: (position: number, total: number, label: string) => string;

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
  /** Boton de la paleta plegada (movil): «Herramientas del documento (activa: Firma)». */
  paletteExpand: (activeTool: string) => string;
  /** Plegar la paleta abierta (movil). */
  paletteCollapse: string;
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
  /** Nombre accesible de un hueco hallado en una pagina escaneada (sin etiqueta del documento). */
  scannedFieldLabel: (position: number) => string;
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
  /* --- Campos sugeridos y busqueda en paginas escaneadas (W6-A) --- */
  /** Interruptor de la capa de sugerencias: «Campos sugeridos (N)». */
  suggestedFieldsToggle: (count: number) => string;
  suggestedFieldsDescription: string;
  suggestedFieldsShown: (count: number) => string;
  suggestedFieldsHidden: string;
  scanPageFields: string;
  scanningPage: string;
  scanFound: (count: number, page: number) => string;
  scanNone: (page: number) => string;
  scanFailed: string;
  /* --- Herramienta «Editar texto» (W6-A) --- */
  toolEditText: string;
  /** Pista de uso mientras la herramienta esta activa. */
  editTextHint: string;
  editTextCount: (count: number) => string;
  /**
   * Nota permanente: al firmar se quita el texto original de lo editado; en casos especiales no se puede, queda bajo la
   * edicion y el resumen del final dice cual y por que (`editReportTitle`...).
   */
  editTextNote: string;
  editTextFlattenLink: string;
  editTextUndo: string;
  editTextRedo: string;
  /* --- Resumen del texto editado al terminar (B1): que se quito del archivo y que no, con el motivo --- */
  /** Titulo de la lista de avisos de la pantalla de resultado. */
  editReportTitle: string;
  /** « en 3 documentos» (se pega tras «N textos editados»). */
  editInDocs: (documents: number) => string;
  /** «el original se elimino del archivo» (varios documentos: «de los archivos»). */
  editTailAllRemoved: (several: boolean) => string;
  editTailSomeRemoved: (removed: number, remains: number) => string;
  editTailNoneRemoved: (remains: number) => string;
  /** Un bloque cuyo original sigue bajo la edicion: donde esta y por que (`reason` ya viene en llano). */
  editRemainsItem: (docName: string | null, page: number, excerpt: string | null, reason: string) => string;
  editRemainsMore: (count: number) => string;
  /** Salida recomendada, una vez: `flattenLabel` es «Aplanar pagina» tal como lo nombra Editar PDF. */
  editRemainsAdvice: (flattenLabel: string) => string;
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

  /* --- Ceremonia robusta: que falta y progreso del turno (F0 · U0.2) --- */
  /** Nombre accesible de la lista de progreso del turno. */
  ceremonyProgressLabel: (name: string) => string;
  /** Texto oculto de un trazo hecho / por hacer en la lista de progreso. */
  ceremonyItemDone: string;
  ceremonyItemMissing: string;
  /* --- Firma que dejo de valer porque cambio el documento (F0-fix, D7) --- */
  /** «La firma de Ana ya no es válida porque cambiaste el texto del documento: Ana debe volver a firmar.» */
  staleSignature: (name: string, reason: StaleReason) => string;
  /** Debajo del firmante en la lista de la ronda: «Debe volver a firmar». */
  statusStale: string;
  /** El motivo, corto, para esa misma linea: «cambió el texto del documento». */
  staleReasonShort: (reason: StaleReason) => string;
  /** Marca del trazo en la lista de progreso del turno: «ya no es válida». */
  ceremonyItemStale: string;
  /** «Falta: Iniciales · Contrato B»: junto al boton apagado. Cada elemento ya viene nombrado. */
  ceremonyMissing: (items: readonly string[]) => string;
  ceremonyGoToMissing: string;
  ceremonyAllCaptured: string;

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
  /** Resumen de una linea que se ve la PRIMERA vez (el texto entero queda tras «Leer completo»). */
  privacySummary: string;
  privacyReadFull: string;
  /** «Entendido»: cierra el resumen y recuerda que ya se vio. */
  privacyUnderstood: string;
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
  /** Aviso bajo «Exportar configuracion» cuando hay ediciones del texto original. */
  exportConfigEditsNote: string;
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
  vaultClearFailed: (stores: readonly ("vault" | "drafts" | "editDrafts" | "proDrafts")[]) => string;

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
  /** `from`: el numero del bloque o, desde la ceremonia por grupos, su nombre («Firma B»). */
  scopeMovePreview: (doc: string, from: number | string) => string;
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

  /** Retomar sin buscar y aviso al salir (F0 · U0.3): ver `ResumeStrings`. */
  resume: ResumeStrings;
  /** Firmas en el borrador y borrar el borrador al descargar (F0 · U0.4): ver `DraftPrivacyStrings`. */
  draftPrivacy: DraftPrivacyStrings;
  /** Opcion «E-sign» deshabilitada (F0 · U0.7): ver `ESignStrings`. */
  esign: ESignStrings;
  /** Subir una firma o iniciales como imagen (F6 · U6.2): ver `InkImportStrings`. */
  inkImport: InkImportStrings;
  /** Exportar todas las firmas / importar firmas (U4.4-UI): ver `VaultBackupStrings`. */
  vaultBackup: VaultBackupStrings;
  /** «¿Quién firma qué?», copias y orden de turnos (F1 · U1.2/U1.3): ver `AssignmentStrings`. */
  assignment: AssignmentStrings;
  /** «Revisar antes de descargar» (F1 · U1.3): ver `ReviewStrings`. */
  review: ReviewStrings;
  /** Plantillas de documento: modo «Configurar plantilla» y aplicacion automatica (Fase 2 · U2.3/U2.4). */
  template: TemplateStrings;
};

/**
 * Privacidad del borrador con firmas (Fase 0 «Firma agil», U0.4): el interruptor «guardar tambien las firmas» (aviso y
 * Ajustes comparten texto), lo que dice el aviso de privacidad segun su estado, la linea de la tarjeta de retomar y la
 * casilla de la pantalla de resultado. Un solo bloque para que ES y EN se mantengan a la par.
 */
export type DraftPrivacyStrings = {
  /** Etiqueta del interruptor del aviso de privacidad. */
  signaturesLabel: string;
  signaturesHint: string;
  /** Lo que dice el aviso de privacidad con el interruptor encendido / apagado. */
  noticeSignaturesOn: string;
  noticeSignaturesOff: string;
  /** Tarjeta y oferta de retomar, cuando el borrador se guardo sin las firmas. */
  cardSignaturesAgain: string;
  /** Casilla de la pantalla de resultado: sin / con las firmas guardadas en el borrador. */
  deleteLabel: string;
  deleteLabelWithSignatures: string;
  /** Solo con firmas guardadas: lo que pasa si no se marca. */
  deleteHintKept: string;
  /** Region viva tras descargar: borrado hecho / no se pudo. */
  deleteDone: string;
  deleteFailed: string;
  /** F0-fix (D5): el borrado se retrasa unos segundos tras pulsar «Descargar»: lo que se dice mientras tanto, con «Deshacer». */
  deleteSoon: string;
  deleteUndo: string;
  /** Tras «Deshacer»: el borrador se conserva. */
  deleteUndone: string;
  /**
   * F0-fix2 (N1): la casilla se DESMARCA durante la espera del borrado: se cancela y se dice que se conserva (sin / con
   * las firmas guardadas, que caducan a los 7 dias).
   */
  deleteKept: string;
  deleteKeptExpires: string;
  /**
   * F0-fix2 (N2): «Quitar ahora las firmas de los borradores guardados» (Ajustes y aviso de privacidad): el boton, su
   * confirmacion y lo que se anuncia al terminar.
   */
  clearStrokesButton: string;
  clearStrokesTitle: string;
  clearStrokesBody: string;
  clearStrokesConfirm: string;
  clearStrokesDone: string;
  clearStrokesNone: string;
  clearStrokesFailed: string;
};

/**
 * Subir una firma o iniciales como imagen (Fase 6 «Firma agil», U6.2): la hoja «Subir firma o iniciales» de «Firmas
 * guardadas» y el modo «Subir» del compositor. Un solo bloque para que ES y EN se mantengan a la par.
 */
export type InkImportErrors = {
  empty: string;
  tooLargeFile: string;
  unsupported: string;
  decode: string;
  heic: string;
  tooManyPixels: string;
  invalid: string;
  noInk: string;
  tooDark: string;
  encode: string;
  generic: string;
};

export type InkImportStrings = {
  /** Boton en «Firmas guardadas». */
  entryButton: string;
  title: string;
  /** Titulo cuando se abre desde el modo «Subir» del compositor. */
  composeTitle: string;
  /** Ayuda: como sacar una buena foto. */
  tip: string;
  /** Privacidad: lo que se guarda y lo que no. */
  privacy: string;
  pickFile: string;
  takePhoto: string;
  dropHint: string;
  dropActive: string;
  formats: string;
  reading: string;
  /* --- Paso de ajustes --- */
  adjustTitle: string;
  originalAlt: string;
  cropTitle: string;
  cropAutoHint: string;
  cropManual: string;
  cropReset: string;
  cropHelp: string;
  cropAreaLabel: string;
  cropHandle: (corner: "nw" | "ne" | "sw" | "se") => string;
  /** Se anuncia tras cada flecha del teclado en una asa del recorte (porcentajes de la imagen). */
  cropValue: (crop: { left: number; top: number; width: number; height: number }) => string;
  cropDone: string;
  cleanLabel: string;
  cleanAuto: string;
  cleanAutoActive: string;
  evenLighting: string;
  evenLightingHint: string;
  removeSpecks: string;
  removeSpecksHint: string;
  inkLabel: string;
  inkOriginal: string;
  inkBlack: string;
  inkBlue: string;
  previewTitle: string;
  previewChecker: string;
  previewLine: string;
  previewWorking: string;
  previewAlt: string;
  /** Anuncio (region viva) cuando la vista previa termina. */
  previewReady: string;
  kindLabel: string;
  kindSignature: string;
  kindInitials: string;
  /* --- Resumen y guardado --- */
  summaryTitle: string;
  slotSignature: string;
  slotInitials: string;
  slotEmpty: string;
  slotAlt: (kind: "signature" | "initials") => string;
  addInitials: string;
  addSignature: string;
  changeImage: string;
  removeImage: string;
  useAs: (kind: "signature" | "initials") => string;
  useDraft: string;
  chooseAnother: string;
  nameLabel: string;
  nameNeeded: string;
  roleLabel: string;
  save: string;
  saving: string;
  vaultFull: string;
  saved: (name: string, kinds: "signature" | "initials" | "both") => string;
  savedDuplicate: (name: string) => string;
  saveLimit: string;
  saveTooLarge: string;
  saveUnavailable: string;
  saveInvalid: string;
  errors: InkImportErrors;
};

/**
 * Exportar todas las firmas / importar firmas (Fase 4 «Firma agil», U4.4-UI): las dos hojas de respaldo de «Firmas
 * guardadas». Un solo bloque para que ES y EN se mantengan a la par.
 */
export type VaultBackupStrings = {
  sectionHint: string;
  exportButton: string;
  importButton: string;
  exportTitle: string;
  exportBody: (count: number) => string;
  protect: string;
  protectHint: string;
  password: string;
  confirmPassword: string;
  strengthLabel: string;
  strengthNone: string;
  strength: [string, string, string, string];
  passwordTooShort: string;
  passwordMismatch: string;
  plainWarning: string;
  encryptionUnavailable: string;
  exportConfirm: string;
  exportWorking: string;
  readyTitle: (filename: string) => string;
  shareButton: string;
  downloadButton: string;
  shareCancelled: string;
  done: (count: number, encrypted: boolean) => string;
  doneFile: (filename: string) => string;
  doneClose: string;
  exportEmpty: string;
  exportUnavailable: string;
  exportTooLarge: string;
  exportFailed: string;
  /* --- Importar --- */
  importTitle: string;
  importIntro: string;
  pickZip: string;
  dropZip: string;
  dropZipActive: string;
  reading: string;
  passwordTitle: string;
  passwordBody: string;
  passwordLabel: string;
  passwordOpen: string;
  wrongPassword: string;
  readErrors: {
    badFile: string;
    tooLarge: string;
    unsafe: string;
    damaged: string;
    newer: string;
    needsPassword: string;
    wrongPassword: string;
    unavailable: string;
    noSignatures: string;
    generic: string;
  };
  previewTitle: string;
  previewIntro: (count: number, encrypted: boolean) => string;
  statusNew: string;
  statusIdentical: string;
  statusDifferent: string;
  /** Mismos dibujos, solo cambian datos del firmante (nombre/cargo). */
  statusSameDrawings: string;
  statusInvalid: string;
  invalidReasons: {
    integrity: string;
    tooLarge: string;
    invalidImage: string;
    invalidEntry: string;
    duplicateId: string;
  };
  contents: (hasSignature: boolean, hasInitials: boolean) => string;
  differentHint: (name: string) => string;
  /** `differs`: lo que cambiaria al reemplazar (nombre y/o cargo). */
  sameDrawingsHint: (existingName: string, differs: ("name" | "role")[]) => string;
  /** Mismo identificador interno que una entrada de OTRA persona: no se puede reemplazar. */
  otherPersonHint: (existingName: string) => string;
  replaceLoses: string;
  /** Con «reemplazar» en «mismos dibujos»: lo que se conserva. */
  replaceKeeps: string;
  /** La opcion «Omitir» cuando es «mismos dibujos» (lo que ya tienes se queda tal cual). */
  decisionKeepExisting: string;
  decisionGroup: (name: string) => string;
  decisionImport: string;
  decisionReplace: string;
  decisionKeepBoth: string;
  decisionOmit: string;
  limitOk: (after: number, max: number) => string;
  limitExceeded: (fits: number, wanted: number, max: number) => string;
  importConfirm: (count: number) => string;
  importNothing: string;
  importing: string;
  /** Se intentó cerrar la hoja mientras se escribía la importación. */
  closeBusy: string;
  result: (imported: number, skipped: number, replaced: number) => string;
  applyFailed: {
    limit: string;
    /** El navegador no tiene espacio libre (cuota agotada): distinto de «no caben» (los límites de la app). */
    quota: string;
    unavailable: string;
    invalid: string;
    /** Otra pestaña cambio la firma que se iba a reemplazar. */
    changed: string;
  };
};

/** La opcion «E-sign» (firma por email), solo visual y deshabilitada (Fase 0 «Firma agil», U0.7). */
export type ESignStrings = {
  /** «E-sign · Pedir firma por email». */
  label: string;
  /** Insignia «Próximamente» / «Soon». */
  soon: string;
  /** Lo que anuncia el lector de pantalla junto al nombre: «Disponible próximamente». */
  unavailable: string;
};

/**
 * Retomar una firma sin terminar y no perder trabajo al salir (Fase 0 «Firma agil», U0.3): la tarjeta de entrada, la oferta
 * al subir los mismos PDF, la hoja «¿Salir de la firma?», el aviso al quitar un documento y el contador de borradores.
 * Un solo bloque para que ES y EN se mantengan a la par.
 */
export type ResumeStrings = {
  /* --- Tarjeta de entrada --- */
  cardTitle: string;
  /** «Documento: A.pdf» / «Documentos: A.pdf, B.pdf y 2 más». */
  cardDocuments: (names: readonly string[]) => string;
  /** «Firmantes: Ana, Luis». */
  cardSigners: (names: readonly string[]) => string;
  /** «Firmas recogidas: Ana ✓, Luis pendiente». */
  cardCollected: (items: readonly { name: string; done: boolean }[]) => string;
  /** «Guardado hace 5 minutos». `ago` ya viene en el idioma. */
  cardSavedAgo: (ago: string) => string;
  /** Lo que se dice en lugar de «hace 0 minutos». */
  justNow: string;
  /** «Hay 2 más sin terminar.» */
  cardMore: (count: number) => string;
  /** Nombre por defecto de un firmante sin nombre (su posicion, desde 1). */
  signerFallback: (position: number) => string;
  resume: string;
  discard: string;
  viewAll: string;
  discardTitle: string;
  discardBody: (documents: number) => string;
  discardConfirm: string;
  discarded: string;
  /* --- Oferta al subir los mismos PDF --- */
  offerTitle: string;
  offerBody: (ago: string) => string;
  offerStartOver: string;
  /** Lo que se anuncia (region viva) cuando aparece la oferta. */
  offerAnnounce: string;
  /* --- Hoja «¿Salir de la firma?» --- */
  leaveTitle: string;
  leaveBodySaved: string;
  leaveBodyUnsaved: string;
  /** F0-fix (D2): el navegador no dejo guardar el borrador (cuota llena, almacenamiento bloqueado): salir pierde el trabajo. */
  leaveBodyFailed: string;
  /** F0-fix (D2): «Solo yo» no guarda borrador. */
  leaveBodySolo: string;
  leaveStay: string;
  leaveLeave: string;
  /* --- Quitar documentos con trabajo hecho --- */
  removedOne: (name: string) => string;
  removedMany: (count: number) => string;
  removedUndo: string;
  removedRestored: string;
  /* --- «Ver borradores» --- */
  /** Descripcion accesible del contador del boton: «2 guardados». */
  draftsCount: (count: number) => string;
  /* --- Avisos persistentes del borrador (F0-fix: D1 y D2) --- */
  /** Mientras el navegador no deja guardar: «Sin autoguardado...». */
  draftFailedNotice: string;
  /** Otra pestaña guardo una version mas nueva de esta sesion (aun no se ha pisado nada). */
  tabNewerNotice: string;
  /** Lo de esta pestaña se guardo APARTE porque otra habia modificado el original. */
  tabForkedNotice: string;
  /** Etiqueta de un borrador que es la copia aparte de una pestaña (en «Ver borradores»). */
  copyTag: string;
};

/**
 * «¿Quién firma qué?», copias, orden de los turnos y «Revisar antes de descargar» (Firma ágil · Fase 1 · U1.2 y U1.3).
 * Las claves de los problemas llevan el nombre de `assignment.issue.<kind>` de `assignmentValidation.ts`. Un solo bloque
 * para que ES y EN se mantengan a la par.
 */
export type IssueTextParams = {
  /** Nombres ya resueltos (firmante, documento, «Firma A»). */
  signer: string;
  doc: string;
  group: string;
  count: number;
  max: number;
  /** Trazos que faltan: «la firma», «las iniciales» o las dos. */
  strokes: readonly ("signature" | "initials")[];
};

export type AssignmentStrings = {
  /* --- Tabla --- */
  title: string;
  hint: string;
  tableLabel: string;
  docColumn: string;
  copiesColumn: string;
  /** «Firma A» / «Signature A». */
  group: (letter: string) => string;
  noSign: string;
  /** Etiqueta accesible de una celda: quién, dónde, qué firma. */
  cellLabel: (signer: string, doc: string, group: string | null) => string;
  cellHint: string;
  /* --- Atajos --- */
  shortcutsLabel: string;
  shortcutAll: string;
  shortcutPerDoc: string;
  shortcutGroups: string;
  shortcutGroupsHint: string;
  /* --- Copias --- */
  copiesFor: (doc: string) => string;
  copiesLess: (doc: string) => string;
  copiesMore: (doc: string) => string;
  copiesValue: (doc: string, copies: number) => string;
  allCopiesLabel: string;
  allCopiesLess: string;
  allCopiesMore: string;
  copiesAtMax: (max: number) => string;
  filesAtMax: (max: number) => string;
  /* --- Cambios --- */
  undo: string;
  undone: string;
  lastSignerCell: (signer: string) => string;
  cellChanged: (signer: string, doc: string, group: string | null) => string;
  shortcutApplied: (shortcut: string) => string;
  copiesChanged: (doc: string, copies: number) => string;
  allCopiesChanged: (copies: number) => string;
  /* --- Confirmación de trazos afectados --- */
  confirmTitle: string;
  confirmIntro: string;
  /** «Esto borrará la firma B de Ana en 2 documentos». */
  lostLine: (group: string, signer: string, docs: number, strokes: readonly ("signature" | "initials")[]) => string;
  /** El trazo sigue pero cubre documentos que su dueño no vio. */
  reconfirmLine: (group: string, signer: string, added: number) => string;
  confirmContinue: string;
  confirmCancel: string;
  cancelled: string;
  /* --- Resumen --- */
  summaryTitle: string;
  /** «Ana firma 4 documentos con 2 firmas: A (Contrato, Anexo) y B (Carta, Autorización).» */
  summarySigner: (
    name: string,
    documents: number,
    groups: readonly { letter: string; docs: readonly string[] }[],
  ) => string;
  summaryFiles: (files: number) => string;
  summaryNobody: (docs: readonly string[]) => string;
  summaryNoSigners: string;
  /* --- Problemas (de `validateAssignment`) --- */
  issueTitleBlocking: string;
  issueTitleWarning: string;
  fixIt: string;
  issue: Record<
    | "slotWithoutSigner"
    | "signerWithoutSlot"
    | "signerWithoutDocuments"
    | "documentWithoutSigner"
    | "requiredFieldEmpty"
    | "groupWithoutStroke"
    | "overlappingGroups"
    | "tooManyFiles",
    (p: IssueTextParams) => string
  >;
  /* --- Ceremonia --- */
  /** «Firma A — para: Contrato, Anexo». */
  groupFor: (group: string, docs: string) => string;
  /** «Firma A» en el hueco de las iniciales, etc. */
  turnAgenda: (signer: string) => string;
  /* --- Orden de los turnos --- */
  orderTitle: string;
  orderHint: string;
  orderMoveUp: (signer: string) => string;
  orderMoveDown: (signer: string) => string;
  orderMoved: (signer: string, position: number, total: number) => string;
  orderLocked: string;
  /* --- Resultado --- */
  filesDelivered: (files: number, documents: number, copiesOfEach: number | null) => string;
};

export type ReviewStrings = {
  title: string;
  intro: string;
  /** «Contrato · 2 páginas con firma». */
  docHeading: (doc: string, marked: number, total: number) => string;
  counterInitials: (done: number, expected: number) => string;
  counterSignatures: (done: number, total: number) => string;
  counterText: (done: number, total: number) => string;
  /** Miniatura: página y qué lleva. */
  thumbLabel: (doc: string, page: number, kinds: readonly string[]) => string;
  thumbGo: (doc: string, page: number) => string;
  kindSignature: string;
  kindInitials: string;
  kindText: string;
  pageNumber: (page: number) => string;
  loadingThumb: string;
  noMarks: string;
  blockedTitle: string;
  warningsTitle: string;
  readyTitle: string;
  readyBody: (files: number) => string;
  disabledBecause: string;
  /** Faltan iniciales en páginas del cuerpo. */
  initialsMissing: (doc: string, signer: string, pages: readonly number[]) => string;
  statusTitle: string;
};

/** «Contrato» · «Contrato y 2 más»: nombres de archivo para los avisos de limite. */
function quotedNames(names: readonly string[], and: string, more: (n: number) => string): string {
  if (names.length === 0) return "";
  const first = `«${names[0]}»`;
  if (names.length === 1) return first;
  return `${first} ${and} ${more(names.length - 1)}`;
}

const resumeEs: ResumeStrings = {
  cardTitle: "Tienes una firma sin terminar",
  cardDocuments: (names) =>
    names.length === 1
      ? `Documento: ${names[0]}`
      : `Documentos: ${names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} y ${names.length - 2} más`}`,
  cardSigners: (names) => `Firmantes: ${names.join(", ")}`,
  cardCollected: (items) =>
    `Firmas recogidas: ${items.map((item) => (item.done ? `${item.name} ✓` : `${item.name} pendiente`)).join(", ")}`,
  cardSavedAgo: (ago) => `Guardado ${ago}`,
  justNow: "ahora mismo",
  cardMore: (count) => (count === 1 ? "Hay 1 más sin terminar." : `Hay ${count} más sin terminar.`),
  signerFallback: (position) => `Firmante ${position}`,
  resume: "Retomar",
  discard: "Descartar",
  viewAll: "Ver todos",
  discardTitle: "¿Descartar esta firma sin terminar?",
  discardBody: (documents) =>
    documents === 1
      ? "Se borrarán el documento, los firmantes y las firmas recogidas de este borrador. No se puede deshacer."
      : `Se borrarán los ${documents} documentos, los firmantes y las firmas recogidas de este borrador. No se puede deshacer.`,
  discardConfirm: "Descartar",
  discarded: "Borrador descartado.",
  offerTitle: "Retomar lo que tenías",
  offerBody: (ago) =>
    `Estos mismos documentos ya tienen un trabajo guardado en este dispositivo (${ago}). Puedes continuar donde lo dejaste o empezar de cero.`,
  offerStartOver: "Empezar de nuevo",
  offerAnnounce: "Hay un trabajo guardado de estos mismos documentos: puedes retomarlo.",
  leaveTitle: "¿Salir de la firma?",
  leaveBodySaved:
    "Todo está guardado en este dispositivo. Cuando vuelvas a Firmar PDF podrás retomarlo donde lo dejaste.",
  leaveBodyUnsaved:
    "Este trabajo es demasiado grande para guardarse en este dispositivo: si sales, se perderá.",
  leaveBodyFailed: "No se pudo guardar tu trabajo en este dispositivo: si sales se perderá.",
  leaveBodySolo: "Este modo no guarda borrador. Si sales, se perderá lo que has hecho.",
  leaveStay: "Seguir firmando",
  leaveLeave: "Salir",
  removedOne: (name) => `Quitaste «${name}» de la ronda.`,
  removedMany: (count) => `Quitaste ${count} documentos de la ronda.`,
  removedUndo: "Deshacer",
  removedRestored: "Los documentos han vuelto, con todo su trabajo.",
  draftsCount: (count) => (count === 1 ? "1 guardado" : `${count} guardados`),
  draftFailedNotice: "Sin autoguardado: el navegador no deja guardar aquí. Descarga antes de salir.",
  tabNewerNotice: "Otra pestaña modificó esta firma. Recarga para ver la versión más reciente; lo que cambies aquí se guardará como copia aparte.",
  tabForkedNotice: "Otra pestaña modificó esta firma; esta copia se guardó aparte.",
  copyTag: "Copia aparte",
};

const resumeEn: ResumeStrings = {
  cardTitle: "You have an unfinished signing",
  cardDocuments: (names) =>
    names.length === 1
      ? `Document: ${names[0]}`
      : `Documents: ${names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`}`,
  cardSigners: (names) => `Signers: ${names.join(", ")}`,
  cardCollected: (items) =>
    `Signatures collected: ${items.map((item) => (item.done ? `${item.name} ✓` : `${item.name} pending`)).join(", ")}`,
  cardSavedAgo: (ago) => `Saved ${ago}`,
  justNow: "just now",
  cardMore: (count) => (count === 1 ? "There is 1 more unfinished." : `There are ${count} more unfinished.`),
  signerFallback: (position) => `Signer ${position}`,
  resume: "Resume",
  discard: "Discard",
  viewAll: "View all",
  discardTitle: "Discard this unfinished signing?",
  discardBody: (documents) =>
    documents === 1
      ? "This deletes the document, the signers and the collected signatures of this draft. This cannot be undone."
      : `This deletes the ${documents} documents, the signers and the collected signatures of this draft. This cannot be undone.`,
  discardConfirm: "Discard",
  discarded: "Draft discarded.",
  offerTitle: "Pick up where you left off",
  offerBody: (ago) =>
    `These same documents already have work saved on this device (${ago}). You can continue where you stopped or start from scratch.`,
  offerStartOver: "Start over",
  offerAnnounce: "These same documents have saved work: you can resume it.",
  leaveTitle: "Leave signing?",
  leaveBodySaved:
    "Everything is saved on this device. When you come back to Sign PDF you can pick it up where you left off.",
  leaveBodyUnsaved:
    "This work is too large to be saved on this device: if you leave, it will be lost.",
  leaveBodyFailed: "Your work could not be saved on this device: if you leave, it will be lost.",
  leaveBodySolo: "This mode does not save a draft. If you leave, what you have done will be lost.",
  leaveStay: "Keep signing",
  leaveLeave: "Leave",
  removedOne: (name) => `You removed “${name}” from the round.`,
  removedMany: (count) => `You removed ${count} documents from the round.`,
  removedUndo: "Undo",
  removedRestored: "The documents are back, with all their work.",
  draftsCount: (count) => (count === 1 ? "1 saved" : `${count} saved`),
  draftFailedNotice: "No autosave: the browser will not let this page save. Download before you leave.",
  tabNewerNotice: "Another tab changed this signing. Reload to see the latest version; what you change here will be saved as a separate copy.",
  tabForkedNotice: "Another tab changed this signing; this copy was saved separately.",
  copyTag: "Separate copy",
};

const strokesEs = (strokes: readonly ("signature" | "initials")[]): string =>
  strokes.length === 2 ? "la firma y las iniciales" : strokes[0] === "initials" ? "las iniciales" : "la firma";
const strokesEn = (strokes: readonly ("signature" | "initials")[]): string =>
  strokes.length === 2 ? "the signature and the initials" : strokes[0] === "initials" ? "the initials" : "the signature";
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const plEs = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const andEs = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
const andEn = (items: readonly string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

const assignmentEs: AssignmentStrings = {
  title: "¿Quién firma qué?",
  hint: "Toca una celda para elegir qué firma lleva cada documento. Las celdas con la misma letra comparten la misma firma.",
  tableLabel: "Quién firma cada documento y cuántas copias se entregan",
  docColumn: "Documento",
  copiesColumn: "Copias",
  group: (letter) => `Firma ${letter}`,
  noSign: "No firma",
  cellLabel: (signer, doc, group) => `${signer} en ${doc}: ${group ?? "no firma"}`,
  cellHint: "Toca para cambiar. Flechas para moverte entre celdas.",
  shortcutsLabel: "Atajos",
  shortcutAll: "Una firma para todos",
  shortcutPerDoc: "Una firma por documento",
  shortcutGroups: "Por grupos",
  shortcutGroupsHint: "Por grupos: la primera mitad de los documentos comparte la firma A y el resto la B.",
  copiesFor: (doc) => `Copias de ${doc}`,
  copiesLess: (doc) => `Una copia menos de ${doc}`,
  copiesMore: (doc) => `Una copia más de ${doc}`,
  copiesValue: (doc, copies) => `${doc}: ${copies} ${copies === 1 ? "copia" : "copias"}`,
  allCopiesLabel: "Copias de todos",
  allCopiesLess: "Una copia menos en todos los documentos",
  allCopiesMore: "Una copia más en todos los documentos",
  copiesAtMax: (max) => `Máximo ${max} copias por documento.`,
  filesAtMax: (max) => `Máximo ${max} archivos por descarga: no caben más copias.`,
  undo: "Deshacer cambio",
  undone: "Cambio deshecho.",
  lastSignerCell: (signer) => `${signer} tiene que firmar al menos un documento. Si no firma ninguno, quítalo de la lista.`,
  cellChanged: (signer, doc, group) => `${signer} en ${doc}: ${group ?? "no firma"}.`,
  shortcutApplied: (shortcut) => `${shortcut}: aplicado.`,
  copiesChanged: (doc, copies) => `${doc}: ${copies} ${copies === 1 ? "copia" : "copias"}.`,
  allCopiesChanged: (copies) => `Todos los documentos: ${copies} ${copies === 1 ? "copia" : "copias"}.`,
  confirmTitle: "¿Cambiar la asignación?",
  confirmIntro: "Este cambio afecta a firmas que ya se recogieron:",
  lostLine: (group, signer, docs, strokes) =>
    `Esto borrará ${strokes.length === 1 && strokes[0] === "initials" ? "las iniciales de " : ""}la ${lowerFirst(group)} de ${signer} en ${plEs(docs, "documento", "documentos")}.`,
  reconfirmLine: (group, signer, added) =>
    `${signer} tendrá que volver a confirmar la ${lowerFirst(group)}: ahora cubre ${plEs(added, "documento más", "documentos más")} que no vio.`,
  confirmContinue: "Continuar",
  confirmCancel: "Cancelar",
  cancelled: "Cambio cancelado.",
  summaryTitle: "Resumen",
  summarySigner: (name, documents, groups) => {
    const docsText = plEs(documents, "documento", "documentos");
    if (groups.length === 1) return `${name} firma ${docsText} con 1 firma.`;
    return `${name} firma ${docsText} con ${groups.length} firmas: ${andEs(
      groups.map((group) => `${group.letter} (${group.docs.join(", ")})`),
    )}.`;
  },
  summaryFiles: (files) => (files === 1 ? "Se descargará 1 archivo." : `Se descargarán ${files} archivos.`),
  summaryNobody: (docs) => `Nadie firma: ${andEs(docs)}.`,
  summaryNoSigners: "Añade al menos un firmante para asignar las firmas.",
  issueTitleBlocking: "Hay que corregir esto antes de descargar",
  issueTitleWarning: "Conviene revisar",
  fixIt: "Ir a corregirlo",
  issue: {
    slotWithoutSigner: ({ signer, doc }) =>
      `${signer} tiene un hueco de firma en ${doc}, pero no está asignado a ese documento.`,
    signerWithoutSlot: ({ signer, doc, group }) =>
      `${signer} firma ${doc} con la ${lowerFirst(group)}, pero ese documento no tiene hueco para esa persona.`,
    signerWithoutDocuments: ({ signer }) => `${signer} no firma ningún documento.`,
    documentWithoutSigner: ({ doc }) => `Nadie firma ${doc}.`,
    requiredFieldEmpty: ({ doc, count }) =>
      `${doc} tiene ${plEs(count, "campo de texto sin rellenar", "campos de texto sin rellenar")}.`,
    groupWithoutStroke: ({ signer, group, strokes }) =>
      `A ${signer} le falta ${strokesEs(strokes)} de la ${lowerFirst(group)}.`,
    overlappingGroups: ({ signer, doc }) =>
      `${signer} tiene dos firmas distintas asignadas a ${doc}; solo se usará la primera.`,
    tooManyFiles: ({ count, max }) =>
      `Son ${count} archivos y el máximo es ${max}. Reduce las copias o quita documentos.`,
  },
  groupFor: (group, docs) => `${group} — para: ${docs}`,
  turnAgenda: (signer) => `Lo que firma ${signer}`,
  orderTitle: "Orden de los turnos",
  orderHint: "Quién recibe el dispositivo primero. Cambia el orden con las flechas.",
  orderMoveUp: (signer) => `Subir a ${signer}`,
  orderMoveDown: (signer) => `Bajar a ${signer}`,
  orderMoved: (signer, position, total) => `${signer} pasa al turno ${position} de ${total}.`,
  orderLocked: "El orden ya no se puede cambiar: alguien ha empezado a firmar.",
  filesDelivered: (files, documents, copiesOfEach) =>
    copiesOfEach !== null && copiesOfEach > 1
      ? `${files} archivos: ${plEs(documents, "documento", "documentos")} con ${copiesOfEach} copias cada uno.`
      : `${files} archivos en el ZIP (${plEs(documents, "documento", "documentos")} y sus copias).`,
};

const reviewEs: ReviewStrings = {
  title: "Revisar antes de descargar",
  intro: "Mira cada página que lleva firma, iniciales o texto. Toca una miniatura para ir a esa página.",
  docHeading: (doc, marked, total) =>
    `${doc} · ${plEs(marked, "página con marcas", "páginas con marcas")} de ${total}`,
  counterInitials: (done, expected) => `Iniciales: ${done} de ${expected}`,
  counterSignatures: (done, total) => `Firmas: ${done} de ${total}`,
  counterText: (done, total) => `Texto: ${done} de ${total}`,
  thumbLabel: (doc, page, kinds) => `${doc}, página ${page}: ${kinds.join(", ")}`,
  thumbGo: (doc, page) => `Ir a la página ${page} de ${doc}`,
  kindSignature: "firma",
  kindInitials: "iniciales",
  kindText: "texto",
  pageNumber: (page) => `Página ${page}`,
  loadingThumb: "Cargando miniatura",
  noMarks: "Este documento no lleva firmas, iniciales ni texto.",
  blockedTitle: "No se puede descargar todavía",
  warningsTitle: "Avisos (puedes continuar)",
  readyTitle: "Todo listo para descargar",
  readyBody: (files) => (files === 1 ? "Se descargará 1 archivo." : `Se descargarán ${files} archivos.`),
  disabledBecause: "Corrige primero lo marcado arriba.",
  initialsMissing: (doc, signer, pages) =>
    `${doc}: a ${signer} le faltan las iniciales en ${pages.length === 1 ? "la página" : "las páginas"} ${andEs(pages.map(String))}.`,
  statusTitle: "Estado de la revisión",
};

const assignmentEn: AssignmentStrings = {
  title: "Who signs what?",
  hint: "Tap a cell to choose which signature goes on each document. Cells with the same letter share the same signature.",
  tableLabel: "Who signs each document and how many copies are delivered",
  docColumn: "Document",
  copiesColumn: "Copies",
  group: (letter) => `Signature ${letter}`,
  noSign: "Does not sign",
  cellLabel: (signer, doc, group) => `${signer} on ${doc}: ${group ?? "does not sign"}`,
  cellHint: "Tap to change. Arrow keys move between cells.",
  shortcutsLabel: "Shortcuts",
  shortcutAll: "One signature for all",
  shortcutPerDoc: "One signature per document",
  shortcutGroups: "By groups",
  shortcutGroupsHint: "By groups: the first half of the documents share signature A and the rest share B.",
  copiesFor: (doc) => `Copies of ${doc}`,
  copiesLess: (doc) => `One copy fewer of ${doc}`,
  copiesMore: (doc) => `One copy more of ${doc}`,
  copiesValue: (doc, copies) => `${doc}: ${copies} ${copies === 1 ? "copy" : "copies"}`,
  allCopiesLabel: "Copies of all",
  allCopiesLess: "One copy fewer of every document",
  allCopiesMore: "One copy more of every document",
  copiesAtMax: (max) => `At most ${max} copies per document.`,
  filesAtMax: (max) => `At most ${max} files per download: no room for more copies.`,
  undo: "Undo change",
  undone: "Change undone.",
  lastSignerCell: (signer) => `${signer} has to sign at least one document. If they sign none, remove them from the list.`,
  cellChanged: (signer, doc, group) => `${signer} on ${doc}: ${group ?? "does not sign"}.`,
  shortcutApplied: (shortcut) => `${shortcut}: applied.`,
  copiesChanged: (doc, copies) => `${doc}: ${copies} ${copies === 1 ? "copy" : "copies"}.`,
  allCopiesChanged: (copies) => `All documents: ${copies} ${copies === 1 ? "copy" : "copies"}.`,
  confirmTitle: "Change the assignment?",
  confirmIntro: "This change affects signatures that were already collected:",
  lostLine: (group, signer, docs, strokes) =>
    `This will delete ${strokes.length === 1 && strokes[0] === "initials" ? "the initials of " : ""}${lowerFirst(group)} of ${signer} on ${docs} ${docs === 1 ? "document" : "documents"}.`,
  reconfirmLine: (group, signer, added) =>
    `${signer} will have to confirm ${lowerFirst(group)} again: it now covers ${added} more ${added === 1 ? "document" : "documents"} they did not see.`,
  confirmContinue: "Continue",
  confirmCancel: "Cancel",
  cancelled: "Change cancelled.",
  summaryTitle: "Summary",
  summarySigner: (name, documents, groups) => {
    const docsText = `${documents} ${documents === 1 ? "document" : "documents"}`;
    if (groups.length === 1) return `${name} signs ${docsText} with 1 signature.`;
    return `${name} signs ${docsText} with ${groups.length} signatures: ${andEn(
      groups.map((group) => `${group.letter} (${group.docs.join(", ")})`),
    )}.`;
  },
  summaryFiles: (files) => (files === 1 ? "1 file will be downloaded." : `${files} files will be downloaded.`),
  summaryNobody: (docs) => `Nobody signs: ${andEn(docs)}.`,
  summaryNoSigners: "Add at least one signer to assign signatures.",
  issueTitleBlocking: "Fix this before downloading",
  issueTitleWarning: "Worth checking",
  fixIt: "Go fix it",
  issue: {
    slotWithoutSigner: ({ signer, doc }) =>
      `${signer} has a signature field on ${doc}, but is not assigned to that document.`,
    signerWithoutSlot: ({ signer, doc, group }) =>
      `${signer} signs ${doc} with ${lowerFirst(group)}, but that document has no field for them.`,
    signerWithoutDocuments: ({ signer }) => `${signer} does not sign any document.`,
    documentWithoutSigner: ({ doc }) => `Nobody signs ${doc}.`,
    requiredFieldEmpty: ({ doc, count }) =>
      `${doc} has ${count} empty text ${count === 1 ? "field" : "fields"}.`,
    groupWithoutStroke: ({ signer, group, strokes }) =>
      `${signer} is missing ${strokesEn(strokes)} of ${lowerFirst(group)}.`,
    overlappingGroups: ({ signer, doc }) =>
      `${signer} has two different signatures assigned to ${doc}; only the first one will be used.`,
    tooManyFiles: ({ count, max }) =>
      `That is ${count} files and the maximum is ${max}. Reduce the copies or remove documents.`,
  },
  groupFor: (group, docs) => `${group} — for: ${docs}`,
  turnAgenda: (signer) => `What ${signer} signs`,
  orderTitle: "Turn order",
  orderHint: "Who gets the device first. Change the order with the arrows.",
  orderMoveUp: (signer) => `Move ${signer} up`,
  orderMoveDown: (signer) => `Move ${signer} down`,
  orderMoved: (signer, position, total) => `${signer} moves to turn ${position} of ${total}.`,
  orderLocked: "The order can no longer be changed: someone has started signing.",
  filesDelivered: (files, documents, copiesOfEach) =>
    copiesOfEach !== null && copiesOfEach > 1
      ? `${files} files: ${documents} ${documents === 1 ? "document" : "documents"} with ${copiesOfEach} copies each.`
      : `${files} files in the ZIP (${documents} ${documents === 1 ? "document" : "documents"} and their copies).`,
};

const reviewEn: ReviewStrings = {
  title: "Review before downloading",
  intro: "Check every page that carries a signature, initials or text. Tap a thumbnail to go to that page.",
  docHeading: (doc, marked, total) =>
    `${doc} · ${marked} marked ${marked === 1 ? "page" : "pages"} of ${total}`,
  counterInitials: (done, expected) => `Initials: ${done} of ${expected}`,
  counterSignatures: (done, total) => `Signatures: ${done} of ${total}`,
  counterText: (done, total) => `Text: ${done} of ${total}`,
  thumbLabel: (doc, page, kinds) => `${doc}, page ${page}: ${kinds.join(", ")}`,
  thumbGo: (doc, page) => `Go to page ${page} of ${doc}`,
  kindSignature: "signature",
  kindInitials: "initials",
  kindText: "text",
  pageNumber: (page) => `Page ${page}`,
  loadingThumb: "Loading thumbnail",
  noMarks: "This document carries no signatures, initials or text.",
  blockedTitle: "It cannot be downloaded yet",
  warningsTitle: "Warnings (you can continue)",
  readyTitle: "Everything is ready to download",
  readyBody: (files) => `${files === 1 ? "1 file" : `${files} files`} will be downloaded.`,
  disabledBecause: "Fix what is marked above first.",
  initialsMissing: (doc, signer, pages) =>
    `${doc}: ${signer} is missing initials on ${pages.length === 1 ? "page" : "pages"} ${andEn(pages.map(String))}.`,
  statusTitle: "Review status",
};

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
    "Sube una imagen o haz una foto de la firma sobre papel blanco, con buena luz: se recorta y se limpia el fondo sola.",
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
  editedFilenameSuffix: "editado",

  certificateTitle: "Registro de firmas",
  certificateNotice: "No es una firma certificada: solo registra quién firmó y cuándo.",
  certificateHashLabel: "Hash SHA-256 del documento firmado (sin esta página)",
  certificateTimestampLabel: "Fecha y hora",
  certificateSignersLabel: "Firmantes",
  certificateNoSignerName: "Sin nombre",
  certificateDisclaimer:
    "Esta página es solo trazabilidad informal: el hash permite comprobar que el documento no cambió después de firmarse. No es una firma electrónica cualificada ni certificada.",
  signingRecordDownload: "Descargar registro (.json)",

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
  stepAnnounce: (position, total, label) => `Paso ${position} de ${total}: ${label}`,

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
  paletteExpand: (activeTool) => `Herramientas del documento (activa: ${activeTool})`,
  paletteCollapse: "Plegar herramientas",
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
  scannedFieldLabel: (position) => `Hueco encontrado en una página escaneada, ${position}`,
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
  suggestedFieldsToggle: (count) => `Campos sugeridos (${count})`,
  suggestedFieldsDescription:
    "Rayas con etiqueta que parecen un hueco para rellenar. Actívalos para escribir sobre ellas; no se aplican al PDF hasta que escribas algo.",
  suggestedFieldsShown: (count) =>
    count === 1 ? "Se muestra 1 campo sugerido." : `Se muestran ${count} campos sugeridos.`,
  suggestedFieldsHidden: "Campos sugeridos ocultos.",
  scanPageFields: "Buscar huecos en páginas escaneadas",
  scanningPage: "Buscando huecos en la página escaneada",
  scanFound: (count, page) =>
    count === 1
      ? `Se encontró 1 posible hueco en la página ${page}. Revísalo antes de firmar.`
      : `Se encontraron ${count} posibles huecos en la página ${page}. Revísalos antes de firmar.`,
  scanNone: (page) => `No se encontraron huecos en la página ${page}.`,
  scanFailed: "No se pudo analizar la página escaneada.",
  toolEditText: "Editar texto",
  editTextHint:
    "Haz doble clic (o toca dos veces) en un texto del PDF para cambiarlo. Con un bloque enfocado: Intro edita, las flechas lo mueven, Supr lo borra.",
  editTextCount: (count) =>
    count === 1
      ? "1 texto editado en este documento."
      : `${count} textos editados en este documento.`,
  editTextNote:
    "Al firmar, el texto original de lo que editaste se elimina del archivo, y al terminar verás un resumen. En casos especiales (fuentes poco comunes, texto vertical u oculto, contenido compartido) no se puede quitar: el resumen te dice cuál y por qué, y «Aplanar página» en Editar PDF lo quita del todo.",
  editTextFlattenLink: "Abrir Editar PDF",
  editTextUndo: "Deshacer cambio de texto",
  editTextRedo: "Rehacer cambio de texto",
  editReportTitle: "Sobre el texto editado",
  editInDocs: (documents) => ` en ${documents} documentos`,
  editTailAllRemoved: (several) =>
    several ? "el original se eliminó de los archivos" : "el original se eliminó del archivo",
  editTailSomeRemoved: (removed, remains) =>
    `el original se eliminó de ${removed} y no se pudo quitar de ${remains} (más abajo, por qué)`,
  editTailNoneRemoved: (remains) =>
    remains === 1
      ? "no se pudo quitar el original (más abajo, por qué)"
      : `no se pudo quitar el original de ${remains} (más abajo, por qué)`,
  editRemainsItem: (docName, page, excerpt, reason) =>
    `${docName ? `${docName}, página` : "Página"} ${page}${excerpt ? `, «${excerpt}»` : ", un texto borrado"}: el original sigue bajo la edición. ${reason}`,
  editRemainsMore: (count) =>
    count === 1 ? "Y 1 texto más con el original sin quitar." : `Y ${count} textos más con el original sin quitar.`,
  editRemainsAdvice: (flattenLabel) =>
    `Para quitarlo del todo, abre el archivo descargado en Editar PDF y usa «${flattenLabel}»: la página pasa a ser una imagen y el texto original desaparece.`,
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

  // Ceremonia robusta (F0 · U0.2): que falta y progreso del turno.
  ceremonyProgressLabel: (name) => `Progreso de ${name}`,
  ceremonyItemDone: "hecho",
  ceremonyItemMissing: "falta",
  staleSignature: (name, reason) =>
    `La firma de ${name} ya no es válida porque ${
      reason === "text"
        ? "cambiaste el texto del documento"
        : reason === "fields"
          ? "cambiaste los huecos de firma del documento"
          : "cambió el documento"
    }: ${name} debe volver a firmar.`,
  statusStale: "Debe volver a firmar",
  staleReasonShort: (reason) =>
    reason === "text"
      ? "cambió el texto del documento"
      : reason === "fields"
        ? "cambiaron los huecos de firma"
        : "cambió el documento",
  ceremonyItemStale: "ya no es válida",
  ceremonyMissing: (items) => `Falta: ${items.join("; ")}`,
  ceremonyGoToMissing: "Ir a lo que falta",
  ceremonyAllCaptured: "Todo listo: ya puedes ver cómo queda.",

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
  privacySummary: "Tus documentos y firmas se quedan en este dispositivo: no se suben a ningún servidor.",
  privacyReadFull: "Leer completo",
  privacyUnderstood: "Entendido",
  privacyNoticeBody:
    "OptimusPDF no guarda datos en la nube ni en un servidor. Los datos únicamente existen y se manejan en su dispositivo y tu navegador. Si deseas eliminar completamente los datos, solo cierra la pestaña, borra los datos de navegación de tu navegador o haz clic en el botón 'Borrar datos'. Los datos que se guardan en tu navegador solo sirven para usarlos en otros documentos que abras en tu navegador, puedes borrarlos cuando lo desees. Mientras trabajas con varios firmantes, el borrador guarda la sesión completa en este dispositivo (los documentos, los firmantes, los campos y, mientras no lo apagues, las firmas ya hechas) para que puedas retomarla, y si exportas la configuración, el archivo .zip contiene tus documentos. El borrador se guarda unas décimas de segundo después de cada cambio; si el navegador se cierra a la fuerza (o la pestaña se descarta) justo después de un cambio, lo último podría no guardarse. Todo se elimina con «Borrar datos» (o «Borrar datos locales» en Ajustes).",
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
  exportConfigEditsNote:
    "Las ediciones de texto no se incluyen en la configuración; se guardan en el borrador del documento.",
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
            : store === "proDrafts"
              ? "borradores de PDF Pro"
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
  blockChangeScopeFor: (block, signer) => `Cambiar los documentos de «${block}» de ${signer}`,
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
    "Elige a qué documentos aplica esta firma. Un documento solo puede llevar una firma de cada persona: si lo marcas aquí, sale de la otra.",
  scopeDocsLabel: "Documentos de esta firma",
  scopeAllLabel: "Todos los documentos",
  scopeEmpty: "Marca al menos un documento.",
  scopeMovePreview: (doc, from) =>
    typeof from === "number" ? `${doc} saldrá del bloque ${from}.` : `${doc} saldrá de «${from}».`,
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
  resume: resumeEs,
  draftPrivacy: {
    signaturesLabel: "Guardar también las firmas recogidas para no perderlas",
    signaturesHint: "Solo en este dispositivo; se borran a los 7 días.",
    noticeSignaturesOn:
      "Las firmas ya recogidas se guardan también en el borrador, solo en este dispositivo, y se borran solas a los 7 días. Al descargar puedes borrar el borrador.",
    noticeSignaturesOff:
      "Las firmas ya recogidas no se guardan en el borrador: si lo retomas, se piden de nuevo. Los borradores ya guardados conservan sus firmas hasta que caduquen o las quites.",
    cardSignaturesAgain: "Firmas: se volverán a pedir",
    deleteLabel: "Borrar el borrador de esta firma",
    deleteLabelWithSignatures: "Borrar el borrador de esta firma (incluye las firmas guardadas en él)",
    deleteHintKept: "Si lo dejas sin marcar, se conserva con sus firmas hasta 7 días.",
    deleteDone: "Borrador borrado de este dispositivo.",
    deleteFailed: "No se pudo borrar el borrador. Puedes quitarlo desde «Ver borradores».",
    deleteSoon: "El borrador se borrará en unos segundos. Si el archivo no llega, toca Deshacer.",
    deleteUndo: "Deshacer",
    deleteUndone: "Listo: el borrador se conserva.",
    deleteKept: "El borrador se conserva.",
    deleteKeptExpires: "El borrador se conserva (se borra solo a los 7 días).",
    clearStrokesButton: "Quitar ahora las firmas de los borradores guardados",
    clearStrokesTitle: "¿Quitar las firmas de los borradores guardados?",
    clearStrokesBody:
      "Los borradores guardados en este dispositivo conservarán todo (documentos, firmantes, huecos y campos) menos las firmas e iniciales: al retomarlos se pedirán de nuevo. No se puede deshacer.",
    clearStrokesConfirm: "Quitar las firmas",
    clearStrokesDone: "Listo: ya no queda ninguna firma en los borradores guardados.",
    clearStrokesNone: "No hay firmas guardadas en los borradores.",
    clearStrokesFailed: "No se pudieron quitar las firmas de los borradores. Inténtalo de nuevo.",
  },
  esign: {
    label: "E-sign · Pedir firma por email",
    soon: "Próximamente",
    unavailable: "Disponible próximamente",
  },  inkImport: {
    entryButton: "Subir firma o iniciales",
    title: "Subir firma o iniciales",
    composeTitle: "Subir una imagen",
    tip: "Toma una foto de la firma sobre papel blanco, con buena luz.",
    privacy:
      "La imagen original no se guarda ni sale de tu dispositivo: solo se guarda la firma ya limpia, con el fondo transparente.",
    pickFile: "Elegir imagen",
    takePhoto: "Tomar una foto",
    dropHint: "También puedes arrastrar una imagen hasta aquí o pegarla desde el portapapeles.",
    dropActive: "Suelta la imagen aquí",
    formats: "PNG, JPG, WEBP o SVG, de hasta 10 MB.",
    reading: "Leyendo la imagen",
    adjustTitle: "Ajusta la imagen",
    originalAlt: "Imagen original con la zona de recorte",
    cropTitle: "Recorte",
    cropAutoHint: "Por defecto se recorta sola, justo alrededor de la tinta.",
    cropManual: "Recortar a mano",
    cropReset: "Volver al recorte automático",
    cropHelp:
      "Arrastra las esquinas para encuadrar solo la firma. Con el teclado, usa las flechas (con Mayús, saltos más grandes).",
    cropAreaLabel: "Zona de recorte sobre la imagen original",
    cropValue: (crop) =>
      `Recorte: desde ${crop.left} % por la izquierda y ${crop.top} % por arriba, ${crop.width} % de ancho y ${crop.height} % de alto.`,
    cropHandle: (corner) =>
      ({
        nw: "Esquina superior izquierda del recorte",
        ne: "Esquina superior derecha del recorte",
        sw: "Esquina inferior izquierda del recorte",
        se: "Esquina inferior derecha del recorte",
      })[corner],
    cropDone: "Listo",
    cleanLabel: "Limpiar fondo",
    cleanAuto: "Automático",
    cleanAutoActive: "automático",
    evenLighting: "Igualar iluminación (fotos)",
    evenLightingHint: "Corrige sombras y luz desigual de una foto.",
    removeSpecks: "Quitar motas",
    removeSpecksHint: "Borra puntitos sueltos. Apágalo si tu firma lleva puntos.",
    inkLabel: "Color de la tinta",
    inkOriginal: "Original",
    inkBlack: "Negro",
    inkBlue: "Azul",
    previewTitle: "Así quedará",
    previewChecker: "Sobre fondo transparente",
    previewLine: "Sobre una línea de firma",
    previewWorking: "Limpiando la imagen",
    previewAlt: "Firma limpia, con el fondo transparente",
    previewReady: "Vista previa actualizada.",
    kindLabel: "¿Qué es esta imagen?",
    kindSignature: "Firma",
    kindInitials: "Iniciales",
    summaryTitle: "Lo que se guardará",
    slotSignature: "Firma",
    slotInitials: "Iniciales",
    slotEmpty: "Sin imagen",
    slotAlt: (kind) => (kind === "signature" ? "Firma lista para guardar" : "Iniciales listas para guardar"),
    addInitials: "Añadir las iniciales (otra imagen)",
    addSignature: "Añadir la firma (otra imagen)",
    changeImage: "Cambiar imagen",
    removeImage: "Quitar",
    useAs: (kind) => (kind === "signature" ? "Usar como firma" : "Usar como iniciales"),
    useDraft: "Usar esta imagen",
    chooseAnother: "Elegir otra imagen",
    nameLabel: "Nombre del firmante",
    nameNeeded: "Escribe el nombre del firmante para guardarla.",
    roleLabel: "Cargo (opcional)",
    save: "Guardar en Firmas guardadas",
    saving: "Guardando",
    vaultFull:
      "Ya tienes 30 firmas guardadas, el máximo. Solo podrás guardar una del mismo firmante; borra alguna para añadir otra.",
    saved: (name, kinds) =>
      kinds === "both"
        ? `Guardadas la firma y las iniciales de ${name}.`
        : kinds === "initials"
          ? `Guardadas las iniciales de ${name}.`
          : `Guardada la firma de ${name}.`,
    savedDuplicate: (name) => `Esa imagen de ${name} ya estaba guardada.`,
    saveLimit:
      "No cabe una firma más en Firmas guardadas (máximo 30 firmas y 20 MB). Borra alguna e inténtalo de nuevo.",
    saveTooLarge: "La imagen limpia sigue siendo demasiado grande para guardarla. Prueba con un recorte más ajustado.",
    saveUnavailable:
      "Este navegador no permite guardar firmas ahora mismo (por ejemplo, en una ventana privada). No se ha guardado nada.",
    saveInvalid: "No se pudo guardar: faltan datos de la firma.",
    errors: {
      empty: "El archivo está vacío. Elige otra imagen.",
      tooLargeFile: "La imagen pesa más de 10 MB. Elige una más pequeña o hazla de nuevo con menos resolución.",
      unsupported: "Ese formato no se puede usar. Elige una imagen PNG, JPG, WEBP o SVG.",
      decode: "No se pudo leer la imagen. Puede estar dañada: prueba con otra o con otra foto.",
      heic: "Este navegador no puede abrir fotos en formato HEIC. Pide la foto en JPG o PNG (en el iPhone: Ajustes > Cámara > Formatos > Más compatible).",
      tooManyPixels: "La imagen tiene demasiados píxeles. Elige una con menos resolución.",
      invalid: "La imagen no es válida. Elige otra.",
      noInk:
        "No se encontró tinta. Comprueba que la firma se vea bien, sobre papel claro y con buena luz, o mueve «Limpiar fondo».",
      tooDark: "La imagen es demasiado oscura: hace falta tinta oscura sobre un fondo claro. Toma la foto con más luz.",
      encode: "No se pudo preparar la imagen limpia. Prueba con un recorte más pequeño.",
      generic: "No se pudo procesar la imagen. Inténtalo con otra.",
    },
  },
  assignment: assignmentEs,
  review: reviewEs,
  template: templateEs,
  vaultBackup: {
    sectionHint: "Respaldo: guarda todas tus firmas en un archivo para llevarlas a otro dispositivo o recuperarlas si pierdes datos.",
    exportButton: "Exportar todas mis firmas",
    importButton: "Importar firmas",
    exportTitle: "Exportar todas mis firmas",
    exportBody: (count) =>
      `Se creará un archivo .zip con ${count === 1 ? "tu firma guardada" : `tus ${count} firmas guardadas`}, con sus iniciales y los datos de cada firmante. Sirve de respaldo y para llevarlas a otro dispositivo.`,
    protect: "Proteger con contraseña",
    protectHint: "Recomendado: el archivo se cifra y solo se abre con ella. Si la olvidas, no se puede recuperar.",
    password: "Contraseña",
    confirmPassword: "Repite la contraseña",
    strengthLabel: "Seguridad de la contraseña",
    strengthNone: "Escribe una contraseña",
    strength: ["Muy corta (mínimo 8 caracteres)", "Floja: añade más letras, números o símbolos", "Buena", "Fuerte"],
    passwordTooShort: "La contraseña necesita al menos 8 caracteres.",
    passwordMismatch: "Las dos contraseñas no coinciden.",
    plainWarning:
      "Sin contraseña, el archivo llevará tus firmas sin cifrar: cualquiera que lo tenga podrá usarlas. Guárdalo solo en un sitio de confianza.",
    encryptionUnavailable:
      "Este navegador no puede cifrar el archivo (hace falta una conexión segura, https). Solo se puede exportar sin contraseña.",
    exportConfirm: "Exportar",
    exportWorking: "Preparando el archivo. Con contraseña puede tardar unos segundos.",
    readyTitle: (filename) => `Archivo listo: ${filename}`,
    shareButton: "Compartir o guardar en Archivos",
    downloadButton: "Descargar",
    shareCancelled: "No se guardó el archivo. Puedes intentarlo de nuevo.",
    done: (count, encrypted) =>
      `${count} ${count === 1 ? "firma exportada" : "firmas exportadas"}${encrypted ? " (cifradas con contraseña)" : " (sin cifrar)"}.`,
    doneFile: (filename) => `Archivo: ${filename}`,
    doneClose: "Listo",
    exportEmpty: "Todavía no hay firmas guardadas que exportar.",
    exportUnavailable: "Este navegador no permite leer las firmas guardadas ahora mismo.",
    exportTooLarge: "Las firmas ocupan demasiado para un solo archivo.",
    exportFailed: "No se pudo crear el archivo. Inténtalo de nuevo.",
    importTitle: "Importar firmas",
    importIntro:
      "Elige un archivo de firmas de OptimusPDF (termina en .optimuspdf.zip). Antes de importar verás qué trae y decidirás qué hacer con cada firma.",
    pickZip: "Elegir archivo .zip",
    dropZip: "O suelta aquí el archivo.",
    dropZipActive: "Suelta el archivo aquí",
    reading: "Leyendo el archivo",
    passwordTitle: "Archivo con contraseña",
    passwordBody: "Este archivo está cifrado. Escribe la contraseña para abrirlo.",
    passwordLabel: "Contraseña",
    passwordOpen: "Abrir archivo",
    wrongPassword: "La contraseña no es correcta, o el archivo está dañado.",
    readErrors: {
      badFile: "Este archivo no es un paquete de firmas de OptimusPDF.",
      tooLarge: "El archivo es demasiado grande para ser un paquete de firmas.",
      unsafe: "El archivo no es seguro de abrir y se ha descartado. No se ha importado nada.",
      damaged: "El archivo está dañado o no se reconoce. No se ha importado nada.",
      newer: "Creado con una versión más nueva de OptimusPDF; actualiza la página.",
      needsPassword: "El archivo está cifrado: escribe su contraseña.",
      wrongPassword: "La contraseña no es correcta, o el archivo está dañado.",
      unavailable: "Este navegador no puede abrir archivos cifrados (hace falta una conexión segura, https).",
      noSignatures: "Este paquete no contiene firmas.",
      generic: "No se pudo abrir el archivo. Inténtalo con otro.",
    },
    previewTitle: "Revisa antes de importar",
    previewIntro: (count, encrypted) =>
      `El archivo trae ${count} ${count === 1 ? "firma" : "firmas"}${encrypted ? " (estaba cifrado)" : ""}. Elige qué hacer con cada una; no se cambia nada hasta que pulses el botón.`,
    statusNew: "Nuevo",
    statusIdentical: "Ya lo tienes (idéntico)",
    statusDifferent: "Distinto",
    statusSameDrawings: "Mismos dibujos, datos distintos",
    statusInvalid: "No se puede importar",
    invalidReasons: {
      integrity: "El archivo no coincide con su huella: está dañado.",
      tooLarge: "La imagen es demasiado grande.",
      invalidImage: "Imagen no válida: está dañada o no es un PNG normal.",
      invalidEntry: "Los datos de esta firma no son válidos.",
      duplicateId: "Está repetida en el archivo.",
    },
    contents: (hasSignature, hasInitials) =>
      hasSignature && hasInitials ? "Firma e iniciales" : hasSignature ? "Solo firma" : hasInitials ? "Solo iniciales" : "Sin imágenes",
    differentHint: (name) => `Ya tienes una firma de ${name} con otra imagen.`,
    sameDrawingsHint: (name, differs) =>
      `Ya tienes estos mismos dibujos guardados como «${name}». Lo que cambia: ${
        differs.includes("role") ? "el nombre y el cargo" : "el nombre"
      }.`,
    otherPersonHint: (name) =>
      `Ya hay otra firma guardada con el mismo identificador interno, la de «${name}». No se puede reemplazar; puedes conservar ambas u omitir esta.`,
    replaceLoses: "Si reemplazas, se pierde alguna imagen que tienes ahora (la del archivo no la trae).",
    replaceKeeps: "Se actualizan los datos del archivo. No se pierde ninguna imagen ni el cargo que ya tienes si el archivo no lo trae.",
    decisionKeepExisting: "Conservar la que ya tienes",
    decisionGroup: (name) => `Qué hacer con la firma de ${name}`,
    decisionImport: "Importar",
    decisionReplace: "Reemplazar",
    decisionKeepBoth: "Conservar ambos",
    decisionOmit: "Omitir",
    limitOk: (after, max) => `Después de importar tendrás ${after} de ${max} firmas.`,
    limitExceeded: (fits, wanted, max) =>
      `Solo ${fits === 1 ? "cabe 1" : `caben ${fits}`} de las ${wanted} elegidas en Firmas guardadas (máximo ${max} firmas y 20 MB). Omite algunas o borra otras antes de importar.`,
    importConfirm: (count) => `Importar ${count} ${count === 1 ? "firma" : "firmas"}`,
    importNothing: "No hay nada que importar",
    importing: "Importando las firmas",
    closeBusy: "Se está importando: espera a que termine antes de cerrar.",
    result: (imported, skipped, replaced) =>
      `${imported} ${imported === 1 ? "importada" : "importadas"}, ${skipped} ${skipped === 1 ? "omitida" : "omitidas"}${replaced > 0 ? ` (${replaced} ${replaced === 1 ? "reemplazada" : "reemplazadas"})` : ""}.`,
    applyFailed: {
      limit: "No cabe todo en Firmas guardadas. No se ha importado nada.",
      quota: "No hay espacio suficiente en este navegador; libera espacio o exporta y borra algo. No se ha importado nada.",
      unavailable: "Este navegador no permite guardar firmas ahora mismo. No se ha importado nada.",
      invalid: "Alguna firma del archivo no es válida. No se ha importado nada.",
      changed: "Esta firma cambió mientras decidías; revisa de nuevo. No se ha importado nada.",
    },
  },
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
    "Upload an image or take a photo of the signature on white paper, in good light: it is cropped and the background is cleaned automatically.",
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
  editedFilenameSuffix: "edited",

  certificateTitle: "Signature record",
  certificateNotice: "This is not a certified signature: it only records who signed and when.",
  certificateHashLabel: "SHA-256 hash of the signed document (without this page)",
  certificateTimestampLabel: "Date and time",
  certificateSignersLabel: "Signers",
  certificateNoSignerName: "No name",
  certificateDisclaimer:
    "This page is informal traceability only: the hash lets you check the document didn't change after signing. It is not a qualified or certified electronic signature.",
  signingRecordDownload: "Download record (.json)",

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
  stepAnnounce: (position, total, label) => `Step ${position} of ${total}: ${label}`,

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
  paletteExpand: (activeTool) => `Document tools (active: ${activeTool})`,
  paletteCollapse: "Fold tools",
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
  scannedFieldLabel: (position) => `Blank found on a scanned page, ${position}`,
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
  suggestedFieldsToggle: (count) => `Suggested fields (${count})`,
  suggestedFieldsDescription:
    "Labelled lines that look like a blank to fill in. Turn them on to type over them; nothing is added to the PDF until you type something.",
  suggestedFieldsShown: (count) =>
    count === 1 ? "Showing 1 suggested field." : `Showing ${count} suggested fields.`,
  suggestedFieldsHidden: "Suggested fields hidden.",
  scanPageFields: "Find blanks on scanned pages",
  scanningPage: "Looking for blanks on the scanned page",
  scanFound: (count, page) =>
    count === 1
      ? `Found 1 possible blank on page ${page}. Review it before signing.`
      : `Found ${count} possible blanks on page ${page}. Review them before signing.`,
  scanNone: (page) => `No blanks found on page ${page}.`,
  scanFailed: "The scanned page could not be analyzed.",
  toolEditText: "Edit text",
  editTextHint:
    "Double-click (or double-tap) a text in the PDF to change it. With a block focused: Enter edits, arrow keys move it, Delete removes it.",
  editTextCount: (count) =>
    count === 1 ? "1 text edited in this document." : `${count} texts edited in this document.`,
  editTextNote:
    "When you sign, the original text of what you edited is removed from the file, and a summary appears when you finish. In special cases (uncommon fonts, vertical or hidden text, shared content) it can't be removed: the summary tells you which one and why, and “Flatten page” in Edit PDF removes it completely.",
  editTextFlattenLink: "Open Edit PDF",
  editTextUndo: "Undo text change",
  editTextRedo: "Redo text change",
  editReportTitle: "About the edited text",
  editInDocs: (documents) => ` in ${documents} documents`,
  editTailAllRemoved: (several) =>
    several ? "the original was removed from the files" : "the original was removed from the file",
  editTailSomeRemoved: (removed, remains) =>
    `the original was removed from ${removed} and could not be removed from ${remains} (see why below)`,
  editTailNoneRemoved: (remains) =>
    remains === 1
      ? "the original could not be removed (see why below)"
      : `the original could not be removed from ${remains} (see why below)`,
  editRemainsItem: (docName, page, excerpt, reason) =>
    `${docName ? `${docName}, page` : "Page"} ${page}${excerpt ? `, “${excerpt}”` : ", a deleted text"}: the original is still under the edit. ${reason}`,
  editRemainsMore: (count) =>
    count === 1 ? "And 1 more text whose original was not removed." : `And ${count} more texts whose original was not removed.`,
  editRemainsAdvice: (flattenLabel) =>
    `To remove it completely, open the downloaded file in Edit PDF and use “${flattenLabel}”: the page becomes an image and the original text disappears.`,
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

  // Robust ceremony (F0 · U0.2): what is missing and turn progress.
  ceremonyProgressLabel: (name) => `${name}'s progress`,
  ceremonyItemDone: "done",
  ceremonyItemMissing: "missing",
  staleSignature: (name, reason) =>
    `${name}'s signature is no longer valid because ${
      reason === "text"
        ? "you changed the document text"
        : reason === "fields"
          ? "you changed the signature spots of the document"
          : "the document changed"
    }: ${name} must sign again.`,
  statusStale: "Must sign again",
  staleReasonShort: (reason) =>
    reason === "text"
      ? "the document text changed"
      : reason === "fields"
        ? "the signature spots changed"
        : "the document changed",
  ceremonyItemStale: "no longer valid",
  ceremonyMissing: (items) => `Missing: ${items.join("; ")}`,
  ceremonyGoToMissing: "Go to what's missing",
  ceremonyAllCaptured: "All set: you can now see how it looks.",

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
  privacySummary: "Your documents and signatures stay on this device: they are not uploaded to any server.",
  privacyReadFull: "Read in full",
  privacyUnderstood: "Got it",
  privacyNoticeBody:
    "OptimusPDF does not store data in the cloud or on a server. Data only exists and is handled on your own device and browser. If you want to fully remove it, just close the tab, clear your browser's browsing data, or click the 'Clear data' button. Whatever is stored in your browser is only used to fill in other documents you open in this browser, and you can clear it whenever you want. While you work with several signers, the draft saves the whole session on this device (the documents, the signers, the fields and, unless you turn it off, the signatures already made) so you can pick it up again, and if you export the configuration, the .zip file contains your documents. The draft is saved a fraction of a second after each change; if the browser is force-closed (or the tab is discarded) right after a change, the latest edit may not be saved. Everything is removed with 'Clear data' (or 'Clear local data' in Settings).",
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
  exportConfigEditsNote:
    "Text edits are not included in the configuration; they are kept in the document draft.",
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
            : store === "proDrafts"
              ? "PDF Pro drafts"
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
  blockChangeScopeFor: (block, signer) => `Change the documents of “${block}” for ${signer}`,
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
  scopeSheetTitle: (block, signer) => `${block} · ${signer}`,
  scopeSheetIntro:
    "Choose which documents this signature applies to. A document can only carry one signature per person: if you tick it here, it leaves the other one.",
  scopeDocsLabel: "Documents of this signature",
  scopeAllLabel: "All documents",
  scopeEmpty: "Tick at least one document.",
  scopeMovePreview: (doc, from) =>
    typeof from === "number" ? `${doc} will leave block ${from}.` : `${doc} will leave “${from}”.`,
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
  resume: resumeEn,
  draftPrivacy: {
    signaturesLabel: "Also save the signatures collected so they are not lost",
    signaturesHint: "Only on this device; deleted after 7 days.",
    noticeSignaturesOn:
      "Signatures already collected are also saved in the draft, only on this device, and deleted on their own after 7 days. After downloading you can delete the draft.",
    noticeSignaturesOff:
      "Signatures already collected are not saved in the draft: if you resume it, they are asked for again. Drafts already saved keep their signatures until they expire or you remove them.",
    cardSignaturesAgain: "Signatures: they will be asked for again",
    deleteLabel: "Delete the draft of this signing",
    deleteLabelWithSignatures: "Delete the draft of this signing (includes the signatures saved in it)",
    deleteHintKept: "If you leave it unticked, it is kept with its signatures for up to 7 days.",
    deleteDone: "Draft deleted from this device.",
    deleteFailed: "The draft could not be deleted. You can remove it from “View drafts”.",
    deleteSoon: "The draft will be deleted in a few seconds. If the file does not arrive, tap Undo.",
    deleteUndo: "Undo",
    deleteUndone: "Done: the draft is kept.",
    deleteKept: "The draft is kept.",
    deleteKeptExpires: "The draft is kept (it deletes itself after 7 days).",
    clearStrokesButton: "Remove the signatures from saved drafts now",
    clearStrokesTitle: "Remove the signatures from saved drafts?",
    clearStrokesBody:
      "Drafts saved on this device will keep everything (documents, signers, placeholders and fields) except the signatures and initials: when you resume them they are asked for again. This cannot be undone.",
    clearStrokesConfirm: "Remove signatures",
    clearStrokesDone: "Done: no signature is left in the saved drafts.",
    clearStrokesNone: "There are no signatures saved in drafts.",
    clearStrokesFailed: "The signatures could not be removed from the drafts. Please try again.",
  },
  esign: {
    label: "E-sign · Request signature by email",
    soon: "Soon",
    unavailable: "Coming soon",
  },  inkImport: {
    entryButton: "Upload a signature or initials",
    title: "Upload a signature or initials",
    composeTitle: "Upload an image",
    tip: "Take a photo of the signature on white paper, in good light.",
    privacy:
      "The original image is not saved and never leaves your device: only the cleaned-up signature, with a transparent background, is kept.",
    pickFile: "Choose image",
    takePhoto: "Take a photo",
    dropHint: "You can also drag an image here or paste one from the clipboard.",
    dropActive: "Drop the image here",
    formats: "PNG, JPG, WEBP or SVG, up to 10 MB.",
    reading: "Reading the image",
    adjustTitle: "Adjust the image",
    originalAlt: "Original image with the crop area",
    cropTitle: "Crop",
    cropAutoHint: "By default it crops itself, right around the ink.",
    cropManual: "Crop by hand",
    cropReset: "Back to automatic crop",
    cropHelp:
      "Drag the corners to frame just the signature. With the keyboard, use the arrow keys (hold Shift for bigger steps).",
    cropAreaLabel: "Crop area over the original image",
    cropValue: (crop) =>
      `Crop: ${crop.left}% from the left and ${crop.top}% from the top, ${crop.width}% wide and ${crop.height}% tall.`,
    cropHandle: (corner) =>
      ({
        nw: "Top-left corner of the crop",
        ne: "Top-right corner of the crop",
        sw: "Bottom-left corner of the crop",
        se: "Bottom-right corner of the crop",
      })[corner],
    cropDone: "Done",
    cleanLabel: "Clean background",
    cleanAuto: "Automatic",
    cleanAutoActive: "automatic",
    evenLighting: "Even out the lighting (photos)",
    evenLightingHint: "Fixes shadows and uneven light in a photo.",
    removeSpecks: "Remove specks",
    removeSpecksHint: "Erases stray dots. Turn it off if your signature has dots.",
    inkLabel: "Ink color",
    inkOriginal: "Original",
    inkBlack: "Black",
    inkBlue: "Blue",
    previewTitle: "How it will look",
    previewChecker: "On a transparent background",
    previewLine: "On a signature line",
    previewWorking: "Cleaning the image",
    previewAlt: "Cleaned signature with a transparent background",
    previewReady: "Preview updated.",
    kindLabel: "What is this image?",
    kindSignature: "Signature",
    kindInitials: "Initials",
    summaryTitle: "What will be saved",
    slotSignature: "Signature",
    slotInitials: "Initials",
    slotEmpty: "No image",
    slotAlt: (kind) => (kind === "signature" ? "Signature ready to save" : "Initials ready to save"),
    addInitials: "Add the initials (another image)",
    addSignature: "Add the signature (another image)",
    changeImage: "Change image",
    removeImage: "Remove",
    useAs: (kind) => (kind === "signature" ? "Use as signature" : "Use as initials"),
    useDraft: "Use this image",
    chooseAnother: "Choose another image",
    nameLabel: "Signer name",
    nameNeeded: "Enter the signer's name to save it.",
    roleLabel: "Role (optional)",
    save: "Save to Saved signatures",
    saving: "Saving",
    vaultFull:
      "You already have 30 saved signatures, the maximum. You can only save one for an existing signer; delete one to add another.",
    saved: (name, kinds) =>
      kinds === "both"
        ? `Saved the signature and initials of ${name}.`
        : kinds === "initials"
          ? `Saved the initials of ${name}.`
          : `Saved the signature of ${name}.`,
    savedDuplicate: (name) => `That image of ${name} was already saved.`,
    saveLimit:
      "There is no room for another signature in Saved signatures (maximum 30 signatures and 20 MB). Delete one and try again.",
    saveTooLarge: "The cleaned image is still too large to save. Try a tighter crop.",
    saveUnavailable:
      "This browser does not allow saving signatures right now (for example, in a private window). Nothing was saved.",
    saveInvalid: "Could not save: some signature data is missing.",
    errors: {
      empty: "The file is empty. Choose another image.",
      tooLargeFile: "The image is larger than 10 MB. Choose a smaller one or retake it at a lower resolution.",
      unsupported: "That format cannot be used. Choose a PNG, JPG, WEBP or SVG image.",
      decode: "The image could not be read. It may be damaged: try another one or take a new photo.",
      heic: "This browser cannot open HEIC photos. Ask for the photo as JPG or PNG (on iPhone: Settings > Camera > Formats > Most Compatible).",
      tooManyPixels: "The image has too many pixels. Choose one with a lower resolution.",
      invalid: "The image is not valid. Choose another one.",
      noInk:
        "No ink was found. Check that the signature is clearly visible on light paper in good light, or move “Clean background”.",
      tooDark: "The image is too dark: dark ink on a light background is needed. Take the photo with more light.",
      encode: "The cleaned image could not be prepared. Try a smaller crop.",
      generic: "The image could not be processed. Try another one.",
    },
  },
  assignment: assignmentEn,
  review: reviewEn,
  template: templateEn,
  vaultBackup: {
    sectionHint: "Backup: save all your signatures in one file to move them to another device or recover them if you lose data.",
    exportButton: "Export all my signatures",
    importButton: "Import signatures",
    exportTitle: "Export all my signatures",
    exportBody: (count) =>
      `A .zip file will be created with ${count === 1 ? "your saved signature" : `your ${count} saved signatures`}, their initials and each signer's details. Use it as a backup or to move them to another device.`,
    protect: "Protect with a password",
    protectHint: "Recommended: the file is encrypted and only opens with it. If you forget it, it cannot be recovered.",
    password: "Password",
    confirmPassword: "Repeat the password",
    strengthLabel: "Password strength",
    strengthNone: "Enter a password",
    strength: ["Too short (minimum 8 characters)", "Weak: add more letters, numbers or symbols", "Good", "Strong"],
    passwordTooShort: "The password needs at least 8 characters.",
    passwordMismatch: "The two passwords do not match.",
    plainWarning:
      "Without a password, the file will hold your signatures unencrypted: anyone who has it can use them. Keep it only somewhere you trust.",
    encryptionUnavailable:
      "This browser cannot encrypt the file (a secure connection, https, is required). It can only be exported without a password.",
    exportConfirm: "Export",
    exportWorking: "Preparing the file. With a password it can take a few seconds.",
    readyTitle: (filename) => `File ready: ${filename}`,
    shareButton: "Share or save to Files",
    downloadButton: "Download",
    shareCancelled: "The file was not saved. You can try again.",
    done: (count, encrypted) =>
      `${count} ${count === 1 ? "signature exported" : "signatures exported"}${encrypted ? " (encrypted with a password)" : " (unencrypted)"}.`,
    doneFile: (filename) => `File: ${filename}`,
    doneClose: "Done",
    exportEmpty: "There are no saved signatures to export yet.",
    exportUnavailable: "This browser does not allow reading the saved signatures right now.",
    exportTooLarge: "The signatures are too big for a single file.",
    exportFailed: "The file could not be created. Please try again.",
    importTitle: "Import signatures",
    importIntro:
      "Choose an OptimusPDF signatures file (it ends in .optimuspdf.zip). Before importing you will see what it holds and decide what to do with each signature.",
    pickZip: "Choose .zip file",
    dropZip: "Or drop the file here.",
    dropZipActive: "Drop the file here",
    reading: "Reading the file",
    passwordTitle: "Password-protected file",
    passwordBody: "This file is encrypted. Enter the password to open it.",
    passwordLabel: "Password",
    passwordOpen: "Open file",
    wrongPassword: "The password is incorrect, or the file is damaged.",
    readErrors: {
      badFile: "This file is not an OptimusPDF signatures package.",
      tooLarge: "The file is too large to be a signatures package.",
      unsafe: "The file is not safe to open and was discarded. Nothing was imported.",
      damaged: "The file is damaged or not recognized. Nothing was imported.",
      newer: "Created with a newer version of OptimusPDF; update the page.",
      needsPassword: "The file is encrypted: enter its password.",
      wrongPassword: "The password is incorrect, or the file is damaged.",
      unavailable: "This browser cannot open encrypted files (a secure connection, https, is required).",
      noSignatures: "This package does not contain any signatures.",
      generic: "The file could not be opened. Try another one.",
    },
    previewTitle: "Review before importing",
    previewIntro: (count, encrypted) =>
      `The file holds ${count} ${count === 1 ? "signature" : "signatures"}${encrypted ? " (it was encrypted)" : ""}. Choose what to do with each one; nothing changes until you press the button.`,
    statusNew: "New",
    statusIdentical: "You already have it (identical)",
    statusDifferent: "Different",
    statusSameDrawings: "Same drawings, different details",
    statusInvalid: "Cannot be imported",
    invalidReasons: {
      integrity: "The file does not match its fingerprint: it is damaged.",
      tooLarge: "The image is too large.",
      invalidImage: "Invalid image: it is damaged or not a regular PNG.",
      invalidEntry: "The data of this signature is not valid.",
      duplicateId: "It is repeated in the file.",
    },
    contents: (hasSignature, hasInitials) =>
      hasSignature && hasInitials ? "Signature and initials" : hasSignature ? "Signature only" : hasInitials ? "Initials only" : "No images",
    differentHint: (name) => `You already have a signature for ${name} with a different image.`,
    sameDrawingsHint: (name, differs) =>
      `You already have these same drawings saved as “${name}”. What differs: ${
        differs.includes("role") ? "the name and the role" : "the name"
      }.`,
    otherPersonHint: (name) =>
      `Another saved signature, the one for “${name}”, already uses the same internal identifier. It cannot be replaced; you can keep both or skip this one.`,
    replaceLoses: "If you replace it, an image you have now is lost (the one in the file does not include it).",
    replaceKeeps: "The details from the file are updated. No image is lost, and neither is the role you have now if the file does not include one.",
    decisionKeepExisting: "Keep the one you have",
    decisionGroup: (name) => `What to do with the signature of ${name}`,
    decisionImport: "Import",
    decisionReplace: "Replace",
    decisionKeepBoth: "Keep both",
    decisionOmit: "Skip",
    limitOk: (after, max) => `After importing you will have ${after} of ${max} signatures.`,
    limitExceeded: (fits, wanted, max) =>
      `Only ${fits} of the ${wanted} chosen ${fits === 1 ? "fits" : "fit"} in Saved signatures (maximum ${max} signatures and 20 MB). Skip some or delete others before importing.`,
    importConfirm: (count) => `Import ${count} ${count === 1 ? "signature" : "signatures"}`,
    importNothing: "Nothing to import",
    importing: "Importing the signatures",
    closeBusy: "An import is in progress: wait for it to finish before closing.",
    result: (imported, skipped, replaced) =>
      `${imported} imported, ${skipped} skipped${replaced > 0 ? ` (${replaced} replaced)` : ""}.`,
    applyFailed: {
      limit: "Not everything fits in Saved signatures. Nothing was imported.",
      quota: "There isn't enough space in this browser; free some up, or export and delete something. Nothing was imported.",
      unavailable: "This browser does not allow saving signatures right now. Nothing was imported.",
      invalid: "Some signature in the file is not valid. Nothing was imported.",
      changed: "This signature changed while you were deciding; review it again. Nothing was imported.",
    },
  },
};

export const SIGN_STRINGS: Record<Language, SignStrings> = { es, en };
