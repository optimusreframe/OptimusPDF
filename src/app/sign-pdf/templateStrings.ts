import type { SaveFailure } from "@/app/sign-pdf/templateLibrary";

/*
 * Textos (ES/EN) de las plantillas de documento de Firmar (Fase 2 · U2.3 y U2.4): el modo «Configurar plantilla», los avisos de
 * la aplicacion automatica y las entradas en la herramienta. Un bloque propio (`strings.template`) para no mezclarse con el
 * resto del copy de Firmar.
 */

export type NoticeStrings = {
  detecting: string;
  appliedTitle: (name: string) => string;
  automapTitle: (placed: number) => string;
  appliedBody: (count: 1 | 2, fields: number, pages: number) => string;
  automapBody: (count: 1 | 2, pages: number) => string;
  warnMissingSecond: string;
  warnFallbackOne: string;
  /** Firmantes que se quedan en la sesion porque otro documento tiene campos suyos (no se retiran al bajar el nº de firmantes). */
  keptSigners: (names: string[]) => string;
  signersLabel: string;
  signersOne: string;
  signersTwo: string;
  goSign: string;
  review: string;
  undo: string;
  similarQuestion: (name: string, percent: number) => string;
  similarHint: string;
  use: string;
  no: string;
  suggestionsTitle: (count: number) => string;
  reviewPagesTitle: (pages: readonly number[], count: number) => string;
  reviewPagesBody: string;
  pendingRow: (page: number, what: string) => string;
  reviewReason: (reason: string) => string;
  noPageHere: string;
  goToPage: (page: number) => string;
  goToPageFor: (page: number, what: string) => string;
  add: string;
  addFor: (page: number, what: string) => string;
  addAll: string;
  signKind: (type: string, who: string) => string;
  textKind: (type: string, label?: string) => string;
  /** Confirmacion al cambiar el nº de firmantes cuando se quitaria trabajo de la persona. */
  changeTitle: (count: 1 | 2) => string;
  changeBody: (count: 1 | 2, loss: ChangeLoss) => string;
  /** Mismo aviso cuando no cambia el nº de firmantes: se aplica lo guardado desde el editor y se reemplazan los campos. */
  replaceTitle: string;
  replaceBody: (loss: ChangeLoss) => string;
  changeConfirm: string;
  changeCancel: string;
  changeClose: string;
  /** El automapeo llego al tope de campos por documento (`document-field-cap`): lo dicho se cumple a medias. */
  capNotice: (placed: number, pages: number) => string;
  capPanelTitle: (pages: number) => string;
};

/** Lo que quitaria un cambio de firmantes, tal como lo cuentan los textos. */
export type ChangeLoss = { signers: ReadonlyArray<{ name: string; strokes: boolean }>; values: number };

export type EditorStrings = {
  title: string;
  subtitle: (fileName: string, pages: number) => string;
  close: string;
  privacy: string;
  nameLabel: string;
  namePlaceholder: string;
  nameRequired: string;
  roleLabel: (n: number) => string;
  variantLabel: string;
  variantOne: string;
  variantTwo: string;
  variantHint: (signers: 1 | 2, fields: number) => string;
  copyFromOther: (signers: 1 | 2) => string;
  variantCopied: (signers: 1 | 2) => string;
  variantShown: (signers: 1 | 2) => string;
  toolsLabel: string;
  undo: string;
  redo: string;
  undone: string;
  redone: string;
  detect: string;
  detecting: string;
  detectFailed: string;
  detected: (placed: number, suggested: number) => string;
  /** El automapeo llego al tope de campos por documento: las paginas del final pueden quedar sin cubrir. */
  detectCapped: string;
  suggestionsTitle: (count: number) => string;
  acceptAll: string;
  accept: string;
  acceptFor: (page: number, what: string) => string;
  goToPage: (page: number) => string;
  goToPageFor: (page: number, what: string) => string;
  suggestionRow: (page: number, what: string) => string;
  suggestionAccepted: string;
  suggestionsAccepted: (count: number) => string;
  signKind: (type: string, role: string) => string;
  textKind: (type: string, label?: string) => string;
  initialsTitle: string;
  initialsHintOne: string;
  initialsHintTwo: string;
  initialsNeedBase: string;
  initialsRepeated: (pages: number, signers: 1 | 2) => string;
  repeatAll: string;
  matchPrevious: string;
  matchPreviousNone: string;
  matchedPrevious: (page: number) => string;
  rangeLegend: string;
  rangeFrom: string;
  rangeTo: string;
  repeatRange: string;
  rangeInvalid: string;
  tooManyFields: string;
  textFieldTitle: string;
  fieldLabel: string;
  dataKeyLabel: string;
  dataKeyNone: string;
  ruleToday: string;
  save: string;
  saveNewVersion: string;
  /** Tras un conflicto (otra pestaña borró o cambió el documento): guarda lo editado como documento y plantilla nuevos. */
  saveAsNew: string;
  saving: string;
  saved: (pages: number) => string;
  signNow: string;
  nothingToSave: string;
  saveFailed: (reason: SaveFailure) => string;
  persistenceGranted: string;
  persistenceDenied: string;
  persistenceUnsupported: string;
  leaveTitle: string;
  leaveBody: string;
  leaveConfirm: string;
  leaveStay: string;
};

export type OfferStrings = {
  title: (name: string) => string;
  body: string;
  save: string;
  notNow: string;
  saved: (name: string, pages: number) => string;
};

export type EntryStrings = {
  configureButton: string;
  configureHint: string;
  groupTitle: string;
  createForDocument: string;
  editForDocument: string;
  groupHint: string;
  detectButton: string;
  detectHint: string;
  legacyConvert: string;
  legacyConvertHint: string;
  handoffMissing: (count: number) => string;
  handoffOnlyFirst: string;
  /** El PDF de «Mis documentos» se reemplazó y ya no coincide con su plantilla: no se aplicó. */
  staleSkipped: (fileName: string) => string;
  openFailed: string;
  noLibrary: string;
};

export type FlagStrings = {
  title: string;
  body: string;
  autoApplyTemplates: { label: string; hint: string };
  autoDetectFields: { label: string; hint: string };
};

export type TemplateStrings = {
  appliedAnnounce: (name: string, count: 1 | 2, pages: number) => string;
  automapAnnounce: (placed: number, suggested: number) => string;
  similarAnnounce: (name: string, percent: number) => string;
  undoneAnnounce: string;
  /** «Deshacer» no se hizo porque ya hay trabajo de la persona (el boton no se ofrece; esto es la red de seguridad). */
  undoBlockedAnnounce: string;
  savedAnnounce: (pages: number) => string;
  saveFailed: (reason: SaveFailure) => string;
  notices: NoticeStrings;
  editor: EditorStrings;
  offer: OfferStrings;
  entry: EntryStrings;
  flags: FlagStrings;
};

const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listEs = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`);
const listEn = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const failEs: Record<SaveFailure, string> = {
  unavailable: "Este navegador no permite guardar documentos (sin almacenamiento local). Prueba con otra ventana que no sea privada.",
  quota: "No hay espacio en este navegador para guardar el documento. Libera espacio o borra documentos que ya no uses.",
  tooBig: "El PDF es demasiado grande para guardarlo como documento base (máximo 100 MB).",
  full: "Ya tienes el máximo de documentos o plantillas guardados. Borra alguno para poder guardar más.",
  conflict: "Otra pestaña modificó o borró este documento o su plantilla mientras la editabas, y no se pudo guardar aquí. Tus cambios siguen en pantalla: puedes guardarlos como un documento nuevo.",
  invalid: "No se pudo guardar: revisa el nombre y que haya al menos una firma o unas iniciales colocadas.",
  encrypted: "El PDF está protegido con contraseña: no se puede guardar como documento base.",
  corrupt: "No se pudo leer el PDF: está dañado.",
  empty: "El archivo está vacío.",
  failed: "No se pudo guardar la plantilla. Inténtalo de nuevo.",
};

const failEn: Record<SaveFailure, string> = {
  unavailable: "This browser can't store documents (no local storage). Try a window that isn't private.",
  quota: "There isn't enough space in this browser to store the document. Free up space or delete documents you no longer use.",
  tooBig: "The PDF is too large to store as a base document (100 MB maximum).",
  full: "You already have the maximum number of documents or templates stored. Delete some to store more.",
  conflict: "Another tab changed or deleted this document or its template while you were editing it, so it couldn't be saved here. Your changes are still on screen: you can save them as a new document.",
  invalid: "Couldn't save: check the name and that at least one signature or initials field is placed.",
  encrypted: "The PDF is password-protected: it can't be stored as a base document.",
  corrupt: "The PDF couldn't be read: it is damaged.",
  empty: "The file is empty.",
  failed: "Couldn't save the template. Try again.",
};

const typeEs: Record<string, string> = { signature: "Firma", initials: "Iniciales", text: "Texto", date: "Fecha", checkbox: "Casilla" };
const typeEn: Record<string, string> = { signature: "Signature", initials: "Initials", text: "Text", date: "Date", checkbox: "Checkbox" };

const reviewEs: Record<string, string> = {
  needsReview: "Propuesta de confianza media: revísala antes de usarla.",
  pageReview: "Esta página cambió respecto a la plantilla: no se aplicó sola.",
  noPageMatch: "Esta página de la plantilla no se encontró en este documento.",
  outOfRange: "Esta página de la plantilla no existe en este documento.",
};
const reviewEn: Record<string, string> = {
  needsReview: "Medium-confidence suggestion: check it before using it.",
  pageReview: "This page changed from the template: it wasn't applied on its own.",
  noPageMatch: "This template page wasn't found in this document.",
  outOfRange: "This template page doesn't exist in this document.",
};

export const templateEs: TemplateStrings = {
  appliedAnnounce: (name, count, pages) => `Plantilla «${name}» aplicada para ${count === 1 ? "1 firmante" : "2 firmantes"} en ${pl(pages, "página", "páginas")}.`,
  automapAnnounce: (placed, suggested) => `Detectamos ${pl(placed, "campo", "campos")} automáticamente${suggested > 0 ? ` y ${pl(suggested, "sugerencia", "sugerencias")} por revisar` : ""}.`,
  similarAnnounce: (name, percent) => `Parece la plantilla «${name}» (${percent} %). ¿Usarla?`,
  undoneAnnounce: "Se deshizo la aplicación de campos.",
  undoBlockedAnnounce: "No se puede deshacer: ya hay firmas o datos tuyos en este documento y no se tocan.",
  savedAnnounce: (pages) => `Plantilla guardada · aplicada a ${pl(pages, "página", "páginas")}.`,
  saveFailed: (reason) => failEs[reason],
  notices: {
    detecting: "Buscando campos de firma e iniciales…",
    appliedTitle: (name) => `Plantilla «${name}» aplicada`,
    automapTitle: (placed) => `Detectamos ${pl(placed, "campo", "campos")} automáticamente`,
    appliedBody: (count, fields, pages) => `${count === 1 ? "1 firmante" : "2 firmantes"} · ${pl(fields, "campo", "campos")} en ${pl(pages, "página", "páginas")}`,
    automapBody: (count, pages) => `${count === 1 ? "1 firmante" : "2 firmantes"} · en ${pl(pages, "página", "páginas")}. Revísalos antes de firmar.`,
    warnMissingSecond: "La plantilla solo tiene la variante de 1 firmante: el segundo firmante no tiene campos.",
    warnFallbackOne: "La plantilla no tiene variante de 1 firmante: se usaron los campos del firmante 1.",
    keptSigners: (names) => `${names.join(", ")} ${names.length === 1 ? "se queda" : "se quedan"} como firmante${names.length === 1 ? "" : "s"} de la sesión porque otro documento tiene campos suyos; en este documento no tiene${names.length === 1 ? "" : "n"} campos.`,
    signersLabel: "Firmantes",
    signersOne: "1 firmante",
    signersTwo: "2 firmantes",
    goSign: "Ir a firmar",
    review: "Revisar campos",
    undo: "Deshacer",
    similarQuestion: (name, percent) => `Parece la plantilla «${name}» (${percent} %)`,
    similarHint: "No es idéntico: usa la plantilla solo si es el mismo contrato. Las páginas distintas quedan para revisar.",
    use: "Usar",
    no: "No",
    suggestionsTitle: (count) => `Sugerencias (${count})`,
    reviewPagesTitle: (pages, count) => (pages.length > 0 ? `Revisar ${pages.length === 1 ? "la página" : "las páginas"} ${listEs(pages.map((page) => String(page + 1)))} (${count})` : `Sugerencias (${count})`),
    reviewPagesBody: "Estas páginas no coinciden del todo con la plantilla, así que sus campos no se aplicaron solos.",
    pendingRow: (page, what) => `Página ${page} · ${what}`,
    reviewReason: (reason) => reviewEs[reason] ?? reviewEs.needsReview,
    noPageHere: "Sin página equivalente",
    goToPage: (page) => `Ir a la página ${page}`,
    goToPageFor: (page, what) => `Ir a la página ${page}: ${what}`,
    add: "Añadir",
    addFor: (page, what) => `Añadir: ${what}, página ${page}`,
    addAll: "Añadir todas",
    signKind: (type, who) => `${typeEs[type] ?? type}${who ? ` de ${who}` : ""}`,
    textKind: (type, label) => `${typeEs[type] ?? "Texto"}${label ? `: ${label}` : ""}`,
    changeTitle: (count) => `¿Cambiar a ${count === 1 ? "1 firmante" : "2 firmantes"}?`,
    changeBody: (count, loss) =>
      `Cambiar a ${count === 1 ? "1 firmante" : "2 firmantes"} quitará ${listEs([
        ...loss.signers.map((signer) => (signer.strokes ? `la firma de ${signer.name || "un firmante sin nombre"}` : `al firmante ${signer.name}`)),
        ...(loss.values > 0 ? [pl(loss.values, "valor escrito", "valores escritos")] : []),
      ])}. ¿Continuar?`,
    replaceTitle: "¿Aplicar la plantilla guardada?",
    replaceBody: (loss) =>
      `Aplicar la plantilla guardada reemplazará los campos del documento y quitará ${listEs([
        ...loss.signers.map((signer) => (signer.strokes ? `la firma de ${signer.name || "un firmante sin nombre"}` : `al firmante ${signer.name}`)),
        ...(loss.values > 0 ? [pl(loss.values, "valor escrito", "valores escritos")] : []),
      ])}. ¿Continuar?`,
    changeConfirm: "Quitar y cambiar",
    changeCancel: "Cancelar",
    changeClose: "Cerrar",
    capNotice: (placed, pages) => `Se colocaron ${pl(placed, "campo", "campos")}, el máximo por documento; ${pages === 1 ? "1 página queda" : `${pages} páginas quedan`} sin iniciales. Revisa ${pages === 1 ? "esa página" : "esas páginas"} y añade lo que falte.`,
    capPanelTitle: (pages) => `Páginas sin cubrir (${pages})`,
  },
  editor: {
    title: "Configurar plantilla",
    subtitle: (fileName, pages) => (pages > 0 ? `${fileName} · ${pl(pages, "página", "páginas")}` : fileName),
    close: "Cerrar",
    privacy: "Se guarda una copia de este PDF en este navegador; usa contratos en blanco, sin datos de clientes.",
    nameLabel: "Nombre de la plantilla",
    namePlaceholder: "Ej. Contrato de servicio",
    nameRequired: "Escribe un nombre para la plantilla.",
    roleLabel: (n) => `Firmante ${n}`,
    variantLabel: "Variante",
    variantOne: "1 firmante",
    variantTwo: "2 firmantes",
    variantHint: (signers, fields) => `Estás configurando la variante de ${signers === 1 ? "1 firmante" : "2 firmantes"}: ${pl(fields, "campo", "campos")}. Cada variante se guarda por separado.`,
    copyFromOther: (signers) => `Copiar de la variante de ${signers === 1 ? "1 firmante" : "2 firmantes"}`,
    variantCopied: (signers) => `Copiado a la variante de ${signers === 1 ? "1 firmante" : "2 firmantes"}.`,
    variantShown: (signers) => `Variante de ${signers === 1 ? "1 firmante" : "2 firmantes"}.`,
    toolsLabel: "Herramientas de la plantilla",
    undo: "Deshacer",
    redo: "Rehacer",
    undone: "Cambio deshecho.",
    redone: "Cambio rehecho.",
    detect: "Detectar campos automáticamente",
    detecting: "Buscando campos…",
    detectFailed: "No se pudieron detectar campos en este PDF. Colócalos a mano.",
    detected: (placed, suggested) => (placed === 0 && suggested === 0 ? "No encontramos campos con claridad. Colócalos a mano." : `Colocamos ${pl(placed, "campo", "campos")} con seguridad${suggested > 0 ? ` y hay ${pl(suggested, "sugerencia", "sugerencias")} por revisar` : ""}.`),
    detectCapped: "Se alcanzó el máximo de 80 campos por documento: las páginas del final pueden quedar sin iniciales. Revísalas y añade lo que falte.",
    suggestionsTitle: (count) => `Sugerencias (${count})`,
    acceptAll: "Aceptar todas",
    accept: "Aceptar",
    acceptFor: (page, what) => `Aceptar: ${what}, página ${page}`,
    goToPage: (page) => `Página ${page}`,
    goToPageFor: (page, what) => `Ir a la página ${page}: ${what}`,
    suggestionRow: (page, what) => `Página ${page} · ${what}`,
    suggestionAccepted: "Sugerencia aceptada.",
    suggestionsAccepted: (count) => `${pl(count, "sugerencia aceptada", "sugerencias aceptadas")}.`,
    signKind: (type, role) => `${typeEs[type] ?? type}${role ? ` de ${role}` : ""}`,
    textKind: (type, label) => `${typeEs[type] ?? "Texto"}${label ? `: ${label}` : ""}`,
    initialsTitle: "Iniciales en todas las páginas",
    initialsHintOne: "Coloca las iniciales en una página y repítelas en las demás. Después ajusta cualquier página arrastrando.",
    initialsHintTwo: "Coloca la línea de iniciales en una página: se reparte en dos, el firmante 1 a la izquierda y el 2 a la derecha. Después ajusta cualquier página arrastrando.",
    initialsNeedBase: "Primero coloca las iniciales en una página con la herramienta Iniciales; después se repiten.",
    initialsRepeated: (pages, signers) => `Iniciales repetidas en ${pl(pages, "página", "páginas")}${signers === 2 ? ", una al lado de la otra" : ""}.`,
    repeatAll: "Repetir iniciales en todas las páginas",
    matchPrevious: "Igualar a la página anterior",
    matchPreviousNone: "La página anterior no tiene iniciales que igualar.",
    matchedPrevious: (page) => `Las iniciales de la página ${page} quedaron como las de la anterior.`,
    rangeLegend: "Repetir solo en un rango de páginas",
    rangeFrom: "Desde la página",
    rangeTo: "Hasta la página",
    repeatRange: "Repetir en ese rango",
    rangeInvalid: "El rango de páginas no es válido.",
    tooManyFields: "Hay demasiados campos en esta variante.",
    textFieldTitle: "Campo de texto seleccionado",
    fieldLabel: "Etiqueta",
    dataKeyLabel: "Origen del dato",
    dataKeyNone: "Sin origen",
    ruleToday: "Poner la fecha de hoy al firmar",
    save: "Guardar plantilla",
    saveNewVersion: "Guardar cambios",
    saveAsNew: "Guardar como documento nuevo",
    saving: "Guardando…",
    saved: (pages) => `Plantilla guardada · aplicada a ${pl(pages, "página", "páginas")}`,
    signNow: "Firmar este documento",
    nothingToSave: "Coloca al menos una firma o unas iniciales antes de guardar.",
    saveFailed: (reason) => failEs[reason],
    persistenceGranted: "Almacenamiento persistente: concedido. El navegador no borrará estos documentos por falta de espacio.",
    persistenceDenied: "Almacenamiento persistente: no concedido. Si el navegador necesita espacio, podría borrar estos documentos.",
    persistenceUnsupported: "Este navegador no ofrece almacenamiento persistente: los documentos guardados podrían borrarse si falta espacio.",
    leaveTitle: "¿Salir sin guardar?",
    leaveBody: "Hay cambios en la plantilla que no se han guardado.",
    leaveConfirm: "Salir sin guardar",
    leaveStay: "Seguir editando",
  },
  offer: {
    title: (name) => `¿Guardar «${name}» como plantilla para la próxima vez?`,
    body: "Se guardará una copia de este PDF en este navegador, con las posiciones de las firmas y de los campos (nunca las firmas que trazaste). Si este PDF contiene datos de un cliente, no lo guardes.",
    save: "Guardar como plantilla",
    notNow: "No guardar",
    saved: (name, pages) => `«${name}»: plantilla guardada · aplicada a ${pl(pages, "página", "páginas")}`,
  },
  entry: {
    configureButton: "Configurar plantilla",
    configureHint: "Marca una vez dónde firma cada quien en un contrato en blanco; la próxima vez los campos aparecen solos.",
    groupTitle: "Plantilla de este documento",
    createForDocument: "Crear plantilla de este documento",
    editForDocument: "Configurar plantilla de este documento",
    groupHint: "Guarda dónde firma cada quien en este PDF; la próxima vez los campos aparecen solos.",
    detectButton: "Detectar campos automáticamente",
    detectHint: "Busca líneas de firma, iniciales y fechas en este documento y las propone.",
    legacyConvert: "Convertir a plantilla de este documento",
    legacyConvertHint: "Así se aplicará sola cada vez que cargues este PDF.",
    handoffMissing: (count) => (count === 1 ? "Un documento ya no está en Mis documentos y no se pudo abrir." : `${count} documentos ya no están en Mis documentos y no se pudieron abrir.`),
    handoffOnlyFirst: "Solo se abrió el primer documento: «Varios documentos a la vez» está apagado en Ajustes.",
    staleSkipped: (fileName) => `La plantilla de «${fileName}» está desactualizada (cambiaste el PDF y ya no coincide), así que no se aplicó. Reconfigúrala en Mis documentos.`,
    openFailed: "No se pudo abrir el PDF para configurar su plantilla.",
    noLibrary: "Este navegador no permite guardar plantillas (sin almacenamiento local).",
  },
  flags: {
    title: "Plantillas de documento",
    body: "Estas opciones son solo de este navegador: nada sale de tu dispositivo.",
    autoApplyTemplates: {
      label: "Aplicar plantillas automáticamente",
      hint: "Al cargar un PDF que ya configuraste (aunque lo hayas vuelto a exportar), sus firmas, iniciales y campos aparecen solos, con aviso para deshacer.",
    },
    autoDetectFields: {
      label: "Detectar campos automáticamente",
      hint: "En un PDF desconocido, busca líneas de firma, iniciales y fechas y coloca las seguras con aviso para deshacer. Las dudosas quedan como sugerencias.",
    },
  },
};

export const templateEn: TemplateStrings = {
  appliedAnnounce: (name, count, pages) => `Template “${name}” applied for ${count === 1 ? "1 signer" : "2 signers"} on ${pl(pages, "page", "pages")}.`,
  automapAnnounce: (placed, suggested) => `We detected ${pl(placed, "field", "fields")} automatically${suggested > 0 ? ` and ${pl(suggested, "suggestion", "suggestions")} to review` : ""}.`,
  similarAnnounce: (name, percent) => `It looks like the template “${name}” (${percent}%). Use it?`,
  undoneAnnounce: "The applied fields were undone.",
  undoBlockedAnnounce: "Can't undo: this document already has your signatures or data and they aren't touched.",
  savedAnnounce: (pages) => `Template saved · applied to ${pl(pages, "page", "pages")}.`,
  saveFailed: (reason) => failEn[reason],
  notices: {
    detecting: "Looking for signature and initials fields…",
    appliedTitle: (name) => `Template “${name}” applied`,
    automapTitle: (placed) => `We detected ${pl(placed, "field", "fields")} automatically`,
    appliedBody: (count, fields, pages) => `${count === 1 ? "1 signer" : "2 signers"} · ${pl(fields, "field", "fields")} on ${pl(pages, "page", "pages")}`,
    automapBody: (count, pages) => `${count === 1 ? "1 signer" : "2 signers"} · on ${pl(pages, "page", "pages")}. Review them before signing.`,
    warnMissingSecond: "The template only has the 1-signer variant: the second signer has no fields.",
    warnFallbackOne: "The template has no 1-signer variant: signer 1's fields were used.",
    keptSigners: (names) => `${names.join(", ")} ${names.length === 1 ? "stays" : "stay"} in the session because another document has fields for them; this document has none for them.`,
    signersLabel: "Signers",
    signersOne: "1 signer",
    signersTwo: "2 signers",
    goSign: "Go to signing",
    review: "Review fields",
    undo: "Undo",
    similarQuestion: (name, percent) => `It looks like the template “${name}” (${percent}%)`,
    similarHint: "It isn't identical: use the template only if it's the same contract. Different pages are left for review.",
    use: "Use it",
    no: "No",
    suggestionsTitle: (count) => `Suggestions (${count})`,
    reviewPagesTitle: (pages, count) => (pages.length > 0 ? `Review ${pages.length === 1 ? "page" : "pages"} ${listEn(pages.map((page) => String(page + 1)))} (${count})` : `Suggestions (${count})`),
    reviewPagesBody: "These pages don't fully match the template, so their fields weren't applied on their own.",
    pendingRow: (page, what) => `Page ${page} · ${what}`,
    reviewReason: (reason) => reviewEn[reason] ?? reviewEn.needsReview,
    noPageHere: "No matching page",
    goToPage: (page) => `Go to page ${page}`,
    goToPageFor: (page, what) => `Go to page ${page}: ${what}`,
    add: "Add",
    addFor: (page, what) => `Add: ${what}, page ${page}`,
    addAll: "Add all",
    signKind: (type, who) => `${typeEn[type] ?? type}${who ? ` for ${who}` : ""}`,
    textKind: (type, label) => `${typeEn[type] ?? "Text"}${label ? `: ${label}` : ""}`,
    changeTitle: (count) => `Switch to ${count === 1 ? "1 signer" : "2 signers"}?`,
    changeBody: (count, loss) =>
      `Switching to ${count === 1 ? "1 signer" : "2 signers"} will remove ${listEn([
        ...loss.signers.map((signer) => (signer.strokes ? `${signer.name || "an unnamed signer"}'s signature` : `signer ${signer.name}`)),
        ...(loss.values > 0 ? [pl(loss.values, "typed value", "typed values")] : []),
      ])}. Continue?`,
    replaceTitle: "Apply the saved template?",
    replaceBody: (loss) =>
      `Applying the saved template will replace the document's fields and remove ${listEn([
        ...loss.signers.map((signer) => (signer.strokes ? `${signer.name || "an unnamed signer"}'s signature` : `signer ${signer.name}`)),
        ...(loss.values > 0 ? [pl(loss.values, "typed value", "typed values")] : []),
      ])}. Continue?`,
    changeConfirm: "Remove and switch",
    changeCancel: "Cancel",
    changeClose: "Close",
    capNotice: (placed, pages) => `${pl(placed, "field was", "fields were")} placed, the maximum per document; ${pages === 1 ? "1 page has" : `${pages} pages have`} no initials. Check ${pages === 1 ? "that page" : "those pages"} and add whatever is missing.`,
    capPanelTitle: (pages) => `Pages not covered (${pages})`,
  },
  editor: {
    title: "Set up template",
    subtitle: (fileName, pages) => (pages > 0 ? `${fileName} · ${pl(pages, "page", "pages")}` : fileName),
    close: "Close",
    privacy: "A copy of this PDF is stored in this browser; use blank contracts, with no client data.",
    nameLabel: "Template name",
    namePlaceholder: "E.g. Service contract",
    nameRequired: "Enter a name for the template.",
    roleLabel: (n) => `Signer ${n}`,
    variantLabel: "Variant",
    variantOne: "1 signer",
    variantTwo: "2 signers",
    variantHint: (signers, fields) => `You are setting up the ${signers === 1 ? "1-signer" : "2-signer"} variant: ${pl(fields, "field", "fields")}. Each variant is saved separately.`,
    copyFromOther: (signers) => `Copy from the ${signers === 1 ? "1-signer" : "2-signer"} variant`,
    variantCopied: (signers) => `Copied to the ${signers === 1 ? "1-signer" : "2-signer"} variant.`,
    variantShown: (signers) => `${signers === 1 ? "1-signer" : "2-signer"} variant.`,
    toolsLabel: "Template tools",
    undo: "Undo",
    redo: "Redo",
    undone: "Change undone.",
    redone: "Change redone.",
    detect: "Detect fields automatically",
    detecting: "Looking for fields…",
    detectFailed: "Couldn't detect fields in this PDF. Place them by hand.",
    detected: (placed, suggested) => (placed === 0 && suggested === 0 ? "We couldn't find fields with confidence. Place them by hand." : `We placed ${pl(placed, "field", "fields")} with confidence${suggested > 0 ? ` and there ${suggested === 1 ? "is" : "are"} ${pl(suggested, "suggestion", "suggestions")} to review` : ""}.`),
    detectCapped: "The limit of 80 fields per document was reached: the last pages may have no initials. Check them and add whatever is missing.",
    suggestionsTitle: (count) => `Suggestions (${count})`,
    acceptAll: "Accept all",
    accept: "Accept",
    acceptFor: (page, what) => `Accept: ${what}, page ${page}`,
    goToPage: (page) => `Page ${page}`,
    goToPageFor: (page, what) => `Go to page ${page}: ${what}`,
    suggestionRow: (page, what) => `Page ${page} · ${what}`,
    suggestionAccepted: "Suggestion accepted.",
    suggestionsAccepted: (count) => `${pl(count, "suggestion", "suggestions")} accepted.`,
    signKind: (type, role) => `${typeEn[type] ?? type}${role ? ` for ${role}` : ""}`,
    textKind: (type, label) => `${typeEn[type] ?? "Text"}${label ? `: ${label}` : ""}`,
    initialsTitle: "Initials on every page",
    initialsHintOne: "Place the initials on one page and repeat them on the others. Then fine-tune any page by dragging.",
    initialsHintTwo: "Place the initials line on one page: it is split in two, signer 1 on the left and signer 2 on the right. Then fine-tune any page by dragging.",
    initialsNeedBase: "First place the initials on a page with the Initials tool; then they can be repeated.",
    initialsRepeated: (pages, signers) => `Initials repeated on ${pl(pages, "page", "pages")}${signers === 2 ? ", side by side" : ""}.`,
    repeatAll: "Repeat initials on all pages",
    matchPrevious: "Match the previous page",
    matchPreviousNone: "The previous page has no initials to match.",
    matchedPrevious: (page) => `Initials on page ${page} now match the previous page.`,
    rangeLegend: "Repeat only on a range of pages",
    rangeFrom: "From page",
    rangeTo: "To page",
    repeatRange: "Repeat on that range",
    rangeInvalid: "The page range isn't valid.",
    tooManyFields: "There are too many fields in this variant.",
    textFieldTitle: "Selected text field",
    fieldLabel: "Label",
    dataKeyLabel: "Data source",
    dataKeyNone: "No source",
    ruleToday: "Fill in today's date when signing",
    save: "Save template",
    saveNewVersion: "Save changes",
    saveAsNew: "Save as a new document",
    saving: "Saving…",
    saved: (pages) => `Template saved · applied to ${pl(pages, "page", "pages")}`,
    signNow: "Sign this document",
    nothingToSave: "Place at least one signature or initials field before saving.",
    saveFailed: (reason) => failEn[reason],
    persistenceGranted: "Persistent storage: granted. The browser won't delete these documents when it runs low on space.",
    persistenceDenied: "Persistent storage: not granted. If the browser needs space, it could delete these documents.",
    persistenceUnsupported: "This browser doesn't offer persistent storage: stored documents could be deleted if space runs low.",
    leaveTitle: "Leave without saving?",
    leaveBody: "There are template changes that haven't been saved.",
    leaveConfirm: "Leave without saving",
    leaveStay: "Keep editing",
  },
  offer: {
    title: (name) => `Save “${name}” as a template for next time?`,
    body: "A copy of this PDF will be stored in this browser, with the positions of the signatures and fields (never the signatures you drew). If this PDF contains client data, don't save it.",
    save: "Save as template",
    notNow: "Don't save",
    saved: (name, pages) => `“${name}”: template saved · applied to ${pl(pages, "page", "pages")}`,
  },
  entry: {
    configureButton: "Set up template",
    configureHint: "Mark once where each person signs in a blank contract; next time the fields appear on their own.",
    groupTitle: "This document's template",
    createForDocument: "Create a template for this document",
    editForDocument: "Set up this document's template",
    groupHint: "Saves where each person signs in this PDF; next time the fields appear on their own.",
    detectButton: "Detect fields automatically",
    detectHint: "Looks for signature lines, initials and dates in this document and suggests them.",
    legacyConvert: "Convert to a template for this document",
    legacyConvertHint: "That way it will apply by itself every time you load this PDF.",
    handoffMissing: (count) => (count === 1 ? "A document is no longer in My documents and couldn't be opened." : `${count} documents are no longer in My documents and couldn't be opened.`),
    handoffOnlyFirst: "Only the first document was opened: “Several documents at once” is off in Settings.",
    staleSkipped: (fileName) => `The template for “${fileName}” is out of date (you replaced the PDF and it no longer matches), so it wasn't applied. Set it up again in My documents.`,
    openFailed: "Couldn't open the PDF to set up its template.",
    noLibrary: "This browser can't store templates (no local storage).",
  },
  flags: {
    title: "Document templates",
    body: "These options are local to this browser: nothing leaves your device.",
    autoApplyTemplates: {
      label: "Apply templates automatically",
      hint: "When you load a PDF you've already set up (even if it was exported again), its signatures, initials and fields appear on their own, with an undo notice.",
    },
    autoDetectFields: {
      label: "Detect fields automatically",
      hint: "On an unknown PDF, looks for signature lines, initials and dates and places the confident ones with an undo notice. Doubtful ones become suggestions.",
    },
  },
};
