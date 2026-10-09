"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CalendarDays,
  CaseUpper,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  CornerUpLeft,
  Move,
  PenLine,
  Signature,
  SquareCheck,
  Trash2,
  Type,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Spinner } from "@/components/ui/Spinner";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type NormalizedRect,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import {
  SIGNER_COLORS,
  normalizeFieldLabel,
  signerDisplayName,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";
import {
  fieldTypeOf,
  isFieldFilled,
  type DetectedField,
  type DetectedFieldType,
} from "@/lib/pdf/detectFields";
import type { SignStrings } from "@/app/sign-pdf/strings";
import {
  SOLO_SIGNER_ID,
  SOLO_SLOT_ID,
  defaultSoloRect,
  refitSoloRect,
} from "@/app/sign-pdf/soloSignature";
import { pageAspectOf } from "@/app/sign-pdf/pageAspect";
import { ValueSuggestions } from "@/app/sign-pdf/ValueSuggestions";
import {
  BarButton,
  BarGroup,
  FloatingFieldBar,
} from "@/app/sign-pdf/FloatingFieldBar";
import { ToolPalette } from "@/app/sign-pdf/ToolPalette";
import {
  IDEAL_TARGET_PX,
  expandHitTargets,
  findFreeSpot,
  type BarSide,
  type Insets,
} from "@/app/sign-pdf/canvasGeometry";
import {
  TEXT_FIELD_DEFAULTS,
  TOOL_CREATES,
  availableTools,
  convertValueForType,
  toolFromShortcut,
  type PlacementTool,
} from "@/app/sign-pdf/canvasTools";
import {
  forgetValue,
  recordValue,
  suggestValues,
  useValueHistoryVersion,
} from "@/lib/valueHistory";

/*
 * W2-C: el mismo lienzo sirve al modo "Solo yo" (`solo`): la firma propia es el
 * unico hueco, se pinta con su imagen y la herramienta Firma la coloca o la
 * mueve; zoom y paginas van en una barra pegajosa (siempre al alcance) con
 * botones de 44 px bajo puntero grueso, y el selector de tipo de la barra se
 * cierra cuando el foco sale de ella.
 *
 * W2-B: la herramienta activa de la paleta (`ToolPalette`) decide que crea un
 * toque o un arrastre; la barra flotante (`FloatingFieldBar`) concentra las
 * acciones del elemento seleccionado; con puntero grueso cada elemento
 * amplia su zona de toque sin solapar a los vecinos (`expandHitTargets`).
 *
 * Lienzo unico del paso "Documento" (W2-A): sobre cada pagina conviven
 * los huecos de firma/iniciales (un `SignatureField` por firmante y tipo)
 * y los campos de texto/casilla/fecha/iniciales (`DetectedField`,
 * detectados o anadidos a mano). Se unifica la INTERFAZ, no el modelo de
 * datos: `fields` y `textFields` + `textValues` siguen viviendo aparte en
 * `SignToolOptions`, para que borradores, plantillas y la configuracion
 * exportada se lean igual que antes. Lo que si es uno solo aqui: la
 * pagina visible, la seleccion (un elemento de cualquier tipo), el
 * "Deshacer" pendiente, el zoom y los gestos.
 */

const PREVIEW_WIDTH = 900;
const THUMB_WIDTH = 96;

/** Lado minimo de un elemento, en fraccion de pagina. */
const MIN_FIELD_SIDE = 0.02;

/** Movimiento por debajo del cual un puntero sobre lienzo vacio cuenta como clic, no arrastre. */
const CLICK_SLOP = 0.004;

/**
 * Movimiento (en pixeles fisicos, no fraccion de pagina) por debajo del
 * cual tocar un elemento YA EXISTENTE cuenta como un toque (abre el
 * editor / selecciona) y no como el inicio de un arrastre. El temblor
 * real de un dedo es una cantidad de pixeles constante, sin importar el
 * zoom de la vista previa: 8px coincide con el "touch slop" de referencia
 * de Android (8dp) y esta cerca del de iOS (~10pt).
 */
const TAP_MOVE_THRESHOLD_PX = 8;

/**
 * `Button size="sm"` amplia su zona de toque a 44 px bajo puntero grueso con
 * `-inset-y-1`, pero la variante `secondary` lleva borde de 1 px y el inset
 * se mide desde la caja de relleno (34 px): 34 + 8 = 42. Con 5 px por lado
 * llega a 44. (Pendiente en el `Button` compartido: ver Backlog de W2-A.)
 */
const BORDERED_SM_COARSE = "pointer-coarse:before:-inset-y-[5px]";

/**
 * Con puntero grueso el boton `sm` pasa a medir 44 px de alto de verdad (no solo
 * su zona de toque): zoom, paginas y altas del lienzo. En ese caso la zona
 * ampliada del `::before` ya no hace falta y vuelve a la caja del boton.
 */
const COARSE_TALL = "pointer-coarse:h-11 pointer-coarse:before:hidden";

const MAX_ZOOM = 3;
/** Niveles de los botones de zoom (el pellizco admite cualquier valor entre 1 y `MAX_ZOOM`). */
const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

/** Limita el desplazamiento para que la hoja ampliada nunca deje de cubrir la tarjeta. */
function clampPan(
  pan: { x: number; y: number },
  zoom: number,
  size: { width: number; height: number },
): { x: number; y: number } {
  const maxX = Math.max(0, (size.width * (zoom - 1)) / 2);
  const maxY = Math.max(0, (size.height * (zoom - 1)) / 2);
  return { x: clamp(pan.x, -maxX, maxX), y: clamp(pan.y, -maxY, maxY) };
}

/** Tipos de campo de texto en el selector de la barra (icono por tipo). */
const TEXT_TYPE_OPTIONS = [
  ["text", Type],
  ["checkbox", SquareCheck],
  ["date", CalendarDays],
  ["initials", CaseUpper],
] as const;

/** Lado minimo (px de pantalla) de una casilla creada con un toque. */
const CHECKBOX_MIN_PX = 24;
/** Por debajo de este lado (px) una casilla dibujada se considera un temblor y vale el tamano por defecto. */
const CHECKBOX_DRAWN_MIN_PX = 16;

/** Un elemento cuyos DOS lados miden menos que esto (px de pantalla) lleva el tirador fuera de la caja. */
const TINY_ELEMENT_PX = 40;
/** Cota generosa del desplazamiento por pellizco: solo evita valores disparatados. */
const PAN_LIMIT_PX = 400;

/** Ancho inicial y proporcion (alto/ancho en pixeles) de cada tipo de hueco. */
const DEFAULT_SLOT: Record<SignatureFieldType, { width: number; ratio: number }> =
  {
    signature: { width: 0.3, ratio: 1 / 3 },
    initials: { width: 0.11, ratio: 1 },
  };

/** Color de un campo de texto sobre la pagina (dato, no token: va en linea como el de los firmantes). */
const TEXT_FIELD_COLOR = "#0d4bff";
const LOW_CONFIDENCE_COLOR = "#f59e0b";
/** Color del valor escrito y del fallback de un hueco sin dueño: siempre sobre la pagina (clara). */
const INK_ON_PAGE = "#111827";
const ORPHAN_SLOT_COLOR = "#8b95a5";
/** Color de la firma propia en "Solo yo" (distinto del azul de los campos de texto). */
const SOLO_COLOR = SIGNER_COLORS[4];

/* ------------------------------------------------------------------ *
 * Identificadores
 * ------------------------------------------------------------------ */

/**
 * Identificadores estables sin depender de `crypto.randomUUID`. Exportado
 * (no solo de uso interno) porque aplicar una plantilla de disposicion
 * (`signTemplates.ts`) tiene que acuñar ids nuevos con el mismo contador
 * que "anadir a mano" -- nunca reutilizar los ids guardados en la
 * plantilla, que pueden colisionar con los del documento actual.
 */
let fieldCounter = 0;
export function nextFieldId(): string {
  fieldCounter += 1;
  return `fld-${fieldCounter}`;
}

/**
 * Adelanta el contador por encima de los ids ya en uso. Necesario al
 * restaurar un borrador o una configuracion importada: el contador
 * arranca en 0 en cada carga de pagina, asi que sin esto un hueco nuevo
 * anadido despues de restaurar podria regenerar un id ya usado por el
 * borrador (`fld-1` de nuevo) y pisar silenciosamente el original.
 */
export function reserveFieldIds(ids: readonly string[]): void {
  for (const id of ids) {
    const match = /^fld-(\d+)$/.exec(id);
    if (match) fieldCounter = Math.max(fieldCounter, Number(match[1]));
  }
}

/** Identificadores estables para los campos de texto anadidos a mano (`txt-N`). */
let textFieldCounter = 0;
export function nextTextFieldId(): string {
  textFieldCounter += 1;
  return `txt-${textFieldCounter}`;
}

/** Mismo motivo que `reserveFieldIds`, para los campos de texto. */
export function reserveTextFieldIds(ids: readonly string[]): void {
  for (const id of ids) {
    const match = /^txt-(\d+)$/.exec(id);
    if (match) textFieldCounter = Math.max(textFieldCounter, Number(match[1]));
  }
}

/* ------------------------------------------------------------------ *
 * Tipos publicos
 * ------------------------------------------------------------------ */

export type { PlacementTool };

export type CanvasElementKind = "slot" | "text";

/** Un unico elemento seleccionado a la vez, de cualquiera de los dos tipos. */
export type CanvasSelection = { kind: CanvasElementKind; id: string };

/**
 * Modo "Solo yo" (W2-C): la firma propia es el unico hueco del lienzo y se
 * pinta con su imagen. Sin firmantes ni iniciales; la herramienta Firma coloca
 * (o mueve) esa firma y, si aun no existe, abre su compositor.
 */
export type SoloConfig = {
  /** PNG de la firma (data URL), o `""` si aun no se ha creado. */
  signaturePng: string;
  /** alto / ancho del PNG; 0 mientras no hay firma. */
  ratio: number;
  /** Abre el compositor de la firma. */
  onCreateSignature: () => void;
  /**
   * Baul de firmas (W3), opcional: abre la hoja de firmas guardadas. Ausente
   * = baul apagado o no disponible, y el lienzo se comporta como siempre.
   */
  onOpenSaved?: () => void;
  /** Hay firmas guardadas: la herramienta Firma, sin firma creada, las ofrece antes de abrir el compositor. */
  hasSaved?: boolean;
};

/**
 * Acciones que el lienzo expone a la vista continua (`DocumentSequence`): ir a
 * una pagina de ESTE documento con los mismos efectos que el paginador de
 * siempre (aborta un gesto a medias y cierra el editor).
 */
export type CanvasHandle = {
  goToPage: (index: number) => void;
};

/**
 * Vista continua (W4-U4): varios PDF que se ven como uno. El envoltorio
 * (`DocumentSequence`) vive FUERA del `key` del lienzo y pinta el paginador
 * global y la tira de miniaturas, para que el foco no caiga a `<body>` al
 * cruzar de un documento a otro (el lienzo se remonta por documento). Con
 * `sequence` ausente (un solo documento) el lienzo se comporta exactamente
 * como siempre.
 */
export type CanvasSequence = {
  /** El paginador lo pinta el envoltorio. */
  hidePager: boolean;
  /** La tira de miniaturas la pinta el envoltorio. */
  hideThumbs: boolean;
  /** Donde va el zoom (en la barra pegajosa del envoltorio); `null` = aun no esta. */
  zoomSlot: HTMLElement | null;
  /** Nodo del lienzo donde el envoltorio pinta la tira de miniaturas. */
  setThumbsSlot: (element: HTMLElement | null) => void;
  /** Alta y baja del lienzo montado (devuelve la baja). */
  register: (handle: CanvasHandle) => () => void;
  /** Paginas del documento recien abierto: ahorra una apertura al envoltorio. */
  onPageCount: (count: number) => void;
  /**
   * No queda un campo pendiente mas alla de aqui en esta direccion: busca en los
   * demas documentos. `true` = ya se salto a otro documento.
   */
  onNoPendingHere: (direction: 1 | -1) => boolean;
  /** Hay campos pendientes en otros documentos (activa «siguiente/anterior campo»). */
  othersPending: boolean;
};

export type DocumentCanvasProps = {
  file: File | null;
  signers: Signer[];
  activeSignerId: string | null;
  onActiveSignerIdChange: (id: string) => void;
  /** Herramienta activa de la paleta: decide que crea un toque o un arrastre. */
  tool: PlacementTool;
  onToolChange: (tool: PlacementTool) => void;
  slots: SignatureField[];
  onSlotsChange: (fields: SignatureField[]) => void;
  textFields: DetectedField[];
  onTextFieldsChange: (fields: DetectedField[]) => void;
  /** Valor actual de cada campo de texto, indexado por `id`. */
  values: Record<string, string>;
  onValueChange: (id: string, value: string) => void;
  pageIndex: number;
  onPageIndexChange: (index: number) => void;
  selection: CanvasSelection | null;
  onSelectionChange: (selection: CanvasSelection | null) => void;
  /** Campo de texto con el input en linea abierto -- distinto de "seleccionado". */
  editingId: string | null;
  onEditingIdChange: (id: string | null) => void;
  strings: SignStrings;
  onError?: (code: PdfErrorCode) => void;
  /** Tab/Enter en un campo de texto salta al siguiente pendiente en vez de cerrar el editor. */
  keyboardNavEnabled?: boolean;
  /** Borrar muestra "Deshacer" (6 s) en vez de borrar sin red. */
  undoDeleteEnabled?: boolean;
  /** Permite elegir el tipo del campo de texto seleccionado (casilla, fecha, inicial). */
  richFieldTypesEnabled?: boolean;
  /** Pellizco con dos dedos para acercar el lienzo. */
  pinchZoomEnabled?: boolean;
  /** Presente = modo "Solo yo" (ver `SoloConfig`). */
  solo?: SoloConfig;
  /** Presente = parte de una vista continua de varios documentos (ver `CanvasSequence`). */
  sequence?: CanvasSequence;
};

/* ------------------------------------------------------------------ *
 * Tipos internos
 * ------------------------------------------------------------------ */

type DragMode = "move" | "resize";

type DragState = {
  kind: CanvasElementKind;
  mode: DragMode;
  id: string;
  startX: number;
  startY: number;
  snapshot: NormalizedRect;
  /** Puntero que inicio el gesto: un segundo dedo no debe poder finalizarlo ni moverlo. */
  pointerId: number;
  /** `true` en cuanto el movimiento supera `TAP_MOVE_THRESHOLD_PX`; hasta entonces es un toque en potencia. */
  moved: boolean;
};

type Draft = { x: number; y: number; toX: number; toY: number };

/**
 * Un unico "Deshacer" pendiente a la vez (no una cola), de cualquiera de
 * los dos tipos: borrar otro elemento mientras el anterior sigue
 * deshacible lo reemplaza sin mas. Restaura el id y el rect EXACTOS
 * (nunca regenerados): `captureStamp` (`SigningCeremony.tsx`) los usa para
 * validar la captura del firmante, asi que borrar y deshacer un hueco
 * tiene que revalidarla en silencio.
 */
type PendingUndo =
  | { kind: "slot"; field: SignatureField; index: number }
  | { kind: "text"; field: DetectedField; index: number; value: string }
  /** Cambio de tipo que borro el valor: repone el tipo y el valor exactos. */
  | {
      kind: "type";
      id: string;
      previousType: DetectedFieldType | undefined;
      toType: DetectedFieldType;
      value: string;
    };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

/** Orden de lectura: pagina, luego de arriba abajo y de izquierda a derecha. */
function byDocumentOrder<T extends { pageIndex: number; rect: NormalizedRect }>(
  a: T,
  b: T,
): number {
  return (
    a.pageIndex - b.pageIndex || a.rect.y - b.rect.y || a.rect.x - b.rect.x
  );
}

function sameSelection(
  a: CanvasSelection | null,
  b: CanvasSelection | null,
): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

/**
 * El lienzo se remonta si cambia la identidad del archivo: la vista
 * previa, las miniaturas, el zoom y el "Deshacer" pendiente describen un
 * documento concreto.
 */
export function DocumentCanvas(props: DocumentCanvasProps) {
  const key = props.file
    ? `${props.file.name}:${props.file.size}:${props.file.lastModified}`
    : "empty";
  return <DocumentCanvasInner key={key} {...props} />;
}

function DocumentCanvasInner({
  file,
  signers,
  activeSignerId,
  onActiveSignerIdChange,
  tool,
  onToolChange,
  slots,
  onSlotsChange,
  textFields,
  onTextFieldsChange,
  values,
  onValueChange,
  pageIndex,
  onPageIndexChange,
  selection,
  onSelectionChange,
  editingId,
  onEditingIdChange,
  strings,
  onError,
  keyboardNavEnabled = false,
  undoDeleteEnabled = false,
  richFieldTypesEnabled = false,
  pinchZoomEnabled = false,
  solo,
  sequence,
}: DocumentCanvasProps) {
  const [pageCount, setPageCount] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  /**
   * Proporcion ancho/alto de la pagina que se ve, leida del propio PDF (con su
   * rotacion), o `null` si no se pudo leer. Es la fuente fiable para colocar la
   * firma al montar: la caja medida (`hostSize`) todavia es la del marcador de
   * posicion 3:4 cuando llega la vista previa, y una firma colocada con esa
   * proporcion sale deformada en las paginas que no son 3:4.
   */
  const [previewAspect, setPreviewAspect] = useState<number | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmClearAllOpen, setConfirmClearAllOpen] = useState(false);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);
  /** Lado en que la barra flotante resolvio colocarse (el desplegable de sugerencias va al opuesto). */
  const [barSide, setBarSide] = useState<BarSide | null>(null);
  /** Texto para la region viva (cambios de herramienta, duplicados, saltos de campo). */
  const [announcement, setAnnouncement] = useState("");
  /** Tamano de layout de la pagina (sin zoom): `hostSize` se mide transformado. */
  const [layoutSize, setLayoutSize] = useState({ width: 0, height: 0 });
  const coarse = useMediaQuery("(pointer: coarse)");
  /** Campo cuyo selector de tipo esta abierto en la barra (se cierra al cambiar de seleccion o al salir el foco de la barra). */
  const [typePickerFor, setTypePickerFor] = useState<string | null>(null);
  /** Lado preferido de la barra para el elemento seleccionado (se fija al seleccionar). */
  const [barPrefs, setBarPrefs] = useState<{ id: string | null; prefer: "top" | "bottom" }>({
    id: null,
    prefer: "top",
  });

  /**
   * Zoom con pellizco: `zoom` y `pan` viven aqui, no en el padre -- solo
   * importan mientras este lienzo concreto este montado.
   * `activePointersRef` registra TODOS los punteros activos para poder
   * medir la distancia entre dos dedos; `pinchRef` solo existe mientras
   * el pellizco esta en marcha.
   */
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(
    new Map(),
  );
  /**
   * Seleccionar sobre la pagina vacia: un toque CORTO (sin movimiento) la
   * deselecciona al SOLTAR, no al pulsar. Pulsar puede ser el primer dedo de
   * un pellizco, de un scroll o de un desplazamiento de la hoja con zoom, y
   * ninguno de esos debe cerrar la barra ni el editor.
   */
  const tapCandidateRef = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  /** Con zoom > 1 y Seleccionar, un dedo sobre lo vacio desplaza la hoja (mover el lienzo). */
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startPan: { x: number; y: number };
  } | null>(null);
  const pinchRef = useRef<{
    pointerIds: [number, number];
    startDistance: number;
    startZoom: number;
    startPan: { x: number; y: number };
    startMid: { x: number; y: number };
  } | null>(null);

  // Re-renderiza este subarbol cuando el historial de valores cambia,
  // incluida otra pestaña (borrar datos ahi apaga las sugerencias aqui).
  useValueHistoryVersion();

  const addButtonRef = useRef<HTMLButtonElement>(null);
  const undoButtonRef = useRef<HTMLButtonElement>(null);
  /**
   * Foco tras quitar elementos: al desmontarse el elemento (o su boton de
   * "quitar") el foco caeria a `<body>`. `refocusAfterRemoveRef` pide
   * recolocarlo en el siguiente render (ver el efecto de mas abajo).
   * `restoreFocusToRef` guarda el elemento al que devolver el foco: el
   * campo cuyo editor cierra Escape (el input se desmonta) o el elemento
   * repuesto por "Deshacer" (el boton se desmonta).
   */
  const refocusAfterRemoveRef = useRef(false);
  const restoreFocusToRef = useRef<{ kind: CanvasElementKind; id: string } | null>(
    null,
  );
  useEffect(() => {
    if (!pendingUndo) return;
    const timer = window.setTimeout(() => {
      // Si el foco esta en "Deshacer", que se desmonta con el aviso, se
      // recoloca en vez de caer a <body> (ver el efecto de foco).
      if (document.activeElement === undoButtonRef.current) {
        refocusAfterRemoveRef.current = true;
      }
      setPendingUndo(null);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [pendingUndo]);

  /** Al cerrar el selector de tipo con el teclado, el foco vuelve al boton que lo abre. */
  const pendingTypeButtonFocusRef = useRef(false);
  /** Valor original de un campo cuyo texto se abrevio al pasar a "iniciales" (para devolverlo al volver a texto). */
  const initialsOriginalRef = useRef<Map<string, { original: string; formatted: string }>>(
    new Map(),
  );
  /**
   * Casillas "tocadas" en esta pasada por el documento: una casilla sin
   * marcar cuenta como pendiente para Tab/Enter solo mientras nadie la
   * haya visitado o alternado. Es estado de esta sesion de edicion, no del
   * documento: nunca entra en el autoguardado ni en la configuracion
   * exportada, y se reinicia al remontar el lienzo (salir del paso y
   * volver), que es lo correcto: una pasada nueva vuelve a ofrecer cada
   * casilla una vez. Es estado (no un ref) porque el aviso de "campo
   * anterior/siguiente" de la paleta se pinta segun lo que queda pendiente.
   */
  const [touchedCheckboxes, setTouchedCheckboxes] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const markCheckboxTouched = useCallback((id: string) => {
    setTouchedCheckboxes((current) =>
      current.has(id) ? current : new Set(current).add(id),
    );
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  /** Escenario `relative` (sin overflow) que aloja la tarjeta de la pagina y la barra flotante. */
  const stageRef = useRef<HTMLDivElement>(null);
  /** Tarjeta con `overflow:hidden` que recorta la pagina al hacer zoom. */
  const clipRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  /** Pagina en la que empezo el borrador en curso: si al soltar es otra, el gesto se descarta. */
  const gesturePageRef = useRef(pageIndex);
  const draftOriginRef = useRef<{ x: number; y: number } | null>(null);
  const errorRef = useRef(onError);

  useEffect(() => {
    errorRef.current = onError;
  });

  /**
   * Vista continua: el envoltorio (fuera del `key` del lienzo) lleva el
   * paginador, la tira de miniaturas y el recuento de paginas. Se lee por
   * `ref` (las funciones cambian en cada render del padre) salvo lo que decide
   * si este lienzo hace o no el trabajo.
   */
  const sequenceRef = useRef(sequence);
  useEffect(() => {
    sequenceRef.current = sequence;
  });
  const thumbsInSequence = Boolean(sequence?.hideThumbs);
  const registerSequence = sequence?.register;
  /** Hueco de la tira de miniaturas global: el nodo se entrega al envoltorio (estable entre renders). */
  const attachThumbsSlot = useCallback((element: HTMLDivElement | null) => {
    sequenceRef.current?.setThumbsSlot(element);
  }, []);

  /* Miniaturas de navegacion: una pasada secuencial por el documento. */
  useEffect(() => {
    if (!file || thumbsInSequence) return;
    let cancelled = false;

    void (async () => {
      try {
        const document = await openPdfDocument(file);
        if (cancelled) {
          void closePdfDocument(document);
          return;
        }
        setPageCount(document.numPages);

        const collected: string[] = [];
        for (let index = 1; index <= document.numPages; index += 1) {
          if (cancelled) break;
          const page = await document.getPage(index);
          const url = await renderPageToDataUrl(page, { maxWidth: THUMB_WIDTH });
          page.cleanup();
          collected.push(url);
          if (!cancelled) setThumbs([...collected]);
        }
        void closePdfDocument(document);
      } catch (error) {
        if (!cancelled) errorRef.current?.(toPdfError(error).code);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, thumbsInSequence]);

  /* Vista grande de la pagina activa. */
  useEffect(() => {
    if (!file) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const document = await openPdfDocument(file);
        if (cancelled) {
          void closePdfDocument(document);
          return;
        }
        setPageCount(document.numPages);
        sequenceRef.current?.onPageCount(document.numPages);
        const number = Math.min(
          Math.max(1, pageIndex + 1),
          Math.max(1, document.numPages),
        );
        const page = await document.getPage(number);
        const viewport = page.getViewport?.({ scale: 1 });
        const url = await renderPageToDataUrl(page, { maxWidth: PREVIEW_WIDTH });
        page.cleanup();
        void closePdfDocument(document);
        if (!cancelled) {
          setPreview(url);
          setPreviewAspect(
            viewport && viewport.height > 0 ? viewport.width / viewport.height : null,
          );
        }
      } catch (error) {
        if (!cancelled) errorRef.current?.(toPdfError(error).code);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, pageIndex]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => {
      const bounds = host.getBoundingClientRect();
      setHostSize({ width: bounds.width, height: bounds.height });
      setLayoutSize({ width: host.offsetWidth, height: host.offsetHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    return () => observer.disconnect();
  }, [preview]);

  /* ---------------------------------------------------------------- *
   * Derivados
   * ---------------------------------------------------------------- */

  /**
   * Herramientas utilizables ahora (firma e iniciales necesitan firmantes;
   * casilla y fecha dependen de `richFieldTypes`). Una herramienta que deja
   * de estar disponible (se borro al ultimo firmante, se apago el ajuste)
   * se trata como Seleccionar.
   */
  const tools = useMemo(
    () =>
      availableTools({
        hasSigners: signers.length > 0,
        richFieldTypes: richFieldTypesEnabled,
        solo: Boolean(solo),
      }),
    [signers.length, richFieldTypesEnabled, solo],
  );
  const effectiveTool: PlacementTool = tools.includes(tool) ? tool : "select";
  /** Que crea la herramienta activa (`null` = Seleccionar). */
  const creates = effectiveTool === "select" ? null : TOOL_CREATES[effectiveTool];

  const signerById = (id: string): Signer | null =>
    id === SOLO_SIGNER_ID && solo
      ? { id: SOLO_SIGNER_ID, name: "", color: SOLO_COLOR }
      : (signers.find((signer) => signer.id === id) ?? null);

  /** Nombre a mostrar de un firmante por id, con el mismo fallback numerado que `SignerManager`. */
  const signerDisplayNameById = (id: string): string => {
    const index = signers.findIndex((signer) => signer.id === id);
    if (index === -1) return "";
    return signerDisplayName(signers[index].name, index, strings.defaultSignerName);
  };

  const slotTypeLabel = (type: SignatureFieldType): string =>
    type === "signature" ? strings.fieldSignature : strings.fieldInitials;

  const textTypeLabel = (type: DetectedFieldType): string =>
    type === "checkbox"
      ? strings.fieldTypeCheckbox
      : type === "date"
        ? strings.fieldTypeDate
        : type === "initials"
          ? strings.fieldTypeInitials
          : strings.fieldTypeText;

  const toolLabel = (id: PlacementTool): string => {
    switch (id) {
      case "select":
        return strings.toolSelect;
      case "signature":
        return strings.fieldSignature;
      case "initials":
        return strings.fieldInitials;
      case "text":
        return strings.fieldTypeText;
      case "checkbox":
        return strings.fieldTypeCheckbox;
      case "date":
        return strings.fieldTypeDate;
    }
  };

  const slotLabel = (field: SignatureField): string =>
    solo
      ? strings.soloSignatureLabel
      : strings.fieldOwnerLabel(
          signerDisplayNameById(field.signerId),
          slotTypeLabel(field.type),
        );

  /** Rol del hueco en su nombre accesible ("hueco de firma"; en "Solo yo", "firma colocada"). */
  const slotRole = solo ? strings.soloSignatureA11y : strings.a11ySlot;
  /** En "Solo yo" ya hay firma para colocar? Sin ella la herramienta Firma abre el compositor. */
  const canPlaceSlot = solo ? true : Boolean(activeSignerId);

  const textLabel = (field: DetectedField): string => {
    if (field.label) return field.label;
    const globalIndex = textFields.findIndex((candidate) => candidate.id === field.id);
    return strings.textFieldFallbackLabel(globalIndex + 1);
  };

  const activeSigner = activeSignerId ? signerById(activeSignerId) : null;
  const pageSlots = slots.filter((field) => field.pageIndex === pageIndex);
  const pageTextFields = textFields.filter((field) => field.pageIndex === pageIndex);

  const selectedTextField =
    selection?.kind === "text"
      ? (textFields.find((field) => field.id === selection.id) ?? null)
      : null;

  /* ---------------------------------------------------------------- *
   * Seleccion
   * ---------------------------------------------------------------- */

  /** Seleccionar otro elemento cierra el editor que estuviera abierto. */
  const select = useCallback(
    (next: CanvasSelection | null) => {
      if (editingId && (next?.kind !== "text" || next.id !== editingId)) {
        onEditingIdChange(null);
      }
      if (!sameSelection(selection, next)) onSelectionChange(next);
    },
    [editingId, onEditingIdChange, selection, onSelectionChange],
  );

  /**
   * Armar una herramienta de creacion deselecciona: la barra flotante (que
   * flota sobre los vecinos del elemento) estorbaria al tocar la pagina para
   * colocar algo nuevo, y el editor en linea abierto se cierra. Volver a
   * Seleccionar no toca la seleccion.
   */
  const changeTool = useCallback(
    (next: PlacementTool) => {
      // "Solo yo" sin firma creada: la herramienta Firma no coloca nada, abre el compositor.
      if (next === "signature" && solo && !solo.signaturePng) {
        // Con firmas guardadas se ofrecen (la hoja trae «Crear una firma nueva»); sin ellas, como siempre.
        if (solo.hasSaved && solo.onOpenSaved) solo.onOpenSaved();
        else solo.onCreateSignature();
        return;
      }
      if (next !== "select") select(null);
      onToolChange(next);
    },
    [select, onToolChange, solo],
  );

  /* ---------------------------------------------------------------- *
   * Mutaciones
   * ---------------------------------------------------------------- */

  const addSlot = useCallback(
    (rect: NormalizedRect, type: SignatureFieldType) => {
      if (solo) {
        // Una sola firma: colocarla otra vez la MUEVE (mismo id, mismo dueño).
        const field: SignatureField = {
          id: SOLO_SLOT_ID,
          signerId: SOLO_SIGNER_ID,
          pageIndex,
          type: "signature",
          rect,
        };
        onSlotsChange([field]);
        select({ kind: "slot", id: field.id });
        restoreFocusToRef.current = { kind: "slot", id: field.id };
        return;
      }
      if (!activeSignerId) return;
      const field: SignatureField = {
        id: nextFieldId(),
        signerId: activeSignerId,
        pageIndex,
        type,
        rect,
      };
      onSlotsChange([...slots, field]);
      select({ kind: "slot", id: field.id });
      // El boton "Anadir aqui" (si lo pulso el teclado) se desmonta al volver a
      // Seleccionar: el foco pasa al hueco recien creado.
      restoreFocusToRef.current = { kind: "slot", id: field.id };
    },
    [activeSignerId, slots, onSlotsChange, select, pageIndex, solo],
  );

  const addTextField = useCallback(
    (rect: NormalizedRect, type: DetectedFieldType) => {
      const field: DetectedField = {
        id: nextTextFieldId(),
        pageIndex,
        rect,
        source: "manual",
        confidence: "high",
        // "Ausente = texto": solo se escribe el tipo cuando no lo es.
        ...(type === "text" ? {} : { type }),
      };
      onTextFieldsChange([...textFields, field]);
      onSelectionChange({ kind: "text", id: field.id });
      if (type === "checkbox") {
        // Una casilla no tiene modo "editar": queda seleccionada y enfocada.
        restoreFocusToRef.current = { kind: "text", id: field.id };
      } else {
        onEditingIdChange(field.id);
      }
    },
    [textFields, onTextFieldsChange, onSelectionChange, onEditingIdChange, pageIndex],
  );

  const patchRect = useCallback(
    (kind: CanvasElementKind, id: string, rect: NormalizedRect) => {
      if (kind === "slot") {
        onSlotsChange(
          slots.map((field) => (field.id === id ? { ...field, rect } : field)),
        );
        return;
      }
      onTextFieldsChange(
        textFields.map((field) => (field.id === id ? { ...field, rect } : field)),
      );
    },
    [slots, onSlotsChange, textFields, onTextFieldsChange],
  );

  const removeElement = useCallback(
    (kind: CanvasElementKind, id: string) => {
      refocusAfterRemoveRef.current = true;
      if (kind === "slot") {
        const index = slots.findIndex((field) => field.id === id);
        if (undoDeleteEnabled && index !== -1) {
          setPendingUndo({ kind: "slot", field: slots[index], index });
        }
        onSlotsChange(slots.filter((field) => field.id !== id));
      } else {
        const index = textFields.findIndex((field) => field.id === id);
        if (undoDeleteEnabled && index !== -1) {
          setPendingUndo({
            kind: "text",
            field: textFields[index],
            index,
            value: values[id] ?? "",
          });
        }
        onTextFieldsChange(textFields.filter((field) => field.id !== id));
        if (editingId === id) onEditingIdChange(null);
      }
      if (selection?.kind === kind && selection.id === id) onSelectionChange(null);
    },
    [
      slots,
      textFields,
      values,
      undoDeleteEnabled,
      onSlotsChange,
      onTextFieldsChange,
      editingId,
      onEditingIdChange,
      selection,
      onSelectionChange,
    ],
  );

  /** Repone el elemento borrado en su posicion original, id y rect intactos (y su valor, si lo tenia). */
  const restorePendingUndo = useCallback(() => {
    if (!pendingUndo) return;
    if (pendingUndo.kind === "type") {
      onTextFieldsChange(
        textFields.map((field) =>
          field.id === pendingUndo.id ? { ...field, type: pendingUndo.previousType } : field,
        ),
      );
      onValueChange(pendingUndo.id, pendingUndo.value);
      select({ kind: "text", id: pendingUndo.id });
      restoreFocusToRef.current = { kind: "text", id: pendingUndo.id };
      setPendingUndo(null);
      return;
    }
    if (pendingUndo.kind === "slot") {
      const next = [...slots];
      next.splice(Math.min(pendingUndo.index, next.length), 0, pendingUndo.field);
      onSlotsChange(next);
    } else {
      const next = [...textFields];
      next.splice(Math.min(pendingUndo.index, next.length), 0, pendingUndo.field);
      onTextFieldsChange(next);
      if (pendingUndo.value) onValueChange(pendingUndo.field.id, pendingUndo.value);
    }
    select({ kind: pendingUndo.kind, id: pendingUndo.field.id });
    restoreFocusToRef.current = { kind: pendingUndo.kind, id: pendingUndo.field.id };
    setPendingUndo(null);
  }, [pendingUndo, slots, onSlotsChange, textFields, onTextFieldsChange, onValueChange, select]);

  /*
   * Teclado global: Supr/Retroceso borra el seleccionado; Escape cierra el
   * editor y, si no hay nada que cerrar, devuelve la herramienta a Seleccionar.
   */
  const removeRef = useRef(removeElement);
  const editingIdRef = useRef(editingId);
  const confirmOpenRef = useRef(confirmClearAllOpen);
  const toolRef = useRef(effectiveTool);
  const toolsRef = useRef(tools);
  const changeToolRef = useRef(changeTool);
  useEffect(() => {
    removeRef.current = removeElement;
    editingIdRef.current = editingId;
    confirmOpenRef.current = confirmClearAllOpen;
    toolRef.current = effectiveTool;
    toolsRef.current = tools;
    changeToolRef.current = changeTool;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Con un dialogo modal abierto ("Borrar todos") las teclas son suyas:
      // ni Supr borra por detras ni Escape toca el editor.
      if (confirmOpenRef.current) return;
      const origin = event.target as HTMLElement | null;
      if (origin?.closest?.('[role="dialog"], [aria-modal="true"]')) return;
      // Un Escape ya atendido (p. ej. el que cierra las sugerencias del
      // input) no sale ademas de la edicion.
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        // Escape sale del editor sin perder la seleccion (tiradores y
        // "quitar" siguen visibles) y devuelve el foco al propio campo
        // (el input se desmonta); si no se estaba editando, no hace mas.
        if (editingIdRef.current) {
          restoreFocusToRef.current = { kind: "text", id: editingIdRef.current };
          onEditingIdChange(null);
          return;
        }
        if (toolRef.current !== "select") {
          onToolChange("select");
          return;
        }
        onEditingIdChange(null);
        return;
      }
      if (!selection) return;
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable) return;
      if (target && /^(input|textarea|select)$/i.test(target.tagName)) return;
      event.preventDefault();
      removeRef.current(selection.kind, selection.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selection, onEditingIdChange, onToolChange]);

  /*
   * Atajos de una letra para las herramientas (V F I T C D). WCAG 2.1.4: solo
   * actuan con el foco dentro del paso o sin foco en ningun control, y nunca
   * mientras se escribe, con un modificador o dentro de un dialogo.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing || event.repeat || confirmOpenRef.current) return;
      const target = event.target instanceof Element ? (event.target as HTMLElement) : null;
      if (isTypingTarget(target)) return;
      if (target?.closest?.('[role="dialog"], [aria-modal="true"]')) return;
      const inScope =
        !target ||
        target === document.body ||
        target === document.documentElement ||
        Boolean(rootRef.current?.contains(target));
      if (!inScope) return;
      const next = toolFromShortcut(event.key);
      if (!next || !toolsRef.current.includes(next)) return;
      event.preventDefault();
      changeToolRef.current(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* Anuncia el cambio de herramienta (no el montaje inicial). */
  const announcedToolRef = useRef(effectiveTool);
  useEffect(() => {
    if (announcedToolRef.current === effectiveTool) return;
    announcedToolRef.current = effectiveTool;
    setAnnouncement(
      effectiveTool === "select"
        ? strings.toolSelectStatus
        : strings.toolArmedStatus(toolLabel(effectiveTool)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTool]);
  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(""), 6000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  /**
   * Tab/Enter en un campo de texto: salta al siguiente campo pendiente en
   * orden de documento (todas las paginas), cambiando de pagina si hace
   * falta. Si no queda ninguno, cierra el editor. Los huecos de firma no
   * entran en esta cola: un hueco colocado no tiene nada que rellenar en
   * este paso (se firma en el siguiente); por teclado se alcanzan con Tab
   * normal, porque cada elemento del lienzo es enfocable.
   *
   * "Pendiente" no es lo mismo que "sin rellenar" (`isFieldFilled`): una
   * casilla sin marcar es una respuesta valida y cuenta como rellena para
   * el aviso; para la navegacion SI es pendiente, pero solo la primera vez
   * que el cursor la visita en esta pasada.
   */
  const isPendingForNav = useCallback(
    (field: DetectedField) => {
      const value = values[field.id] ?? "";
      if (fieldTypeOf(field) === "checkbox") {
        return value.length === 0 && !touchedCheckboxes.has(field.id);
      }
      return value.trim().length === 0;
    },
    [values, touchedCheckboxes],
  );

  /**
   * Cambiar de pagina a mitad de un gesto (flechas, miniatura o Tab/Enter
   * con el boton pulsado y un segundo dedo/tecla) lo ABORTA: ni se crea un
   * elemento fantasma en la pagina nueva con el rectangulo de la vieja, ni
   * queda un arrastre colgado ignorando los punteros siguientes.
   */
  const cancelGesture = useCallback(() => {
    dragRef.current = null;
    draftOriginRef.current = null;
    setDraft(null);
  }, []);

  const goToPage = (index: number) => {
    cancelGesture();
    onEditingIdChange(null);
    onPageIndexChange(index);
  };

  /* Vista continua: el paginador global (fuera de este lienzo) pide paginas de ESTE documento por aqui. */
  const goToPageRef = useRef(goToPage);
  useEffect(() => {
    goToPageRef.current = goToPage;
  });
  useEffect(() => {
    if (!registerSequence) return;
    return registerSequence({ goToPage: (index) => goToPageRef.current(index) });
  }, [registerSequence]);

  /**
   * Salta al campo pendiente siguiente (`direction` 1) o anterior (-1) en
   * orden de documento, con vuelta al otro extremo, y abre su editor.
   * `fromId` es el campo de partida; sin el, se parte del elemento
   * seleccionado (un hueco cuenta por su posicion en la pagina) o, sin
   * seleccion, de uno de los extremos. Devuelve `false` si no hay ningun
   * otro campo pendiente (no toca nada).
   */
  const stepWithinDocument = useCallback(
    (direction: 1 | -1, fromId?: string, wrap = true): boolean => {
      const ordered = [...textFields].sort(byDocumentOrder);
      const total = ordered.length;
      if (total === 0) return false;
      const startId =
        fromId ?? (selection?.kind === "text" ? selection.id : undefined);
      const startIndex = startId
        ? ordered.findIndex((field) => field.id === startId)
        : -1;
      // `after`: primer indice a mirar hacia delante; `before`: hacia atras.
      let after: number;
      let before: number;
      if (startIndex !== -1) {
        after = startIndex + 1;
        before = startIndex - 1;
      } else if (selection?.kind === "slot") {
        const slot = slots.find((candidate) => candidate.id === selection.id);
        const position = slot
          ? ordered.filter(
              (field) =>
                byDocumentOrder<{ pageIndex: number; rect: NormalizedRect }>(field, slot) <= 0,
            ).length
          : 0;
        after = position;
        before = position - 1;
      } else {
        after = 0;
        before = total - 1;
      }
      for (let step = 0; step < total; step += 1) {
        const raw = direction === 1 ? after + step : before - step;
        // Vista continua: sin dar la vuelta, para poder seguir en el documento vecino.
        if (!wrap && (raw < 0 || raw >= total)) break;
        const index = ((raw % total) + total) % total;
        const candidate = ordered[index];
        if (candidate.id === startId || !isPendingForNav(candidate)) continue;
        if (fieldTypeOf(candidate) === "checkbox") markCheckboxTouched(candidate.id);
        onSelectionChange({ kind: "text", id: candidate.id });
        if (candidate.pageIndex !== pageIndex) cancelGesture();
        onPageIndexChange(candidate.pageIndex);
        onEditingIdChange(candidate.id);
        setAnnouncement(
          strings.fieldNavAnnounce(textLabel(candidate), index + 1, total),
        );
        return true;
      }
      return false;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      textFields,
      slots,
      selection,
      isPendingForNav,
      markCheckboxTouched,
      onSelectionChange,
      onPageIndexChange,
      onEditingIdChange,
      pageIndex,
      cancelGesture,
      strings,
    ],
  );

  /**
   * Vista continua: el documento es una parte de un PDF mayor, asi que «mas
   * alla del ultimo pendiente» es el primero del documento siguiente, no la
   * vuelta al principio de este. Solo si ningun otro documento tiene pendientes
   * se da la vuelta aqui (como siempre).
   */
  const stepToPendingField = useCallback(
    (direction: 1 | -1, fromId?: string): boolean => {
      const link = sequenceRef.current;
      if (!link) return stepWithinDocument(direction, fromId);
      if (stepWithinDocument(direction, fromId, false)) return true;
      if (link.onNoPendingHere(direction)) return true;
      return stepWithinDocument(direction, fromId, true);
    },
    [stepWithinDocument],
  );

  /** Tab/Enter (hacia delante) y Mayus+Tab (hacia atras) dentro de un campo. */
  const advanceToNextEmptyField = useCallback(
    (currentId: string, direction: 1 | -1 = 1) => {
      if (stepToPendingField(direction, currentId)) return;
      // Ya no queda nada pendiente: se cierra el editor y el foco vuelve al propio campo
      // (el input se desmonta; sin esto caeria a <body>).
      restoreFocusToRef.current = { kind: "text", id: currentId };
      onEditingIdChange(null);
    },
    [stepToPendingField, onEditingIdChange],
  );

  /** "Campo anterior/siguiente" de la paleta y de la barra flotante. */
  const navigateFields = (direction: 1 | -1) => {
    if (!stepToPendingField(direction)) setAnnouncement(strings.noMorePendingFields);
  };

  /** Botones de zoom: la alternativa fiable al pellizco (que en Seleccionar compite con el scroll). */
  const setZoomLevel = (next: number) => {
    setZoom(next);
    setPan((current) =>
      next === 1 ? { x: 0, y: 0 } : clampPan(current, next, layoutSize),
    );
  };
  const zoomIn = () =>
    setZoomLevel(ZOOM_STEPS.find((step) => step > zoom + 0.01) ?? zoom);
  const zoomOut = () =>
    setZoomLevel([...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.01) ?? 1);

  const hasOtherPendingField =
    Boolean(sequence?.othersPending) ||
    textFields.some(
      (field) =>
        !(selection?.kind === "text" && selection.id === field.id) &&
        isPendingForNav(field),
    );

  const toggleCheckbox = (field: DetectedField) => {
    markCheckboxTouched(field.id);
    onValueChange(field.id, (values[field.id] ?? "") ? "" : "true");
  };

  /** Relacion ancho/alto de la pagina en pantalla (0.75 mientras no hay vista previa medida). */
  const pageAspect =
    hostSize.width > 0 && hostSize.height > 0 ? hostSize.width / hostSize.height : 0.75;

  /** Ancho de la hoja en px de layout (sin zoom); cae a la medida con transformacion si aun no hay layout. */
  const pageWidthPx = layoutSize.width || hostSize.width;

  /** Tamano por defecto de lo que crea la herramienta activa, en fracciones de la pagina. */
  const defaultSize = (): { width: number; height: number } => {
    if (creates?.kind === "slot" && solo && solo.ratio > 0) {
      return defaultSoloRect(solo.ratio, pageAspect);
    }
    if (creates?.kind === "slot") {
      const preset = DEFAULT_SLOT[creates.slotType];
      return {
        width: preset.width,
        height: Math.min(0.9, preset.width * preset.ratio * pageAspect),
      };
    }
    const preset = TEXT_FIELD_DEFAULTS[creates?.kind === "text" ? creates.fieldType : "text"];
    // Una casilla es cuadrada en pantalla (no en fracciones de pagina) y mide al
    // menos CHECKBOX_MIN_PX: a 375 px el 3,4 % de la hoja eran 11 px.
    const width =
      creates?.kind === "text" && creates.fieldType === "checkbox" && pageWidthPx > 0
        ? Math.min(0.08, Math.max(preset.width, CHECKBOX_MIN_PX / pageWidthPx))
        : preset.width;
    return {
      width,
      height: preset.height ?? Math.min(0.9, width * pageAspect),
    };
  };

  /** Crea lo que toca la herramienta activa y vuelve a Seleccionar (cada herramienta es de un solo uso). */
  const createWithTool = (rect: NormalizedRect) => {
    if (!creates) return;
    if (creates.kind === "text" && creates.fieldType === "checkbox") {
      // Dibujada o tocada, una casilla es CUADRADA: el lado menor del rectangulo
      // (o el tamano por defecto si lo dibujado es demasiado pequeno).
      const aspect = pageAspect;
      const side = Math.min(rect.width, rect.height / aspect);
      if (side * pageWidthPx >= CHECKBOX_DRAWN_MIN_PX || pageWidthPx === 0) {
        rect = { x: rect.x, y: rect.y, width: side, height: side * aspect };
      } else {
        const size = defaultSize();
        rect = {
          x: clamp(rect.x, 0, Math.max(0, 1 - size.width)),
          y: clamp(rect.y, 0, Math.max(0, 1 - size.height)),
          width: size.width,
          height: size.height,
        };
      }
    }
    if (creates.kind === "slot") addSlot(rect, creates.slotType);
    else addTextField(rect, creates.fieldType);
    onToolChange("select");
  };

  const addCentered = (x: number, y: number) => {
    if (!creates) return;
    const size = defaultSize();
    createWithTool({
      x: clamp(x - size.width / 2, 0, Math.max(0, 1 - size.width)),
      y: clamp(y - size.height / 2, 0, Math.max(0, 1 - size.height)),
      width: size.width,
      height: size.height,
    });
  };

  const addDrawn = (rect: NormalizedRect) => createWithTool(rect);

  /**
   * Alcance de "quitar de la pagina" / "borrar todo": lo que crea la
   * herramienta activa (huecos o campos) o, con Seleccionar, todo.
   */
  // En "Solo yo" la firma es un elemento mas: con Firma armada se limpia todo (no hay "huecos").
  const clearScope: "slot" | "text" | "all" =
    creates && !(solo && creates.kind === "slot") ? creates.kind : "all";

  const clearPage = () => {
    refocusAfterRemoveRef.current = true;
    if (clearScope !== "text") {
      onSlotsChange(slots.filter((field) => field.pageIndex !== pageIndex));
    }
    if (clearScope !== "slot") {
      onTextFieldsChange(textFields.filter((field) => field.pageIndex !== pageIndex));
    }
    select(null);
  };

  const clearAll = () => {
    refocusAfterRemoveRef.current = true;
    if (clearScope !== "text") onSlotsChange([]);
    if (clearScope !== "slot") onTextFieldsChange([]);
    select(null);
  };

  /* ---------------------------------------------------------------- *
   * Acciones de la barra flotante
   * ---------------------------------------------------------------- */

  const duplicateSelected = () => {
    if (!selection) return;
    const others = [
      ...slots.filter((field) => field.pageIndex === pageIndex),
      ...textFields.filter((field) => field.pageIndex === pageIndex),
    ].map((field) => field.rect);
    if (selection.kind === "slot") {
      const source = slots.find((field) => field.id === selection.id);
      if (!source) return;
      const copy: SignatureField = {
        ...source,
        id: nextFieldId(),
        rect: findFreeSpot(source.rect, others),
      };
      onSlotsChange([...slots, copy]);
      select({ kind: "slot", id: copy.id });
    } else {
      const source = textFields.find((field) => field.id === selection.id);
      if (!source) return;
      // Sin etiqueta ni valor: la copia es un campo nuevo, no otro "Nombre".
      const copy: DetectedField = {
        id: nextTextFieldId(),
        pageIndex: source.pageIndex,
        rect: findFreeSpot(source.rect, others),
        source: "manual",
        confidence: "high",
        ...(source.type ? { type: source.type } : {}),
      };
      onTextFieldsChange([...textFields, copy]);
      select({ kind: "text", id: copy.id });
    }
    setAnnouncement(strings.elementDuplicated);
  };

  /**
   * Cambia el tipo de un campo SIN perder lo tecleado cuando el tipo nuevo lo
   * admite (ver `convertValueForType`). Si el valor no vale (un texto como
   * fecha, una casilla...) se borra, se anuncia por la region de estado y,
   * con "Deshacer" activo, se ofrece el snackbar de 6 s que repone tipo y
   * valor exactos. Texto -> iniciales -> texto recupera el original si no se
   * toco entre medias (las iniciales recortan a 4 letras).
   */
  const changeTextType = (field: DetectedField, type: DetectedFieldType) => {
    const from = fieldTypeOf(field);
    if (from === type) return;
    const current = values[field.id] ?? "";
    const saved = initialsOriginalRef.current.get(field.id);
    const base = from === "initials" && saved && saved.formatted === current ? saved.original : current;
    const converted = convertValueForType(base, from, type);
    if (type === "initials" && converted.value !== base) {
      initialsOriginalRef.current.set(field.id, { original: base, formatted: converted.value });
    }
    onTextFieldsChange(
      textFields.map((candidate) => (candidate.id === field.id ? { ...candidate, type } : candidate)),
    );
    if (converted.value !== current) onValueChange(field.id, converted.value);
    const typeName = textTypeLabel(type);
    if (converted.cleared && current) {
      if (undoDeleteEnabled) {
        setPendingUndo({
          kind: "type",
          id: field.id,
          previousType: field.type,
          toType: type,
          value: current,
        });
      }
      setAnnouncement(
        `${strings.fieldChangedTo(typeName)} ${strings.typeChangeClearedNotice(typeName)}`,
      );
    } else {
      setAnnouncement(strings.fieldChangedTo(typeName));
    }
  };

  const changeSlot = (field: SignatureField, patch: Partial<SignatureField>) => {
    const next = { ...field, ...patch };
    onSlotsChange(slots.map((candidate) => (candidate.id === field.id ? next : candidate)));
    setAnnouncement(
      strings.slotChangedTo(signerDisplayNameById(next.signerId), slotTypeLabel(next.type)),
    );
  };

  /* ---------------------------------------------------------------- *
   * Puntero: crear arrastrando sobre lienzo vacio, mover, redimensionar
   * por el tirador, pellizcar para acercar.
   * ---------------------------------------------------------------- */

  const toNormalized = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const host = hostRef.current;
    if (!host) return null;
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return {
      x: clamp01((clientX - bounds.left) / bounds.width),
      y: clamp01((clientY - bounds.top) / bounds.height),
    };
  };

  const startCreate = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinchZoomEnabled) {
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      // Un segundo dedo mientras no hay ningun elemento en arrastre es un
      // pellizco, nunca un segundo intento de dibujar.
      if (activePointersRef.current.size === 2 && !dragRef.current) {
        const [[idA, a], [idB, b]] = [...activePointersRef.current.entries()];
        event.preventDefault();
        draftOriginRef.current = null;
        tapCandidateRef.current = null;
        panDragRef.current = null;
        setDraft(null);
        pinchRef.current = {
          pointerIds: [idA, idB],
          startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          startZoom: zoom,
          startPan: pan,
          startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
        return;
      }
      if (activePointersRef.current.size > 2 || pinchRef.current) return;
    }

    // Seleccionar: lo vacio solo deselecciona, y al soltar si fue un toque corto.
    if (!creates) {
      tapCandidateRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      if (pinchZoomEnabled && zoom > 1) {
        panDragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          startPan: pan,
        };
      }
      return;
    }
    if (!preview) return;
    if (creates.kind === "slot" && !canPlaceSlot) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Tocar el lienzo vacio siempre cierra el editor que estuviera abierto.
    onEditingIdChange(null);
    gesturePageRef.current = pageIndex;
    draftOriginRef.current = point;
    setDraft({ x: point.x, y: point.y, toX: point.x, toY: point.y });
  };

  const startDrag = (event: ReactPointerEvent<Element>) => {
    const host = hostRef.current;
    const target = event.currentTarget as HTMLElement;
    const mode = target.dataset.dragMode as DragMode | undefined;
    const kind = target.dataset.elementKind as CanvasElementKind | undefined;
    const id = target.dataset.elementId;
    if (!host || !mode || !kind || !id) return;
    const snapshot =
      kind === "slot"
        ? slots.find((field) => field.id === id)?.rect
        : textFields.find((field) => field.id === id)?.rect;
    if (!snapshot) return;
    event.stopPropagation();
    target.setPointerCapture(event.pointerId);
    // El tirador no tiene ambiguedad de "¿fue un toque?": previene el
    // comportamiento por defecto ya. El cuerpo del elemento NO: si se
    // previniera en el pointerdown, un toque real (que abre el teclado en
    // el input recien enfocado) quedaria bloqueado en iOS; se previene en
    // el primer pointermove que supera el umbral de temblor.
    if (mode === "resize") event.preventDefault();
    dragRef.current = {
      kind,
      mode,
      id,
      startX: event.clientX,
      startY: event.clientY,
      snapshot,
      pointerId: event.pointerId,
      moved: false,
    };
    select({ kind, id });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinchZoomEnabled) {
      if (activePointersRef.current.has(event.pointerId)) {
        activePointersRef.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }
      const pinch = pinchRef.current;
      if (pinch) {
        const a = activePointersRef.current.get(pinch.pointerIds[0]);
        const b = activePointersRef.current.get(pinch.pointerIds[1]);
        if (a && b) {
          event.preventDefault();
          const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
          const nextZoom = clamp(
            pinch.startZoom * (distance / pinch.startDistance),
            1,
            MAX_ZOOM,
          );
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          setZoom(nextZoom);
          setPan({
            x: clamp(pinch.startPan.x + (midX - pinch.startMid.x), -PAN_LIMIT_PX, PAN_LIMIT_PX),
            y: clamp(pinch.startPan.y + (midY - pinch.startMid.y), -PAN_LIMIT_PX, PAN_LIMIT_PX),
          });
        }
        return;
      }
    }

    const tap = tapCandidateRef.current;
    if (tap && event.pointerId === tap.pointerId) {
      if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_MOVE_THRESHOLD_PX) {
        tapCandidateRef.current = null;
      }
    }
    const panning = panDragRef.current;
    if (panning && event.pointerId === panning.pointerId && !tapCandidateRef.current) {
      event.preventDefault();
      setPan(
        clampPan(
          {
            x: panning.startPan.x + (event.clientX - panning.startX),
            y: panning.startPan.y + (event.clientY - panning.startY),
          },
          zoom,
          layoutSize,
        ),
      );
      return;
    }

    const host = hostRef.current;
    const drag = dragRef.current;
    if (drag && host) {
      if (event.pointerId !== drag.pointerId) return;

      if (drag.mode === "move" && !drag.moved) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance <= TAP_MOVE_THRESHOLD_PX) return;
        drag.moved = true;
      }
      event.preventDefault();

      const bounds = host.getBoundingClientRect();
      const dx = (event.clientX - drag.startX) / (bounds.width || 1);
      const dy = (event.clientY - drag.startY) / (bounds.height || 1);
      const start = drag.snapshot;

      if (drag.mode === "move") {
        patchRect(drag.kind, drag.id, {
          x: clamp(start.x + dx, 0, Math.max(0, 1 - start.width)),
          y: clamp(start.y + dy, 0, Math.max(0, 1 - start.height)),
          width: start.width,
          height: start.height,
        });
        return;
      }

      patchRect(drag.kind, drag.id, {
        x: start.x,
        y: start.y,
        width: clamp(start.width + dx, MIN_FIELD_SIDE, 1 - start.x),
        height: clamp(start.height + dy, MIN_FIELD_SIDE, 1 - start.y),
      });
      return;
    }

    if (!draftOriginRef.current) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    setDraft((current) =>
      current ? { ...current, toX: point.x, toY: point.y } : current,
    );
  };

  /**
   * Deja de rastrear un dedo para el pellizco. Si era uno de los dos que
   * lo sostenian, el pellizco termina; si el zoom quedo muy cerca de 1x,
   * encaja del todo (sin esto quedaria un residuo imperceptible pero ya
   * no reiniciable sin pasar primero por debajo de 1x).
   */
  const endPinchPointer = (pointerId: number) => {
    if (!pinchZoomEnabled) return;
    activePointersRef.current.delete(pointerId);
    const pinch = pinchRef.current;
    if (pinch && pinch.pointerIds.includes(pointerId)) {
      pinchRef.current = null;
      setZoom((current) => {
        if (current > 1.02) return current;
        setPan({ x: 0, y: 0 });
        return 1;
      });
    }
  };

  /** Puntero perdido a medio gesto (interrupcion del sistema): se aborta sin decidir toque ni arrastre. */
  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    endPinchPointer(event.pointerId);
    tapCandidateRef.current = null;
    panDragRef.current = null;
    dragRef.current = null;
    draftOriginRef.current = null;
    setDraft(null);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    endPinchPointer(event.pointerId);
    if (panDragRef.current?.pointerId === event.pointerId) panDragRef.current = null;
    const tap = tapCandidateRef.current;
    if (tap && tap.pointerId === event.pointerId) {
      tapCandidateRef.current = null;
      onEditingIdChange(null);
      select(null);
      return;
    }
    const drag = dragRef.current;
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      // Un toque limpio (sin superar el umbral) sobre el cuerpo de un
      // campo de texto abre el editor (o alterna la casilla): la unica
      // forma de rellenar que se le pide a la persona, tiene que sentirse
      // inmediata. Sobre un hueco de firma solo selecciona (ya hecho en
      // el pointerdown). El tirador nunca abre el editor.
      if (drag.kind === "text" && drag.mode === "move" && !drag.moved) {
        const tapped = textFields.find((field) => field.id === drag.id);
        if (tapped && fieldTypeOf(tapped) === "checkbox") toggleCheckbox(tapped);
        else onEditingIdChange(drag.id);
      }
      return;
    }
    const origin = draftOriginRef.current;
    draftOriginRef.current = null;
    const current = draft;
    setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!origin || !current) return;
    // Defensa extra: la pagina cambio por cualquier via entre pulsar y soltar.
    if (gesturePageRef.current !== pageIndex) return;

    const width = Math.abs(current.toX - current.x);
    const height = Math.abs(current.toY - current.y);
    if (width < CLICK_SLOP && height < CLICK_SLOP) {
      addCentered(current.x, current.y);
      return;
    }
    if (width < MIN_FIELD_SIDE || height < MIN_FIELD_SIDE) {
      select(null);
      return;
    }
    addDrawn({
      x: Math.min(current.x, current.toX),
      y: Math.min(current.y, current.toY),
      width,
      height,
    });
  };

  /* Foco gestionado tras quitar elementos y tras Escape (nunca a <body>). */
  useEffect(() => {
    if (!refocusAfterRemoveRef.current) return;
    refocusAfterRemoveRef.current = false;
    const active = document.activeElement;
    // Solo si el foco se perdio (elemento desmontado): si sigue en un
    // control vivo, no se toca. La barra flotante sale con una animacion: su
    // boton "Borrar" sigue conectado unos frames, pero ya no vale como destino.
    const inLeavingBar =
      !selection && Boolean(active?.closest?.("[data-floating-bar]"));
    if (active && active !== document.body && active.isConnected && !inLeavingBar) {
      return;
    }
    const add = addButtonRef.current;
    const target =
      undoButtonRef.current ?? (add && !add.disabled ? add : null) ?? hostRef.current;
    target?.focus({ preventScroll: true });
  });

  useEffect(() => {
    const target = restoreFocusToRef.current;
    if (!target || editingId) return;
    const element = hostRef.current?.querySelector<HTMLElement>(
      `[data-element-kind="${target.kind}"][data-element-id="${CSS.escape(target.id)}"]`,
    );
    if (!element) return;
    restoreFocusToRef.current = null;
    element.focus({ preventScroll: true });
  });

  /* Selector de tipo: al abrir, foco en el tipo actual; al cerrar, en el boton que lo abre. */
  useEffect(() => {
    const bar = stageRef.current?.querySelector<HTMLElement>("[data-floating-bar]");
    if (!bar) return;
    if (typePickerFor !== null && typePickerFor === selection?.id) {
      bar.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
    } else if (pendingTypeButtonFocusRef.current) {
      pendingTypeButtonFocusRef.current = false;
      bar.querySelector<HTMLElement>('[data-bar-action="type"]')?.focus();
    }
  }, [typePickerFor, selection?.id]);

  /*
   * "Solo yo": coloca la firma recien creada en la pagina visible (el flujo
   * rapido: crear -> ya esta puesta) o, si ya habia una colocada, ajusta su
   * alto a la proporcion de la firma nueva. Una vez por firma (el PNG es la
   * clave): quitarla a mano no la vuelve a poner.
   */
  const soloHandledPngRef = useRef<string | null>(null);
  /** Ultimos `slots`/`onSlotsChange`: el ajuste de una pagina que no se ve termina despues de un `await`. */
  const soloLatestRef = useRef({ slots, onSlotsChange });
  const aliveRef = useRef(true);
  useEffect(() => {
    soloLatestRef.current = { slots, onSlotsChange };
  });
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!solo || !solo.signaturePng || solo.ratio <= 0) return;
    if (!preview || hostSize.width === 0 || hostSize.height === 0) return;
    if (soloHandledPngRef.current === solo.signaturePng) return;
    soloHandledPngRef.current = solo.signaturePng;
    const aspect = previewAspect ?? hostSize.width / hostSize.height;
    const existing = slots.find((field) => field.id === SOLO_SLOT_ID);
    if (existing) {
      // El alto sigue a la proporcion de la pagina DONDE ESTA la firma, no de la
      // que se ve ahora (paginas apaisadas y verticales conviven en un PDF).
      const ratio = solo.ratio;
      const refitTo = (pageAspect: number) => {
        const latest = soloLatestRef.current;
        const current = latest.slots.find((field) => field.id === SOLO_SLOT_ID);
        if (!current) return;
        const refit = refitSoloRect(current.rect, ratio, pageAspect);
        if (Math.abs(refit.height - current.rect.height) <= 0.002) return;
        latest.onSlotsChange(
          latest.slots.map((field) =>
            field.id === SOLO_SLOT_ID ? { ...field, rect: refit } : field,
          ),
        );
      };
      if (existing.pageIndex === pageIndex) {
        refitTo(aspect);
      } else if (file) {
        void pageAspectOf(file, existing.pageIndex).then((pageAspect) => {
          if (pageAspect && aliveRef.current) refitTo(pageAspect);
        });
      }
      return;
    }
    onSlotsChange([
      {
        id: SOLO_SLOT_ID,
        signerId: SOLO_SIGNER_ID,
        pageIndex,
        type: "signature",
        rect: defaultSoloRect(solo.ratio, aspect),
      },
    ]);
    onSelectionChange({ kind: "slot", id: SOLO_SLOT_ID });
    queueMicrotask(() => setAnnouncement(strings.soloSignaturePlaced(pageIndex + 1)));
    // Solo cuando llega una firma nueva o la vista previa: el resto se lee con los valores de ese instante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solo?.signaturePng, solo?.ratio, preview, previewAspect, hostSize.width, hostSize.height]);

  /*
   * La paleta movil es FIJA (sobre la barra de accion de ToolShell): mientras
   * el lienzo esta montado marca `<html>` para que `globals.css` reserve, al
   * final de la pagina, el alto de la paleta y el pie no quede tapado.
   */
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-fixed-palette", "");
    return () => root.removeAttribute("data-fixed-palette");
  }, []);

  if (!file) return null;

  /*
   * Zonas de toque ampliadas (WCAG 2.2 · 2.5.8) solo con puntero grueso y en
   * Seleccionar: con una herramienta de creacion activa los elementos no
   * deben comerse el sitio donde se quiere colocar uno nuevo. El objetivo se
   * expresa en px de la hoja: con zoom `z` la hoja se ve `z` veces mayor.
   */
  const hitInsets: Map<string, Insets> | null =
    coarse && !creates && layoutSize.width > 0 && layoutSize.height > 0
      ? expandHitTargets(
          [
            ...pageSlots.map((field) => ({ id: `slot:${field.id}`, rect: field.rect })),
            ...pageTextFields.map((field) => ({ id: `text:${field.id}`, rect: field.rect })),
          ].map((item) => ({
            id: item.id,
            rect: {
              x: item.rect.x * layoutSize.width,
              y: item.rect.y * layoutSize.height,
              width: item.rect.width * layoutSize.width,
              height: item.rect.height * layoutSize.height,
            },
          })),
          layoutSize,
          IDEAL_TARGET_PX / zoom,
        )
      : null;

  /**
   * Elemento cuyo cuerpo entero (ambos lados, en pantalla y con zoom) queda
   * debajo de `TINY_ELEMENT_PX`: el tirador de 24 px lo taparia. Un campo
   * ancho pero bajo NO cuenta: su cuerpo sigue libre a la izquierda.
   */
  const isTiny = (rect: NormalizedRect): boolean =>
    layoutSize.width > 0 &&
    Math.max(rect.width * layoutSize.width, rect.height * layoutSize.height) * zoom <
      TINY_ELEMENT_PX;

  const total = Math.max(1, pageCount);

  const clearPageDisabled =
    clearScope === "slot"
      ? pageSlots.length === 0
      : clearScope === "text"
        ? pageTextFields.length === 0
        : pageSlots.length + pageTextFields.length === 0;
  const clearAllDisabled =
    clearScope === "slot"
      ? slots.length === 0
      : clearScope === "text"
        ? textFields.length === 0
        : slots.length + textFields.length === 0;

  const owner = !solo && activeSigner
    ? {
        name: signerDisplayNameById(activeSigner.id),
        color: activeSigner.color,
      }
    : null;

  const selectedSlot =
    selection?.kind === "slot"
      ? (slots.find((field) => field.id === selection.id) ?? null)
      : null;
  const selectedElement = selectedSlot ?? selectedTextField;
  /** Nombre accesible del elemento seleccionado (el mismo que lleva en el lienzo): lo repiten el grupo y las acciones de la barra. */
  const selectedName = selectedSlot
    ? `${slotLabel(selectedSlot)}, ${slotRole}`
    : selectedTextField
      ? `${textLabel(selectedTextField)}, ${
          isFieldFilled(selectedTextField, values[selectedTextField.id])
            ? strings.a11yFilled
            : strings.a11yPending
        }`
      : "";
  // El selector de tipo pertenece al elemento que lo abrio: si la seleccion cambia o se va
  // (clic fuera, Escape, otra herramienta), se cierra, y no reaparece abierto al volver a elegirlo.
  if (typePickerFor !== null && typePickerFor !== (selection?.id ?? null)) {
    setTypePickerFor(null);
  }
  const typePickerOpen = typePickerFor !== null && typePickerFor === selection?.id;
  /** La barra solo se ancla a un elemento de la pagina visible. */
  const barSelection =
    selectedElement && selectedElement.pageIndex === pageIndex ? selection : null;

  const barLayoutKey = [
    pageIndex,
    zoom.toFixed(3),
    pan.x.toFixed(1),
    pan.y.toFixed(1),
    selectedElement
      ? [
          selectedElement.rect.x,
          selectedElement.rect.y,
          selectedElement.rect.width,
          selectedElement.rect.height,
        ]
          .map((value) => value.toFixed(4))
          .join(",")
      : "",
    hostSize.width.toFixed(1),
    hostSize.height.toFixed(1),
    preview ? 1 : 0,
    selection?.kind ?? "",
    richFieldTypesEnabled ? 1 : 0,
    signers.length > 1 ? 1 : 0,
  ].join("|");

  /*
   * Lado natural del desplegable de sugerencias (arriba en la mitad inferior
   * de la pagina, para no salirse de la tarjeta que recorta). La barra
   * prefiere el opuesto y, si acaba en ese lado, las sugerencias pasan al otro.
   */
  const naturalSuggestionSide: "top" | "bottom" =
    selectedTextField && selectedTextField.rect.y > 0.5 ? "top" : "bottom";
  if ((selection?.id ?? null) !== barPrefs.id) {
    // La preferencia se fija al seleccionar: si siguiera a la posicion, la barra
    // saltaria de lado al arrastrar el elemento por la mitad de la pagina.
    setBarPrefs({
      id: selection?.id ?? null,
      prefer: naturalSuggestionSide === "top" ? "bottom" : "top",
    });
  }
  const barPrefers = barPrefs.prefer;
  const suggestionSideFor = (field: DetectedField): "top" | "bottom" => {
    const natural = field.rect.y > 0.5 ? "top" : "bottom";
    return barSide === natural ? (natural === "top" ? "bottom" : "top") : natural;
  };

  /** Cierra el selector de tipo y devuelve el foco al boton que lo abre. */
  const closeTypePicker = () => {
    setTypePickerFor(null);
    pendingTypeButtonFocusRef.current = true;
  };

  /** Foco hacia la barra (Tab desde el elemento seleccionado). */
  const focusBar = (): boolean => {
    const first = stageRef.current?.querySelector<HTMLElement>(
      "[data-floating-bar] button:not([disabled]), [data-floating-bar] select",
    );
    if (!first) return false;
    first.focus();
    // Una barra oculta (el elemento esta fuera de la ventana) no admite foco: sin
    // esta comprobacion Tab se tragaba y el foco no se movia.
    return document.activeElement === first;
  };

  const focusSelectedElement = () => {
    if (!selection) return;
    hostRef.current
      ?.querySelector<HTMLElement>(
        `[data-element-kind="${selection.kind}"][data-element-id="${CSS.escape(selection.id)}"][data-drag-mode="move"]`,
      )
      ?.focus({ preventScroll: true });
  };

  /** Tab desde la ultima accion de la barra: el siguiente elemento de la pagina (o la salida natural). */
  const focusElementAfterSelection = (): boolean => {
    const host = hostRef.current;
    if (!host || !selection) return false;
    const elements = Array.from(
      host.querySelectorAll<HTMLElement>('[data-drag-mode="move"][tabindex="0"]'),
    );
    const index = elements.findIndex(
      (element) =>
        element.dataset.elementKind === selection.kind &&
        element.dataset.elementId === selection.id,
    );
    const next = elements[index + 1];
    if (index === -1 || !next) return false;
    next.focus();
    return true;
  };

  /** Botones de zoom (en la vista continua van a la barra pegajosa del envoltorio). */
  const zoomGroup = (
    <div
      role="group"
      aria-label={strings.zoomGroupLabel}
      className="flex items-center gap-0.5"
    >
      <Button
        variant="ghost"
        size="sm"
        className={COARSE_TALL}
        aria-label={strings.zoomOut}
        title={strings.zoomOut}
        disabled={zoom <= 1.01}
        onClick={zoomOut}
      >
        <ZoomOut aria-hidden="true" className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={strings.resetZoomButton}
        title={strings.resetZoomButton}
        disabled={zoom === 1}
        onClick={() => setZoomLevel(1)}
        className={cn("min-w-12 px-1.5! tabular-nums", COARSE_TALL)}
      >
        {Math.round(zoom * 100)} %
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={COARSE_TALL}
        aria-label={strings.zoomIn}
        title={strings.zoomIn}
        disabled={zoom >= MAX_ZOOM - 0.01}
        onClick={zoomIn}
      >
        <ZoomIn aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );

  const pendingNote =
    creates?.kind === "slot" && !solo
      ? activeSigner
        ? strings.fieldOwnerLabel(
            signerDisplayNameById(activeSigner.id),
            slotTypeLabel(creates.slotType),
          )
        : strings.needSigner
      : solo
        ? strings.soloPageSummary(pageSlots.length, pageTextFields.length)
        : strings.canvasPageSummary(pageSlots.length, pageTextFields.length);

  return (
    <div ref={rootRef}>
      {/* Region viva SIEMPRE montada: herramienta activa, duplicados, saltos de campo. */}
      <div role="status" aria-live="polite" className="sr-only" data-canvas-announcer="">
        {announcement}
      </div>

      <div className="mb-4">
        <h3 className="text-headline text-foreground">{strings.documentTitle}</h3>
        <p className="mt-1 text-footnote leading-relaxed text-muted-foreground">
          {solo ? strings.soloDocumentHint : strings.documentHint}
        </p>
      </div>

      {/* Dueño de los huecos nuevos (o la firma propia, en "Solo yo") y alta con teclado. */}
      <div className="surface-card rounded-ios mb-3 space-y-3 p-3">
        {solo ? (
          /* "Solo yo": crear o rehacer la firma sin salir del lienzo. */
          <div className="flex flex-wrap items-center justify-between gap-3">
            {solo.signaturePng ? (
              <span className="ui-label text-muted-foreground">
                {strings.soloSignatureLabel}
              </span>
            ) : (
              <p className="min-w-0 flex-1 text-footnote leading-relaxed text-muted-foreground">
                {strings.noSignature}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={solo.signaturePng ? "secondary" : "primary"}
                size="sm"
                className={COARSE_TALL}
                onClick={solo.onCreateSignature}
              >
                <PenLine aria-hidden="true" className="size-4" />
                {solo.signaturePng ? strings.changeSignature : strings.createSignature}
              </Button>
              {solo.onOpenSaved ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className={COARSE_TALL}
                  onClick={solo.onOpenSaved}
                >
                  <Bookmark aria-hidden="true" className="size-4" />
                  {strings.vaultButton}
                </Button>
              ) : null}
            </div>
          </div>
        ) : signers.length > 0 ? (
          /* Dueño del proximo hueco: se cambia aqui mismo, sin volver al paso 1. */
          <div>
            <span className="ui-label mb-1.5 block text-muted-foreground">
              {strings.activeSignerLabel}
            </span>
            <div
              role="radiogroup"
              aria-label={strings.activeSignerLabel}
              className="flex flex-wrap gap-1.5"
            >
              {signers.map((signer, index) => {
                const active = signer.id === activeSignerId;
                return (
                  <button
                    key={signer.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onActiveSignerIdChange(signer.id)}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-ios-sm border px-3 text-footnote font-medium transition-colors duration-200 ease-spring focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
                      active
                        ? "border-signal/60 bg-signal/15 text-foreground"
                        : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:bg-white/10 hover:text-foreground",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 rounded-full"
                      /* Color del firmante: dato del documento, no un token del tema. */
                      style={{ backgroundColor: signer.color }}
                    />
                    <span className="max-w-32 truncate">
                      {signerDisplayName(signer.name, index, strings.defaultSignerName)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <p className="text-footnote leading-relaxed text-muted-foreground">
            {strings.slotsNeedSigners}
          </p>
        )}

        {/*
          Alta SIN puntero (teclado, lector de pantalla): con una herramienta
          de creacion activa, coloca el elemento por defecto en la pagina.
        */}
        {creates ? (
          <Button
            ref={addButtonRef}
            variant="secondary"
            size="sm"
            className={COARSE_TALL}
            disabled={creates.kind === "slot" && !canPlaceSlot}
            onClick={() => addCentered(0.5, 0.75)}
          >
            {creates.kind === "slot"
              ? solo
                ? strings.soloPlaceHere
                : strings.addFieldHere
              : strings.addTextFieldHere}
          </Button>
        ) : null}
      </div>

      {/*
        Zoom y paginas: pegajosos bajo la cabecera, para que sigan al alcance
        con la hoja ampliada o desplazada (en movil la hoja ocupa la pantalla y
        el zoom quedaba arriba, fuera de la vista). Con puntero grueso miden 44 px.
      */}
      {sequence?.hidePager ? (
        /* Vista continua: el paginador global lo pinta `DocumentSequence`; aqui solo el zoom, en su barra. */
        pinchZoomEnabled && sequence.zoomSlot ? createPortal(zoomGroup, sequence.zoomSlot) : null
      ) : (
        <div
          data-canvas-sticky=""
          className="material-thick shadow-elevation-2 rounded-ios sticky top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] z-30 mb-3 flex flex-wrap items-center justify-between gap-x-1 gap-y-1 p-1 md:top-[calc(4rem+env(safe-area-inset-top,0px)+0.5rem)] lg:top-3"
        >
          {pinchZoomEnabled ? zoomGroup : <span />}
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className={COARSE_TALL}
              aria-label={strings.previousPage}
              disabled={pageIndex === 0}
              onClick={() => goToPage(Math.max(0, pageIndex - 1))}
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <span className="text-footnote font-medium text-foreground tabular-nums">
              {/* En pantallas estrechas se pinta "2 / 40" y el texto completo queda para lectores de pantalla: la barra cabe en una fila. */}
              <span aria-hidden="true" className="hidden max-[420px]:inline">
                {pageIndex + 1} / {total}
              </span>
              <span className="max-[420px]:sr-only">{strings.pageOf(pageIndex + 1, total)}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              className={COARSE_TALL}
              aria-label={strings.nextPage}
              disabled={pageCount === 0 || pageIndex >= pageCount - 1}
              onClick={() => goToPage(Math.min(pageCount - 1, pageIndex + 1))}
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/*
       * Estado y acciones destructivas, encima del lienzo: en movil se
       * hace scroll dentro de la vista previa para moverse por el
       * documento, asi que ningun boton que borre queda en esa ruta.
       */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground tabular-nums">
          <span>{pendingNote}</span>
          <span aria-hidden="true">·</span>
          <span>
            {solo
              ? strings.soloTotalSummary(slots.length, textFields.length)
              : strings.canvasTotalSummary(slots.length, textFields.length)}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            className={BORDERED_SM_COARSE}
            disabled={clearPageDisabled}
            onClick={clearPage}
          >
            {clearScope === "slot"
              ? strings.clearPageFields
              : clearScope === "text"
                ? strings.clearPageTextFields
                : strings.clearPageAll}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={clearAllDisabled}
            onClick={() => setConfirmClearAllOpen(true)}
          >
            {clearScope === "slot"
              ? strings.clearAllFields
              : clearScope === "text"
                ? strings.clearAllTextFields
                : strings.clearAllAll}
          </Button>
        </div>
      </div>

      {/*
       * Paleta + escenario. La paleta va PRIMERO en el DOM (se elige la
       * herramienta antes de tocar la pagina); en movil `flex-col-reverse` la
       * pinta debajo de la pagina, pegajosa sobre la barra de accion de
       * ToolShell (barra de pestanas 4.5 rem + barra de accion 4.25 rem).
       */}
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <ToolPalette
          tool={effectiveTool}
          tools={tools}
          onToolChange={changeTool}
          owner={owner}
          onPrevField={() => navigateFields(-1)}
          onNextField={() => navigateFields(1)}
          canPrevField={hasOtherPendingField}
          canNextField={hasOtherPendingField}
          strings={strings}
          className="z-20 max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(9.25rem+env(safe-area-inset-bottom,0px))] max-md:flex-wrap max-md:justify-center max-md:rounded-none max-md:px-1 md:sticky md:top-24 md:w-12 md:shrink-0"
        />

        <div ref={stageRef} className="relative min-w-0 flex-1">
          <div
            ref={clipRef}
            className="surface-card rounded-ios flex justify-center overflow-hidden p-3"
          >
            <div
              ref={hostRef}
              data-canvas="host"
              data-tool={effectiveTool}
              // Ultimo recurso del foco tras quitar elementos (ver arriba); no entra en el orden de Tab.
              tabIndex={-1}
              onPointerDown={startCreate}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              className={cn(
                "relative w-full max-w-[640px] select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                // Seleccionar a 1x: un dedo sobre lo vacio desplaza la pagina (`pan-y`); los
                // elementos llevan `touch-none` propio. Con una herramienta armada o con
                // zoom, el lienzo se queda con el gesto (dibujar, pellizcar, mover la hoja).
                effectiveTool === "select" && zoom === 1 ? "touch-pan-y" : "touch-none",
                creates ? "cursor-crosshair" : "cursor-default",
              )}
              style={
                zoom !== 1 || pan.x !== 0 || pan.y !== 0
                  ? {
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                      transformOrigin: "center center",
                    }
                  : undefined
              }
            >
              {preview ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={preview}
                  alt={strings.documentTitle}
                  draggable={false}
                  className="block w-full rounded-[10px]"
                />
              ) : (
                <div className="flex aspect-[3/4] w-full items-center justify-center rounded-[10px] bg-white/5">
                  {loading ? (
                    <Spinner className="size-5" label={strings.loadingPreview} />
                  ) : null}
                </div>
              )}

              {pageSlots.map((field) => (
                <SlotBox
                  key={field.id}
                  field={field}
                  signer={signerById(field.signerId)}
                  selected={selection?.kind === "slot" && selection.id === field.id}
                  label={slotLabel(field)}
                  role={slotRole}
                  resizeLabel={solo ? strings.soloResizeSignature : strings.resizeField}
                  image={solo && solo.signaturePng ? solo.signaturePng : null}
                  strings={strings}
                  hit={hitInsets?.get(`slot:${field.id}`)}
                  tiny={isTiny(field.rect)}
                  onPointerDownHandler={startDrag}
                  onFocusSelect={() => select({ kind: "slot", id: field.id })}
                  onTabToBar={focusBar}
                />
              ))}

              {pageTextFields.map((field) => (
                <TextFieldBox
                  key={field.id}
                  field={field}
                  label={textLabel(field)}
                  value={values[field.id] ?? ""}
                  onValueChange={(value) => onValueChange(field.id, value)}
                  historyKey={
                    field.label &&
                    (fieldTypeOf(field) === "text" || fieldTypeOf(field) === "initials")
                      ? normalizeFieldLabel(field.label)
                      : null
                  }
                  selected={selection?.kind === "text" && selection.id === field.id}
                  editing={field.id === editingId}
                  strings={strings}
                  hit={hitInsets?.get(`text:${field.id}`)}
                  tiny={isTiny(field.rect)}
                  suggestionsPlacement={suggestionSideFor(field)}
                  onPointerDownHandler={startDrag}
                  onFocusSelect={() => select({ kind: "text", id: field.id })}
                  onOpenEditor={() => {
                    select({ kind: "text", id: field.id });
                    onEditingIdChange(field.id);
                  }}
                  onEditEnd={() => onEditingIdChange(null)}
                  onAdvance={
                    keyboardNavEnabled
                      ? (direction) => advanceToNextEmptyField(field.id, direction)
                      : undefined
                  }
                  onToggle={
                    fieldTypeOf(field) === "checkbox"
                      ? () => toggleCheckbox(field)
                      : undefined
                  }
                  onTabToBar={focusBar}
                />
              ))}

              {draft ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute rounded-[4px] border-2 border-dashed"
                  style={{
                    left: percent(Math.min(draft.x, draft.toX)),
                    top: percent(Math.min(draft.y, draft.toY)),
                    width: percent(Math.abs(draft.toX - draft.x)),
                    height: percent(Math.abs(draft.toY - draft.y)),
                    borderColor:
                      creates?.kind === "slot"
                        ? solo
                          ? SOLO_COLOR
                          : (activeSigner?.color ?? ORPHAN_SLOT_COLOR)
                        : TEXT_FIELD_COLOR,
                  }}
                />
              ) : null}
            </div>
          </div>

          <FloatingFieldBar
            stageRef={stageRef}
            clipRef={clipRef}
            hostRef={hostRef}
            selection={barSelection}
            layoutKey={barLayoutKey}
            prefer={barPrefers}
            label={strings.selectionBarLabel(selectedName)}
            onSideChange={setBarSide}
            onEscape={() => {
              if (typePickerOpen) closeTypePicker();
              else focusSelectedElement();
            }}
            onTabBackward={focusSelectedElement}
            onTabForward={focusElementAfterSelection}
            onFocusLeave={() => {
              // El foco salio de la barra (Tab o Mayus+Tab): el selector de tipo se cierra, sin robar el foco.
              if (typePickerFor !== null) setTypePickerFor(null);
            }}
          >
            {selectedSlot && solo ? (
              /* La firma propia solo se quita (no se duplica ni cambia de tipo ni de dueño). */
              <BarButton
                label={strings.elementAction(strings.soloRemoveSignature, selectedName)}
                destructive
                onClick={() => removeElement("slot", selectedSlot.id)}
              >
                <Trash2 aria-hidden="true" className="size-5" />
              </BarButton>
            ) : selectedSlot ? (
              <>
                {signers.length > 1 ? (
                  <SignerSelect
                    value={selectedSlot.signerId}
                    signers={signers}
                    label={strings.elementAction(strings.signerOfSlotLabel, selectedName)}
                    nameOf={(signer, index) =>
                      signerDisplayName(signer.name, index, strings.defaultSignerName)
                    }
                    onChange={(signerId) => changeSlot(selectedSlot, { signerId })}
                  />
                ) : null}
                <BarGroup label={strings.elementAction(strings.fieldTypeLabel, selectedName)}>
                  <BarButton
                    label={strings.fieldSignature}
                    pressed={selectedSlot.type === "signature"}
                    onClick={() => changeSlot(selectedSlot, { type: "signature" })}
                  >
                    <PenLine aria-hidden="true" className="size-5" />
                  </BarButton>
                  <BarButton
                    label={strings.fieldInitials}
                    pressed={selectedSlot.type === "initials"}
                    onClick={() => changeSlot(selectedSlot, { type: "initials" })}
                  >
                    <Signature aria-hidden="true" className="size-5" />
                  </BarButton>
                </BarGroup>
                <BarButton
                  label={strings.elementAction(strings.duplicateElement, selectedName)}
                  onClick={duplicateSelected}
                >
                  <Copy aria-hidden="true" className="size-5" />
                </BarButton>
                <BarButton
                  label={strings.elementAction(strings.removeField, selectedName)}
                  destructive
                  onClick={() => removeElement("slot", selectedSlot.id)}
                >
                  <Trash2 aria-hidden="true" className="size-5" />
                </BarButton>
              </>
            ) : selectedTextField && typePickerOpen ? (
              /* Selector de tipo en la propia barra: sustituye a las acciones (una sola fila a 375 px). */
              <>
                <BarGroup label={strings.elementAction(strings.textFieldTypeLabel, selectedName)}>
                  {TEXT_TYPE_OPTIONS.map(([type, Icon]) => (
                    <BarButton
                      key={type}
                      label={textTypeLabel(type)}
                      pressed={fieldTypeOf(selectedTextField) === type}
                      onClick={() => {
                        changeTextType(selectedTextField, type);
                        closeTypePicker();
                      }}
                    >
                      <Icon aria-hidden="true" className="size-5" />
                    </BarButton>
                  ))}
                </BarGroup>
                <BarButton label={strings.closeTypePicker} onClick={closeTypePicker}>
                  <CornerUpLeft aria-hidden="true" className="size-5" />
                </BarButton>
              </>
            ) : selectedTextField ? (
              <>
                {richFieldTypesEnabled ? (
                  <BarButton
                    label={strings.changeFieldType(textTypeLabel(fieldTypeOf(selectedTextField)))}
                    dataAction="type"
                    ariaExpanded={typePickerOpen}
                    onClick={() => setTypePickerFor(selectedTextField.id)}
                  >
                    {(() => {
                      const Icon =
                        TEXT_TYPE_OPTIONS.find(([type]) => type === fieldTypeOf(selectedTextField))?.[1] ??
                        Type;
                      return <Icon aria-hidden="true" className="size-5" />;
                    })()}
                  </BarButton>
                ) : null}
                <BarButton
                  label={strings.elementAction(strings.duplicateElement, selectedName)}
                  onClick={duplicateSelected}
                >
                  <Copy aria-hidden="true" className="size-5" />
                </BarButton>
                <BarButton
                  label={strings.prevField}
                  ariaDisabled={!hasOtherPendingField}
                  onClick={() => navigateFields(-1)}
                >
                  <ArrowUp aria-hidden="true" className="size-5" />
                </BarButton>
                <BarButton
                  label={strings.nextField}
                  ariaDisabled={!hasOtherPendingField}
                  onClick={() => navigateFields(1)}
                >
                  <ArrowDown aria-hidden="true" className="size-5" />
                </BarButton>
                <BarButton
                  label={strings.elementAction(strings.removeTextField, selectedName)}
                  destructive
                  onClick={() => removeElement("text", selectedTextField.id)}
                >
                  <Trash2 aria-hidden="true" className="size-5" />
                </BarButton>
              </>
            ) : null}
          </FloatingFieldBar>
        </div>
      </div>

      {selectedTextField?.confidence === "low" ? (
        <p className="mt-3 flex items-start gap-2 text-footnote leading-relaxed text-foreground">
          <span
            aria-hidden="true"
            className="mt-[0.45em] size-2 shrink-0 rounded-full bg-amber-400"
          />
          {strings.lowConfidenceHint}
        </p>
      ) : null}

      {slots.length === 0 && textFields.length === 0 ? (
        <p className="mt-3 text-footnote leading-relaxed text-muted-foreground">
          {solo ? strings.soloCanvasEmptyHint : strings.canvasEmptyHint}
        </p>
      ) : null}

      {/* Region de estado siempre montada: solo cambia su contenido. */}
      <div role="status" aria-live="polite">
        {pendingUndo ? (
          <div className="animate-rise-in mt-3 flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5">
            <span className="text-footnote text-muted-foreground">
              {pendingUndo.kind === "slot"
                ? solo
                  ? strings.soloSignatureDeletedNotice
                  : strings.fieldDeletedNotice
                : pendingUndo.kind === "type"
                  ? strings.typeChangeClearedNotice(textTypeLabel(pendingUndo.toType))
                  : strings.textFieldDeletedNotice}
            </span>
            <Button
              ref={undoButtonRef}
              variant="ghost"
              size="sm"
              onClick={restorePendingUndo}
            >
              {pendingUndo.kind === "slot"
                ? strings.undoRemoveField
                : pendingUndo.kind === "type"
                  ? strings.undoTypeChange
                  : strings.undoRemoveTextField}
            </Button>
          </div>
        ) : null}
      </div>

      {sequence?.hideThumbs ? (
        /* Vista continua: la tira de miniaturas de TODOS los documentos la pinta `DocumentSequence` en este hueco. */
        <div ref={attachThumbsSlot} data-sequence-thumbs-slot="" />
      ) : thumbs.length > 1 ? (
        <div className="mt-5">
          <h4 className="ui-label mb-2 text-muted-foreground">{strings.thumbsTitle}</h4>
          <ul className="flex gap-2 overflow-x-auto pb-2">
            {thumbs.map((thumb, index) => {
              const count =
                slots.filter((field) => field.pageIndex === index).length +
                textFields.filter((field) => field.pageIndex === index).length;
              const active = index === pageIndex;
              return (
                <li key={index} className="shrink-0">
                  <button
                    type="button"
                    aria-label={strings.goToPage(index + 1)}
                    aria-current={active ? "true" : undefined}
                    onClick={() => goToPage(index)}
                    className={cn(
                      "relative block overflow-hidden rounded-ios-sm border p-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
                      active ? "border-signal" : "border-white/10 hover:border-white/25",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={thumb}
                      alt=""
                      draggable={false}
                      className="block w-16 rounded-[8px]"
                    />
                    <span className="absolute right-1 bottom-1 rounded-full bg-background/85 px-1.5 py-0.5 text-caption-2 leading-tight font-semibold text-foreground tabular-nums">
                      {count > 0 ? `${index + 1} · ${count}` : index + 1}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <ConfirmSheet
        open={confirmClearAllOpen}
        onClose={() => setConfirmClearAllOpen(false)}
        onConfirm={clearAll}
        title={
          clearScope === "slot"
            ? strings.confirmClearAllFieldsTitle
            : clearScope === "text"
              ? strings.confirmClearAllTextFieldsTitle
              : strings.confirmClearAllEverythingTitle
        }
        body={
          clearScope === "slot"
            ? strings.confirmClearAllFieldsBody
            : clearScope === "text"
              ? strings.confirmClearAllTextFieldsBody
              : strings.confirmClearAllEverythingBody
        }
        confirmLabel={
          clearScope === "slot"
            ? strings.clearAllFields
            : clearScope === "text"
              ? strings.clearAllTextFields
              : strings.clearAllAll
        }
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Piezas comunes de los elementos sobre la pagina
 * ------------------------------------------------------------------ */

/** Anillo de seleccion: separado del borde (del color del elemento) por el fondo. */
const SELECTION_RING =
  "0 0 0 2px var(--color-background), 0 0 0 4px var(--color-signal)";

/**
 * Las clases de foco van en el elemento (no inline): Tailwind v4 + `outline-none`
 * dejaria el anillo invisible, asi que aqui no hay `outline-none` y la
 * seleccion se pinta con `box-shadow`, nunca con `outline`.
 */
const BOX_BASE =
  "absolute cursor-move touch-none rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

/** El resto de elementos del lienzo ceden el gesto al navegador solo fuera de ellos: `touch-none` en el anfitrion. */
type HitProps = { hit?: Insets; tiny?: boolean };

/**
 * Zona de toque ampliada: `globals.css` (`[data-hit-zone]::before`) pinta,
 * solo con puntero grueso, un pseudo-elemento transparente que sobresale del
 * elemento lo que digan estas variables (px de la hoja). El pseudo-elemento
 * forma parte del elemento para el hit-testing, asi que el `pointerdown`
 * llega al mismo manejador.
 */
function hitStyle(hit: Insets | undefined): CSSProperties {
  if (!hit) return {};
  return {
    "--hit-t": `${hit.top.toFixed(2)}px`,
    "--hit-r": `${hit.right.toFixed(2)}px`,
    "--hit-b": `${hit.bottom.toFixed(2)}px`,
    "--hit-l": `${hit.left.toFixed(2)}px`,
  } as CSSProperties;
}

/**
 * Zona de toque de 44 px del tirador bajo puntero grueso: el `::before` se
 * posiciona respecto a la caja de relleno, asi que el inset descuenta el
 * borde de 2 px (20 + 2 x 12 = 44; medido en Chromium a 375 px).
 */
const COARSE_HIT_HANDLE =
  "pointer-coarse:before:absolute pointer-coarse:before:-inset-3 pointer-coarse:before:content-['']";
/**
 * Tirador de un elemento diminuto (fuera de la caja): su zona ampliada solo
 * crece hacia fuera (derecha y abajo). Con `-inset-3` entraba ~4 px en la
 * caja de una casilla de ~11 px y los toques sobre ella iban al tirador.
 */
const COARSE_HIT_HANDLE_OUTSIDE =
  "pointer-coarse:before:absolute pointer-coarse:before:-top-0.5 pointer-coarse:before:-left-0.5 pointer-coarse:before:-right-3 pointer-coarse:before:-bottom-3 pointer-coarse:before:content-['']";

type ElementLabelProps = { label: string; color: string };

/**
 * Pestana de etiqueta: texto del tema sobre superficie elevada, con el
 * color del elemento en el borde y en un punto. Antes era texto blanco de
 * 11 px sobre el propio color (verde y ambar no llegaban a 4,5:1).
 */
function ElementLabel({ label, color }: ElementLabelProps) {
  return (
    <span
      className="pointer-events-none absolute -top-0.5 left-0 flex max-w-full -translate-y-full items-center gap-1 rounded-t-[4px] border border-b-0 bg-elevated px-1.5 py-0.5 text-caption-2 leading-tight font-semibold text-foreground"
      style={{ borderColor: color }}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

type ResizeHandleProps = {
  kind: CanvasElementKind;
  id: string;
  resizeLabel: string;
  /**
   * Elemento diminuto (una casilla, un campo bajo): el tirador de 24 px
   * cubriria casi todo su cuerpo y no se podria tocar para marcar o editar.
   * Con `outside` el tirador sale por completo de la caja, en diagonal.
   */
  outside: boolean;
  onPointerDownHandler: (event: ReactPointerEvent<Element>) => void;
};

/**
 * Tirador de tamano del elemento seleccionado (24 px, zona de toque de
 * 44 px con puntero grueso). "Quitar" ya no vive aqui: esta en la barra
 * flotante, con un objetivo de 44 px que no compite con el de los vecinos.
 */
function ResizeHandle({
  kind,
  id,
  resizeLabel,
  outside,
  onPointerDownHandler,
}: ResizeHandleProps) {
  return (
    <span
      role="button"
      tabIndex={-1}
      aria-label={resizeLabel}
      data-drag-mode="resize"
      data-element-kind={kind}
      data-element-id={id}
      onPointerDown={onPointerDownHandler}
      className={cn(
        "absolute flex size-6 cursor-nwse-resize touch-none items-center justify-center rounded-full border-2 border-foreground bg-signal",
        outside ? "-right-11 -bottom-11" : "-right-2.5 -bottom-2.5",
        outside ? COARSE_HIT_HANDLE_OUTSIDE : COARSE_HIT_HANDLE,
      )}
    >
      <Move aria-hidden="true" className="size-3 text-foreground" />
    </span>
  );
}

/** Selector nativo del firmante de un hueco (compacto, y en movil abre el selector del sistema). */
function SignerSelect({
  value,
  signers,
  label,
  nameOf,
  onChange,
}: {
  value: string;
  signers: Signer[];
  label: string;
  nameOf: (signer: Signer, index: number) => string;
  onChange: (signerId: string) => void;
}) {
  const current = signers.find((signer) => signer.id === value);
  return (
    <div className="relative flex items-center rounded-ios-sm bg-white/6">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 size-3 rounded-full"
        /* Color del firmante: dato del documento, no un token del tema. */
        style={{ backgroundColor: current?.color ?? ORPHAN_SLOT_COLOR }}
      />
      <select
        aria-label={label}
        title={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        /* En pantallas estrechas solo punto de color + flecha (el nombre va en el nombre accesible y el `title`): la barra cabe en una fila. */
        className="h-9 w-[3.75rem] appearance-none rounded-ios-sm bg-transparent pr-7 pl-7 text-footnote font-medium text-transparent pointer-coarse:h-11 sm:w-auto sm:max-w-40 sm:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] outline-signal"
      >
        {signers.map((signer, index) => (
          <option key={signer.id} value={signer.id} className="bg-elevated text-foreground">
            {nameOf(signer, index)}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2 size-3.5 text-muted-foreground"
      />
    </div>
  );
}

/** Destino de teclado donde escribir: ni atajos ni borrado por Supr. */
function isTypingTarget(target: HTMLElement | null): boolean {
  if (!target) return false;
  if (/^(input|textarea|select)$/i.test(target.tagName)) return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute?.("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

/* ------------------------------------------------------------------ *
 * Hueco de firma / iniciales
 * ------------------------------------------------------------------ */

type SlotBoxProps = HitProps & {
  field: SignatureField;
  signer: Signer | null;
  selected: boolean;
  label: string;
  /** Rol en el nombre accesible ("hueco de firma"; "firma colocada" en "Solo yo"). */
  role: string;
  resizeLabel: string;
  /** Imagen de la firma que ya ocupa el hueco ("Solo yo"), o `null` si es un hueco por rellenar. */
  image: string | null;
  strings: SignStrings;
  onPointerDownHandler: (event: ReactPointerEvent<Element>) => void;
  onFocusSelect: () => void;
  /** Tab con el hueco enfocado: entra en la barra flotante. Devuelve `true` si lo hizo. */
  onTabToBar: () => boolean;
};

function SlotBox({
  field,
  signer,
  selected,
  label,
  role,
  resizeLabel,
  image,
  hit,
  tiny = false,
  onPointerDownHandler,
  onFocusSelect,
  onTabToBar,
}: SlotBoxProps) {
  const color = signer?.color ?? ORPHAN_SLOT_COLOR;

  return (
    <div
      role="group"
      aria-label={`${label}, ${role}`}
      tabIndex={0}
      data-drag-mode="move"
      data-element-kind="slot"
      data-element-id={field.id}
      data-hit-zone={hit ? "" : undefined}
      onPointerDown={onPointerDownHandler}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusSelect();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onFocusSelect();
          return;
        }
        if (event.key === "Tab" && !event.shiftKey && selected && onTabToBar()) {
          event.preventDefault();
        }
      }}
      className={BOX_BASE}
      style={{
        ...hitStyle(hit),
        left: percent(field.rect.x),
        top: percent(field.rect.y),
        width: percent(field.rect.width),
        height: percent(field.rect.height),
        boxSizing: "border-box",
        /* Color del firmante: dato del documento, no un token del tema. */
        border: `2px ${selected ? "solid" : "dashed"} ${color}`,
        backgroundColor: image ? "transparent" : `${color}22`,
        boxShadow: selected ? SELECTION_RING : undefined,
        // El seleccionado va por encima de los demas: huecos y campos
        // comparten lienzo y pueden solaparse, y su tirador no debe quedar
        // tapado por un hermano posterior en el DOM.
        zIndex: selected ? 20 : undefined,
      }}
    >
      {image ? (
        /* La firma tal como quedara en el PDF: encajada en el hueco sin deformarla. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          draggable={false}
          className="pointer-events-none absolute inset-0 block size-full object-contain"
        />
      ) : null}
      <ElementLabel label={label} color={color} />
      {selected ? (
        <ResizeHandle
          kind="slot"
          id={field.id}
          resizeLabel={resizeLabel}
          outside={tiny}
          onPointerDownHandler={onPointerDownHandler}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Campo de texto / casilla / fecha / iniciales
 * ------------------------------------------------------------------ */

type TextFieldBoxProps = HitProps & {
  field: DetectedField;
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Clave del historial de valores (etiqueta normalizada), o `null` sin etiqueta estable. */
  historyKey: string | null;
  selected: boolean;
  /** Input en linea abierto (distinto de `selected`). */
  editing: boolean;
  strings: SignStrings;
  /** Lado del desplegable de sugerencias (lo decide el lienzo segun donde quede la barra flotante). */
  suggestionsPlacement: "top" | "bottom";
  onPointerDownHandler: (event: ReactPointerEvent<Element>) => void;
  onFocusSelect: () => void;
  /** Enter/Espacio con el propio campo enfocado (teclado): abre el editor. */
  onOpenEditor: () => void;
  /** El input perdio el foco: cierra el editor sin perder la seleccion. */
  onEditEnd: () => void;
  /** Tab/Enter (1) o Mayus+Tab (-1): saltar al campo pendiente. `undefined` si la navegacion por teclado esta apagada. */
  onAdvance?: (direction: 1 | -1) => void;
  /** Alterna una casilla (marca/desmarca) y la registra como "tocada". Solo definido para `type === "checkbox"`. */
  onToggle?: () => void;
  /** Tab con el campo enfocado (sin editar): entra en la barra flotante. Devuelve `true` si lo hizo. */
  onTabToBar: () => boolean;
};

/**
 * Un campo de texto sobre la vista previa: contorno solido (AcroForm o
 * vectorial) o discontinuo (deteccion raster, confianza baja). Un toque
 * limpio (sin arrastre) abre el input en linea justo encima del propio
 * campo -- la unica forma de rellenar, como tocar un hueco en Acrobat.
 */
function TextFieldBox({
  field,
  label,
  value,
  onValueChange,
  historyKey,
  selected,
  editing,
  strings,
  hit,
  tiny = false,
  suggestionsPlacement,
  onPointerDownHandler,
  onFocusSelect,
  onOpenEditor,
  onEditEnd,
  onAdvance,
  onToggle,
  onTabToBar,
}: TextFieldBoxProps) {
  const type = fieldTypeOf(field);
  const dashed = field.confidence === "low";
  const color = dashed ? LOW_CONFIDENCE_COLOR : TEXT_FIELD_COLOR;
  const filled = isFieldFilled(field, value);
  const status = filled ? strings.a11yFilled : strings.a11yPending;

  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const checkboxRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (type === "checkbox" && editing) {
      checkboxRef.current?.focus();
    }
  }, [type, editing]);

  const suggestions =
    editing && historyKey && !suggestionsDismissed
      ? suggestValues(historyKey, value, 5)
      : [];

  const commitAndClose = () => {
    if (historyKey) recordValue(historyKey, value);
    onEditEnd();
  };

  const onBoxKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Tab" && !event.shiftKey && selected && !editing && onTabToBar()) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    if (type === "checkbox") onToggle?.();
    else onOpenEditor();
  };

  return (
    <div
      role="group"
      aria-label={`${label}, ${status}`}
      tabIndex={0}
      data-drag-mode="move"
      data-element-kind="text"
      data-element-id={field.id}
      data-hit-zone={hit ? "" : undefined}
      onPointerDown={onPointerDownHandler}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusSelect();
      }}
      onKeyDown={onBoxKeyDown}
      className={BOX_BASE}
      style={{
        ...hitStyle(hit),
        left: percent(field.rect.x),
        top: percent(field.rect.y),
        width: percent(field.rect.width),
        height: percent(field.rect.height),
        boxSizing: "border-box",
        border: `2px ${dashed ? "dashed" : "solid"} ${color}`,
        backgroundColor: value ? `${color}22` : "transparent",
        boxShadow: selected ? SELECTION_RING : undefined,
        // Por encima de los elementos siguientes (hermanos absolutos sin
        // z-index propio, apilados por orden del DOM): sin esto, el
        // desplegable de sugerencias puede quedar tapado por un campo
        // posterior en la misma pagina.
        zIndex: editing ? 30 : selected ? 20 : undefined,
      }}
    >
      <ElementLabel label={label} color={color} />

      {selected ? (
        <ResizeHandle
          kind="text"
          id={field.id}
          resizeLabel={strings.resizeTextField}
          outside={tiny}
          onPointerDownHandler={onPointerDownHandler}
        />
      ) : null}

      {/*
        Una casilla no tiene modo "editar": el toque limpio que la
        marca/desmarca vive en `onPointerUp` del lienzo. Este nodo es solo
        el objetivo de foco para Tab/Enter (navegacion por teclado) y
        Espacio (alternar) -- no intercepta punteros.
      */}
      {type === "checkbox" ? (
        <span
          ref={checkboxRef}
          role="checkbox"
          aria-checked={Boolean(value)}
          aria-label={label}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === " ") {
              event.preventDefault();
              onToggle?.();
              return;
            }
            if (onAdvance && event.key === "Tab") {
              event.preventDefault();
              onAdvance(event.shiftKey ? -1 : 1);
              return;
            }
            if (onAdvance && event.key === "Enter") {
              event.preventDefault();
              onAdvance(1);
            }
          }}
          className="pointer-events-none absolute inset-0 flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
        >
          {value ? (
            <Check aria-hidden="true" className="size-4" style={{ color: INK_ON_PAGE }} />
          ) : null}
        </span>
      ) : editing ? (
        <>
          <input
            type={type === "date" ? "date" : "text"}
            aria-label={label}
            value={value}
            placeholder={
              type === "initials"
                ? strings.initialsFieldPlaceholder
                : strings.textFieldPlaceholder
            }
            maxLength={type === "initials" ? 4 : undefined}
            autoFocus
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) => {
              const next =
                type === "initials"
                  ? event.target.value.toUpperCase()
                  : event.target.value;
              onValueChange(next);
              setHighlightedIndex(-1);
              setSuggestionsDismissed(false);
            }}
            onBlur={commitAndClose}
            onKeyDown={(event) => {
              // Sin `stopPropagation`: Escape tiene que llegar al listener
              // de `window` que cierra el editor, y el contenedor ya ignora
              // las teclas que no vienen de el mismo.
              if (suggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlightedIndex((index) =>
                    Math.min(index + 1, suggestions.length - 1),
                  );
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlightedIndex((index) => Math.max(index - 1, 0));
                  return;
                }
                if (event.key === "Enter" && highlightedIndex >= 0) {
                  event.preventDefault();
                  onValueChange(suggestions[highlightedIndex]);
                  setSuggestionsDismissed(true);
                  return;
                }
                if (event.key === "Escape") {
                  // El primer Escape solo cierra las sugerencias: se marca
                  // como atendido para que el listener global no cierre
                  // tambien el editor. El segundo ya sale de la edicion.
                  event.preventDefault();
                  setSuggestionsDismissed(true);
                  return;
                }
              }

              // Navegacion por teclado (si esta activa en Ajustes): Tab o
              // Enter confirma el valor y salta al siguiente campo vacio;
              // Mayus+Tab, al anterior.
              if (
                onAdvance &&
                (event.key === "Enter" || event.key === "Tab")
              ) {
                event.preventDefault();
                if (historyKey) recordValue(historyKey, value);
                setSuggestionsDismissed(true);
                onAdvance(event.key === "Tab" && event.shiftKey ? -1 : 1);
              }
            }}
            /* Fondo y tinta fijos: el input va sobre la pagina (siempre clara), y en el tema claro `bg-white/95` resuelve a un gris casi negro (token invertido) con texto negro encima. */
            className="absolute inset-0 h-full w-full rounded-[3px] border-0 bg-[#fffffff2] px-1.5 text-xs text-[#111827] outline-2 -outline-offset-2 outline-signal placeholder:text-[#6b7280]"
          />
          {/* Fecha/inicial no tienen historial (`historyKey` llega null): la lista queda vacia y no se pinta nada. */}
          <ValueSuggestions
            id={`${field.id}-suggestions`}
            suggestions={suggestions}
            highlightedIndex={highlightedIndex}
            placement={suggestionsPlacement}
            onPick={(picked) => {
              onValueChange(picked);
              setSuggestionsDismissed(true);
            }}
            onForget={(forgotten) => {
              if (historyKey) forgetValue(historyKey, forgotten);
            }}
            strings={strings}
          />
        </>
      ) : value ? (
        <span
          className="pointer-events-none absolute inset-0 flex items-center truncate px-1.5 text-xs"
          style={{ color: INK_ON_PAGE }}
        >
          {value}
        </span>
      ) : null}
    </div>
  );
}
