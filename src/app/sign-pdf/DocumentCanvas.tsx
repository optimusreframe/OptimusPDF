"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";
import Link from "next/link";
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
  Hand,
  Maximize2,
  Move,
  PenLine,
  Signature,
  Sparkles,
  SquareCheck,
  Trash2,
  Type,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ButtonGroup } from "@/components/ui/ButtonGroup";
import { LiveSinkProvider, StatusRegion } from "@/components/tool/liveRouting";
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
  signerDisplayName,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";
import {
  detectRasterFields,
  fieldTypeOf,
  isFieldFilled,
  isSuggestedField,
  isSuggestionOnly,
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
import { useCanvasCompact } from "@/app/sign-pdf/canvasCompact";
import { useIsDesktop } from "@/app/pdf-pro/shell/useIsDesktop";
import { usePageImage } from "@/app/sign-pdf/usePageImage";
import { useSignTextEditing, type SignTextEditConfig } from "@/app/sign-pdf/useSignTextEditing";
import { ValueSuggestions } from "@/app/sign-pdf/ValueSuggestions";
import { SuggestionBar } from "@/app/sign-pdf/SuggestionBar";
import { FieldTagPicker, TagGlyph } from "@/app/sign-pdf/FieldTagPicker";
import { CustomTagSheet } from "@/app/sign-pdf/CustomTagSheet";
import { impliedTagOf, memoryKeyOf } from "@/app/sign-pdf/fieldMemory";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";
import type { CanvasTagging } from "@/app/sign-pdf/useFieldTagging";
import {
  BarButton,
  BarChip,
  BarGroup,
  FloatingFieldBar,
} from "@/app/sign-pdf/FloatingFieldBar";
import { ToolPalette } from "@/app/sign-pdf/ToolPalette";
import { useInProSuite } from "@/app/sign-pdf/useInProSuite";
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
  rectsOverlap,
  toolAfterPlacement,
  toolFromShortcut,
  type PlacementTool,
} from "@/app/sign-pdf/canvasTools";
import { tagLabel, tagOf, type TaggableType } from "@/lib/fieldTags";
import { useOptionalLanguage } from "@/lib/i18n";
import {
  FINGER_HINT_MS,
  createPenGuard,
  isDraftTap,
  isScrollLikeSwipe,
  markFingerHintSeen,
  pageScrollForTwoFingers,
  readFingerDrawPref,
  readFingerHintSeen,
  writeFingerDrawPref,
  type PenPhase,
} from "@/app/sign-pdf/canvasGestures";
import { useGestureStrings } from "@/app/sign-pdf/gestureStrings";
import {
  customTagNames,
  forgetValue,
  rankedSuggestions,
  recordValue,
  setPinned,
  useValueHistoryVersion,
} from "@/lib/valueHistory";
import { createEdgeAutoScroller, type EdgeAutoScroller } from "@/lib/touch/edgeAutoScroll";
import { clampPan, panForPinch, panToCenterPoint, panWithOverflow } from "@/lib/touch/panZoom";
import {
  findScrollParent,
  freeRegion,
  revealDelta,
  scrollVerticallyBy,
  type Box,
} from "@/lib/touch/scrollRegion";
import { useFieldEditMode } from "@/app/sign-pdf/editMode/FieldEditModeProvider";
import { useEditModeStrings } from "@/app/sign-pdf/editMode/editModeStrings";
import { EditModeFrame, type DockTab } from "@/app/sign-pdf/editMode/EditModeFrame";
import { EditInspector } from "@/app/sign-pdf/editMode/EditInspector";
import { ElementsPanel, HelpPanel, PagesPanel, type ElementIcon, type ElementRow } from "@/app/sign-pdf/editMode/EditPanels";
import { SwitchRow } from "@/app/sign-pdf/editMode/editUi";
import { useEditStage } from "@/app/sign-pdf/editMode/useEditStage";
import { useEditHistory, type EditSnapshot } from "@/app/sign-pdf/editMode/useEditHistory";
import { useEditInput, type EditInputApi } from "@/app/sign-pdf/editMode/useEditInput";
import {
  EDIT_MAX_ZOOM,
  clampPanTo,
  initialPan,
  nextPageWithFields,
  pageSwipeIntent,
  panForZoomAt,
  revealShift,
  stepZoom,
  zoomForField,
  type FreeBox,
  type Insets as ViewInsets,
  type Size as ViewSize,
} from "@/app/sign-pdf/editMode/viewMath";
import {
  alignTo,
  clampFontSize,
  matchSizeTo,
  nearestOther,
  nudge as nudgeRect,
  pasteSpot,
  repeatTargets,
  resizeTo,
  type AlignMode,
} from "@/app/sign-pdf/editMode/editGeometry";
import { LINE_HEIGHT_FACTOR, MIN_FONT_SIZE } from "@/lib/pdf/editPdf";

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

/** Miniaturas de navegacion: pequenas a proposito. La vista principal se dibuja al tamano real (`usePageImage`). */
const THUMB_WIDTH = 96;

/**
 * Con hasta este numero de sugerencias el interruptor «Campos sugeridos» arranca
 * ACTIVADO; con mas (un documento ruidoso) arranca apagado y la pagina se ve limpia.
 */
export const SUGGESTIONS_DEFAULT_MAX = 8;

/** Lado minimo de un elemento, en fraccion de pagina. */
const MIN_FIELD_SIDE = 0.02;

/**
 * Cuanto debe cambiar la distancia entre dos dedos (fraccion de la inicial) para que el gesto deje de ser «mover la
 * pagina con dos dedos» y empiece a ampliar. Por debajo, el zoom no se mueve aunque los dedos se abran o cierren un poco.
 */
const PINCH_SCALE_SLOP = 0.06;
/** A pantalla completa dos dedos son TAMBIEN el gesto de pasar de pagina: el margen es mayor para que un arrastre rapido no se tome por pellizco. */
const PINCH_SCALE_SLOP_EDIT = 0.12;

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
/**
 * `COARSE_TALL` + alto minimo, para botones con `wrap` (rotulo largo que parte en lineas): `wrap` fija `h-auto!`, que gana
 * a `pointer-coarse:h-11`; el `min-h-11` mantiene los 44 px con puntero grueso cuando el rotulo cabe en una linea.
 */
const COARSE_TALL_MIN = `${COARSE_TALL} pointer-coarse:min-h-11`;

/**
 * En movil la paleta (dock pegajoso) y las barras fijas de abajo (tab bar + «Opciones/Procesar», ~12,5 rem en total) tapan el
 * borde inferior: al enfocar un control de la pagina, el navegador lo desplaza hasta dejarlo por encima (WCAG 2.4.11).
 */
const ABOVE_FLOATING_PALETTE = "max-md:scroll-mb-48";

const MAX_ZOOM = 3;
/** Niveles de los botones de zoom (el pellizco admite cualquier valor entre 1 y `MAX_ZOOM`). */
const ZOOM_STEPS = [1, 1.5, 2, 3] as const;

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

/**
 * Tiempo (ms) que el dedo debe estar QUIETO sobre la hoja, con una herramienta de creacion armada y «Un dedo dibuja»
 * APAGADO, para que el arrastre siguiente DIBUJE el recuadro en vez de desplazar la pagina (GE-01). Un toque corto coloca
 * el elemento por defecto; deslizar de inmediato desplaza.
 */
const HOLD_TO_DRAW_MS = 260;

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
  /** Los documentos de la ronda, para cambiar de uno a otro desde el modo «Editar campos» (W3-B1). */
  docs?: readonly { id: string; name: string; active: boolean }[];
  /** Pasa a otro documento (en su ultima pagina vista). */
  selectDoc?: (docId: string) => void;
};

/**
 * Que hace UN dedo sobre la hoja cuando hay una herramienta de creacion armada (GE-01 / W3-A3):
 * Con la prop AUSENTE manda el interruptor visible «Un dedo dibuja» (puntero grueso), ENCENDIDO por defecto y recordado en
 * este navegador: encendido el dedo dibuja de inmediato y DOS dedos mueven la pagina; apagado, un toque coloca, deslizar
 * desplaza la pagina y mantener quieto ~260 ms antes de arrastrar dibuja. Con la prop presente:
 *  - `auto` y `scroll`: el modo de antes (toque = colocar, deslizar = desplazar, mantener = dibujar) y sin interruptor.
 *    `getGestureMode()` devuelve `auto` con el interruptor apagado.
 *  - `draw`  : el dedo dibuja de inmediato y dos dedos mueven la pagina, sin interruptor.
 * Sin herramienta (Seleccionar) el dedo siempre desplaza la pagina (a 1x) o mueve la hoja ampliada y, al llegar a su borde,
 * sigue con la pagina. Con raton o lapiz el arrastre siempre dibuja de inmediato (el lapiz, ademas, con rechazo de palma).
 */
export type GestureMode = "auto" | "scroll" | "draw";

export type RevealOptions = {
  /** Pagina del hueco (0-based); por defecto la visible. Si es otra, el lienzo cambia de pagina primero. */
  pageIndex?: number;
  /** `center` (por defecto) lo deja en medio de la zona libre; `nearest` solo desplaza lo justo. */
  block?: "center" | "nearest";
  /** Margen (px) respecto a las barras que tapan. 12 por defecto. */
  margin?: number;
  /** `smooth` anima el desplazamiento (se ignora con «reducir movimiento»). */
  behavior?: "auto" | "smooth";
  /** Resalta el elemento ~1 s (`id` de un hueco o campo de la pagina). */
  highlightId?: string;
};

/**
 * API imperativa del lienzo para quien lo monta (Firmar, PDF Pro): se pide con `apiRef`. Es ADITIVA: el resto del
 * contrato (`DocumentCanvasProps`) no cambia.
 */
export type DocumentCanvasApi = {
  /**
   * «Ver este hueco»: desplaza la pagina (y, con zoom, la hoja) para que `rect` (fracciones de la pagina, como los huecos
   * y campos) quede visible en la zona LIBRE: entre la cabecera, la barra de zoom y las barras o la paleta fijas de abajo.
   * Devuelve `false` si aun no hay hoja que medir (el lienzo reintenta al pintar la hoja).
   */
  scrollIntoViewRect: (rect: NormalizedRect, options?: RevealOptions) => boolean;
  /** Caja libre (px de pantalla) que ve la persona: lo que no tapan las barras fijas. Util para colocar avisos o centrar. */
  getFreeRegion: () => { top: number; bottom: number; left: number; right: number };
  /** Modo de gesto vigente (el de la prop, o el del interruptor visible). */
  getGestureMode: () => GestureMode;
};

/** Evento de `window` equivalente a `apiRef.scrollIntoViewRect` (`detail: { rect, options? }`). */
export const CANVAS_REVEAL_EVENT = "optimus:canvas:reveal";

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
  /** Acceso imperativo (`scrollIntoViewRect`...): ver `DocumentCanvasApi`. */
  apiRef?: Ref<DocumentCanvasApi>;
  /** Que hace un dedo sobre la hoja con una herramienta armada: ver `GestureMode`. Ausente = `auto` (interruptor «Un dedo dibuja», encendido). */
  gestureMode?: GestureMode;
  /**
   * Presente = la herramienta «Editar texto» existe en la paleta: las ediciones del texto
   * original de ESTE documento y sus textos (W6-A, ver `useSignTextEditing`).
   */
  textEdit?: SignTextEditConfig;
  /**
   * Etiquetas de campo, memoria y autorrelleno (W3-A1): lo da `useDocumentSession` (`tagging`). Ausente = el lienzo se
   * comporta como antes de las etiquetas (sin chips, sin autorrelleno; las sugerencias salen de la etiqueta del rotulo).
   */
  tagging?: CanvasTagging;
  /**
   * Modo «Rellenar» (W3-B2): `id` del campo de texto que el asistente tiene ahora. Se pinta con un anillo propio (`data-fill-current`),
   * sin seleccionarlo ni abrir su editor. Ausente/`null` = ningun campo destacado.
   */
  fillFocusId?: string | null;
};

export type { SignTextEditConfig };

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
  /** Posicion inicial del dedo en fracciones de la hoja: sigue valiendo si la pagina se desplaza o la hoja se mueve. */
  startNorm: { x: number; y: number };
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

/** Una sugerencia que la persona toca (mueve, cambia de tipo) pasa a ser un campo suyo. */
function ownField(field: DetectedField): DetectedField {
  return isSuggestedField(field) ? { ...field, source: "manual" } : field;
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
  textFields: allTextFields,
  onTextFieldsChange: commitTextFields,
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
  textEdit,
  apiRef,
  gestureMode,
  tagging,
  fillFocusId = null,
}: DocumentCanvasProps) {
  const gestureStrings = useGestureStrings();
  const tagStrings = useTagStrings();
  const tagLanguage = useOptionalLanguage();
  const compact = useCanvasCompact();
  /** Dentro de PDF Pro el layout de tablet lo gobierna la suite (paleta en carril desde 768 px); fuera, desde 1 280 px. */
  const inPro = useInProSuite();
  const isDesktop = useIsDesktop();
  /*
   * Modo «Editar campos» a pantalla completa (W3-B1). El MISMO lienzo y la misma sesion: con el modo abierto la hoja se
   * pinta en el nodo del modo (un portal a pantalla completa, `editMode/`) en vez de en la pagina, y estos gestos y
   * funciones cambian de sitio de reparto (hoja fija, zoom y desplazamiento propios, panel de edicion); con el modo
   * cerrado, o sin proveedor (Rellenar, editor de plantillas), nada de esto se nota.
   */
  const editHost = useFieldEditMode();
  const editStrings = useEditModeStrings();
  const immersive = Boolean(editHost?.active && editHost.container);
  const [dockState, setDockState] = useState<{ open: boolean; tab: DockTab }>({ open: false, tab: "element" });
  const [dockSelKey, setDockSelKey] = useState<string | null>(null);
  const [smoothView, setSmoothView] = useState(false);
  /** Alto que tenia el lienzo en la pagina al abrir el modo: el marcador que lo sustituye lo conserva para no mover el scroll. */
  const [inlineHeight, setInlineHeight] = useState(0);
  const [clipboardKind, setClipboardKind] = useState<CanvasElementKind | null>(null);
  const clipboardRef = useRef<
    { kind: "slot"; field: SignatureField } | { kind: "text"; field: DetectedField; value: string } | null
  >(null);
  /** Recuento de paginas que da la pasada de miniaturas (la vista grande trae el suyo). */
  const [thumbPageCount, setThumbPageCount] = useState(0);
  const [thumbs, setThumbs] = useState<string[]>([]);
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
  const wideScreen = useMediaQuery("(min-width: 900px)");
  /** Campo cuyo selector de tipo esta abierto en la barra (se cierra al cambiar de seleccion o al salir el foco de la barra). */
  const [typePickerFor, setTypePickerFor] = useState<string | null>(null);
  /** Campo cuyos chips de etiqueta estan abiertos en la barra flotante (raton): se cierra igual que el selector de tipo. */
  const [tagPickerFor, setTagPickerFor] = useState<string | null>(null);
  /** Campo recien dibujado que aun espera su etiqueta: sus chips se abren solos (en la barra sobre el teclado, con el dedo). */
  const [freshTagId, setFreshTagId] = useState<string | null>(null);
  /** «Otra…»: campo al que se le pone una etiqueta propia desde la hoja de nombre. */
  const [customTagFor, setCustomTagFor] = useState<string | null>(null);
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
  /**
   * Con zoom > 1 un dedo sobre lo vacio desplaza la hoja (mover el lienzo) y, cuando la hoja llega a su borde, el resto del
   * movimiento sigue con la pagina («encadenado»: sin esto el zoom era una trampa de scroll, GE-01).
   */
  const panDragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);
  const pinchRef = useRef<{
    pointerIds: [number, number];
    startDistance: number;
    startZoom: number;
    startPan: { x: number; y: number };
    startMid: { x: number; y: number };
    /** La separacion de los dedos ya supero `PINCH_SCALE_SLOP`: desde ahi el gesto tambien amplia (antes solo mueve la pagina). */
    scaling: boolean;
    /** Punto medio de los dedos en el ultimo movimiento: lo que se mueven DOS dedos en vertical desplaza la pagina. */
    lastMid: { x: number; y: number };
    /** Centro (px de pantalla) de la hoja al empezar: con `transform-origin: center` es `centro de layout + pan`. */
    startCenter: { x: number; y: number };
    /** A pantalla completa y con la hoja ajustada, este gesto ya cambio de pagina (una vez por gesto). */
    flipped: boolean;
  } | null>(null);
  /** Valores vivos de zoom y pan para los gestos (los manejadores de puntero no deben leer un cierre viejo). */
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  /** Valores vivos del modo a pantalla completa para los gestos (los manejadores no deben leer un cierre viejo). */
  const immersiveRef = useRef(immersive);
  const freeRef = useRef<FreeBox>({ width: 1, height: 1, cx: 0, cy: 0 });
  const insetsRef = useRef<ViewInsets>({ top: 0, right: 0, bottom: 0, left: 0 });
  const sheetRef = useRef<ViewSize | null>(null);
  /**
   * Modo de antes («Un dedo dibuja» apagado), con una herramienta de creacion armada y un dedo: toque corto = colocar, quieto
   * `HOLD_TO_DRAW_MS` = dibujar, deslizar antes = desplazar. `holdRef` guarda el candidato mientras decide. El lapiz no pasa
   * por aqui: dibuja de inmediato.
   */
  const holdRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    point: { x: number; y: number };
    timer: number | null;
  } | null>(null);
  /** El dedo esta dibujando o moviendo algo: el `touchmove` nativo debe impedir que el navegador desplace la pagina. */
  const blockNativeScrollRef = useRef(false);
  /** Ultimo punto del dedo (px de pantalla) mientras se arrastra: el auto-desplazamiento reaplica el arrastre en el. */
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollRef = useRef<EdgeAutoScroller | null>(null);
  /** Donde (px de pantalla) empezo el recuadro: el auto-desplazamiento espera a que el dedo se mueva de verdad. */
  const draftStartClientRef = useRef<{ x: number; y: number } | null>(null);
  /**
   * Interruptor visible «Un dedo dibuja» (GE-01 / W3-A3): con una herramienta de creacion armada, un dedo dibuja de
   * inmediato (y dos dedos mueven la pagina). Viene ENCENDIDO por defecto y la preferencia se recuerda en este navegador;
   * apagado vuelve al modo de antes (arrastrar desplaza, mantener quieto un momento y arrastrar dibuja).
   */
  const [fingerDraw, setFingerDraw] = useState(readFingerDrawPref);
  /** Pista de la primera vez («Un dedo dibuja · dos dedos mueven la pagina»), visible unos segundos. */
  const [fingerHintOpen, setFingerHintOpen] = useState(false);
  const fingerHintTimerRef = useRef<number | null>(null);
  /** Lapiz en contacto o reciente: sus dedos vecinos (la palma) no crean ni dibujan. Ver `canvasGestures.ts`. */
  const penGuardRef = useRef(createPenGuard());
  /** Punteros de dedo rechazados como palma: sus eventos siguientes (mover, soltar) no tocan ningun gesto en curso. */
  const ignoredPointersRef = useRef<Set<number>>(new Set());
  /**
   * Con dedo o lapiz, un toque corto sobre la hoja vacia MIENTRAS un campo estaba abierto en edicion solo lo cierra (y
   * suelta la seleccion): no crea otro. Al cerrarse el teclado la hoja cambia de sitio y el toque no apuntaba donde parecia, y
   * asi cerrar no deja un campo fantasma. Arrastrar, o un segundo toque, si crean. Con raton crea al momento.
   */
  const closeOnlyRef = useRef(false);

  /*
   * Sugerencias de la heuristica: una capa OPCIONAL, no campos del documento. Una
   * sugerencia sin valor (`isSuggestionOnly`) solo se ve con el interruptor
   * «Campos sugeridos» activado (o mientras esta seleccionada o en edicion); en
   * cuanto la persona escribe en ella, la mueve o le cambia el tipo, es un campo
   * suyo. `textFields` (de aqui en adelante) es la lista VISIBLE; las ocultas se
   * conservan y vuelven a la lista completa al escribir (`onTextFieldsChange`).
   * El estado inicial se decide UNA vez, al llegar las primeras sugerencias.
   */
  const [suggestionsPref, setSuggestionsPref] = useState<boolean | null>(null);
  const [suggestionsAuto, setSuggestionsAuto] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const suggestionIds = allTextFields
    .filter((field) => isSuggestionOnly(field, values[field.id]))
    .map((field) => field.id);
  const suggestionCount = suggestionIds.length;
  if (suggestionsAuto === null && suggestionCount > 0) {
    setSuggestionsAuto(suggestionCount <= SUGGESTIONS_DEFAULT_MAX);
  }
  const suggestionsOn = suggestionsPref ?? suggestionsAuto ?? true;
  const openFieldId =
    editingId ?? (selection?.kind === "text" ? selection.id : null);
  const hiddenKey = suggestionsOn
    ? ""
    : suggestionIds.filter((id) => id !== openFieldId).join("|");
  const textFields = useMemo(() => {
    if (hiddenKey === "") return allTextFields;
    const hidden = new Set(hiddenKey.split("|"));
    return allTextFields.filter((field) => !hidden.has(field.id));
  }, [allTextFields, hiddenKey]);
  const allTextFieldsRef = useRef(allTextFields);
  const valuesRef = useRef(values);
  useEffect(() => {
    allTextFieldsRef.current = allTextFields;
    valuesRef.current = values;
  });
  /** Guarda la lista visible editada sin perder las sugerencias ocultas. */
  const onTextFieldsChange = useCallback(
    (next: DetectedField[]) => {
      if (textFields === allTextFields) {
        commitTextFields(next);
        return;
      }
      const visible = new Set(textFields.map((field) => field.id));
      commitTextFields([
        ...next,
        ...allTextFields.filter((field) => !visible.has(field.id)),
      ]);
    },
    [textFields, allTextFields, commitTextFields],
  );

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
  /** Los chips de etiqueta de la barra los abrio la persona (no el campo recien dibujado): el foco entra en ellos; al cerrar vuelve al boton. */
  const pendingTagButtonFocusRef = useRef(false);
  const focusTagPickerRef = useRef(false);
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
  /** Pagina visible y `goToPage` vivos para la API imperativa (`apiRef`): que la API no lea un cierre viejo. */
  const pageIndexRef = useRef(pageIndex);
  const pageCountRef = useRef(0);
  const goToPageForRevealRef = useRef<(index: number) => void>(() => {});
  useEffect(() => {
    pageIndexRef.current = pageIndex;
  });
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

  /* Miniaturas de navegacion: una pasada secuencial por el documento. En la vista continua las pinta el envoltorio; el modo «Editar campos» las necesita aqui. */
  const needThumbs = !thumbsInSequence || immersive;
  useEffect(() => {
    if (!file || !needThumbs) return;
    let cancelled = false;

    void (async () => {
      try {
        const document = await openPdfDocument(file);
        if (cancelled) {
          void closePdfDocument(document);
          return;
        }
        setThumbPageCount(document.numPages);

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
  }, [file, needThumbs]);

  /*
   * Vista grande de la pagina activa: dibujada al tamano real en que se ve
   * (ancho x zoom x densidad de pantalla), nitida tambien al acercar. Un
   * documento abierto por archivo; render cancelable y con cache (`usePageImage`).
   */
  const reportError = useCallback((code: PdfErrorCode) => errorRef.current?.(code), []);
  const image = usePageImage({
    file,
    pageIndex,
    layoutWidth: layoutSize.width,
    zoom,
    onError: reportError,
  });
  const preview = image.src;
  /**
   * Proporcion ancho/alto de la pagina que se ve, leida del propio PDF (con su
   * rotacion), o `null` si no se pudo leer. Es la fuente fiable para colocar la
   * firma al montar: la caja medida (`hostSize`) todavia es la del marcador de
   * posicion 3:4 cuando llega la vista previa, y una firma colocada con esa
   * proporcion sale deformada en las paginas que no son 3:4.
   */
  const previewAspect = image.aspect;
  const loading = image.loading;
  const pageCount = image.pageCount || thumbPageCount;
  const imagePageCount = image.pageCount;
  /** Tamano de la pagina en puntos PDF: convierte el tamano de letra (pt) a pixeles de la hoja. */
  const pageSizePt = useMemo(() => {
    const view = image.page?.getViewport?.({ scale: 1 });
    return view && view.width > 0 && view.height > 0 ? { width: view.width, height: view.height } : null;
  }, [image.page]);
  useEffect(() => {
    if (imagePageCount > 0) sequenceRef.current?.onPageCount(imagePageCount);
  }, [imagePageCount]);

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
    // La hoja cambia de nodo al abrir o cerrar el modo a pantalla completa: se vuelve a observar.
  }, [preview, immersive]);

  /* Escenario del modo «Editar campos»: tamano de la hoja fija y lo que la tapa (ver `useEditStage`). */
  const aspectForFit =
    previewAspect ?? (hostSize.width > 0 && hostSize.height > 0 ? hostSize.width / hostSize.height : 0.75);
  const stage = useEditStage({ enabled: immersive, clipRef, aspect: aspectForFit, watchKey: editingId });

  /* ---------------------------------------------------------------- *
   * Derivados
   * ---------------------------------------------------------------- */

  /**
   * Herramientas utilizables ahora (firma e iniciales necesitan firmantes;
   * casilla y fecha dependen de `richFieldTypes`). Una herramienta que deja
   * de estar disponible (se borro al ultimo firmante, se apago el ajuste)
   * se trata como Seleccionar.
   */
  const hasTextEditTool = textEdit !== undefined;
  const tools = useMemo(
    () =>
      availableTools({
        hasSigners: signers.length > 0,
        richFieldTypes: richFieldTypesEnabled,
        solo: Boolean(solo),
        editText: hasTextEditTool,
      }),
    [signers.length, richFieldTypesEnabled, solo, hasTextEditTool],
  );
  const effectiveTool: PlacementTool = tools.includes(tool) ? tool : "select";
  /** Que crea la herramienta activa (`null` = Seleccionar o «Editar texto», que no crean huecos). */
  const creates =
    effectiveTool === "select" || effectiveTool === "editText"
      ? null
      : TOOL_CREATES[effectiveTool];
  const editingText = effectiveTool === "editText";
  /** Zoom y desplazamiento con dos dedos: el ajuste de Firmar o, siempre, el modo a pantalla completa (hoja fija). */
  const zoomOn = pinchZoomEnabled || immersive;
  /** Un dedo con una herramienta armada dibuja de inmediato (la prop manda; sin ella, el interruptor visible, encendido por defecto). */
  const fingerDrawOn = immersive || gestureMode === "draw" || (gestureMode === undefined && fingerDraw);
  /**
   * Gestos de varios dedos (pellizco y arrastre de dos dedos para mover la pagina): con el zoom activado, o con una
   * herramienta armada y un dedo que dibuja (entonces dos dedos son la UNICA forma de mover la pagina sin soltar la
   * herramienta). El lapiz nunca cuenta para el pellizco.
   */
  const multiTouchOn = zoomOn || (creates !== null && fingerDrawOn);

  /* «Editar texto»: la capa de bloques de Editar PDF sobre la MISMA imagen (ver `useSignTextEditing`). */
  const imageRef = useRef<HTMLImageElement>(null);
  const textEditing = useSignTextEditing({
    config: textEdit,
    active: editingText,
    doc: image.doc,
    page: image.page,
    pageIndex,
    layoutWidth: layoutSize.width,
    renderKey: image.src,
    imageRef,
    hostRef,
    stageRef,
    clipRef,
    coarse,
    announce: setAnnouncement,
  });

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
      case "editText":
        return strings.toolEditText;
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
    // Un hueco hallado en una pagina escaneada no es un «Campo N» del documento: se dice lo que es.
    if (field.source === "heuristic-raster") return strings.scannedFieldLabel(globalIndex + 1);
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

  /*
   * Pista de la primera vez (W3-A3): con un dedo que dibuja de inmediato la pagina ya no se desplaza con un dedo; se dice
   * UNA vez («Un dedo dibuja · dos dedos mueven la pagina») al armar la primera herramienta, visible unos segundos y por la
   * region viva. Se da por vista al terminar o al colocar el primer elemento; sin almacenamiento puede volver a salir. Un
   * arrastre de dedo casi vertical (intento de desplazar) la recuerda sin dejar un campo (ver `isScrollLikeSwipe`).
   */
  const hideFingerHint = useCallback(() => {
    if (fingerHintTimerRef.current !== null) window.clearTimeout(fingerHintTimerRef.current);
    fingerHintTimerRef.current = null;
    setFingerHintOpen(false);
  }, []);
  /** Muestra la pista unos segundos (y la lee la region viva); `markSeen` la da por vista al terminar (la de la primera vez). */
  const showFingerHint = useCallback(
    (markSeen: boolean) => {
      if (fingerHintTimerRef.current !== null) window.clearTimeout(fingerHintTimerRef.current);
      setFingerHintOpen(true);
      setAnnouncement(gestureStrings.fingerHint);
      fingerHintTimerRef.current = window.setTimeout(() => {
        fingerHintTimerRef.current = null;
        if (markSeen) markFingerHintSeen();
        setFingerHintOpen(false);
      }, FINGER_HINT_MS);
    },
    [gestureStrings.fingerHint],
  );
  useEffect(
    () => () => {
      if (fingerHintTimerRef.current !== null) window.clearTimeout(fingerHintTimerRef.current);
    },
    [],
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
      if (next === "select") {
        hideFingerHint();
      } else if (next !== "editText" && coarse && fingerDrawOn && !readFingerHintSeen()) {
        showFingerHint(true);
      }
    },
    [select, onToolChange, solo, coarse, fingerDrawOn, hideFingerHint, showFingerHint],
  );

  /* ---------------------------------------------------------------- *
   * Mutaciones
   * ---------------------------------------------------------------- */

  const addSlot = useCallback(
    (rect: NormalizedRect, type: SignatureFieldType, quiet = false) => {
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
      // Con la herramienta aun armada (`quiet`) el hueco nuevo NO queda seleccionado ni enfocado: su barra y su tirador
      // taparian el sitio del siguiente toque (iniciales una tras otra) y el boton "Anadir aqui" sigue en pantalla con el
      // foco del teclado. Tocarlo lo selecciona, como siempre.
      if (quiet) return;
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
        // Campo nuevo: se ofrecen los chips de etiqueta (con el dedo, en la barra sobre el teclado; con raton, en la barra flotante).
        if (tagging && (type === "text" || type === "date")) {
          setFreshTagId(field.id);
          // A pantalla completa no hay barra flotante: las etiquetas van en el panel de edicion.
          if (!coarse && !immersive) setTagPickerFor(field.id);
        }
      }
    },
    [textFields, onTextFieldsChange, onSelectionChange, onEditingIdChange, pageIndex, tagging, coarse, immersive],
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
        textFields.map((field) =>
          field.id === id ? { ...ownField(field), rect } : field,
        ),
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
  /** Acciones del modo a pantalla completa que Escape necesita (cerrar el panel, salir): se refrescan en cada pintado. */
  const immersiveActionsRef = useRef<{ dockOpen: boolean; closeDock: () => void; exit: () => void }>({
    dockOpen: false,
    closeDock: () => {},
    exit: () => {},
  });
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
      // El propio modo «Editar campos» es un dialogo modal, pero sus teclas SON las del lienzo.
      if (
        origin?.closest?.(
          '[role="dialog"]:not([data-field-edit-mode]), [aria-modal="true"]:not([data-field-edit-mode])',
        )
      ) {
        return;
      }
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
          // «Editar texto»: con el foco en un bloque o en su editor, Esc es del bloque (suelta la seleccion);
          // la herramienta se deja con otro Esc, ya sin foco dentro de la capa.
          if (toolRef.current === "editText" && origin?.closest?.("[data-block-layer], [data-inline-editor]")) {
            return;
          }
          onToolChange("select");
          return;
        }
        if (immersiveRef.current) {
          // A pantalla completa, un Escape por capa: panel abierto, seleccion y, al final, salir del modo.
          if (immersiveActionsRef.current.dockOpen) {
            immersiveActionsRef.current.closeDock();
            return;
          }
          if (selection) {
            onSelectionChange(null);
            return;
          }
          immersiveActionsRef.current.exit();
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
  }, [selection, onEditingIdChange, onToolChange, onSelectionChange]);

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
      if (
        target?.closest?.(
          '[role="dialog"]:not([data-field-edit-mode]), [aria-modal="true"]:not([data-field-edit-mode])',
        )
      ) {
        return;
      }
      // «Editar texto»: teclear una letra con un bloque enfocado EDITA ese bloque (no cambia de herramienta).
      if (toolRef.current === "editText" && target?.closest?.("[data-block-layer]")) return;
      const inScope =
        !target ||
        target === document.body ||
        target === document.documentElement ||
        Boolean(rootRef.current?.contains(target)) ||
        // A pantalla completa el foco esta en el nodo del modo, fuera de la pagina.
        Boolean(target.closest?.("[data-field-edit-mode]"));
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
      if (field.optional === true) return false;
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
    // Y el seguimiento del dedo: sin esto el auto-desplazamiento seguiria con el arrastre ya abortado.
    blockNativeScrollRef.current = false;
    lastPointerRef.current = null;
    autoScrollRef.current?.stop();
    const hold = holdRef.current;
    if (hold?.timer != null) window.clearTimeout(hold.timer);
    holdRef.current = null;
    closeOnlyRef.current = false;
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
    goToPageForRevealRef.current = goToPage;
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
    if (immersiveRef.current) {
      zoomEdit(next, null);
      return;
    }
    applyView(next, next === 1 ? { x: 0, y: 0 } : clampPan(panRef.current, next, layoutSize));
  };
  const zoomIn = () =>
    setZoomLevel(
      immersiveRef.current ? stepZoom(zoomRef.current, 1) : (ZOOM_STEPS.find((step) => step > zoom + 0.01) ?? zoom),
    );
  const zoomOut = () =>
    setZoomLevel(
      immersiveRef.current
        ? stepZoom(zoomRef.current, -1)
        : ([...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.01) ?? 1),
    );

  const hasOtherPendingField =
    Boolean(sequence?.othersPending) ||
    textFields.some(
      (field) =>
        !(selection?.kind === "text" && selection.id === field.id) &&
        isPendingForNav(field),
    );

  /**
   * «Buscar huecos en páginas escaneadas»: la heuristica raster NO corre sola (toma por
   * hueco cualquier raya oscura de una foto); la persona la pide para la pagina que ve.
   * Los resultados entran como sugerencias (se ven con el interruptor encendido).
   */
  const scanScannedPage = async () => {
    if (!file || scanning) return;
    const page = pageIndex;
    setScanning(true);
    try {
      const found = await detectRasterFields(file, [page]);
      if (!aliveRef.current) return;
      const current = allTextFieldsRef.current;
      const kept = current.filter(
        (field) =>
          !(
            field.source === "heuristic-raster" &&
            field.pageIndex === page &&
            isSuggestionOnly(field, valuesRef.current[field.id])
          ),
      );
      commitTextFields([...kept, ...found]);
      setSuggestionsPref(true);
      setAnnouncement(
        found.length > 0 ? strings.scanFound(found.length, page + 1) : strings.scanNone(page + 1),
      );
    } catch {
      if (aliveRef.current) setAnnouncement(strings.scanFailed);
    } finally {
      if (aliveRef.current) setScanning(false);
    }
  };

  const toggleCheckbox = (field: DetectedField) => {
    markCheckboxTouched(field.id);
    onValueChange(field.id, (values[field.id] ?? "") ? "" : "true");
  };

  /** Relacion ancho/alto de la pagina en pantalla (0.75 mientras no hay vista previa medida). */
  const pageAspect =
    hostSize.width > 0 && hostSize.height > 0 ? hostSize.width / hostSize.height : 0.75;

  /** Ancho de la hoja en px de layout (sin zoom); cae a la medida con transformacion si aun no hay layout. */
  const pageWidthPx = layoutSize.width || hostSize.width;
  /** Pixeles de la hoja por punto PDF (para el tamano de letra propio de un campo). */
  const pointScale = pageSizePt && layoutSize.width > 0 ? layoutSize.width / pageSizePt.width : undefined;

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

  /**
   * Crea lo que toca la herramienta activa. La herramienta SE QUEDA armada (W3-A3): cambia solo cuando la persona toca otra
   * en la paleta («Seleccionar» incluida), pulsa Escape o su atajo (`toolAfterPlacement`; la firma de «Solo yo» es la unica
   * que vuelve a Seleccionar). Asi se ponen las iniciales de cada pagina o varias casillas sin volver a elegirla.
   */
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
    const nextTool = toolAfterPlacement(effectiveTool, { solo: Boolean(solo) });
    const stays = nextTool !== "select";
    if (creates.kind === "slot") addSlot(rect, creates.slotType, stays);
    else {
      addTextField(rect, creates.fieldType);
      // Una casilla no abre editor: con la herramienta aun armada no queda seleccionada (ver `addSlot`). Un campo de texto
      // o de fecha si queda abierto en edicion; tocar luego la hoja vacia (dedo o lapiz) solo lo cierra.
      if (stays && creates.fieldType === "checkbox") {
        onSelectionChange(null);
        restoreFocusToRef.current = null;
      }
    }
    if (!stays) {
      onToolChange("select");
      return;
    }
    // La pista de la primera vez ya cumplio (la persona acaba de colocar algo) y la region viva lo cuenta sin ruido.
    markFingerHintSeen();
    hideFingerHint();
    setAnnouncement(gestureStrings.placedStillArmed(toolLabel(effectiveTool)));
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
   * «Anadir aqui» (sin puntero): como la herramienta sigue armada, pulsarlo otra vez NO apila otro elemento encima del
   * anterior: se busca el hueco libre mas cercano (en «Solo yo» la firma es una y simplemente se coloca).
   */
  const addAtDefaultSpot = () => {
    if (!creates) return;
    const size = defaultSize();
    const centered: NormalizedRect = {
      x: clamp(0.5 - size.width / 2, 0, Math.max(0, 1 - size.width)),
      y: clamp(0.75 - size.height / 2, 0, Math.max(0, 1 - size.height)),
      width: size.width,
      height: size.height,
    };
    if (solo && creates.kind === "slot") {
      createWithTool(centered);
      return;
    }
    const others = [...pageSlots, ...pageTextFields].map((field) => field.rect);
    createWithTool(
      others.some((other) => rectsOverlap(centered, other))
        ? { ...findFreeSpot(centered, others), width: centered.width, height: centered.height }
        : centered,
    );
  };

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
        // La copia lleva el mismo dato (la misma etiqueta): si la sesion ya lo tiene, se rellena sola (`useFieldTagging`).
        ...(tagOf(source) ? { tag: tagOf(source) } : {}),
        ...(source.optional ? { optional: true } : {}),
        ...(source.fontSize ? { fontSize: source.fontSize } : {}),
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
      textFields.map((candidate) => {
        if (candidate.id !== field.id) return candidate;
        const changed = { ...ownField(candidate), type };
        // La etiqueta solo la llevan los campos de texto y de fecha: una casilla o unas iniciales no la conservan.
        if (type === "checkbox" || type === "initials") delete changed.tag;
        return changed;
      }),
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

  /** Posicion del dedo en fracciones de la hoja SIN recortar a [0, 1] (un arrastre puede salirse de la hoja). */
  const toRawNormalized = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const host = hostRef.current;
    if (!host) return null;
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return null;
    return { x: (clientX - bounds.left) / bounds.width, y: (clientY - bounds.top) / bounds.height };
  };

  /**
   * Fija zoom y desplazamiento a la vez (estado y refs vivos para los gestos). `animate` (solo a pantalla completa y con los
   * botones, el teclado o un reencuadre) lleva la hoja con una transicion suave; un gesto la corta y sigue al dedo 1:1.
   */
  const applyView = (nextZoom: number, nextPan: { x: number; y: number }, animate = false) => {
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
    setSmoothView(animate);
  };

  /** Limita el desplazamiento al recorrido de la hoja: el de siempre o, a pantalla completa, contra la caja libre del escenario. */
  const limitPan = (nextPan: { x: number; y: number }, nextZoom: number) =>
    immersiveRef.current
      ? clampPanTo(nextPan, nextZoom, layoutSizeRef.current, freeRef.current)
      : clampPan(nextPan, nextZoom, layoutSizeRef.current);

  /**
   * Zoom de la hoja fija alrededor de `anchor` (px de pantalla; por defecto el centro de la zona libre, que es lo que se ve
   * entre el panel y el teclado). `next` exactamente 1 vuelve al AJUSTE (borde superior a la vista).
   */
  const zoomEdit = (next: number, anchor: { x: number; y: number } | null, animate = true) => {
    const target = clamp(next, 1, EDIT_MAX_ZOOM);
    const surface = clipRef.current?.getBoundingClientRect();
    const free = freeRef.current;
    if (!surface) return;
    const from = anchor
      ? { x: anchor.x - (surface.left + surface.width / 2), y: anchor.y - (surface.top + surface.height / 2) }
      : { x: free.cx, y: free.cy };
    const raw = panForZoomAt(panRef.current, zoomRef.current, target, from);
    const nextPan =
      target === 1 ? initialPan(1, layoutSizeRef.current, free) : clampPanTo(raw, target, layoutSizeRef.current, free);
    applyView(target, nextPan, animate);
    if (animate) setAnnouncement(editStrings.zoomStatus(Math.round(target * 100)));
  };

  /** Quita el candidato de «mantener para dibujar» (y su temporizador). */
  const clearHold = () => {
    const hold = holdRef.current;
    if (hold?.timer != null) window.clearTimeout(hold.timer);
    holdRef.current = null;
  };

  /** Empieza el recuadro de creacion en `point` (fracciones de la hoja). */
  const beginDraft = (
    pointerId: number,
    point: { x: number; y: number },
    client: { x: number; y: number },
    target: HTMLElement,
    fromTouch: boolean,
  ) => {
    draftStartClientRef.current = client;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      /* el puntero ya termino */
    }
    // Tocar el lienzo vacio siempre cierra el editor que estuviera abierto.
    onEditingIdChange(null);
    gesturePageRef.current = pageIndex;
    draftOriginRef.current = point;
    if (fromTouch) blockNativeScrollRef.current = true;
    setDraft({ x: point.x, y: point.y, toX: point.x, toY: point.y });
  };

  /** Termina el seguimiento del dedo que arrastra: para el auto-desplazamiento y suelta el bloqueo del scroll nativo. */
  const endDragTracking = () => {
    blockNativeScrollRef.current = false;
    lastPointerRef.current = null;
    autoScrollRef.current?.stop();
  };

  const startCreate = (event: ReactPointerEvent<HTMLDivElement>) => {
    const isPen = event.pointerType === "pen";
    const isFinger = event.pointerType === "touch";
    // Dedo y lapiz impiden el desplazamiento nativo mientras dibujan (`touchmove` no pasivo); solo el raton no lo necesita.
    const fromTouch = isFinger || isPen;
    // Un id de puntero se puede reutilizar (Chrome recicla ids pequenos): un toque nuevo nunca hereda un rechazo viejo.
    ignoredPointersRef.current.delete(event.pointerId);
    // Palma: con el lapiz tocando la hoja, ningun dedo hace nada (ni cuenta para el pellizco). Ver `canvasGestures.ts`.
    if (isFinger && penGuardRef.current.penInContact()) {
      ignoredPointersRef.current.add(event.pointerId);
      return;
    }
    // El lapiz nunca forma parte de un pellizco: solo los dedos (y el raton) se registran.
    if (multiTouchOn && !isPen) {
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      // Un segundo dedo mientras no hay ningun elemento en arrastre es un
      // pellizco (que tambien mueve la pagina con dos dedos), nunca un segundo intento de dibujar.
      if (activePointersRef.current.size === 2 && !dragRef.current) {
        const [[idA, a], [idB, b]] = [...activePointersRef.current.entries()];
        event.preventDefault();
        draftOriginRef.current = null;
        tapCandidateRef.current = null;
        panDragRef.current = null;
        closeOnlyRef.current = false;
        clearHold();
        endDragTracking();
        setDraft(null);
        const bounds = hostRef.current?.getBoundingClientRect();
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        pinchRef.current = {
          pointerIds: [idA, idB],
          startDistance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
          startZoom: zoomRef.current,
          startPan: panRef.current,
          startMid: mid,
          scaling: false,
          lastMid: mid,
          startCenter: bounds
            ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
            : mid,
          flipped: false,
        };
        return;
      }
      if (activePointersRef.current.size > 2 || pinchRef.current) return;
    }
    // Palma (cola): el lapiz se levanto hace menos de `PALM_REJECT_MS`. El dedo queda registrado (dos dedos si pellizcan),
    // pero un solo dedo no crea, no dibuja ni deselecciona.
    if (isFinger && penGuardRef.current.rejectsFinger()) {
      ignoredPointersRef.current.add(event.pointerId);
      return;
    }

    // Seleccionar: lo vacio solo deselecciona, y al soltar si fue un toque corto.
    if (!creates) {
      tapCandidateRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      // A pantalla completa la hoja es fija: un dedo sobre lo vacio la mueve siempre que haya donde (con zoom o hoja alta).
      if (zoomOn && (immersiveRef.current || zoomRef.current > 1)) {
        panDragRef.current = {
          pointerId: event.pointerId,
          lastX: event.clientX,
          lastY: event.clientY,
        };
      }
      return;
    }
    if (!preview) return;
    if (creates.kind === "slot" && !canPlaceSlot) return;
    const point = toNormalized(event.clientX, event.clientY);
    if (!point) return;
    // A pantalla completa los gestos escuchan en todo el escenario: un toque fuera de la hoja no crea nada.
    if (immersiveRef.current) {
      const raw = toRawNormalized(event.clientX, event.clientY);
      if (raw && (raw.x < 0 || raw.x > 1 || raw.y < 0 || raw.y > 1)) return;
    }

    // Con un campo abierto en edicion, un toque corto de dedo o lapiz solo lo cierra (ver `closeOnlyRef`).
    closeOnlyRef.current = fromTouch && editingId !== null;

    // «Un dedo dibuja» apagado: un dedo con la herramienta armada: toque = colocar, quieto = dibujar, deslizar = desplazar (GE-01).
    // El lapiz NO pasa por aqui: dibuja de inmediato.
    if (isFinger && !fingerDrawOn) {
      // Sin los eventos de raton que el navegador sintetiza tras el toque (sacarian el foco del campo recien creado).
      event.preventDefault();
      clearHold();
      const hold = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        point,
        timer: null as number | null,
      };
      holdRef.current = hold;
      const target = event.currentTarget;
      hold.timer = window.setTimeout(() => {
        hold.timer = null;
        if (holdRef.current !== hold) return;
        // Quieto el tiempo suficiente: a partir de aqui el dedo dibuja (el `touchmove` nativo impide el scroll).
        beginDraft(hold.pointerId, hold.point, { x: hold.x, y: hold.y }, target, true);
        try {
          navigator.vibrate?.(8);
        } catch {
          /* sin vibracion */
        }
      }, HOLD_TO_DRAW_MS);
      return;
    }

    // Raton, lapiz y dedo con «Un dedo dibuja»: el recuadro empieza al instante, sin espera ni desplazamiento.
    event.preventDefault();
    beginDraft(event.pointerId, point, { x: event.clientX, y: event.clientY }, event.currentTarget, fromTouch);
  };

  const startDrag = (event: ReactPointerEvent<Element>) => {
    const host = hostRef.current;
    const target = event.currentTarget as HTMLElement;
    // Palma sobre un elemento o su tirador mientras escribe el lapiz: se ignora (y no sube a la hoja).
    ignoredPointersRef.current.delete(event.pointerId);
    if (event.pointerType === "touch" && penGuardRef.current.rejectsFinger()) {
      event.stopPropagation();
      ignoredPointersRef.current.add(event.pointerId);
      return;
    }
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
    clearHold();
    dragRef.current = {
      kind,
      mode,
      id,
      startX: event.clientX,
      startY: event.clientY,
      startNorm: toRawNormalized(event.clientX, event.clientY) ?? { x: 0, y: 0 },
      snapshot,
      pointerId: event.pointerId,
      moved: false,
    };
    select({ kind, id });
  };

  /**
   * Reaplica el arrastre (mover, redimensionar, recuadro de creacion) con el dedo en `(clientX, clientY)`. Lo llaman el
   * movimiento del puntero y el auto-desplazamiento, que mueve la pagina bajo un dedo quieto. Devuelve `true` si habia
   * algo que arrastrar.
   */
  const applyDragAt = (clientX: number, clientY: number): boolean => {
    const host = hostRef.current;
    const drag = dragRef.current;
    if (drag && host) {
      const raw = toRawNormalized(clientX, clientY);
      if (!raw) return true;
      const start = drag.snapshot;
      // En fracciones de la hoja: sigue valiendo aunque la pagina se haya desplazado o la hoja movido desde el inicio.
      const dx = raw.x - drag.startNorm.x;
      const dy = raw.y - drag.startNorm.y;

      if (drag.mode === "move") {
        patchRect(drag.kind, drag.id, {
          x: clamp(start.x + dx, 0, Math.max(0, 1 - start.width)),
          y: clamp(start.y + dy, 0, Math.max(0, 1 - start.height)),
          width: start.width,
          height: start.height,
        });
        return true;
      }

      patchRect(drag.kind, drag.id, {
        x: start.x,
        y: start.y,
        width: clamp(start.width + dx, MIN_FIELD_SIDE, 1 - start.x),
        height: clamp(start.height + dy, MIN_FIELD_SIDE, 1 - start.y),
      });
      return true;
    }

    if (!draftOriginRef.current) return false;
    const point = toNormalized(clientX, clientY);
    if (!point) return true;
    setDraft((current) =>
      current ? { ...current, toX: point.x, toY: point.y } : current,
    );
    return true;
  };
  const applyDragAtRef = useRef(applyDragAt);
  useEffect(() => {
    applyDragAtRef.current = applyDragAt;
  });

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (multiTouchOn) {
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
          const ratio = distance / pinch.startDistance;
          // Dos dedos que se desplazan casi nunca conservan la distancia al milimetro (y cada dedo manda su propio
          // `pointermove`): hasta que la separacion cambie mas de `PINCH_SCALE_SLOP` el gesto SOLO mueve la pagina y no
          // amplia. Sin el zoom activado (solo dedo que dibuja) los dos dedos nunca amplian: la hoja se queda a 1x.
          if (
            !pinch.scaling &&
            Math.abs(ratio - 1) > (immersiveRef.current ? PINCH_SCALE_SLOP_EDIT : PINCH_SCALE_SLOP)
          ) {
            pinch.scaling = true;
          }
          const nextZoom = pinch.scaling
            ? clamp(pinch.startZoom * ratio, 1, zoomOn ? (immersiveRef.current ? EDIT_MAX_ZOOM : MAX_ZOOM) : 1)
            : pinch.startZoom;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const prevZoom = zoomRef.current;
          const prevPan = panRef.current;
          // Los dedos mandan: el punto de la hoja que estaba entre ellos sigue entre ellos (zoom con foco en el centro).
          const pinched = panForPinch({
            pan0: pinch.startPan,
            zoom0: pinch.startZoom,
            zoom1: nextZoom,
            mid0: pinch.startMid,
            mid1: mid,
            rectCenter0: pinch.startCenter,
          });
          // A pantalla completa la hoja ajustada puede ser mas alta que el escenario: se recorre tambien sin zoom.
          const nextPan = immersiveRef.current
            ? limitPan(pinched, nextZoom)
            : nextZoom === 1
              ? { x: 0, y: 0 }
              : clampPan(pinched, nextZoom, layoutSize);
          // A 1x en reposo no hay nada que repintar (evita un render por movimiento al desplazar con dos dedos).
          if (nextZoom !== prevZoom || nextPan.x !== prevPan.x || nextPan.y !== prevPan.y) {
            applyView(nextZoom, nextPan);
          }
          // Dos dedos MUEVEN LA PAGINA: lo que la hoja no absorbe de su movimiento vertical se encadena al desplazamiento.
          const last = pinch.lastMid;
          pinch.lastMid = mid;
          const scroll = pageScrollForTwoFingers({
            fingersDy: mid.y - last.y,
            panDy: nextPan.y - prevPan.y,
            zoomChanged: nextZoom !== prevZoom,
          });
          if (scroll !== 0 && hostRef.current && !immersiveRef.current) {
            scrollVerticallyBy(findScrollParent(hostRef.current), scroll);
            dragRegionRef.current = null;
          }
          // Hoja ajustada: arrastrar dos dedos hacia los lados pasa de pagina (una vez por gesto, nunca si pellizca).
          if (immersiveRef.current && !pinch.flipped) {
            const step = pageSwipeIntent({
              dx: mid.x - pinch.startMid.x,
              dy: mid.y - pinch.startMid.y,
              zoom: nextZoom,
              scaled: pinch.scaling,
            });
            if (step !== 0 && pageIndexRef.current + step >= 0 && pageIndexRef.current + step < Math.max(1, pageCountRef.current)) {
              pinch.flipped = true;
              goToPageRef.current(pageIndexRef.current + step);
            }
          }
        }
        return;
      }
    }
    // Un dedo rechazado como palma no mueve ningun gesto en curso (el del lapiz, por ejemplo).
    if (ignoredPointersRef.current.has(event.pointerId)) return;

    // Candidato de «mantener para dibujar»: si el dedo se mueve antes de tiempo, es un gesto de desplazamiento.
    const hold = holdRef.current;
    if (hold && event.pointerId === hold.pointerId && hold.timer !== null) {
      if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > TAP_MOVE_THRESHOLD_PX) {
        clearHold();
        // Con zoom el lienzo se queda el gesto (`touch-action: none`): mover la hoja y, en el borde, la pagina.
        // A 1x el navegador ya desplaza la pagina por su cuenta (y mandara `pointercancel`).
        if (zoomOn && zoomRef.current > 1) {
          panDragRef.current = {
            pointerId: event.pointerId,
            lastX: hold.x,
            lastY: hold.y,
          };
        }
      }
    }

    const tap = tapCandidateRef.current;
    if (tap && event.pointerId === tap.pointerId) {
      if (Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_MOVE_THRESHOLD_PX) {
        tapCandidateRef.current = null;
      }
    }
    const panning = panDragRef.current;
    if (panning && event.pointerId === panning.pointerId && !tapCandidateRef.current && !holdRef.current) {
      event.preventDefault();
      const moved = immersiveRef.current
        ? (() => {
            const desired = {
              x: panRef.current.x + (event.clientX - panning.lastX),
              y: panRef.current.y + (event.clientY - panning.lastY),
            };
            const limited = limitPan(desired, zoomRef.current);
            return { pan: limited, overflow: { x: desired.x - limited.x, y: desired.y - limited.y } };
          })()
        : panWithOverflow(
            panRef.current,
            { x: event.clientX - panning.lastX, y: event.clientY - panning.lastY },
            zoomRef.current,
            layoutSize,
          );
      panning.lastX = event.clientX;
      panning.lastY = event.clientY;
      applyView(zoomRef.current, moved.pan);
      // Lo que la hoja no absorbio sigue con la pagina (el dedo sube, la pagina baja): se encadena el scroll.
      // A pantalla completa la hoja es fija: no hay pagina que desplazar.
      if (moved.overflow.y !== 0 && hostRef.current && !immersiveRef.current) {
        scrollVerticallyBy(findScrollParent(hostRef.current), -moved.overflow.y);
      }
      return;
    }

    const drag = dragRef.current;
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;

      if (!drag.moved) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance <= TAP_MOVE_THRESHOLD_PX && drag.mode === "move") return;
        if (distance > TAP_MOVE_THRESHOLD_PX) drag.moved = true;
      }
      event.preventDefault();
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      if (drag.moved) autoScrollRef.current?.start();
      applyDragAt(event.clientX, event.clientY);
      return;
    }

    if (!draftOriginRef.current) return;
    event.preventDefault();
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    const origin = draftStartClientRef.current;
    if (!origin || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > TAP_MOVE_THRESHOLD_PX) {
      autoScrollRef.current?.start();
    }
    applyDragAt(event.clientX, event.clientY);
  };

  /**
   * Deja de rastrear un dedo para el pellizco. Si era uno de los dos que
   * lo sostenian, el pellizco termina; si el zoom quedo muy cerca de 1x,
   * encaja del todo (sin esto quedaria un residuo imperceptible pero ya
   * no reiniciable sin pasar primero por debajo de 1x).
   */
  const endPinchPointer = (pointerId: number) => {
    activePointersRef.current.delete(pointerId);
    const pinch = pinchRef.current;
    if (pinch && pinch.pointerIds.includes(pointerId)) {
      pinchRef.current = null;
      if (zoomRef.current <= 1.02) {
        // A pantalla completa la hoja ajustada se queda donde esta (su pan lo limita la caja libre), solo con zoom 1 exacto.
        if (immersiveRef.current) applyView(1, limitPan(panRef.current, 1));
        else applyView(1, { x: 0, y: 0 });
      }
    }
  };

  /** Puntero perdido a medio gesto (interrupcion del sistema o el navegador tomo el desplazamiento): se aborta. */
  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    endPinchPointer(event.pointerId);
    // La palma que se levanta no aborta el trazo del lapiz.
    if (ignoredPointersRef.current.delete(event.pointerId)) return;
    closeOnlyRef.current = false;
    tapCandidateRef.current = null;
    panDragRef.current = null;
    dragRef.current = null;
    draftOriginRef.current = null;
    clearHold();
    endDragTracking();
    setDraft(null);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    endPinchPointer(event.pointerId);
    if (ignoredPointersRef.current.delete(event.pointerId)) return;
    if (panDragRef.current?.pointerId === event.pointerId) panDragRef.current = null;
    endDragTracking();
    // Toque corto con la herramienta armada (un dedo): coloca el elemento por defecto donde se toco.
    const hold = holdRef.current;
    if (hold && hold.pointerId === event.pointerId) {
      const wasPending = hold.timer !== null;
      clearHold();
      if (wasPending) {
        gesturePageRef.current = pageIndex;
        onEditingIdChange(null);
        // Un campo estaba abierto en edicion: este toque solo lo cierra (ver `closeOnlyRef`).
        if (closeOnlyRef.current) {
          closeOnlyRef.current = false;
          select(null);
          return;
        }
        addCentered(hold.point.x, hold.point.y);
        return;
      }
    }
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
    const closeOnly = closeOnlyRef.current;
    closeOnlyRef.current = false;
    if (!origin || !current) return;
    // Defensa extra: la pagina cambio por cualquier via entre pulsar y soltar.
    if (gesturePageRef.current !== pageIndex) return;

    const width = Math.abs(current.toX - current.x);
    const height = Math.abs(current.toY - current.y);
    const startClient = draftStartClientRef.current;
    // Un toque: sin moverse (con dedo o lapiz, menos de `TAP_MOVE_THRESHOLD_PX` px aunque la hoja sea pequena).
    if (
      isDraftTap({
        pointerType: event.pointerType,
        movedPx: startClient ? Math.hypot(event.clientX - startClient.x, event.clientY - startClient.y) : null,
        spanX: width,
        spanY: height,
        clickSlop: CLICK_SLOP,
        tapPx: TAP_MOVE_THRESHOLD_PX,
      })
    ) {
      // Con un campo abierto en edicion este toque solo lo cierra y suelta la seleccion; el siguiente crea.
      if (closeOnly) {
        select(null);
        return;
      }
      addCentered(current.x, current.y);
      return;
    }
    // Un dedo que arrastra casi en vertical y lejos intentaba DESPLAZAR la pagina (habito): no crea un campo estrecho y alto.
    if (
      !immersiveRef.current &&
      startClient &&
      isScrollLikeSwipe({
        pointerType: event.pointerType,
        dxPx: event.clientX - startClient.x,
        dyPx: event.clientY - startClient.y,
      })
    ) {
      select(null);
      showFingerHint(false);
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

  /* Chips de etiqueta de la barra: abiertos por la persona, el foco entra en ellos; al cerrar vuelve al boton de etiqueta. */
  useEffect(() => {
    const bar = stageRef.current?.querySelector<HTMLElement>("[data-floating-bar]");
    if (!bar) return;
    if (tagPickerFor !== null && tagPickerFor === selection?.id) {
      if (!focusTagPickerRef.current) return;
      focusTagPickerRef.current = false;
      (bar.querySelector<HTMLElement>('[data-tag-picker] [aria-pressed="true"]') ?? bar.querySelector<HTMLElement>("[data-tag-picker] button"))?.focus();
    } else if (pendingTagButtonFocusRef.current) {
      pendingTagButtonFocusRef.current = false;
      bar.querySelector<HTMLElement>('[data-bar-action="tag"]')?.focus();
    }
  }, [tagPickerFor, selection?.id]);

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

  /* ---------------------------------------------------------------- *
   * Gestos con el dedo (GE-01, GE-06): auto-desplazamiento por tiempo, bloqueo del scroll nativo mientras se dibuja
   * o se pellizca, y la API imperativa «ver este hueco».
   * ---------------------------------------------------------------- */

  /** Hay gestos de dos dedos (pellizco y/o mover la pagina): el `touchmove` nativo con 2 dedos no debe desplazar ni ampliar la pagina. */
  const pinchEnabledRef = useRef(multiTouchOn);
  const layoutSizeRef = useRef(layoutSize);
  const gestureModeRef = useRef<GestureMode>("auto");
  useEffect(() => {
    pinchEnabledRef.current = multiTouchOn;
    layoutSizeRef.current = layoutSize;
    gestureModeRef.current = gestureMode ?? (fingerDraw ? "draw" : "auto");
    immersiveRef.current = immersive;
    freeRef.current = stage.free;
    insetsRef.current = stage.insets;
    sheetRef.current = stage.sheet;
    pageCountRef.current = pageCount;
  });

  /** Zona visible en la que el dedo NO desplaza: la libre del scroller (sin barras fijas) y, con zoom, la de la tarjeta. */
  const dragRegionRef = useRef<{ at: number; box: Box } | null>(null);
  const hasFile = Boolean(file);

  /*
   * Rechazo de palma (W3-A3): el lapiz se anota en CAPTURA sobre `window`, porque sus eventos pueden llegar a un elemento, a
   * un tirador o a la hoja (que paran la propagacion). Solo cuenta el trazo con contacto; ver `createPenGuard`.
   */
  useEffect(() => {
    const guard = penGuardRef.current;
    const noteOf = (phase: PenPhase) => (event: PointerEvent) => {
      if (event.pointerType === "pen") guard.pen(phase, event.pointerId);
    };
    const listeners: Array<[string, (event: PointerEvent) => void]> = [
      ["pointerdown", noteOf("down")],
      ["pointermove", noteOf("move")],
      ["pointerup", noteOf("up")],
      ["pointercancel", noteOf("cancel")],
    ];
    for (const [type, listener] of listeners) {
      window.addEventListener(type, listener as EventListener, { capture: true, passive: true });
    }
    return () => {
      for (const [type, listener] of listeners) {
        window.removeEventListener(type, listener as EventListener, { capture: true });
      }
    };
  }, []);

  useEffect(() => {
    const regionOf = (): Box => {
      const host = hostRef.current;
      if (!host) return { top: 0, bottom: 0, left: 0, right: 0 };
      if (immersiveRef.current) {
        // A pantalla completa la zona libre es el escenario menos lo que tapan el panel y el teclado.
        const surface = clipRef.current?.getBoundingClientRect();
        if (!surface) return { top: 0, bottom: 0, left: 0, right: 0 };
        const covered = insetsRef.current;
        return {
          top: surface.top + covered.top,
          bottom: surface.bottom - covered.bottom,
          left: surface.left + covered.left,
          right: surface.right - covered.right,
        };
      }
      const cached = dragRegionRef.current;
      const nowMs = performance.now();
      if (!cached || nowMs - cached.at > 200) {
        dragRegionRef.current = { at: nowMs, box: freeRegion(findScrollParent(host)) };
      }
      const free = dragRegionRef.current!.box;
      const clip = clipRef.current?.getBoundingClientRect();
      if (zoomRef.current > 1.001 && clip) {
        return {
          top: Math.max(free.top, clip.top),
          bottom: Math.min(free.bottom, clip.bottom),
          left: Math.max(free.left, clip.left),
          right: Math.min(free.right, clip.right),
        };
      }
      // Sin zoom solo hay desplazamiento vertical: los bordes laterales no cuentan.
      return { top: free.top, bottom: free.bottom, left: -Infinity, right: Infinity };
    };
    /** `true` si, desplazando la pagina `dy` px (+ baja), aun se descubre hoja bajo (o sobre) la zona libre. */
    const sheetHasRoomToScroll = (dy: number): boolean => {
      const card = (clipRef.current ?? hostRef.current)?.getBoundingClientRect();
      if (!card) return true;
      const free = regionOf();
      return dy > 0 ? card.bottom > free.bottom + 1 : card.top < free.top - 1;
    };
    const scroller = createEdgeAutoScroller({
      pointer: () => lastPointerRef.current,
      region: regionOf,
      // A pantalla completa la hoja se recorre tambien en horizontal (se lee por fotograma: sigue al modo vigente).
      get horizontal() {
        return immersiveRef.current;
      },
      scroll: (dx, dy) => {
        const host = hostRef.current;
        if (!host) return { dx: 0, dy: 0 };
        let appliedX = 0;
        let appliedY = 0;
        let restY = dy;
        if (zoomRef.current > 1.001 || immersiveRef.current) {
          // Con la hoja ampliada, el dedo en el borde de la tarjeta primero la mueve y, agotada, sigue con la pagina.
          const result = immersiveRef.current
            ? (() => {
                const desired = { x: panRef.current.x - dx, y: panRef.current.y - dy };
                const limited = clampPanTo(desired, zoomRef.current, layoutSizeRef.current, freeRef.current);
                return { pan: limited };
              })()
            : panWithOverflow(panRef.current, { x: -dx, y: -dy }, zoomRef.current, layoutSizeRef.current);
          appliedX = -(result.pan.x - panRef.current.x);
          appliedY = -(result.pan.y - panRef.current.y);
          if (appliedX !== 0 || appliedY !== 0) applyView(zoomRef.current, result.pan);
          restY = dy - appliedY;
        }
        // (M5 · N6) La pagina solo se desplaza mientras quede hoja por descubrir en esa direccion: con el borde de la hoja ya a la
        // vista el elemento (sujeto a ese borde) no puede ir mas lejos, y seguir desplazando lo sacaba de la pantalla.
        // A pantalla completa no hay pagina que desplazar: todo el recorrido es el de la hoja.
        if (!immersiveRef.current && restY !== 0 && sheetHasRoomToScroll(restY)) {
          appliedY += scrollVerticallyBy(findScrollParent(host), restY);
        }
        dragRegionRef.current = null;
        return { dx: appliedX, dy: appliedY };
      },
      onTick: () => {
        const point = lastPointerRef.current;
        if (point) applyDragAtRef.current(point.x, point.y);
      },
    });
    autoScrollRef.current = scroller;
    return () => {
      scroller.stop();
      autoScrollRef.current = null;
    };
    // `applyView` solo escribe refs y estados estables: no hace falta recrear el bucle.
  }, []);

  /*
   * `touchmove` NATIVO y no pasivo: React registra los toques como pasivos, asi que no puede impedir el desplazamiento
   * del navegador. Se impide solo mientras el dedo o el lapiz dibujan un recuadro (`blockNativeScrollRef` se activa en el
   * `pointerdown`, ANTES del primer `touchmove`, que es cuando aun es cancelable), y con DOS dedos (pellizco y desplazar con
   * dos dedos propios: si el navegador los tomara como desplazamiento mandaria `pointercancel` y el gesto se perderia).
   * El `touch-action` del anfitrion (`touch-none` con la herramienta armada) se fija antes de tocar: en iOS no se puede
   * cambiar a mitad de un gesto.
   */
  useEffect(() => {
    // A pantalla completa los gestos escuchan en todo el escenario (no solo en la hoja).
    const element = immersive ? clipRef.current : hostRef.current;
    if (!element) return;
    const onTouchMove = (event: TouchEvent) => {
      if (!event.cancelable) return;
      if (
        blockNativeScrollRef.current ||
        (pinchEnabledRef.current && event.touches.length >= 2) ||
        immersiveRef.current
      ) {
        event.preventDefault();
      }
    };
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => element.removeEventListener("touchmove", onTouchMove);
  }, [hasFile, immersive]);

  /** Lleva `rect` (fracciones de la hoja) a la zona libre; con zoom, centra tambien la hoja bajo el hueco. */
  const revealRect = (rect: NormalizedRect, options: RevealOptions = {}): boolean => {
    const host = hostRef.current;
    if (!host) return false;
    const bounds = host.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return false;
    const flash = (id: string) => {
      const mark = host.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"][data-drag-mode="move"]`);
      if (mark) {
        mark.setAttribute("data-flash", "");
        window.setTimeout(() => mark.removeAttribute("data-flash"), 1200);
      }
    };
    if (immersiveRef.current) {
      // Hoja fija: no hay pagina que desplazar. Se mueve la hoja hasta dejar el hueco en la zona libre (entre el panel y el teclado).
      const surface = clipRef.current?.getBoundingClientRect();
      if (!surface) return false;
      const covered = insetsRef.current;
      const shift = revealShift(
        {
          left: bounds.left + rect.x * bounds.width,
          right: bounds.left + (rect.x + rect.width) * bounds.width,
          top: bounds.top + rect.y * bounds.height,
          bottom: bounds.top + (rect.y + rect.height) * bounds.height,
        },
        {
          left: surface.left + covered.left,
          right: surface.right - covered.right,
          top: surface.top + covered.top,
          bottom: surface.bottom - covered.bottom,
        },
        { margin: options.margin ?? 12, center: (options.block ?? "center") === "center" },
      );
      if (shift.x !== 0 || shift.y !== 0) {
        applyView(
          zoomRef.current,
          limitPan({ x: panRef.current.x + shift.x, y: panRef.current.y + shift.y }, zoomRef.current),
          true,
        );
      }
      if (options.highlightId) flash(options.highlightId);
      return true;
    }
    const scroller = findScrollParent(host);
    const region = freeRegion(scroller);
    let target = {
      left: bounds.left + rect.x * bounds.width,
      right: bounds.left + (rect.x + rect.width) * bounds.width,
      top: bounds.top + rect.y * bounds.height,
      bottom: bounds.top + (rect.y + rect.height) * bounds.height,
    };
    const clip = clipRef.current?.getBoundingClientRect();
    if (zoomRef.current > 1.001 && clip) {
      // La hoja ampliada se ve a trozos: se mueve para dejar el hueco en el centro de lo que la tarjeta ensena.
      const seen = {
        left: Math.max(clip.left, region.left),
        right: Math.min(clip.right, region.right),
        top: Math.max(clip.top, region.top),
        bottom: Math.min(clip.bottom, region.bottom),
      };
      const next = panToCenterPoint({
        pan: panRef.current,
        zoom: zoomRef.current,
        size: layoutSizeRef.current,
        point: { x: (target.left + target.right) / 2, y: (target.top + target.bottom) / 2 },
        target: { x: (seen.left + seen.right) / 2, y: (seen.top + seen.bottom) / 2 },
      });
      const shiftX = next.x - panRef.current.x;
      const shiftY = next.y - panRef.current.y;
      applyView(zoomRef.current, next);
      target = {
        left: target.left + shiftX,
        right: target.right + shiftX,
        top: target.top + shiftY,
        bottom: target.bottom + shiftY,
      };
    }
    const delta = revealDelta(target, region, { block: options.block, margin: options.margin });
    if (delta !== 0) {
      const reduced =
        typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      scrollVerticallyBy(scroller, delta, options.behavior === "smooth" && !reduced ? "smooth" : "auto");
    }
    if (options.highlightId) flash(options.highlightId);
    return true;
  };

  /** «Ver este hueco» pedido antes de que la hoja (o su pagina) este pintada: se atiende en cuanto se pueda. */
  const pendingRevealRef = useRef<{ rect: NormalizedRect; options: RevealOptions; pageIndex: number } | null>(null);
  const revealRectRef = useRef(revealRect);
  useEffect(() => {
    revealRectRef.current = revealRect;
  });
  useEffect(() => {
    const pending = pendingRevealRef.current;
    if (!pending || pending.pageIndex !== pageIndex || !preview || hostSize.width === 0) return;
    pendingRevealRef.current = null;
    // Tras pintar la pagina nueva (la hoja puede cambiar de alto al cargar la imagen).
    const frame = requestAnimationFrame(() => {
      if (!revealRectRef.current(pending.rect, pending.options)) pendingRevealRef.current = pending;
    });
    return () => cancelAnimationFrame(frame);
  }, [pageIndex, preview, hostSize.width, hostSize.height]);

  /*
   * Alternativa sin `ref` a `apiRef.scrollIntoViewRect`: un evento de `window` (`CANVAS_REVEAL_EVENT`, `detail` =
   * `{ rect, options? }`). Lo atiende el lienzo montado; sirve a quien no tiene el `ref` a mano (y a los E2E).
   */
  useEffect(() => {
    const onReveal = (event: Event) => {
      const detail = (event as CustomEvent<{ rect?: NormalizedRect; options?: RevealOptions }>).detail;
      if (!detail?.rect) return;
      const options = detail.options ?? {};
      const page = options.pageIndex ?? pageIndexRef.current;
      if (page !== pageIndexRef.current) {
        pendingRevealRef.current = { rect: detail.rect, options, pageIndex: page };
        goToPageForRevealRef.current(page);
        return;
      }
      if (!revealRectRef.current(detail.rect, options)) {
        pendingRevealRef.current = { rect: detail.rect, options, pageIndex: page };
      }
    };
    window.addEventListener(CANVAS_REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(CANVAS_REVEAL_EVENT, onReveal);
  }, []);

  useImperativeHandle(
    apiRef,
    (): DocumentCanvasApi => ({
      scrollIntoViewRect: (rect, options = {}) => {
        const page = options.pageIndex ?? pageIndexRef.current;
        if (page !== pageIndexRef.current) {
          pendingRevealRef.current = { rect, options, pageIndex: page };
          goToPageForRevealRef.current(page);
          return true;
        }
        const done = revealRectRef.current(rect, options);
        if (!done) pendingRevealRef.current = { rect, options, pageIndex: page };
        return done;
      },
      getFreeRegion: () => {
        const host = hostRef.current;
        if (host && immersiveRef.current) {
          const surface = clipRef.current?.getBoundingClientRect();
          const covered = insetsRef.current;
          if (surface) {
            return {
              top: surface.top + covered.top,
              bottom: surface.bottom - covered.bottom,
              left: surface.left + covered.left,
              right: surface.right - covered.right,
            };
          }
        }
        return host
          ? freeRegion(findScrollParent(host))
          : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
      },
      getGestureMode: () => gestureModeRef.current,
    }),
    [],
  );

  /* ---------------------------------------------------------------- *
   * Modo «Editar campos» a pantalla completa (W3-B1): escenario, historial, entradas y reencuadre.
   * Todo esto solo trabaja con `immersive`; con el modo cerrado son efectos que no hacen nada.
   * ---------------------------------------------------------------- */

  const { setChromeInsets } = stage;
  const containerRef = useRef<HTMLElement | null>(null);
  const elementsOnPageRef = useRef(0);
  const selectedRectRef = useRef<NormalizedRect | null>(null);
  const editingRectRef = useRef<NormalizedRect | null>(null);

  const editApply = (snap: EditSnapshot) => {
    onSlotsChange(snap.slots);
    commitTextFields(snap.textFields);
    const current = valuesRef.current;
    for (const id of new Set([...Object.keys(snap.values), ...Object.keys(current)])) {
      const wanted = snap.values[id] ?? "";
      if ((current[id] ?? "") !== wanted) onValueChange(id, wanted);
    }
    const gone =
      selection !== null &&
      !(selection.kind === "slot"
        ? snap.slots.some((field) => field.id === selection.id)
        : snap.textFields.some((field) => field.id === selection.id));
    if (gone) {
      onEditingIdChange(null);
      onSelectionChange(null);
    }
  };
  const history = useEditHistory({
    enabled: immersive,
    slots,
    textFields: allTextFields,
    values,
    apply: editApply,
  });
  const runUndo = () => setAnnouncement(history.undo() ? editStrings.undone : editStrings.nothingToUndo);
  const runRedo = () => setAnnouncement(history.redo() ? editStrings.redone : editStrings.nothingToRedo);

  /** Elementos de la pagina visible (para alinear, pegar y repetir). */
  const othersOnPage = (kind: CanvasElementKind, id: string) => [
    ...slots
      .filter((field) => field.pageIndex === pageIndex && !(kind === "slot" && field.id === id))
      .map((field) => ({ kind: "slot" as const, id: field.id, rect: field.rect, name: slotLabel(field) })),
    ...textFields
      .filter((field) => field.pageIndex === pageIndex && !(kind === "text" && field.id === id))
      .map((field) => ({ kind: "text" as const, id: field.id, rect: field.rect, name: textLabel(field) })),
  ];

  const cloneTextField = (source: DetectedField, page: number, rect: NormalizedRect): DetectedField => {
    const tag = tagOf(source);
    return {
      id: nextTextFieldId(),
      pageIndex: page,
      rect,
      source: "manual",
      confidence: "high",
      ...(source.type ? { type: source.type } : {}),
      ...(tag ? { tag } : {}),
      ...(source.optional ? { optional: true } : {}),
      ...(source.fontSize ? { fontSize: source.fontSize } : {}),
    };
  };

  const copySelected = () => {
    if (!selection) return;
    if (selection.kind === "slot") {
      const field = slots.find((candidate) => candidate.id === selection.id);
      if (!field || solo) return;
      clipboardRef.current = { kind: "slot", field };
    } else {
      const field = textFields.find((candidate) => candidate.id === selection.id);
      if (!field) return;
      clipboardRef.current = { kind: "text", field, value: values[field.id] ?? "" };
    }
    setClipboardKind(clipboardRef.current?.kind ?? null);
    setAnnouncement(editStrings.copiedStatus);
  };

  const pasteHere = () => {
    const clip = clipboardRef.current;
    if (!clip) return;
    const others = [...slots, ...textFields].filter((field) => field.pageIndex === pageIndex).map((field) => field.rect);
    if (clip.kind === "slot") {
      if (solo) return;
      const copy: SignatureField = { ...clip.field, id: nextFieldId(), pageIndex, rect: pasteSpot(clip.field.rect, others) };
      onSlotsChange([...slots, copy]);
      select({ kind: "slot", id: copy.id });
    } else {
      const copy = cloneTextField(clip.field, pageIndex, pasteSpot(clip.field.rect, others));
      onTextFieldsChange([...textFields, copy]);
      if (clip.value) onValueChange(copy.id, clip.value);
      select({ kind: "text", id: copy.id });
    }
    setAnnouncement(editStrings.pastedStatus(pageIndex + 1));
  };

  /** Iniciales: el mismo elemento en el mismo sitio de cada pagina que aun no lo tiene. */
  const repeatSelected = () => {
    if (!selection) return;
    const pages = repeatTargets(Math.max(1, pageCount), pageIndex);
    if (selection.kind === "slot") {
      const source = slots.find((field) => field.id === selection.id);
      if (!source || solo) return;
      const created: SignatureField[] = [];
      for (const page of pages) {
        const taken = slots.some(
          (field) =>
            field.pageIndex === page &&
            field.signerId === source.signerId &&
            field.type === source.type &&
            rectsOverlap(field.rect, source.rect),
        );
        if (!taken) created.push({ ...source, id: nextFieldId(), pageIndex: page });
      }
      if (created.length === 0) {
        setAnnouncement(editStrings.nothingToRepeat);
        return;
      }
      onSlotsChange([...slots, ...created]);
      setAnnouncement(editStrings.repeatedStatus(created.length));
      return;
    }
    const source = textFields.find((field) => field.id === selection.id);
    if (!source) return;
    const created: DetectedField[] = [];
    for (const page of pages) {
      const taken = textFields.some(
        (field) => field.pageIndex === page && fieldTypeOf(field) === fieldTypeOf(source) && rectsOverlap(field.rect, source.rect),
      );
      if (!taken) created.push(cloneTextField(source, page, source.rect));
    }
    if (created.length === 0) {
      setAnnouncement(editStrings.nothingToRepeat);
      return;
    }
    onTextFieldsChange([...textFields, ...created]);
    const copied = values[source.id] ?? "";
    if (copied) for (const field of created) onValueChange(field.id, copied);
    setAnnouncement(editStrings.repeatedStatus(created.length));
  };

  const alignSelected = (mode: AlignMode) => {
    if (!selection) return;
    const rect = (selection.kind === "slot" ? slots : textFields).find((field) => field.id === selection.id)?.rect;
    if (!rect) return;
    const other = nearestOther(rect, othersOnPage(selection.kind, selection.id));
    if (!other) {
      setAnnouncement(editStrings.alignNoNeighbor);
      return;
    }
    patchRect(selection.kind, selection.id, alignTo(rect, other.rect, mode));
    setAnnouncement(editStrings.alignedStatus(mode, other.name));
  };

  const matchSelectedSize = () => {
    if (!selection) return;
    const rect = (selection.kind === "slot" ? slots : textFields).find((field) => field.id === selection.id)?.rect;
    if (!rect) return;
    const other = nearestOther(rect, othersOnPage(selection.kind, selection.id), (candidate) => candidate.kind === selection.kind);
    if (!other) {
      setAnnouncement(editStrings.alignNoNeighbor);
      return;
    }
    patchRect(selection.kind, selection.id, matchSizeTo(rect, other.rect));
    setAnnouncement(editStrings.matchedStatus(other.name));
  };

  /** Propiedades opcionales de un campo de texto (letra y obligatorio): se quitan del campo en vez de guardar el valor por defecto. */
  const patchTextField = (id: string, patch: { fontSize?: number | null; optional?: boolean }) => {
    onTextFieldsChange(
      textFields.map((field) => {
        if (field.id !== id) return field;
        const next: DetectedField = { ...ownField(field) };
        if (patch.fontSize !== undefined) {
          if (patch.fontSize === null) delete next.fontSize;
          else next.fontSize = clampFontSize(patch.fontSize);
        }
        if (patch.optional !== undefined) {
          if (patch.optional) next.optional = true;
          else delete next.optional;
        }
        return next;
      }),
    );
  };

  /** Pone la hoja en `zoomTo` con el centro de `rect` en el centro de la zona libre (el campo que se escribe, sobre el teclado). */
  const centerOn = (rect: NormalizedRect, zoomTo: number, animate = true) => {
    const size = layoutSizeRef.current;
    const free = freeRef.current;
    const local = { x: (rect.x + rect.width / 2 - 0.5) * size.width, y: (rect.y + rect.height / 2 - 0.5) * size.height };
    applyView(
      zoomTo,
      limitPan({ x: free.cx - zoomTo * local.x, y: free.cy - zoomTo * local.y }, zoomTo),
      animate,
    );
  };

  const openDockTab = (tab: DockTab) =>
    setDockState((current) => (current.open && current.tab === tab ? { ...current, open: false } : { open: true, tab }));
  const closeDock = () => {
    // Cerrar el panel del elemento suelta la seleccion (como cerrar la hoja de propiedades de iOS).
    if (dockState.tab === "element" && selection) {
      onEditingIdChange(null);
      onSelectionChange(null);
    }
    setDockState((current) => ({ ...current, open: false }));
  };
  const exitEditMode = () => {
    onEditingIdChange(null);
    editHost?.close();
  };

  /** Elementos por pagina (para los puntos de las miniaturas y «siguiente pagina con campos»). */
  const elementsOnPageIndex = (index: number): number =>
    slots.filter((field) => field.pageIndex === index).length +
    textFields.filter((field) => field.pageIndex === index).length;
  const stepWithFields = (direction: 1 | -1) => {
    const target = nextPageWithFields(pageIndex, direction, Math.max(1, pageCount), elementsOnPageIndex);
    if (target === null) {
      setAnnouncement(editStrings.noPageWithFields);
      return;
    }
    goToPage(target);
  };

  /** Selecciona un elemento desde la lista (sin gestos), cambiando de pagina si hace falta, y lo lleva a la vista. */
  const selectFromList = (row: ElementRow) => {
    const field = (row.kind === "slot" ? slots : textFields).find((candidate) => candidate.id === row.id);
    if (!field) return;
    if (toolRef.current !== "select") onToolChange("select");
    if (field.pageIndex !== pageIndex) {
      pendingRevealRef.current = { rect: field.rect, options: { pageIndex: field.pageIndex, block: "nearest" }, pageIndex: field.pageIndex };
      goToPage(field.pageIndex);
    }
    select({ kind: row.kind, id: row.id });
    setAnnouncement(editStrings.elementSelectedStatus(row.name, row.pageIndex + 1));
  };

  const inputApiRef = useRef<EditInputApi | null>(null);
  useEffect(() => {
    containerRef.current = editHost?.container ?? null;
    selectedRectRef.current = selection
      ? ((selection.kind === "slot" ? slots : textFields).find((field) => field.id === selection.id)?.rect ?? null)
      : null;
    editingRectRef.current = editingId ? (textFields.find((field) => field.id === editingId)?.rect ?? null) : null;
    immersiveActionsRef.current = { dockOpen: dockState.open, closeDock, exit: exitEditMode };
    inputApiRef.current = {
      zoomBy: (factor, anchor) => zoomEdit(zoomRef.current * factor, anchor, false),
      zoomStep: (direction) => zoomEdit(stepZoom(zoomRef.current, direction), null, true),
      zoomFit: () => zoomEdit(1, null, true),
      panBy: (dx, dy) => {
        const next = limitPan({ x: panRef.current.x + dx, y: panRef.current.y + dy }, zoomRef.current);
        if (next.x === panRef.current.x && next.y === panRef.current.y) return false;
        applyView(zoomRef.current, next);
        return true;
      },
      hasSelection: () => selection !== null,
      nudge: (dx, dy) => {
        if (!selection) return;
        const rect = (selection.kind === "slot" ? slots : textFields).find((field) => field.id === selection.id)?.rect;
        if (rect) patchRect(selection.kind, selection.id, nudgeRect(rect, dx, dy));
      },
      stepPage: (direction) => {
        const target = pageIndex + direction;
        if (target >= 0 && target < Math.max(1, pageCount)) goToPage(target);
      },
      undo: runUndo,
      redo: runRedo,
      copy: copySelected,
      paste: pasteHere,
      duplicate: duplicateSelected,
      help: () => setDockState({ open: true, tab: "help" }),
    };
  });
  useEditInput({ enabled: immersive, surfaceRef: clipRef, apiRef: inputApiRef, containerRef });

  /* Alta del lienzo en el proveedor (si el modo esta abierto y se queda sin lienzo, se cierra solo) y entrada automatica. */
  const registerEditCanvas = editHost?.registerCanvas;
  useEffect(() => {
    if (!registerEditCanvas) return;
    return registerEditCanvas();
  }, [registerEditCanvas]);
  const offerAutoOpen = editHost?.offerAutoOpen;
  const canOfferAutoOpen = Boolean(preview) && !immersive;
  useEffect(() => {
    if (canOfferAutoOpen) offerAutoOpen?.();
  }, [canOfferAutoOpen, offerAutoOpen]);

  /* «Editar texto» (el texto original del PDF) vive en su propia capa y no entra en este modo: se vuelve a Seleccionar. */
  useEffect(() => {
    if (immersive && toolRef.current === "editText") onToolChange("select");
  }, [immersive, onToolChange]);

  /*
   * La hoja se vuelve a ajustar (zoom 1 y borde superior a la vista) al abrir el modo, al cambiar de pagina o de ajuste y
   * cuando llega la proporcion real de la pagina. El ajuste espera a que la hoja ya mida lo que dice el escenario.
   */
  const viewKey = immersive ? `${pageIndex}|${stage.fitMode}|${aspectForFit.toFixed(3)}` : "inline";
  const viewKeyRef = useRef(viewKey);
  const alignPendingRef = useRef(false);
  useEffect(() => {
    if (viewKeyRef.current === viewKey) return;
    viewKeyRef.current = viewKey;
    if (!immersive) {
      queueMicrotask(() => applyView(1, { x: 0, y: 0 }));
      return;
    }
    alignPendingRef.current = true;
  }, [viewKey, immersive]);
  const sheetWidth = stage.sheet?.width ?? 0;
  useEffect(() => {
    if (!immersive) return;
    const frame = requestAnimationFrame(() => {
      const layout = layoutSizeRef.current;
      const wanted = sheetRef.current;
      const measured = wanted !== null && layout.width > 0 && Math.abs(layout.width - wanted.width) < 2;
      if (alignPendingRef.current && measured) {
        alignPendingRef.current = false;
        applyView(1, initialPan(1, layout, freeRef.current));
      } else if (measured) {
        applyView(zoomRef.current, limitPan(panRef.current, zoomRef.current));
      }
    });
    return () => cancelAnimationFrame(frame);
    // Cuando cambia el tamano de la hoja medida, la caja libre o la llave de ajuste.
  }, [immersive, layoutSize.width, layoutSize.height, sheetWidth, stage.free.width, stage.free.height, stage.free.cx, stage.free.cy, viewKey]);

  /* El elemento seleccionado se reencuadra sobre el panel y el teclado cuando la seleccion o lo que tapa se asienta. */
  const revealKey = immersive && selection ? `${selection.kind}:${selection.id}:${pageIndex}` : "";
  const insetsKey = `${Math.round(stage.insets.top)}|${Math.round(stage.insets.right)}|${Math.round(stage.insets.bottom)}`;
  useEffect(() => {
    if (!revealKey) return;
    const timer = window.setTimeout(() => {
      const rect = selectedRectRef.current;
      if (!rect || dragRef.current || draftOriginRef.current) return;
      revealRectRef.current(rect, { block: "nearest", margin: 16 });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [revealKey, insetsKey]);

  /* Escribir en un campo con el dedo: se acerca hasta que se lee comodo y se centra sobre el teclado. */
  const editingKey = immersive && coarse && editingId ? `${editingId}:${pageIndex}` : "";
  useEffect(() => {
    if (!editingKey) return;
    const timer = window.setTimeout(() => {
      const rect = editingRectRef.current;
      if (!rect || dragRef.current) return;
      const fieldWidthPx = rect.width * layoutSizeRef.current.width * zoomRef.current;
      const target = zoomForField({
        zoom: zoomRef.current,
        fieldWidthPx,
        freeWidth: freeRef.current.width,
        fraction: 0.8,
        comfortablePx: 300,
        max: 3,
      });
      centerOn(rect, Math.max(zoomRef.current, target));
    }, 180);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingKey, insetsKey]);

  /*
   * El panel de edicion se abre solo al seleccionar un hueco o una casilla (nada que escribir) y se cierra al soltar la
   * seleccion. Un campo de texto o de fecha se ESCRIBE al tocarlo (teclado): su panel no tapa la hoja, se abre con el boton
   * «Propiedades». Se decide al pintar, sobre la llave de la seleccion, no en un efecto.
   */
  const dockSelKeyNow = immersive && selection ? `${selection.kind}:${selection.id}` : null;
  if (dockSelKeyNow !== dockSelKey) {
    setDockSelKey(dockSelKeyNow);
    if (dockSelKeyNow === null) {
      if (dockState.tab === "element") setDockState((current) => ({ ...current, open: false }));
    } else {
      const picked = selection?.kind === "text" ? textFields.find((field) => field.id === selection.id) : undefined;
      const typing = picked !== undefined && fieldTypeOf(picked) !== "checkbox";
      // Con raton y pantalla ancha el panel es lateral y no tapa la hoja ni el teclado: se abre tambien con los campos de texto.
      if (!typing || (!coarse && wideScreen)) setDockState({ open: true, tab: "element" });
    }
  }

  /* Anuncio de la pagina visible. */
  useEffect(() => {
    if (!immersive) return;
    const timer = window.setTimeout(
      () =>
        setAnnouncement(
          editStrings.pageStatus(pageIndex + 1, Math.max(1, pageCountRef.current), elementsOnPageRef.current),
        ),
      0,
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [immersive, pageIndex]);
  useEffect(() => {
    elementsOnPageRef.current = elementsOnPageIndex(pageIndex);
  });

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
  /** Etiqueta del campo de texto seleccionado y su nombre visible (chip de la barra flotante). */
  const selectedTag = selectedTextField ? (tagOf(selectedTextField) ?? null) : null;
  const selectedTagName = selectedTag ? tagLabel(selectedTag, tagLanguage, customTagNames()) : null;
  // El selector de tipo pertenece al elemento que lo abrio: si la seleccion cambia o se va
  // (clic fuera, Escape, otra herramienta), se cierra, y no reaparece abierto al volver a elegirlo.
  if (typePickerFor !== null && typePickerFor !== (selection?.id ?? null)) {
    setTypePickerFor(null);
  }
  const typePickerOpen = typePickerFor !== null && typePickerFor === selection?.id;
  // Igual con los chips de etiqueta de la barra, y los del campo recien dibujado solo duran mientras se edita ese campo.
  if (tagPickerFor !== null && tagPickerFor !== (selection?.id ?? null)) {
    setTagPickerFor(null);
  }
  const tagPickerOpen = tagPickerFor !== null && tagPickerFor === selection?.id;
  if (freshTagId !== null && freshTagId !== editingId) {
    setFreshTagId(null);
  }
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

  /** Pone, cambia o quita la etiqueta de un campo (lo hace `tagging`) y lo anuncia. */
  const changeTag = (field: DetectedField, tag: string | null) => {
    if (!tagging) return;
    tagging.onTagChange(field.id, tag);
    setFreshTagId(null);
    setTagPickerFor(null);
    setAnnouncement(
      tag
        ? tagStrings.tagSet(textLabel(field), tagLabel(tag, tagLanguage, customTagNames()))
        : tagStrings.tagCleared(textLabel(field)),
    );
  };

  /** Cierra los chips de la barra y devuelve el foco al boton que los abre (si se cierran con el teclado). */
  const closeTagPicker = () => {
    setTagPickerFor(null);
    pendingTagButtonFocusRef.current = true;
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

  /* La hoja con sus huecos y campos: la misma en la pagina y a pantalla completa. */
  const hostElement = (
    <div
      ref={hostRef}
      data-canvas="host"
      data-tool={effectiveTool}
      // Ultimo recurso del foco tras quitar elementos (ver arriba); no entra en el orden de Tab.
      tabIndex={-1}
      // A pantalla completa los gestos escuchan en todo el escenario (ver `clipRef` del modo), no solo en la hoja.
      onPointerDown={immersive ? undefined : startCreate}
      onPointerMove={immersive ? undefined : onPointerMove}
      onPointerUp={immersive ? undefined : onPointerUp}
      onPointerCancel={immersive ? undefined : onPointerCancel}
      className={cn(
        "relative select-none",
        // A pantalla completa la hoja mide lo que dice el escenario (ver `useEditStage`); en la pagina, el ancho de siempre.
        immersive ? "shrink-0 shadow-elevation-2" : "w-full max-w-[640px]",
        // Tablet (768-1279 px, fuera de PDF Pro): la hoja pasa de los 640 px de escritorio (en un iPad vertical y
        // horizontal ocupaba 295-460 px). El escritorio (>= 1 280 px) queda igual.
        !immersive && !inPro && "md:max-xl:max-w-[52rem]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        // GE-01 / W3-A3: con Seleccionar un dedo sobre la hoja DESPLAZA la pagina (`pan-x pan-y`). Con una herramienta
        // armada el lienzo se queda el gesto (`touch-none`, fijado ANTES del toque: en iOS no se cambia a mitad
        // de un gesto): el dedo y el lapiz dibujan de inmediato y la pagina se mueve con DOS dedos. Con «Un dedo
        // dibuja» apagado vuelve el modo de antes (arrastrar desplaza; quieto un momento y arrastrar, dibuja).
        // Los elementos y tiradores llevan `touch-none` propio. Con zoom el lienzo tambien se queda el gesto
        // (mover la hoja y, en su borde, la pagina).
        // A pantalla completa no hay pagina que desplazar: `touch-none` desde el primer toque (en iOS no se cambia a mitad de gesto).
        immersive || zoom > 1.001 || (creates && fingerDrawOn) ? "touch-none" : "touch-pan-x touch-pan-y",
        immersive && smoothView && "transition-transform duration-[280ms] ease-[var(--ease-spring)] motion-reduce:transition-none",
        creates ? "cursor-crosshair" : "cursor-default",
        // «Editar texto»: los huecos y campos se ven pero no reciben puntero (el texto manda).
        editingText && "[&_.sign-field-box]:pointer-events-none",
      )}
      style={
        immersive
          ? ({
              width: stage.sheet ? stage.sheet.width : undefined,
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: "center center",
              willChange: "transform",
              visibility: stage.sheet ? undefined : "hidden",
              "--sheet-zoom": zoom,
            } as CSSProperties)
          : zoom !== 1 || pan.x !== 0 || pan.y !== 0
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
          ref={imageRef}
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
          memoryKey={memoryKeyOf(field)}
          tag={tagOf(field) ?? null}
          impliedTag={impliedTagOf(field)}
          taggable={tagging ? taggableTypeOf(field) : null}
          autoMark={tagging?.autoFilled[field.id]}
          freshTag={field.id === freshTagId}
          onCommitValue={tagging ? (committed) => tagging.onCommit(field.id, committed) : undefined}
          onTag={(next) => changeTag(field, next)}
          onOtherTag={() => setCustomTagFor(field.id)}
          selected={selection?.kind === "text" && selection.id === field.id}
          fillCurrent={field.id === fillFocusId}
          editing={field.id === editingId}
          suggested={isSuggestionOnly(field, values[field.id])}
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
          pointScale={pointScale}
          pageHeightPt={pageSizePt?.height}
          fitFont={immersive}
        />
      ))}

      {textEditing.layer}

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
  );

  /** Botones de zoom (en la vista continua van a la barra pegajosa del envoltorio). */
  /* VI-07: `ButtonGroup` separa 4 px con raton y 8 px con dedo (antes 2 px): un dedo gordo no acierta el vecino. */
  const zoomGroup = (
    <ButtonGroup role="group" aria-label={strings.zoomGroupLabel}>
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
    </ButtonGroup>
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

  const pendingUndoText = !pendingUndo
    ? ""
    : pendingUndo.kind === "slot"
      ? solo
        ? strings.soloSignatureDeletedNotice
        : strings.fieldDeletedNotice
      : pendingUndo.kind === "type"
        ? strings.typeChangeClearedNotice(textTypeLabel(pendingUndo.toType))
        : strings.textFieldDeletedNotice;

  /*
   * Compacto en escritorio (PDF Pro · Firmar, B1): el dueño de la firma o de los huecos y el alta con teclado van
   * EN la barra de zoom y paginas, en una sola fila, en vez de en una tarjeta aparte. Quita ~74 px de alto antes de
   * la hoja. En movil (y fuera de PDF Pro) siguen en su tarjeta, como siempre. El mismo JSX en los dos sitios: nunca
   * se pintan a la vez.
   */
  const merged = compact && isDesktop && !sequence?.hidePager;
  /*
   * Hoja primero (PDF Pro, tablet y movil; auditoria VP-01): dentro de Pro cada pixel antes de la hoja cuenta, asi que el
   * texto de ayuda de la tarjeta va solo para lectores de pantalla y el estado y las acciones de borrar (raras) pasan
   * DEBAJO de la hoja, como en escritorio.
   */
  const sheetFirst = merged || compact;

  /* Dueño de los huecos nuevos (o la firma propia, en "Solo yo"). */
  const signatureControls = (
    <>
      {solo ? (
        /* "Solo yo": crear o rehacer la firma sin salir del lienzo. */
        <div
          className={
            merged
              ? "flex flex-wrap items-center gap-2"
              : "flex flex-wrap items-center justify-between gap-3"
          }
        >
          {solo.signaturePng ? (
            <span className="ui-label text-muted-foreground">
              {strings.soloSignatureLabel}
            </span>
          ) : (
            <p
              className={
                sheetFirst
                  ? "sr-only"
                  : // VI-01: `flex-1` (base 0) nunca pasaba a otra linea y se comprimia a una palabra por linea bajo
                    // los botones. Con base de 14 rem crece si hay sitio y, si no, ocupa su propia linea.
                    "min-w-0 grow basis-56 text-footnote leading-relaxed text-muted-foreground"
              }
            >
              {strings.noSignature}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 max-[480px]:w-full">
            <Button
              variant={solo.signaturePng ? "secondary" : "primary"}
              size="sm"
              className={cn(COARSE_TALL, compact && "px-2.5!")}
              onClick={solo.onCreateSignature}
            >
              <PenLine aria-hidden="true" className="size-4" />
              {solo.signaturePng ? strings.changeSignature : strings.createSignature}
            </Button>
            {solo.onOpenSaved ? (
              <Button
                variant="secondary"
                size="sm"
                className={cn(COARSE_TALL, compact && "px-2.5!")}
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
        <div className={merged ? "flex flex-wrap items-center gap-2" : undefined}>
          <span className={cn("ui-label text-muted-foreground", !merged && "mb-1.5 block")}>
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
    </>
  );

  /*
    Alta SIN puntero (teclado, lector de pantalla): con una herramienta
    de creacion activa, coloca el elemento por defecto en la pagina.
  */
  const placeControl = creates ? (
    <Button
      ref={addButtonRef}
      variant="secondary"
      size="sm"
      className={COARSE_TALL}
      disabled={creates.kind === "slot" && !canPlaceSlot}
      onClick={addAtDefaultSpot}
    >
      {creates.kind === "slot"
        ? solo
          ? strings.soloPlaceHere
          : strings.addFieldHere
        : strings.addTextFieldHere}
    </Button>
  ) : null;

  /* Entrada al modo «Editar campos» a pantalla completa (solo con proveedor: Firmar y Firmar de PDF Pro). */
  const openEditMode = (event: ReactMouseEvent<HTMLButtonElement>) => {
    setInlineHeight(rootRef.current?.offsetHeight ?? 0);
    if (toolRef.current === "editText") onToolChange("select");
    editHost?.open(event.currentTarget);
  };
  const entry = editHost ? (
    coarse && !merged ? (
      <div className="space-y-2.5 rounded-ios-sm bg-signal/10 p-3" data-edit-entry-card="">
        <Button variant="primary" size="md" fullWidth wrap data-edit-entry="" onClick={openEditMode}>
          <Maximize2 aria-hidden="true" className="size-4" />
          {editStrings.entryButtonTouch}
        </Button>
        <p className="text-footnote leading-relaxed text-muted-foreground">{editStrings.entryHint}</p>
        <SwitchRow
          label={editStrings.entryOpenAlways}
          hint={editStrings.entryOpenAlwaysHint}
          checked={editHost.openOnEnter}
          onChange={editHost.setOpenOnEnter}
        />
      </div>
    ) : (
      <Button variant="secondary" size="sm" className={COARSE_TALL} data-edit-entry="" onClick={openEditMode}>
        <Maximize2 aria-hidden="true" className="size-4" />
        {editStrings.entryButton}
      </Button>
    )
  ) : null;

  /*
   * Estado y acciones destructivas, encima del lienzo: en movil se hace scroll dentro de la vista previa para
   * moverse por el documento, asi que ningun boton que borre queda en esa ruta. Con los controles en la barra
   * (`merged`, PDF Pro en escritorio) va DEBAJO de la hoja: son acciones raras y la hoja gana ~50 px de alto.
   */
  const statusRow = (
    <div
      data-canvas-status-row=""
      className={cn(
        "flex flex-wrap items-center justify-between gap-3",
        sheetFirst ? "mt-3" : "mb-3",
      )}
    >
      <p className="flex flex-wrap items-center gap-x-1.5 text-caption text-muted-foreground tabular-nums">
        <span>{pendingNote}</span>
        <span aria-hidden="true">·</span>
        <span>
          {solo
            ? strings.soloTotalSummary(slots.length, textFields.length)
            : strings.canvasTotalSummary(slots.length, textFields.length)}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {suggestionCount > 0 || suggestionsPref !== null ? (
          <button
            type="button"
            role="switch"
            aria-checked={suggestionsOn}
            data-suggestions-toggle=""
            title={strings.suggestedFieldsDescription}
            onClick={() => {
              const next = !suggestionsOn;
              setSuggestionsPref(next);
              setAnnouncement(
                next ? strings.suggestedFieldsShown(suggestionCount) : strings.suggestedFieldsHidden,
              );
            }}
            className={cn(
              "inline-flex min-h-9 items-center gap-2 rounded-ios-sm border px-2.5 text-footnote font-medium transition-colors duration-200 ease-spring motion-reduce:transition-none pointer-coarse:min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
              // Colores forzados (alto contraste): el estado se distingue por el color de sistema, no por el tema.
              "forced-colors:border-[ButtonText] forced-colors:text-[ButtonText]",
              suggestionsOn
                ? "border-signal/60 bg-signal/15 text-foreground forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                : "border-hairline bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground forced-colors:bg-[ButtonFace]",
            )}
          >
            {/* Pista y pulgar: con colores forzados la pista lleva borde y el pulgar el color del texto, a un lado u otro. */}
            <span
              aria-hidden="true"
              data-switch-track=""
              className={cn(
                "relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors duration-200 motion-reduce:transition-none",
                // Colores de SISTEMA (un color no-sistema, como `currentColor`, se sustituye por Canvas).
                "forced-colors:border forced-colors:bg-transparent",
                suggestionsOn
                  ? "bg-signal forced-colors:border-[HighlightText]"
                  : "bg-muted-foreground/40 forced-colors:border-[ButtonText]",
              )}
            >
              <span
                data-switch-thumb=""
                className={cn(
                  "absolute top-0.5 left-0.5 size-3 rounded-full bg-background transition-transform duration-200 motion-reduce:transition-none",
                  suggestionsOn ? "translate-x-3 forced-colors:bg-[HighlightText]" : "forced-colors:bg-[ButtonText]",
                )}
              />
            </span>
            {strings.suggestedFieldsToggle(suggestionCount)}
          </button>
        ) : null}
        {coarse && creates && gestureMode === undefined ? (
          /* GE-01 / W3-A3: con una herramienta armada un dedo dibuja (dos dedos mueven la pagina); apagado vuelve a desplazar con uno. */
          <button
            type="button"
            role="switch"
            aria-checked={fingerDraw}
            data-finger-draw-toggle=""
            title={gestureStrings.fingerSwitchHint}
            onClick={() => {
              const next = !fingerDraw;
              setFingerDraw(next);
              writeFingerDrawPref(next);
              setAnnouncement(next ? gestureStrings.fingerOnStatus : gestureStrings.fingerOffStatus);
            }}
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-ios-sm border px-2.5 text-footnote font-medium transition-colors duration-200 ease-spring motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
              "forced-colors:border-[ButtonText] forced-colors:text-[ButtonText]",
              fingerDraw
                ? "border-signal/60 bg-signal/15 text-foreground forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                : "border-hairline bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground forced-colors:bg-[ButtonFace]",
            )}
          >
            <Hand aria-hidden="true" className="size-4 shrink-0" />
            {gestureStrings.fingerSwitchLabel}
          </button>
        ) : null}
        {image.hasText === false ? (
          <Button
            variant="secondary"
            size="sm"
            className={BORDERED_SM_COARSE}
            disabled={scanning}
            data-scan-fields=""
            onClick={() => void scanScannedPage()}
          >
            {scanning ? (
              <Spinner className="size-4" label={strings.scanningPage} />
            ) : null}
            {strings.scanPageFields}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          size="sm"
          wrap
          className={cn(COARSE_TALL_MIN, ABOVE_FLOATING_PALETTE)}
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
          wrap
          className={cn(COARSE_TALL_MIN, ABOVE_FLOATING_PALETTE)}
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
  );

  /* ---------------------------------------------------------------- *
   * Modo «Editar campos» a pantalla completa: lo que se pinta en el nodo del proveedor (portal).
   * ---------------------------------------------------------------- */
  if (immersive && editHost?.container) {
    const visibleText = textFields.filter((field) => !isSuggestionOnly(field, values[field.id]));
    const total = Math.max(1, pageCount, thumbs.length);
    const counts = Array.from({ length: total }, (_, index) => elementsOnPageIndex(index));

    const iconOfText = (field: DetectedField): ElementIcon => {
      const type = fieldTypeOf(field);
      return type === "checkbox" ? "checkbox" : type === "date" ? "date" : type === "initials" ? "textInitials" : "text";
    };
    const rows: ElementRow[] = [
      ...[...slots].sort(byDocumentOrder).map(
        (field): ElementRow => ({
          key: `slot:${field.id}`,
          id: field.id,
          kind: "slot",
          pageIndex: field.pageIndex,
          name: slotLabel(field),
          detail: slotTypeLabel(field.type),
          done: null,
          color: signerById(field.signerId)?.color ?? ORPHAN_SLOT_COLOR,
          icon: field.type,
          selected: selection?.kind === "slot" && selection.id === field.id,
        }),
      ),
      ...[...visibleText].sort(byDocumentOrder).map(
        (field): ElementRow => ({
          key: `text:${field.id}`,
          id: field.id,
          kind: "text",
          pageIndex: field.pageIndex,
          name: textLabel(field),
          detail: fieldTypeOf(field) === "checkbox" ? textTypeLabel("checkbox") : (values[field.id] ?? "").trim().slice(0, 60),
          done: isFieldFilled(field, values[field.id]) || field.optional === true,
          color: TEXT_FIELD_COLOR,
          icon: iconOfText(field),
          selected: selection?.kind === "text" && selection.id === field.id,
        }),
      ),
    ].sort((a, b) => a.pageIndex - b.pageIndex);

    const frameTools = tools.filter((id) => id !== "editText");
    const dockTab: DockTab = dockState.tab === "element" && !selectedElement ? "elements" : dockState.tab;
    const dockTabs: DockTab[] = selectedElement
      ? ["element", "elements", "pages", "help"]
      : ["elements", "pages", "help"];

    const neighbors = selection ? othersOnPage(selection.kind, selection.id) : [];
    const heightPt = selectedTextField && pageSizePt ? selectedTextField.rect.height * pageSizePt.height : 0;
    const autoFontSize = clampFontSize(Math.min(24, Math.max(MIN_FONT_SIZE, heightPt / LINE_HEIGHT_FACTOR)) || 12);
    const selectedType = selectedTextField ? fieldTypeOf(selectedTextField) : null;

    const inspector = selectedElement ? (
      <EditInspector
        strings={strings}
        edit={editStrings}
        name={selectedSlot ? slotLabel(selectedSlot) : selectedTextField ? textLabel(selectedTextField) : ""}
        typeName={
          selectedSlot ? slotTypeLabel(selectedSlot.type) : selectedType ? textTypeLabel(selectedType) : ""
        }
        color={
          selectedSlot ? (signerById(selectedSlot.signerId)?.color ?? ORPHAN_SLOT_COLOR) : TEXT_FIELD_COLOR
        }
        kind={selectedSlot ? "slot" : "text"}
        rect={selectedElement.rect}
        signer={
          selectedSlot && !solo && signers.length > 1
            ? {
                value: selectedSlot.signerId,
                choices: signers.map((signer, index) => ({
                  value: signer.id,
                  label: signerDisplayName(signer.name, index, strings.defaultSignerName),
                  color: signer.color,
                })),
              }
            : null
        }
        slotType={selectedSlot && !solo ? selectedSlot.type : null}
        textType={selectedType}
        richTypes={richFieldTypesEnabled}
        tag={
          tagging && selectedTextField && taggableTypeOf(selectedTextField)
            ? {
                type: taggableTypeOf(selectedTextField) as TaggableType,
                current: selectedTag,
                suggested: impliedTagOf(selectedTextField),
              }
            : null
        }
        optional={selectedTextField?.optional === true}
        fontSize={selectedTextField?.fontSize}
        autoFontSize={autoFontSize}
        hasNeighbor={neighbors.length > 0}
        canPaste={clipboardKind !== null && !(solo && clipboardKind === "slot")}
        canRepeat={
          Math.max(1, pageCount) > 1 &&
          !solo &&
          (selectedSlot ? selectedSlot.type === "initials" : selectedType === "initials")
        }
        canDuplicate={!(solo && selectedSlot)}
        canCopy={!(solo && selectedSlot)}
        onSize={(size) => selection && patchRect(selection.kind, selection.id, resizeTo(selectedElement.rect, size))}
        onSigner={(signerId) => selectedSlot && changeSlot(selectedSlot, { signerId })}
        onSlotType={(type) => selectedSlot && changeSlot(selectedSlot, { type })}
        onTextType={(type) => selectedTextField && changeTextType(selectedTextField, type)}
        onTag={(next) => selectedTextField && changeTag(selectedTextField, next)}
        onOtherTag={() => selectedTextField && setCustomTagFor(selectedTextField.id)}
        onOptional={(optional) => selectedTextField && patchTextField(selectedTextField.id, { optional })}
        onFontSize={(size) =>
          selectedTextField && patchTextField(selectedTextField.id, { fontSize: size === undefined ? null : size })
        }
        onAlign={alignSelected}
        onMatchSize={matchSelectedSize}
        onDuplicate={duplicateSelected}
        onCopy={copySelected}
        onPaste={pasteHere}
        onRepeat={repeatSelected}
        onDelete={() => {
          if (!selection) return;
          removeElement(selection.kind, selection.id);
          setAnnouncement(editStrings.removedStatus);
        }}
      />
    ) : null;

    const dockBody = (layout: { dockSide: "bottom" | "right" }) =>
      dockTab === "element" ? (
        inspector
      ) : dockTab === "elements" ? (
        <ElementsPanel rows={rows} pageIndex={pageIndex} edit={editStrings} onSelect={selectFromList} />
      ) : dockTab === "pages" ? (
        <PagesPanel
          thumbs={thumbs}
          pageCount={total}
          pageIndex={pageIndex}
          counts={counts}
          strip={layout.dockSide === "bottom"}
          strings={strings}
          edit={editStrings}
          onGo={goToPage}
          onStepWithFields={stepWithFields}
          docs={sequence?.docs}
          onSelectDoc={sequence?.selectDoc}
        />
      ) : (
        <HelpPanel
          edit={editStrings}
          fitMode={stage.fitMode}
          onFit={stage.setFitMode}
          openOnEnter={editHost.openOnEnter}
          onOpenOnEnter={editHost.setOpenOnEnter}
        />
      );

    const stageNode = (
      <div ref={stageRef} className="absolute inset-0" data-edit-stage-root="">
        <StatusRegion text={announcement} className="sr-only" data-canvas-announcer="">
          {announcement}
        </StatusRegion>
        <div
          ref={clipRef}
          data-edit-stage=""
          onPointerDown={startCreate}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className={cn(
            "absolute inset-0 flex touch-none items-center justify-center overflow-hidden select-none",
            creates ? "cursor-crosshair" : "cursor-default",
          )}
        >
          {hostElement}
        </div>
        {fingerHintOpen && creates ? (
          <div
            aria-hidden="true"
            data-finger-hint=""
            className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3"
          >
            <p className="material-thick shadow-elevation-2 flex max-w-full items-center gap-2 rounded-ios px-3.5 py-2 text-center text-footnote font-medium text-foreground">
              <Hand aria-hidden="true" className="size-4 shrink-0" />
              {gestureStrings.fingerHint}
            </p>
          </div>
        ) : null}
        <StatusRegion text={pendingUndoText} className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3">
          {pendingUndo ? (
            <div className="animate-rise-in material-thick pointer-events-auto flex max-w-full items-center gap-1 rounded-full py-1 pr-1 pl-4 shadow-elevation-3">
              <span className="min-w-0 py-2 text-footnote font-medium text-foreground">{pendingUndoText}</span>
              <Button ref={undoButtonRef} variant="ghost" size="sm" className="rounded-full" onClick={restorePendingUndo}>
                {pendingUndo.kind === "slot"
                  ? strings.undoRemoveField
                  : pendingUndo.kind === "type"
                    ? strings.undoTypeChange
                    : strings.undoRemoveTextField}
              </Button>
            </div>
          ) : null}
        </StatusRegion>
      </div>
    );

    return (
      <>
        <div
          ref={rootRef}
          data-edit-stub=""
          style={{ minHeight: inlineHeight || undefined }}
          className="surface-card rounded-ios p-4 text-footnote text-muted-foreground"
        >
          {editStrings.stub}
        </div>
        {createPortal(
          <LiveSinkProvider value={null}>
            <EditModeFrame
              strings={strings}
              edit={editStrings}
              title={sequence?.docs && sequence.docs.length > 1 ? (sequence.docs.find((doc) => doc.active)?.name ?? editStrings.title) : editStrings.title}
              onDone={exitEditMode}
              history={{ canUndo: history.canUndo, canRedo: history.canRedo, onUndo: runUndo, onRedo: runRedo }}
              tools={frameTools}
              tool={effectiveTool}
              toolLabel={toolLabel}
              onTool={changeTool}
              signers={
                solo
                  ? []
                  : signers.map((signer, index) => ({
                      id: signer.id,
                      name: signerDisplayName(signer.name, index, strings.defaultSignerName),
                      color: signer.color,
                    }))
              }
              activeSignerId={activeSignerId}
              onActiveSigner={onActiveSignerIdChange}
              pages={{
                index: pageIndex,
                count: total,
                onPrev: () => goToPage(Math.max(0, pageIndex - 1)),
                onNext: () => goToPage(Math.min(total - 1, pageIndex + 1)),
                onStepWithFields: stepWithFields,
              }}
              zoom={{
                value: zoom,
                canIn: zoom < EDIT_MAX_ZOOM - 0.01,
                canOut: zoom > 1.01,
                onIn: zoomIn,
                onOut: zoomOut,
                onFit: () => zoomEdit(1, null, true),
                fitMode: stage.fitMode,
                onToggleFit: () => {
                  const next = stage.fitMode === "height" ? "width" : "height";
                  stage.setFitMode(next);
                  setAnnouncement(editStrings.fitStatus(next));
                },
              }}
              dock={{
                open: dockState.open,
                tab: dockTab,
                tabs: dockTabs,
                onTab: (tab) => setDockState({ open: true, tab }),
                onClose: closeDock,
                body: dockBody,
              }}
              properties={{
                visible: Boolean(selectedElement) && !(dockState.open && dockTab === "element"),
                onClick: () => setDockState({ open: true, tab: "element" }),
              }}
              onOpenTab={openDockTab}
              stage={stageNode}
              onChromeInsets={setChromeInsets}
            />
          </LiveSinkProvider>,
          editHost.container,
        )}
        {tagging ? (
          <CustomTagSheet
            open={customTagFor !== null}
            onClose={() => setCustomTagFor(null)}
            closeLabel={strings.confirmClose}
            onCreated={(tag) => {
              const target = textFields.find((field) => field.id === customTagFor);
              if (target) changeTag(target, tag);
            }}
          />
        ) : null}
      </>
    );
  }

  return (
    <div ref={rootRef}>
      {/* Region viva SIEMPRE montada: herramienta activa, duplicados, saltos de campo. */}
      <StatusRegion text={announcement} className="sr-only" data-canvas-announcer="">
        {announcement}
      </StatusRegion>

      <div className={compact ? "sr-only" : "mb-4"} data-canvas-intro="">
        <h3 className="text-headline text-foreground">{strings.documentTitle}</h3>
        <p className="mt-1 text-footnote leading-relaxed text-muted-foreground">
          {solo ? strings.soloDocumentHint : strings.documentHint}
        </p>
      </div>

      {/* Dueño de los huecos nuevos (o la firma propia, en "Solo yo") y alta con teclado. */}
      {merged ? null : (
        <div className={cn("surface-card rounded-ios space-y-3", compact ? "mb-2 p-2" : "mb-3 p-3")}>
          {signatureControls}
          {placeControl}
          {entry}
        </div>
      )}

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
          className={cn(
            "material-thick shadow-elevation-2 rounded-ios sticky z-30 flex flex-wrap items-center justify-between gap-x-1 gap-y-1 p-1",
            // VI-04: con la paleta vertical a la izquierda (md+) la barra empieza donde empieza la hoja (3rem de la
            // paleta + 0.75rem de separacion): al salir la paleta por arriba ya no pasa por debajo de los botones de zoom.
            !merged && (inPro ? "md:ml-[3.75rem]" : "xl:ml-[3.75rem]"),
            merged ? "mb-1.5" : compact ? "mb-2" : "mb-3",
            compact
              ? "top-1"
              : "top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] md:top-[calc(4rem+env(safe-area-inset-top,0px)+0.5rem)] lg:top-3",
          )}
        >
          {pinchZoomEnabled ? zoomGroup : <span />}
          {merged ? (
            <div
              data-canvas-controls=""
              className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-2 px-2"
            >
              {signatureControls}
              {placeControl}
              {entry}
            </div>
          ) : null}
          <ButtonGroup>
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
          </ButtonGroup>
        </div>
      )}

      {sheetFirst ? null : statusRow}

      {/* «Editar texto»: pista, deshacer/rehacer y la nota de que al firmar se quita el texto original (salvo casos especiales). */}
      {textEdit && (editingText || textEditing.count > 0) ? (
        <div data-edit-text-panel="" className="surface-card rounded-ios mb-3 space-y-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 basis-60 text-footnote leading-relaxed text-muted-foreground">
              {editingText ? strings.editTextHint : strings.editTextCount(textEditing.count)}
            </p>
            {editingText ? (
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className={COARSE_TALL}
                  aria-label={strings.editTextUndo}
                  title={strings.editTextUndo}
                  aria-disabled={!textEditing.canUndo}
                  onClick={() => {
                    if (textEditing.canUndo) textEditing.undo();
                  }}
                >
                  <Undo2 aria-hidden="true" className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={COARSE_TALL}
                  aria-label={strings.editTextRedo}
                  title={strings.editTextRedo}
                  aria-disabled={!textEditing.canRedo}
                  onClick={() => {
                    if (textEditing.canRedo) textEditing.redo();
                  }}
                >
                  <Redo2 aria-hidden="true" className="size-4" />
                </Button>
              </div>
            ) : null}
          </div>
          {editingText && textEditing.status !== "ready" && textEditing.status !== "idle" ? (
            <p className="text-footnote text-muted-foreground" data-edit-text-status="">
              {textEditing.status === "analyzing"
                ? textEdit.strings.analyzing
                : textEditing.status === "failed"
                  ? textEdit.strings.analysisFailed
                  : textEdit.strings.scanned}
            </p>
          ) : null}
          {editingText && textEditing.nonEditable > 0 && textEditing.status === "ready" ? (
            <p className="text-caption text-muted-foreground">
              {textEdit.strings.nonEditableCount(textEditing.nonEditable)}
            </p>
          ) : null}
          {/* Compacto (PDF Pro): la nota del texto original va en la cabecera del modo, plegada con los demas avisos. */}
          {textEditing.count > 0 && !compact ? (
            <p className="text-footnote leading-relaxed text-muted-foreground">
              {strings.editTextNote}{" "}
              <Link
                href="/edit-pdf"
                // Otra pestana: lo que se esta firmando no se pierde.
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-signal-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
              >
                {strings.editTextFlattenLink}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
       * Paleta + escenario. La paleta va PRIMERO en el DOM (se elige la
       * herramienta antes de tocar la pagina); en movil `flex-col-reverse` la
       * pinta debajo de la pagina, pegajosa sobre la barra de accion de
       * ToolShell (barra de pestanas 4.5 rem + barra de accion 4.25 rem).
       */}
      <div className={cn("flex flex-col gap-3", inPro ? "md:flex-row md:items-start" : "xl:flex-row xl:items-start")}>
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
        />

        <div ref={stageRef} className="relative min-w-0 flex-1">
          {fingerHintOpen && creates ? (
            /* Pista de la primera vez: no recibe toques (se ve unos segundos); la region viva ya dijo lo mismo. */
            <div
              aria-hidden="true"
              data-finger-hint=""
              className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3"
            >
              <p className="material-thick shadow-elevation-2 flex max-w-full items-center gap-2 rounded-ios px-3.5 py-2 text-center text-footnote font-medium text-foreground">
                <Hand aria-hidden="true" className="size-4 shrink-0" />
                {gestureStrings.fingerHint}
              </p>
            </div>
          ) : null}
          <div
            ref={clipRef}
            className={cn(
              "surface-card rounded-ios flex justify-center overflow-hidden",
              merged ? "p-1.5" : "p-3",
            )}
          >
            {hostElement}
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
            ) : selectedTextField && tagging && tagPickerOpen && taggableTypeOf(selectedTextField) ? (
              /* Chips de etiqueta en la propia barra: sustituyen a las acciones (como el selector de tipo). */
              <>
                <FieldTagPicker
                  type={taggableTypeOf(selectedTextField) as TaggableType}
                  current={selectedTag}
                  suggested={impliedTagOf(selectedTextField)}
                  onPick={(next) => changeTag(selectedTextField, next)}
                  onNone={() => changeTag(selectedTextField, null)}
                  onOther={() => setCustomTagFor(selectedTextField.id)}
                  className="flex-wrap justify-center"
                />
                <BarButton label={tagStrings.chipClose} onClick={closeTagPicker}>
                  <CornerUpLeft aria-hidden="true" className="size-5" />
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
                {tagging && taggableTypeOf(selectedTextField) ? (
                  <BarChip
                    label={tagStrings.barTag(selectedTagName)}
                    dataAction="tag"
                    active={selectedTag !== null}
                    ariaExpanded={false}
                    onClick={() => {
                      focusTagPickerRef.current = true;
                      setTagPickerFor(selectedTextField.id);
                    }}
                  >
                    <TagGlyph />
                    <span className="truncate">{selectedTagName ?? tagStrings.pillNoTag}</span>
                  </BarChip>
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

          {textEditing.bar}
        </div>
      </div>

      {sheetFirst ? statusRow : null}

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
      <StatusRegion text={pendingUndoText}>
        {pendingUndo ? (
          <div className="animate-rise-in mt-3 flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5">
            <span className="text-footnote text-muted-foreground">{pendingUndoText}</span>
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
      </StatusRegion>

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

      {tagging ? (
        <CustomTagSheet
          open={customTagFor !== null}
          onClose={() => setCustomTagFor(null)}
          closeLabel={strings.confirmClose}
          onCreated={(tag) => {
            const target = textFields.find((field) => field.id === customTagFor);
            if (target) changeTag(target, tag);
          }}
        />
      ) : null}
    </div>
  );
}

/** El tipo de un campo de texto al que se le puede poner etiqueta (texto o fecha), o `null`. */
function taggableTypeOf(field: DetectedField): TaggableType | null {
  const type = fieldTypeOf(field);
  return type === "text" || type === "date" ? type : null;
}

/* ------------------------------------------------------------------ *
 * Piezas comunes de los elementos sobre la pagina
 * ------------------------------------------------------------------ */

/** Anillo de seleccion: separado del borde (del color del elemento) por el fondo. */
const SELECTION_RING =
  "0 0 0 2px var(--color-background), 0 0 0 4px var(--color-signal)";

/** Anillo del campo que tiene el asistente «Rellenar»: mas ancho que el de seleccion, para verlo de un vistazo en la pagina. */
const FILL_RING =
  "0 0 0 3px var(--color-background), 0 0 0 6px var(--color-signal)";

/**
 * Las clases de foco van en el elemento (no inline): Tailwind v4 + `outline-none`
 * dejaria el anillo invisible, asi que aqui no hay `outline-none` y la
 * seleccion se pinta con `box-shadow`, nunca con `outline`.
 */
const BOX_BASE =
  "sign-field-box absolute cursor-move touch-none rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

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
 * Tirador de un elemento diminuto (fuera de la caja): el tirador (24 px) se pinta a 44 px de la esquina, asi que su zona
 * ampliada puede crecer 10 px por arriba/izquierda y 14 por derecha/abajo (medidos desde la caja de relleno, que descuenta
 * el borde de 2 px) sin entrar en la caja del elemento (con `-inset-3` entraba ~4 px en la caja de una casilla de ~11 px y
 * los toques sobre ella iban al tirador). 10 + 20 + 14 = 44 px de zona de agarre en cada eje (VI-05: antes eran 38).
 */
const COARSE_HIT_HANDLE_OUTSIDE =
  "pointer-coarse:before:absolute pointer-coarse:before:-top-2.5 pointer-coarse:before:-left-2.5 pointer-coarse:before:-right-3.5 pointer-coarse:before:-bottom-3.5 pointer-coarse:before:content-['']";

type ElementLabelProps = { label: string; color: string; className?: string };

/**
 * Pestana de etiqueta: texto del tema sobre superficie elevada, con el
 * color del elemento en el borde y en un punto. Antes era texto blanco de
 * 11 px sobre el propio color (verde y ambar no llegaban a 4,5:1).
 */
function ElementLabel({ label, color, className }: ElementLabelProps) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute -top-0.5 left-0 flex max-w-full -translate-y-full items-center gap-1 rounded-t-[4px] border border-b-0 bg-elevated px-1.5 py-0.5 text-caption-2 leading-tight font-semibold text-foreground",
        // A pantalla completa (`--sheet-zoom` en la hoja) la pestana no crece con el zoom: se queda del tamano de siempre.
        "origin-bottom-left [scale:calc(1/var(--sheet-zoom,1))]",
        className,
      )}
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
        // A pantalla completa (`--sheet-zoom` en la hoja) el tirador no crece con el zoom: se queda de 24 px con su zona de 44.
        "[scale:calc(1/var(--sheet-zoom,1))]",
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
  /** Clave de la memoria de valores (la etiqueta del campo o, sin ella, la que sugiere su rotulo), o `null` si no recuerda. */
  memoryKey: string | null;
  /** Etiqueta del campo, o `null`. */
  tag: string | null;
  /** Etiqueta que sugiere el rotulo detectado cuando aun no tiene ninguna. */
  impliedTag: string | null;
  /** Tipo de campo al que se le pueden poner etiquetas con los chips, o `null` (sin `tagging`, iniciales...). */
  taggable: TaggableType | null;
  /** Marca de autorrelleno: `"filled"` = lo relleno la propagacion y nadie lo ha tocado. */
  autoMark?: "filled" | "declined";
  /** Campo recien dibujado: abre solos los chips de etiqueta. */
  freshTag?: boolean;
  /** La persona confirmo el valor (propagacion por etiqueta). Ausente = sin etiquetas. */
  onCommitValue?: (value: string) => void;
  onTag: (tag: string | null) => void;
  /** «Otra…»: pide el nombre de una etiqueta propia. */
  onOtherTag: () => void;
  selected: boolean;
  /** Campo que el asistente «Rellenar» tiene ahora (anillo propio; no abre el editor). */
  fillCurrent?: boolean;
  /** Input en linea abierto (distinto de `selected`). */
  editing: boolean;
  /** Sugerencia de la heuristica que nadie ha tocado: contorno discreto, etiqueta solo al apuntarla. */
  suggested?: boolean;
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
  /** Pixeles de la hoja por punto PDF: el texto con tamano de letra propio (`field.fontSize`) se ve a su tamano real. */
  pointScale?: number;
  /** Alto de la pagina en puntos PDF. Con `fitFont` (modo «Editar campos»), el texto automatico se ve al tamano que tendra en el PDF. */
  pageHeightPt?: number;
  fitFont?: boolean;
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
  memoryKey,
  tag,
  impliedTag,
  taggable,
  autoMark,
  freshTag = false,
  onCommitValue,
  onTag,
  onOtherTag,
  selected,
  fillCurrent = false,
  editing,
  suggested = false,
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
  pointScale,
  pageHeightPt,
  fitFont = false,
}: TextFieldBoxProps) {
  const type = fieldTypeOf(field);
  const dashed = field.confidence === "low";
  const color = dashed ? LOW_CONFIDENCE_COLOR : TEXT_FIELD_COLOR;
  const filled = isFieldFilled(field, value);
  const editStrings = useEditModeStrings();
  const status = filled ? strings.a11yFilled : field.optional === true ? editStrings.optionalMark : strings.a11yPending;
  /** Tamano de letra propio del campo, en pixeles de la hoja (con el editor abierto: el de la caja antes de reducirla al 75 %). */
  // Letra automatica: la del PDF (sigue al alto del hueco, 6-24 pt); asi el texto crece y encoge con la hoja en vez de quedarse en 12 px.
  const autoPt =
    fitFont && pageHeightPt && !field.fontSize
      ? Math.min(24, Math.max(MIN_FONT_SIZE, (field.rect.height * pageHeightPt) / LINE_HEIGHT_FACTOR))
      : null;
  const fontPt = field.fontSize ?? autoPt;
  const fontPx = fontPt && pointScale ? fontPt * pointScale : null;
  const language = useOptionalLanguage();
  const tagName = tag ? tagLabel(tag, language, customTagNames()) : null;
  const autoFilled = autoMark === "filled" && filled;

  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const checkboxRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const coarse = useMediaQuery("(pointer: coarse)");
  const tagStrings = useTagStrings();
  /** Chips de etiqueta de la barra sobre el teclado: `null` = los decide el campo recien dibujado. */
  const [pickerChoice, setPickerChoice] = useState<boolean | null>(null);
  const pickerOpen = pickerChoice ?? (freshTag && tag === null);
  /** Ultimo valor confirmado: confirmar dos veces lo mismo (blur y cierre del editor) cuenta una sola vez. */
  const lastCommitRef = useRef<string | null>(null);

  useEffect(() => {
    if (type === "checkbox" && editing) {
      checkboxRef.current?.focus();
    }
  }, [type, editing]);

  const suggestions =
    editing && memoryKey && !suggestionsDismissed
      ? rankedSuggestions(memoryKey, value, coarse ? 8 : 5)
      : [];

  /**
   * La persona da por bueno el valor: se recuerda bajo la clave del campo (salvo que lo haya puesto el autorrelleno y nadie lo
   * haya tocado: ese dato ya esta en la memoria por su origen) y, si lleva etiqueta, se propaga a los campos que la comparten.
   */
  const commit = () => {
    if (lastCommitRef.current === value) return;
    lastCommitRef.current = value;
    if (memoryKey && autoMark !== "filled") recordValue(memoryKey, value);
    onCommitValue?.(value);
  };
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });
  // Cerrar el editor por cualquier camino (Escape, otro campo, Tab) tambien confirma lo escrito.
  useEffect(() => {
    if (!editing) return;
    return () => commitRef.current();
  }, [editing]);

  const commitAndClose = () => {
    commit();
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
      aria-label={[
        `${label}, ${status}`,
        tagName ? tagStrings.fieldTagged(tagName) : null,
        autoFilled ? tagStrings.autoFilledMark : null,
      ]
        .filter(Boolean)
        .join(", ")}
      tabIndex={0}
      data-drag-mode="move"
      data-element-kind="text"
      data-element-id={field.id}
      data-hit-zone={hit ? "" : undefined}
      data-suggested={suggested ? "" : undefined}
      data-tag={tag ?? undefined}
      data-auto-filled={autoFilled ? "" : undefined}
      data-fill-current={fillCurrent ? "" : undefined}
      onPointerDown={onPointerDownHandler}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocusSelect();
      }}
      onKeyDown={onBoxKeyDown}
      className={cn(BOX_BASE, "group")}
      style={{
        ...hitStyle(hit),
        left: percent(field.rect.x),
        top: percent(field.rect.y),
        width: percent(field.rect.width),
        height: percent(field.rect.height),
        boxSizing: "border-box",
        // Una sugerencia es una capa discreta: trazo fino y translucido; el campo real, el de siempre.
        border:
          suggested && !selected && !editing
            ? `1.5px dashed ${color}99`
            : `2px ${dashed ? "dashed" : "solid"} ${color}`,
        // Lo autorrellenado se ve un poco mas tenue que lo escrito (y lleva su destello): se nota de un vistazo, sin gritar.
        backgroundColor: value ? (autoFilled ? `${color}12` : `${color}22`) : "transparent",
        boxShadow: selected ? SELECTION_RING : fillCurrent ? FILL_RING : undefined,
        // Por encima de los elementos siguientes (hermanos absolutos sin
        // z-index propio, apilados por orden del DOM): sin esto, el
        // desplegable de sugerencias puede quedar tapado por un campo
        // posterior en la misma pagina.
        zIndex: editing ? 30 : selected || fillCurrent ? 20 : undefined,
      }}
    >
      {/* Solo la etiqueta REAL del documento ("Nombre:"), nunca un «Campo N» generico. */}
      {field.label ? (
        <ElementLabel
          label={label}
          color={color}
          className={
            suggested && !selected && !editing
              ? "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
              : undefined
          }
        />
      ) : null}

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
            ref={inputRef}
            type={type === "date" ? "date" : "text"}
            aria-label={label}
            value={value}
            placeholder={
              type === "initials"
                ? strings.initialsFieldPlaceholder
                : strings.textFieldPlaceholder
            }
            maxLength={type === "initials" ? 4 : undefined}
            style={fontPx ? { fontSize: `${Math.max(16, fontPx / 0.75)}px` } : undefined}
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
                  onValueChange(suggestions[highlightedIndex].value);
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
                commit();
                setSuggestionsDismissed(true);
                onAdvance(event.key === "Tab" && event.shiftKey ? -1 : 1);
              }
            }}
            data-canvas-input=""
            /* Fondo y tinta fijos: el input va sobre la pagina (siempre clara), y en el tema claro `bg-white/95` resuelve a un gris casi negro (token invertido) con texto negro encima.
               SC-04: el campo mide 16 px de verdad (Safari de iPhone acerca la pagina al enfocar uno de 12) y se REDUCE al
               75 % (`scale-75`, con 133,33 % de caja) para que el texto se vea a los 12 px de siempre y llene exactamente el hueco. */
            className="absolute top-0 left-0 h-[133.3333%] w-[133.3333%] origin-top-left scale-75 rounded-[3px] border-0 bg-[#fffffff2] px-2 text-base text-[#111827] outline-2 -outline-offset-2 outline-signal placeholder:text-[#6b7280]"
          />
          {/* Fecha/casilla no tienen historial (`memoryKey` llega null): sin etiqueta y sin valores no se pinta nada. */}
          {coarse ? (
            /* Con el dedo: barra fija sobre el teclado (la lista del recuadro quedaba tapada por el). La fecha usa el selector nativo. */
            type === "date" ? null : (
              <SuggestionBar
                taggable={taggable}
                tag={tag}
                impliedTag={impliedTag}
                pickerOpen={pickerOpen}
                onPickerOpenChange={setPickerChoice}
                suggestions={suggestions}
                highlightedIndex={highlightedIndex}
                onPick={(picked) => {
                  onValueChange(picked);
                  setSuggestionsDismissed(true);
                }}
                onForget={(forgotten) => {
                  if (memoryKey) forgetValue(memoryKey, forgotten);
                }}
                onPin={(pinnedValue, pinned) => {
                  if (memoryKey) setPinned(memoryKey, pinnedValue, pinned);
                }}
                onTag={(next) => {
                  setPickerChoice(false);
                  // El texto que ya habia escrito pasa a ser el dato de la etiqueta (lo recuerda y propaga `onTag`): no se cuenta otra vez al salir.
                  if (next && value.trim() !== "") lastCommitRef.current = value;
                  onTag(next);
                }}
                onOther={onOtherTag}
                anchorRef={inputRef}
              />
            )
          ) : (
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
                if (memoryKey) forgetValue(memoryKey, forgotten);
              }}
              onPin={(pinnedValue, pinned) => {
                if (memoryKey) setPinned(memoryKey, pinnedValue, pinned);
              }}
              strings={strings}
            />
          )}
        </>
      ) : value ? (
        <>
          <span
            className={cn("pointer-events-none absolute inset-0 flex items-center truncate px-1.5", !fontPx && "text-xs")}
            style={{ color: INK_ON_PAGE, ...(fontPx ? { fontSize: `${fontPx}px`, lineHeight: 1.1 } : {}) }}
          >
            {value}
          </span>
          {autoFilled && !tiny ? (
            <Sparkles
              aria-hidden="true"
              className="pointer-events-none absolute top-0.5 right-0.5 size-3 opacity-70"
              style={{ color }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
