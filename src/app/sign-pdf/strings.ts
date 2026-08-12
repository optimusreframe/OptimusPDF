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
  placeTitle: string;
  placeHint: string;
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
  stepFields: string;
  stepText: string;
  stepSign: string;
  back: string;
  next: string;

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

  /* --- Campos --- */
  fieldsTitle: string;
  fieldsHint: string;
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
  fieldsOnPage: (count: number) => string;
  totalFields: (count: number) => string;
  clearPageFields: string;
  clearAllFields: string;
  confirmClearAllFieldsTitle: string;
  confirmClearAllFieldsBody: string;
  noFields: string;
  thumbsTitle: string;
  goToPage: (page: number) => string;
  needSigner: string;

  /* --- Campos de texto (deteccion + relleno) --- */
  textFieldsTitle: string;
  textFieldsHint: string;
  detectingFields: string;
  detectionFailedHint: string;
  detectedFieldsSummary: (count: number) => string;
  addTextFieldHere: string;
  /** Vuelve el lienzo a 1x tras un pellizco (Ajustes > Zoom con pellizco). */
  resetZoomButton: string;
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
  textFieldsOnPage: (count: number) => string;
  totalTextFields: (count: number) => string;
  clearPageTextFields: string;
  clearAllTextFields: string;
  confirmClearAllTextFieldsTitle: string;
  confirmClearAllTextFieldsBody: string;
  noTextFields: string;
  lowConfidenceHint: string;
  /** "12 de 31 campos rellenados" -- resumen de avance del panel de saltos. */
  fieldsFilledSummary: (filled: number, total: number) => string;
  /** Aviso NO bloqueante antes de firmar/descargar si quedan campos vacios. */
  pendingTextFieldsWarning: (missing: number) => string;
  /** Anuncio del snackbar tras borrar un campo con "Deshacer" activo. */
  textFieldDeletedNotice: string;
  undoRemoveTextField: string;
  pageGroupLabel: (page: number) => string;
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

  /* --- Exportar/importar configuracion --- */
  exportConfigButton: string;
  importConfigButton: string;

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
  applyTemplateNothingFits: string;
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
    "Un PNG con fondo transparente da el mejor resultado. También se admite JPG.",
  inkLabel: "Color de la tinta",
  strokeLabel: "Grosor del trazo",
  rotateHint: "Gira el teléfono para firmar con más espacio.",
  save: "Usar esta firma",
  emptyWarning: "Todavía no hay nada que guardar.",
  placeTitle: "Coloca la firma",
  placeHint:
    "Arrastra la firma hasta su sitio y usa el tirador de la esquina para cambiar su tamaño.",
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
    "Creas tu firma, la colocas donde quieras y descargas. Es el camino rápido.",
  modeMulti: "Varios firmantes",
  modeMultiHint:
    "Reserva un hueco para cada persona y firmad por turnos en este mismo dispositivo, pasándooslo de mano en mano.",

  stepSigners: "Firmantes",
  stepFields: "Campos",
  stepText: "Texto",
  stepSign: "Firmar",
  back: "Atrás",
  next: "Continuar",

  signersTitle: "¿Quién tiene que firmar?",
  signersHint:
    "Añade a cada persona. El color sirve para reconocer sus huecos sobre el documento.",
  addSigner: "Añadir firmante",
  signerNameLabel: (position) => `Nombre del firmante ${position}`,
  defaultSignerName: (position) => `Firmante ${position}`,
  removeSigner: (name) => `Quitar a ${name}`,
  signerLimit: "Ya no caben más firmantes distinguibles por color.",
  noSigners: "Añade al menos un firmante para continuar.",
  signerFieldCount: (count) =>
    count === 1 ? "1 hueco" : `${count} huecos`,
  activeSignerLabel: "Firmante activo",
  activeSignerHint:
    "Los huecos nuevos se asignan al firmante activo. Cámbialo antes de marcar los suyos.",
  signerDeletedNotice: "Firmante eliminado, junto con sus huecos y su firma.",
  undoRemoveSigner: "Deshacer",

  fieldsTitle: "Reserva los huecos",
  fieldsHint:
    "Arrastra sobre la página para dibujar un hueco, o toca para colocar uno del tamaño habitual. Muévelos y ajústalos como quieras.",
  fieldTypeLabel: "Tipo de hueco",
  fieldSignature: "Firma",
  fieldInitials: "Iniciales",
  addFieldHere: "Añadir hueco en esta página",
  fieldOwnerLabel: (name, type) => `${name} — ${type}`,
  removeField: "Quitar el hueco",
  fieldDeletedNotice: "Hueco eliminado.",
  undoRemoveField: "Deshacer",
  resizeField: "Cambiar el tamaño del hueco",
  fieldsOnPage: (count) =>
    count === 1 ? "1 hueco en esta página" : `${count} huecos en esta página`,
  totalFields: (count) =>
    count === 1 ? "1 hueco en total" : `${count} huecos en total`,
  clearPageFields: "Quitar los huecos de esta página",
  clearAllFields: "Borrar todos los huecos del documento",
  confirmClearAllFieldsTitle: "¿Borrar todos los huecos?",
  confirmClearAllFieldsBody:
    "Se van a quitar todos los huecos de firma/iniciales reservados en el documento, en todas las páginas. Esta acción no se puede deshacer.",
  noFields: "Reserva al menos un hueco para poder firmar.",
  thumbsTitle: "Páginas",
  goToPage: (page) => `Ir a la página ${page}`,
  needSigner: "Elige antes a quién pertenece el hueco.",

  textFieldsTitle: "Rellena el documento",
  textFieldsHint:
    "Toca un campo sobre la página para escribir ahí mismo. Arrastra sobre la página para añadir uno nuevo donde falte; el resumen de abajo sirve para saltar directo a cualquier campo.",
  detectingFields: "Buscando campos rellenables en el documento",
  detectionFailedHint:
    "No se pudieron detectar campos automáticamente, pero puedes añadirlos a mano arrastrando sobre la página.",
  detectedFieldsSummary: (count) =>
    count === 1
      ? "Se detectó 1 campo. Revísalo antes de firmar."
      : `Se detectaron ${count} campos. Revísalos antes de firmar.`,
  addTextFieldHere: "Añadir campo en esta página",
  resetZoomButton: "Restablecer zoom",
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
  textFieldsOnPage: (count) =>
    count === 1 ? "1 campo en esta página" : `${count} campos en esta página`,
  totalTextFields: (count) =>
    count === 1 ? "1 campo en total" : `${count} campos en total`,
  clearPageTextFields: "Quitar los campos de esta página",
  clearAllTextFields: "Borrar todos los campos del documento",
  confirmClearAllTextFieldsTitle: "¿Borrar todos los campos?",
  confirmClearAllTextFieldsBody:
    "Se van a quitar todos los campos de texto detectados o añadidos a mano, en todas las páginas, junto con lo que hayas escrito en ellos. Esta acción no se puede deshacer.",
  noTextFields:
    "Todavía no hay ningún campo de texto. Es opcional: puedes seguir sin rellenar nada.",
  lowConfidenceHint:
    "Contorno discontinuo = detección experimental sobre una imagen escaneada. Revísala antes de firmar; si no es un campo real, bórrala.",
  fieldsFilledSummary: (filled, total) =>
    `${filled} de ${total} campo${total === 1 ? "" : "s"} rellenado${total === 1 ? "" : "s"}`,
  pendingTextFieldsWarning: (missing) =>
    `Queda${missing === 1 ? "" : "n"} ${missing} campo${missing === 1 ? "" : "s"} de texto sin rellenar. Puedes continuar igual.`,
  textFieldDeletedNotice: "Campo eliminado.",
  undoRemoveTextField: "Deshacer",
  pageGroupLabel: (page) => `Página ${page}`,
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
    "OptimusPDF no guarda datos en la nube ni en un servidor. Los datos únicamente existen y se manejan en su dispositivo y tu navegador. Si deseas eliminar completamente los datos, solo cierra la pestaña, borra los datos de navegación de tu navegador o haz clic en el botón 'Borrar datos'. Los datos que se guardan en tu navegador solo sirven para usarlos en otros documentos que abras en tu navegador, puedes borrarlos cuando lo desees.",
  privacyClearData: "Borrar datos",
  privacyClearDataTitle: "¿Borrar los datos guardados?",
  privacyClearDataBody:
    "Se van a borrar todos los valores de campos que se recordaron para sugerirlos en otros documentos (nombres, direcciones, números y demás texto que hayas escrito), además de las plantillas de disposición guardadas. Esta acción no se puede deshacer.",
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

  exportConfigButton: "Exportar configuración",
  importConfigButton: "Importar configuración",

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
    `Aplicada. ${dropped} campo${dropped === 1 ? "" : "s"} de la plantilla no encajaba${dropped === 1 ? "" : "n"} en este documento (menos páginas) y se descartó${dropped === 1 ? "" : "aron"}.`,
  applyTemplateNothingFits:
    "Esta plantilla no encaja en este documento: todos sus campos caen en páginas que este documento no tiene.",
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
  placeTitle: "Place the signature",
  placeHint:
    "Drag the signature where you want it and use the corner handle to resize.",
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
    "Create your signature, place it wherever you want and download. The quick path.",
  modeMulti: "Several signers",
  modeMultiHint:
    "Reserve a slot for each person and sign in turns on this same device, passing it around.",

  stepSigners: "Signers",
  stepFields: "Slots",
  stepText: "Text",
  stepSign: "Sign",
  back: "Back",
  next: "Continue",

  signersTitle: "Who has to sign?",
  signersHint:
    "Add every person. The colour is what tells their slots apart on the document.",
  addSigner: "Add signer",
  signerNameLabel: (position) => `Name of signer ${position}`,
  defaultSignerName: (position) => `Signer ${position}`,
  removeSigner: (name) => `Remove ${name}`,
  signerLimit: "No more signers can be told apart by colour.",
  noSigners: "Add at least one signer to continue.",
  signerFieldCount: (count) => (count === 1 ? "1 slot" : `${count} slots`),
  activeSignerLabel: "Active signer",
  activeSignerHint:
    "New slots go to the active signer. Switch first, then mark their slots.",
  signerDeletedNotice: "Signer deleted, along with their slots and signature.",
  undoRemoveSigner: "Undo",

  fieldsTitle: "Reserve the slots",
  fieldsHint:
    "Drag on the page to draw a slot, or tap to drop one at the usual size. Move and resize them freely.",
  fieldTypeLabel: "Slot type",
  fieldSignature: "Signature",
  fieldInitials: "Initials",
  addFieldHere: "Add a slot on this page",
  fieldOwnerLabel: (name, type) => `${name} — ${type}`,
  removeField: "Remove the slot",
  fieldDeletedNotice: "Slot deleted.",
  undoRemoveField: "Undo",
  resizeField: "Resize the slot",
  fieldsOnPage: (count) =>
    count === 1 ? "1 slot on this page" : `${count} slots on this page`,
  totalFields: (count) =>
    count === 1 ? "1 slot in total" : `${count} slots in total`,
  clearPageFields: "Remove slots on this page",
  clearAllFields: "Delete all slots in this document",
  confirmClearAllFieldsTitle: "Delete all slots?",
  confirmClearAllFieldsBody:
    "This removes every signature/initials slot reserved in the document, on every page. This cannot be undone.",
  noFields: "Reserve at least one slot so there is something to sign.",
  thumbsTitle: "Pages",
  goToPage: (page) => `Go to page ${page}`,
  needSigner: "Pick who the slot belongs to first.",

  textFieldsTitle: "Fill in the document",
  textFieldsHint:
    "Tap a field on the page to type right there. Drag on the page to add a new one wherever one is missing; the summary below jumps straight to any field.",
  detectingFields: "Looking for fillable fields in the document",
  detectionFailedHint:
    "Fields couldn't be detected automatically, but you can still add them by hand by dragging on the page.",
  detectedFieldsSummary: (count) =>
    count === 1
      ? "1 field was detected. Review it before signing."
      : `${count} fields were detected. Review them before signing.`,
  addTextFieldHere: "Add a field on this page",
  resetZoomButton: "Reset zoom",
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
  textFieldsOnPage: (count) =>
    count === 1 ? "1 field on this page" : `${count} fields on this page`,
  totalTextFields: (count) =>
    count === 1 ? "1 field in total" : `${count} fields in total`,
  clearPageTextFields: "Remove fields on this page",
  clearAllTextFields: "Delete all fields in this document",
  confirmClearAllTextFieldsTitle: "Delete all fields?",
  confirmClearAllTextFieldsBody:
    "This removes every text field, detected or added by hand, on every page, along with whatever you typed into them. This cannot be undone.",
  noTextFields:
    "There are no text fields yet. This is optional: you can continue without filling anything in.",
  lowConfidenceHint:
    "Dashed outline = experimental detection on a scanned image. Review it before signing; delete it if it isn't a real field.",
  fieldsFilledSummary: (filled, total) =>
    `${filled} of ${total} field${total === 1 ? "" : "s"} filled in`,
  pendingTextFieldsWarning: (missing) =>
    `${missing} text field${missing === 1 ? "" : "s"} still empty. You can continue anyway.`,
  textFieldDeletedNotice: "Field deleted.",
  undoRemoveTextField: "Undo",
  pageGroupLabel: (page) => `Page ${page}`,
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
    "OptimusPDF does not store data in the cloud or on a server. Data only exists and is handled on your own device and browser. If you want to fully remove it, just close the tab, clear your browser's browsing data, or click the 'Clear data' button. Whatever is stored in your browser is only used to fill in other documents you open in this browser, and you can clear it whenever you want.",
  privacyClearData: "Clear data",
  privacyClearDataTitle: "Clear the stored data?",
  privacyClearDataBody:
    "This deletes every field value remembered to suggest it in other documents (names, addresses, numbers and any other text you typed), plus any saved layout templates. This cannot be undone.",
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

  exportConfigButton: "Export configuration",
  importConfigButton: "Import configuration",

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
    `Applied. ${dropped} field${dropped === 1 ? "" : "s"} from the template didn't fit this document (fewer pages) and ${dropped === 1 ? "was" : "were"} dropped.`,
  applyTemplateNothingFits:
    "This template doesn't fit this document: all of its fields fall on pages this document doesn't have.",
};

export const SIGN_STRINGS: Record<Language, SignStrings> = { es, en };
