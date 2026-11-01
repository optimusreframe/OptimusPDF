import type { ExtractWarningCode } from "@/lib/autofill/types";

/**
 * Textos del autorrelleno desde documentos («Rellenar con datos del cliente») en español e inglés. Viven aparte de
 * `strings.ts` de Firmar (3 000 lineas) como los de las plantillas (`templateStrings.ts`): el lenguaje es claro y sin
 * jerga («leer», «datos del cliente», «perfil»), y las advertencias dicen que hacer, no un codigo.
 */

export type AutofillStrings = {
  /* --- Boton y estado --- */
  button: string;
  buttonHint: string;
  filled: (count: number, from: string | null) => string;
  undo: string;
  undone: string;
  /* --- Hoja --- */
  title: string;
  close: string;
  back: string;
  /* --- Elegir fuentes --- */
  chooseIntro: string;
  privacyLine: string;
  sourcesLegend: string;
  upload: string;
  camera: string;
  scanned: string;
  scanLink: string;
  paste: string;
  pasteLabel: string;
  pasteHint: string;
  pasteAdd: string;
  pasteCancel: string;
  pastedName: (n: number) => string;
  chosenTitle: (count: number) => string;
  remove: (name: string) => string;
  originName: { file: string; camera: string; scan: string; paste: string };
  kindPdf: string;
  kindImage: string;
  kindText: string;
  read: string;
  noSources: string;
  rejectedType: (name: string) => string;
  rejectedSize: (name: string, mb: number) => string;
  rejectedCount: (max: number) => string;
  sourcesAdded: (count: number) => string;
  /* --- Leyendo --- */
  reading: string;
  readingLabel: string;
  readingNote: string;
  cancel: string;
  cancelled: string;
  readFailed: string;
  tryAgain: string;
  /* --- Modelo de lectura (OCR): se descarga SOLO si la persona lo pide --- */
  modelTitle: string;
  modelBody: string;
  modelNote: string;
  modelDownload: string;
  modelRetryDownload: string;
  modelSkipPhotos: string;
  modelDownloading: string;
  modelDownloadingNote: string;
  modelFailed: (reason: "offline" | "network" | "engine") => string;
  modelRetry: string;
  skippedPhotos: (count: number) => string;
  /* --- Avisos del motor --- */
  warning: (code: ExtractWarningCode, source: string | null) => string;
  /* --- Revisar --- */
  reviewTitle: string;
  reviewIntro: string;
  foundCount: (values: number, groups: number) => string;
  nothingFound: string;
  nothingFoundHint: string;
  groupConflict: string;
  noneOption: string;
  confidenceHigh: string;
  confidenceReview: string;
  confidenceLabel: string;
  valueLabel: (key: string) => string;
  useValue: (key: string, value: string) => string;
  pickOne: (key: string) => string;
  evidence: (page: number, snippet: string) => string;
  why: (reason: string) => string;
  fromProfile: (name: string) => string;
  edited: string;
  mapTitle: string;
  mapIntro: string;
  mapRow: (label: string, page: number) => string;
  mapRowNoLabel: (page: number) => string;
  mapSuggested: string;
  fillThisField: (label: string) => string;
  overwrites: (current: string) => string;
  overwritesHint: string;
  notDate: (label: string) => string;
  noFieldFor: (keys: string) => string;
  noMatches: string;
  fillButton: (count: number) => string;
  fillNothing: string;
  /* --- Guardar como perfil --- */
  saveProfile: string;
  saveProfileHint: string;
  profileName: string;
  profileNameRequired: string;
  profileSaved: (name: string, updated: boolean) => string;
  profileFull: string;
  profileFailed: string;
  profileUnavailable: string;
  /* --- Perfiles guardados --- */
  profilesButton: string;
  profilesTitle: string;
  profilesEmpty: string;
  profilesPrivacy: string;
  profileValues: (count: number) => string;
  profileUseShort: string;
  profileUse: (name: string) => string;
  profileEdit: (name: string) => string;
  profileDelete: (name: string) => string;
  profileDeleteTitle: string;
  profileDeleteBody: (name: string) => string;
  profileDeleteConfirm: string;
  profileDeleted: (name: string) => string;
  profileRenameLabel: string;
  profileRename: string;
  profileRenamed: string;
  profileSaveShort: string;
  profileValueSave: (key: string) => string;
  profileValueRemove: (key: string) => string;
  profileValueSaved: string;
  profileValueRemoved: string;
  profileInvalid: string;
  profileDone: string;
};

const ES: AutofillStrings = {
  button: "Rellenar con datos del cliente",
  buttonHint: "Lee un PDF, una foto o un texto y propone qué escribir en cada campo. Tú decides qué se rellena.",
  filled: (count, from) => `${count === 1 ? "Se rellenó 1 campo" : `Se rellenaron ${count} campos`}${from ? ` con datos de ${from}` : ""}.`,
  undo: "Deshacer",
  undone: "Se deshizo el relleno.",

  title: "Rellenar con datos del cliente",
  close: "Cerrar",
  back: "Volver",

  chooseIntro: "Elige de dónde sacar los datos del cliente. Puedes combinar varias fuentes.",
  privacyLine: "Todo se lee en este dispositivo: ningún archivo ni dato se sube.",
  sourcesLegend: "Fuentes de datos",
  upload: "Subir PDF o imagen",
  camera: "Tomar foto",
  scanned: "Hoja escaneada",
  scanLink: "Escanear una hoja ahora",
  paste: "Pegar texto",
  pasteLabel: "Texto con los datos del cliente",
  pasteHint: "Por ejemplo: «Asegurado: …», «Teléfono: …». Una línea por dato.",
  pasteAdd: "Añadir texto",
  pasteCancel: "Cancelar",
  pastedName: (n) => `Texto pegado ${n}`,
  chosenTitle: (count) => (count === 1 ? "1 fuente elegida" : `${count} fuentes elegidas`),
  remove: (name) => `Quitar ${name}`,
  originName: { file: "Archivo", camera: "Foto", scan: "Hoja escaneada", paste: "Texto pegado" },
  kindPdf: "PDF",
  kindImage: "Imagen",
  kindText: "Texto",
  read: "Leer datos",
  noSources: "Añade al menos una fuente para poder leerla.",
  rejectedType: (name) => `${name}: solo se pueden leer PDF e imágenes.`,
  rejectedSize: (name, mb) => `${name}: pesa demasiado (máximo ${mb} MB).`,
  rejectedCount: (max) => `Solo puedes elegir hasta ${max} fuentes a la vez.`,
  sourcesAdded: (count) => (count === 1 ? "Se añadió 1 fuente." : `Se añadieron ${count} fuentes.`),

  reading: "Leyendo…",
  readingLabel: "Leyendo las fuentes",
  readingNote: "Las fotos y los escaneos se leen con reconocimiento de texto en este dispositivo y pueden tardar más que un PDF con texto.",
  cancel: "Cancelar",
  cancelled: "Lectura cancelada.",
  readFailed: "No se pudo leer. Inténtalo de nuevo o prueba con otra fuente.",
  tryAgain: "Volver a las fuentes",

  modelTitle: "Hace falta el modelo de lectura",
  modelBody: "Para leer fotos hace falta descargar el modelo una vez; los PDF con texto se leen sin descargar nada.",
  modelNote: "Se descarga una sola vez y se guarda en este dispositivo; después las fotos se leen sin conexión. No se sube ningún documento: solo se baja el modelo.",
  modelDownload: "Descargar el modelo y leer",
  modelRetryDownload: "Reintentar la descarga",
  modelSkipPhotos: "Leer sin las fotos",
  modelDownloading: "Descargando el modelo de lectura…",
  modelDownloadingNote: "La primera vez puede tardar un poco. Puedes cancelar.",
  modelFailed: (reason) =>
    reason === "offline"
      ? "Sin conexión: no se pudo descargar el modelo. Conéctate e inténtalo de nuevo, o lee solo lo que no son fotos."
      : reason === "network"
        ? "No se pudo descargar el modelo. Inténtalo de nuevo en un momento."
        : "Este navegador no pudo preparar el modelo de lectura.",
  modelRetry: "Descargar el modelo y volver a leer",
  skippedPhotos: (count) => (count === 1 ? "No se leyó 1 foto." : `No se leyeron ${count} fotos.`),

  warning: (code, source) => {
    const where = source ? ` en ${source}` : "";
    switch (code) {
      case "ocr-unavailable":
        return "Para leer fotos hace falta descargar el modelo una vez; los PDF con texto se leen sin descargar nada.";
      case "no-data":
        return `No encontramos datos del cliente${where}.`;
      case "page-skipped":
        return `Se saltó alguna página que no se pudo leer${where}.`;
      case "too-many-pages":
        return `${source ?? "El documento"} tiene muchas páginas: solo se leyeron las primeras.`;
      case "unreadable-source":
        return `No se pudo leer ${source ?? "una de las fuentes"}.`;
    }
  },

  reviewTitle: "Revisa los datos encontrados",
  reviewIntro: "Solo se rellena lo que dejes marcado. Puedes corregir cualquier valor antes de rellenar.",
  foundCount: (values, groups) => `Se encontró ${values === 1 ? "1 dato" : `${values} datos`} de ${groups === 1 ? "1 tipo" : `${groups} tipos`}.`,
  nothingFound: "No encontramos datos del cliente.",
  nothingFoundHint: "Prueba con otro documento, una foto más nítida y de frente, o pega el texto.",
  groupConflict: "Hay varios valores posibles: elige uno.",
  noneOption: "Ninguno",
  confidenceHigh: "Confianza alta",
  confidenceReview: "Revisar",
  confidenceLabel: "Confianza",
  valueLabel: (key) => `Valor de ${key}`,
  useValue: (key, value) => `Usar ${key}: ${value}`,
  pickOne: (key) => `Valor de ${key} que se usará`,
  evidence: (page, snippet) => `Pág. ${page}: «${snippet}»`,
  why: (reason) => `Por qué: ${reason}`,
  fromProfile: (name) => `Del perfil guardado «${name}»`,
  edited: "Corregido por ti",
  mapTitle: "Dónde se escribirá",
  mapIntro: "Cada dato va al campo del documento cuya etiqueta le corresponde. Los campos que ya tienen texto quedan sin marcar.",
  mapRow: (label, page) => `Campo «${label}» · pág. ${page}`,
  mapRowNoLabel: (page) => `Campo sin etiqueta · pág. ${page}`,
  mapSuggested: "sugerido",
  fillThisField: (label) => `Rellenar el campo ${label}`,
  overwrites: (current) => `Ya tiene escrito «${current}»: se sustituiría. Sin marcar, no se toca.`,
  overwritesHint: "Ya tiene texto",
  notDate: (label) => `El valor no tiene formato de fecha: el campo ${label} no se rellenará.`,
  noFieldFor: (keys) => `Sin campo donde ir en este documento: ${keys}.`,
  noMatches: "Ningún dato marcado corresponde a un campo de este documento.",
  fillButton: (count) => (count === 1 ? "Rellenar 1 campo" : `Rellenar ${count} campos`),
  fillNothing: "Marca algún dato para rellenar",

  saveProfile: "Guardar como perfil",
  saveProfileHint: "Guarda estos datos en este dispositivo para rellenar otros documentos del mismo cliente sin volver a leerlos.",
  profileName: "Nombre del perfil",
  profileNameRequired: "Escribe un nombre para el perfil.",
  profileSaved: (name, updated) => (updated ? `Perfil «${name}» actualizado.` : `Perfil «${name}» guardado.`),
  profileFull: "Ya tienes 20 perfiles guardados: borra uno para poder guardar otro.",
  profileFailed: "No se pudo guardar el perfil.",
  profileUnavailable: "Este navegador no permite guardar perfiles.",

  profilesButton: "Usar un perfil guardado",
  profilesTitle: "Perfiles guardados",
  profilesEmpty: "Aún no hay perfiles. Se crean al rellenar con «Guardar como perfil».",
  profilesPrivacy: "Los perfiles contienen datos de clientes y se guardan solo en este dispositivo. «Borrar datos» los elimina.",
  profileValues: (count) => (count === 1 ? "1 dato" : `${count} datos`),
  profileUseShort: "Usar",
  profileUse: (name) => `Usar el perfil ${name}`,
  profileEdit: (name) => `Editar el perfil ${name}`,
  profileDelete: (name) => `Borrar el perfil ${name}`,
  profileDeleteTitle: "¿Borrar este perfil?",
  profileDeleteBody: (name) => `Se borran todos los datos guardados de «${name}» en este dispositivo. Esta acción no se puede deshacer.`,
  profileDeleteConfirm: "Borrar perfil",
  profileDeleted: (name) => `Perfil «${name}» borrado.`,
  profileRenameLabel: "Nombre del perfil",
  profileRename: "Renombrar",
  profileRenamed: "Perfil renombrado.",
  profileSaveShort: "Guardar",
  profileValueSave: (key) => `Guardar ${key}`,
  profileValueRemove: (key) => `Quitar ${key}`,
  profileValueSaved: "Dato guardado.",
  profileValueRemoved: "Dato quitado.",
  profileInvalid: "Escribe un valor de al menos 2 caracteres.",
  profileDone: "Listo",
};

const EN: AutofillStrings = {
  button: "Fill with client data",
  buttonHint: "Reads a PDF, a photo or some text and suggests what to write in each field. You decide what gets filled.",
  filled: (count, from) => `${count === 1 ? "Filled 1 field" : `Filled ${count} fields`}${from ? ` with data from ${from}` : ""}.`,
  undo: "Undo",
  undone: "The fill was undone.",

  title: "Fill with client data",
  close: "Close",
  back: "Back",

  chooseIntro: "Choose where to take the client's data from. You can combine several sources.",
  privacyLine: "Everything is read on this device: no file or data is uploaded.",
  sourcesLegend: "Data sources",
  upload: "Upload PDF or image",
  camera: "Take photo",
  scanned: "Scanned sheet",
  scanLink: "Scan a sheet now",
  paste: "Paste text",
  pasteLabel: "Text with the client's data",
  pasteHint: "For example: \"Insured: …\", \"Phone: …\". One line per item.",
  pasteAdd: "Add text",
  pasteCancel: "Cancel",
  pastedName: (n) => `Pasted text ${n}`,
  chosenTitle: (count) => (count === 1 ? "1 source chosen" : `${count} sources chosen`),
  remove: (name) => `Remove ${name}`,
  originName: { file: "File", camera: "Photo", scan: "Scanned sheet", paste: "Pasted text" },
  kindPdf: "PDF",
  kindImage: "Image",
  kindText: "Text",
  read: "Read data",
  noSources: "Add at least one source to read it.",
  rejectedType: (name) => `${name}: only PDFs and images can be read.`,
  rejectedSize: (name, mb) => `${name}: too large (maximum ${mb} MB).`,
  rejectedCount: (max) => `You can choose up to ${max} sources at a time.`,
  sourcesAdded: (count) => (count === 1 ? "Added 1 source." : `Added ${count} sources.`),

  reading: "Reading…",
  readingLabel: "Reading the sources",
  readingNote: "Photos and scans are read with text recognition on this device and can take longer than a PDF with text.",
  cancel: "Cancel",
  cancelled: "Reading cancelled.",
  readFailed: "Could not read. Try again or try another source.",
  tryAgain: "Back to the sources",

  modelTitle: "The reading model is needed",
  modelBody: "Reading photos needs a one-time download of the model; PDFs with text are read without downloading anything.",
  modelNote: "It is downloaded once and kept on this device; after that, photos are read offline. No document is uploaded: only the model comes down.",
  modelDownload: "Download the model and read",
  modelRetryDownload: "Retry the download",
  modelSkipPhotos: "Read without the photos",
  modelDownloading: "Downloading the reading model…",
  modelDownloadingNote: "The first time it can take a while. You can cancel.",
  modelFailed: (reason) =>
    reason === "offline"
      ? "No connection: the model could not be downloaded. Connect and try again, or read only what is not a photo."
      : reason === "network"
        ? "The model could not be downloaded. Try again in a moment."
        : "This browser could not prepare the reading model.",
  modelRetry: "Download the model and read again",
  skippedPhotos: (count) => (count === 1 ? "1 photo was not read." : `${count} photos were not read.`),

  warning: (code, source) => {
    const where = source ? ` in ${source}` : "";
    switch (code) {
      case "ocr-unavailable":
        return "Reading photos needs a one-time download of the model; PDFs with text are read without downloading anything.";
      case "no-data":
        return `We found no client data${where}.`;
      case "page-skipped":
        return `A page that could not be read was skipped${where}.`;
      case "too-many-pages":
        return `${source ?? "The document"} has many pages: only the first ones were read.`;
      case "unreadable-source":
        return `Could not read ${source ?? "one of the sources"}.`;
    }
  },

  reviewTitle: "Review the data found",
  reviewIntro: "Only what you leave ticked is filled. You can correct any value before filling.",
  foundCount: (values, groups) => `Found ${values === 1 ? "1 item" : `${values} items`} of ${groups === 1 ? "1 kind" : `${groups} kinds`}.`,
  nothingFound: "We found no client data.",
  nothingFoundHint: "Try another document, a sharper photo taken straight on, or paste the text.",
  groupConflict: "There are several possible values: choose one.",
  noneOption: "None",
  confidenceHigh: "High confidence",
  confidenceReview: "Check it",
  confidenceLabel: "Confidence",
  valueLabel: (key) => `Value for ${key}`,
  useValue: (key, value) => `Use ${key}: ${value}`,
  pickOne: (key) => `Value of ${key} to use`,
  evidence: (page, snippet) => `Page ${page}: “${snippet}”`,
  why: (reason) => `Why: ${reason}`,
  fromProfile: (name) => `From the saved profile “${name}”`,
  edited: "Corrected by you",
  mapTitle: "Where it will be written",
  mapIntro: "Each item goes to the document field whose label matches it. Fields that already have text are left unticked.",
  mapRow: (label, page) => `Field “${label}” · page ${page}`,
  mapRowNoLabel: (page) => `Field without a label · page ${page}`,
  mapSuggested: "suggested",
  fillThisField: (label) => `Fill the field ${label}`,
  overwrites: (current) => `It already says “${current}”: it would be replaced. Unticked, it is left alone.`,
  overwritesHint: "Already has text",
  notDate: (label) => `The value is not in date format: the field ${label} will not be filled.`,
  noFieldFor: (keys) => `No field for these in this document: ${keys}.`,
  noMatches: "None of the ticked items matches a field in this document.",
  fillButton: (count) => (count === 1 ? "Fill 1 field" : `Fill ${count} fields`),
  fillNothing: "Tick some data to fill",

  saveProfile: "Save as profile",
  saveProfileHint: "Keeps this data on this device so you can fill other documents of the same client without reading them again.",
  profileName: "Profile name",
  profileNameRequired: "Type a name for the profile.",
  profileSaved: (name, updated) => (updated ? `Profile “${name}” updated.` : `Profile “${name}” saved.`),
  profileFull: "You already have 20 saved profiles: delete one to save another.",
  profileFailed: "The profile could not be saved.",
  profileUnavailable: "This browser does not allow saving profiles.",

  profilesButton: "Use a saved profile",
  profilesTitle: "Saved profiles",
  profilesEmpty: "There are no profiles yet. They are created when you fill with “Save as profile”.",
  profilesPrivacy: "Profiles contain client data and are kept only on this device. “Clear data” removes them.",
  profileValues: (count) => (count === 1 ? "1 item" : `${count} items`),
  profileUseShort: "Use",
  profileUse: (name) => `Use the profile ${name}`,
  profileEdit: (name) => `Edit the profile ${name}`,
  profileDelete: (name) => `Delete the profile ${name}`,
  profileDeleteTitle: "Delete this profile?",
  profileDeleteBody: (name) => `All the data saved for “${name}” on this device will be deleted. This cannot be undone.`,
  profileDeleteConfirm: "Delete profile",
  profileDeleted: (name) => `Profile “${name}” deleted.`,
  profileRenameLabel: "Profile name",
  profileRename: "Rename",
  profileRenamed: "Profile renamed.",
  profileSaveShort: "Save",
  profileValueSave: (key) => `Save ${key}`,
  profileValueRemove: (key) => `Remove ${key}`,
  profileValueSaved: "Item saved.",
  profileValueRemoved: "Item removed.",
  profileInvalid: "Type a value of at least 2 characters.",
  profileDone: "Done",
};

export const AUTOFILL_STRINGS: Record<"es" | "en", AutofillStrings> = { es: ES, en: EN };
