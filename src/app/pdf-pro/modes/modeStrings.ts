import type { Language } from "@/lib/i18n";

/**
 * Textos del host de modos y de los modos Editar y Anotar de PDF Pro (Wave 7 · U6), es/en. Viven en su propio
 * archivo (y no en `proStrings.ts`) para que cada modo traiga los suyos sin pisarse con las demas unidades.
 */
export type ModeStrings = {
  host: {
    /** Barra del modo: nombre del grupo y estado. */
    barLabel: string;
    editing: string;
    annotating: string;
    /** Genérico para modos sin nombre propio (Firmar, Rellenar...). */
    working: (mode: string) => string;
    dirty: string;
    clean: string;
    /** «Aplicar» pulsado sin cambios (se anuncia, no se hace nada). */
    noChanges: string;
    apply: string;
    applying: string;
    discard: string;
    cancelApply: string;
    /** Región con el contenido del modo. */
    regionLabel: (mode: string) => string;
    /** Hoja al salir con cambios sin aplicar. */
    leaveTitle: string;
    leaveBody: (mode: string) => string;
    leaveApply: string;
    leaveDiscard: string;
    leaveStay: string;
    /** Hoja de confirmacion de descartar sin salir de la pestaña. */
    discardTitle: string;
    discardBody: string;
    discardConfirm: string;
    /** Firmas digitales antes de aplicar. */
    signaturesTitle: string;
    signaturesConfirm: string;
    signaturesCancel: string;
    /** Resultado de aplicar. */
    appliedTitle: (label: string) => string;
    appliedNoticesTitle: string;
    appliedDismiss: string;
    applyFailed: string;
    applyStale: string;
    close: string;
    /** Anuncio al entrar y al salir. */
    entered: (mode: string) => string;
    discarded: (mode: string) => string;
    kept: string;
    /** (M2) Barras plegables del modo en movil: el boton que oculta/muestra paleta, avisos y dock para dar sitio a la hoja. */
    hideTools: string;
    showTools: string;
    /** (M2) Interruptor «Desplazar»: con el, un dedo sobre la hoja la desplaza aunque haya una herramienta armada. */
    panLabel: string;
    panHint: string;
    /** (M5) Con la bandeja cerrada, el boton nombra la herramienta armada: «Mostrar herramientas (activa: Texto)». */
    showToolsActive: (tool: string) => string;
    /** (M5) Aviso de una sola vez al armar la primera herramienta con el dedo. */
    panFirstHint: string;
  };
  /** (M2) Ayudas de cada herramienta armada con el dedo (sin «clic», sin «Esc»): sustituyen a las de escritorio en tactil. */
  touchHints: Record<"text" | "note" | "image" | "rect" | "ellipse" | "line" | "highlight" | "check", string>;
  edit: {
    /** Nombre del modo en las etiquetas («Editando»). */
    name: string;
    /** Etiqueta del snapshot al aplicar. */
    label: (count: number) => string;
    preparing: string;
    nothingToApply: string;
    largeFile: string;
  };
  annotate: {
    name: string;
    label: (count: number) => string;
    /** Interruptor «Seleccionar texto» (editar el texto que ya trae el PDF), secundario. */
    textToggle: string;
    textToggleOn: string;
    textToggleOff: string;
    textToggleDisabled: string;
    nothingToApply: string;
  };
  /** Nombre de cada modo: en la barra («Editando») y como sustantivo en frases («los cambios de “Editar”»). */
  names: Record<"edit" | "annotate" | "sign" | "fill", { bar: string; short: string }>;
  /** Comandos de la paleta Cmd/Ctrl+K. */
  commands: {
    editText: string;
    annotate: string;
    addImage: string;
    highlight: string;
    addNote: string;
    addShape: string;
    signDocument: string;
    fillForm: string;
  };
  /** Entradas del panel de atajos. */
  shortcuts: {
    openEdit: string;
    openAnnotate: string;
    openSign: string;
    openFill: string;
  };
};

const ES: ModeStrings = {
  host: {
    barLabel: "Barra del modo",
    editing: "Editando",
    annotating: "Anotando",
    working: (mode) => `Trabajando en ${mode}`,
    dirty: "Cambios sin aplicar",
    clean: "Sin cambios todavía",
    noChanges: "No hay cambios que aplicar",
    apply: "Aplicar",
    applying: "Aplicando…",
    discard: "Descartar",
    cancelApply: "Cancelar",
    regionLabel: (mode) => `Modo ${mode}`,
    leaveTitle: "Hay cambios sin aplicar",
    leaveBody: (mode) =>
      `Si sales ahora, los cambios de «${mode}» se perderán. Puedes aplicarlos al documento o descartarlos.`,
    leaveApply: "Aplicar y salir",
    leaveDiscard: "Descartar y salir",
    leaveStay: "Seguir editando",
    discardTitle: "¿Descartar los cambios?",
    discardBody: "Se perderán los cambios que no hayas aplicado. El documento queda como estaba.",
    discardConfirm: "Descartar cambios",
    signaturesTitle: "Este PDF tiene firmas digitales",
    signaturesConfirm: "Aplicar de todos modos",
    signaturesCancel: "Seguir sin aplicar",
    appliedTitle: (label) => `Aplicado: ${label}`,
    appliedNoticesTitle: "Avisos",
    appliedDismiss: "Cerrar este aviso",
    applyFailed: "No se pudo aplicar",
    applyStale: "El documento cambió mientras se aplicaba y no se guardó el resultado. Vuelve a intentarlo.",
    close: "Cerrar",
    entered: (mode) => `${mode}: modo abierto. Aplica o descarta los cambios para volver al documento.`,
    discarded: (mode) => `${mode}: cambios descartados.`,
    kept: "Sigues en el modo.",
    hideTools: "Ocultar herramientas",
    showTools: "Mostrar herramientas",
    panLabel: "Desplazar",
    panHint: "Con «Desplazar» activado, un dedo sobre la hoja la mueve; toca para colocar el elemento. Con dos dedos siempre se desplaza y se hace zoom.",
    showToolsActive: (tool) => `Mostrar herramientas (activa: ${tool})`,
    panFirstHint: "Para mover la página, activa Desplazar o usa dos dedos.",
  },
  touchHints: {
    text: "Toca o arrastra en la página para añadir un cuadro de texto. Toca otra herramienta para cancelar.",
    note: "Toca o arrastra en la página para añadir una nota. Toca otra herramienta para cancelar.",
    image: "Elige un PNG o un JPG para colocarlo en la página. Toca otra herramienta para cancelar.",
    rect: "Arrastra sobre la página para dibujar el rectángulo, o toca para soltar uno.",
    ellipse: "Arrastra para dibujar la elipse, o toca para soltar una.",
    line: "Arrastra de un punto al otro, o toca para soltar una línea.",
    highlight: "Arrastra por encima del texto que quieras resaltar.",
    check: "Toca la casilla para dejar el símbolo, o arrastra para darle otro tamaño.",
  },
  edit: {
    name: "Editar",
    label: (count) => `Edición (${count})`,
    preparing: "Preparando el documento para editar…",
    nothingToApply: "Aún no hay cambios que aplicar.",
    largeFile: "Este PDF supera los 100 MB: el navegador puede quedarse sin memoria al editarlo.",
  },
  annotate: {
    name: "Anotar",
    label: (count) => `Anotaciones (${count})`,
    textToggle: "Seleccionar texto",
    textToggleOn: "Seleccionar texto: activado",
    textToggleOff: "Seleccionar texto: desactivado",
    textToggleDisabled: "Seleccionar texto está apagado en Ajustes («Editar el texto que ya trae el PDF»).",
    nothingToApply: "Aún no hay anotaciones que aplicar.",
  },
  names: {
    edit: { bar: "Editando", short: "Editar" },
    annotate: { bar: "Anotando", short: "Anotar" },
    sign: { bar: "Firmando", short: "Firmar" },
    fill: { bar: "Rellenando", short: "Rellenar formulario" },
  },
  commands: {
    editText: "Editar texto",
    annotate: "Anotar",
    addImage: "Añadir imagen",
    highlight: "Resaltar texto",
    addNote: "Añadir nota",
    addShape: "Dibujar un rectángulo",
    signDocument: "Firmar documento",
    fillForm: "Rellenar formulario",
  },
  shortcuts: {
    openEdit: "Abrir el modo Editar",
    openAnnotate: "Abrir el modo Anotar",
    openSign: "Abrir el modo Firmar",
    openFill: "Abrir Rellenar formulario",
  },
};

const EN: ModeStrings = {
  host: {
    barLabel: "Mode bar",
    editing: "Editing",
    annotating: "Annotating",
    working: (mode) => `Working in ${mode}`,
    dirty: "Unapplied changes",
    clean: "No changes yet",
    noChanges: "There are no changes to apply",
    apply: "Apply",
    applying: "Applying…",
    discard: "Discard",
    cancelApply: "Cancel",
    regionLabel: (mode) => `${mode} mode`,
    leaveTitle: "You have unapplied changes",
    leaveBody: (mode) =>
      `If you leave now, the “${mode}” changes will be lost. You can apply them to the document or discard them.`,
    leaveApply: "Apply and leave",
    leaveDiscard: "Discard and leave",
    leaveStay: "Keep working",
    discardTitle: "Discard the changes?",
    discardBody: "Changes you have not applied will be lost. The document stays as it was.",
    discardConfirm: "Discard changes",
    signaturesTitle: "This PDF has digital signatures",
    signaturesConfirm: "Apply anyway",
    signaturesCancel: "Keep working",
    appliedTitle: (label) => `Applied: ${label}`,
    appliedNoticesTitle: "Notices",
    appliedDismiss: "Dismiss this notice",
    applyFailed: "Could not apply",
    applyStale: "The document changed while applying and the result was not saved. Try again.",
    close: "Close",
    entered: (mode) => `${mode}: mode open. Apply or discard your changes to go back to the document.`,
    discarded: (mode) => `${mode}: changes discarded.`,
    kept: "You are still in the mode.",
    hideTools: "Hide tools",
    showTools: "Show tools",
    panLabel: "Scroll",
    panHint: "With “Scroll” on, one finger on the page moves it; tap to place the item. Two fingers always scroll and zoom.",
    showToolsActive: (tool) => `Show tools (active: ${tool})`,
    panFirstHint: "To move the page, turn on Scroll or use two fingers.",
  },
  touchHints: {
    text: "Tap or drag on the page to add a text box. Tap another tool to cancel.",
    note: "Tap or drag on the page to add a note. Tap another tool to cancel.",
    image: "Pick a PNG or a JPG to place it on the page. Tap another tool to cancel.",
    rect: "Drag across the page to draw the rectangle, or tap to drop one.",
    ellipse: "Drag to draw the ellipse, or tap to drop one.",
    line: "Drag from one point to the other, or tap to drop a line.",
    highlight: "Drag over the text you want to highlight.",
    check: "Tap the box to leave the symbol, or drag to give it another size.",
  },
  edit: {
    name: "Edit",
    label: (count) => `Edit (${count})`,
    preparing: "Getting the document ready to edit…",
    nothingToApply: "There are no changes to apply yet.",
    largeFile: "This PDF is over 100 MB: the browser may run out of memory while editing it.",
  },
  annotate: {
    name: "Annotate",
    label: (count) => `Annotations (${count})`,
    textToggle: "Select text",
    textToggleOn: "Select text: on",
    textToggleOff: "Select text: off",
    textToggleDisabled: "Select text is turned off in Settings (“Edit the text the PDF already has”).",
    nothingToApply: "There are no annotations to apply yet.",
  },
  names: {
    edit: { bar: "Editing", short: "Edit" },
    annotate: { bar: "Annotating", short: "Annotate" },
    sign: { bar: "Signing", short: "Sign" },
    fill: { bar: "Filling in", short: "Fill in form" },
  },
  commands: {
    editText: "Edit text",
    annotate: "Annotate",
    addImage: "Add image",
    highlight: "Highlight text",
    addNote: "Add note",
    addShape: "Draw a rectangle",
    signDocument: "Sign document",
    fillForm: "Fill in form",
  },
  shortcuts: {
    openEdit: "Open Edit mode",
    openAnnotate: "Open Annotate mode",
    openSign: "Open Sign mode",
    openFill: "Open Fill in form",
  },
};

const STRINGS: Record<Language, ModeStrings> = { es: ES, en: EN };

export function getModeStrings(language: Language): ModeStrings {
  return STRINGS[language] ?? ES;
}

export const MODE_STRINGS = STRINGS;

/** Nombre de un modo en la barra («Editando», «Firmando»...); un id desconocido cae en el generico `working`. */
export function modeBarName(language: Language, tab: string): string {
  const m = getModeStrings(language);
  const known = (m.names as Record<string, { bar: string; short: string }>)[tab];
  return known ? known.bar : m.host.working(tab);
}

/** Nombre del modo como sustantivo («Editar», «Firmar», «Rellenar formulario»): para frases como «los cambios de “Editar”». */
export function modeShortName(language: Language, tab: string): string {
  const m = getModeStrings(language);
  const known = (m.names as Record<string, { bar: string; short: string }>)[tab];
  return known ? known.short : tab;
}
