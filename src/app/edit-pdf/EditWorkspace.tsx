"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ImagePlus, Layers, Redo2, Undo2 } from "lucide-react";
import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import type { PdfErrorCode } from "@/lib/pdf/core";
import {
  DEFAULT_EDIT_STYLE,
  type EditStyle,
} from "@/lib/pdf/editPdf";
import type { TextBlock, TextEdit, UserBox } from "@/lib/pdf/editTypes";
import { EditFloatingBar, glyphNotice, type BarTextState } from "@/app/edit-pdf/EditFloatingBar";
import { EditNavBar, ZOOM_STEPS } from "@/app/edit-pdf/EditNavBar";
import { EditSurface, type SurfaceHandle } from "@/app/edit-pdf/EditSurface";
import { EditToolPalette, type PaletteTool } from "@/app/edit-pdf/EditToolPalette";
import { TOOL_SHORTCUTS, buildPaletteTools, isTool, type Tool } from "@/app/edit-pdf/editTools";
import {
  ElementFloatingBar,
  barStateOf,
  type ElementBarState,
} from "@/app/edit-pdf/ElementFloatingBar";
import {
  ElementLayer,
  elementName,
  type ElementHandlers,
} from "@/app/edit-pdf/ElementLayer";
import { InlineTextEditor, type InlineExitReason } from "@/app/edit-pdf/InlineTextEditor";
import { PageStrip } from "@/app/edit-pdf/PageStrip";
import {
  TextBlockLayer,
  type LayerHandlers,
} from "@/app/edit-pdf/TextBlockLayer";
import { blockCoverExtent, blockCoverQuad, coverShape, polygonsOverlap } from "@/lib/pdf/editCover";
import {
  COVER_PADDING_PT,
  MIN_BOX_PT,
  NEW_TEXT_FONT_SIZE,
  draftEditForBlock,
  excerpt,
  newTextEditAt,
  newTextPxRect,
  nextFocusKey,
  nudgeDelta,
  pageLayoutOf,
  pxRectToUserBox,
  textFrame,
  userBoxToPx,
  userDeltaFromView,
  type NudgeDirection,
  type PageMetrics,
  type PxRect,
} from "@/app/edit-pdf/editCanvasMath";
import {
  addImageOp,
  duplicateOp,
  elementGeometryKey,
  imageElementAt,
  isDrawTool,
  isTap,
  pxToNorm,
  pxRectToNormBox,
  shapeFromGesture,
  styleFromRestyle,
  visibleCenterNorm,
  type DrawTool,
  type NormPoint,
} from "@/app/edit-pdf/editElements";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  firstImageCandidate,
  readImageFile,
  type ImageRejection,
} from "@/app/edit-pdf/editImages";
import {
  findFlattenItem,
  flattenItem,
  flattenedPages,
  itemPageIndex,
  newEditId,
  shapeItem,
  textItem,
  type EditImageItem,
  type EditShapeElement,
  type EditShapeItem,
  type EditTextItem,
  type RestylePatch,
} from "@/app/edit-pdf/editSession";
import type { EditFlowStrings } from "@/app/edit-pdf/flowStrings";
import type { EditStrings } from "@/app/edit-pdf/strings";
import { useEditDocument, usePageText } from "@/app/edit-pdf/useEditDocument";
import { isEditableElement, type UseEditSession } from "@/app/edit-pdf/useEditSession";
import { PINCH_START_EVENT, useZoomGestures } from "@/app/edit-pdf/useZoomGestures";
import { blocksInReadingOrder } from "@/lib/pdf/textBlocks";

/*
 * Lienzo de edicion inline v2 (W5-U4a/b): orquesta la superficie de la pagina, la
 * capa de bloques de texto, la capa de imagenes y formas, el editor inline, las
 * barras flotantes, la paleta y la navegacion del documento sobre una
 * `useEditSession`. Edita texto (existente y nuevo) y anade imagen, rectangulo,
 * elipse, linea, resaltado y marca con paridad completa con el lienzo anterior.
 *
 * Modelo de foco del TEXTO: `focus` = {clave, modo}. La clave es el id del bloque
 * (o el de la edicion si es texto nuevo); no depende de que exista una edicion en
 * la sesion. Un bloque SIN tocar no crea nada en el historial: la edicion nace con
 * el primer cambio real (texto, estilo, movimiento) en UNA sola operacion `add`,
 * ya con ese cambio aplicado, y desde entonces se usan update/restyle/move/
 * resize. Un texto nuevo vive como borrador (`pending`) hasta que se escribe
 * algo.
 *
 * Imagenes y formas son items de la sesion desde el primer instante: se eligen con
 * `session.select(id)` (el foco de texto se suelta) y su barra es `ElementFloatingBar`.
 * Herramientas de un solo uso, como en Firmar: tras crear algo vuelven a
 * «Seleccionar»; Esc o volver a pulsarla tambien. Armar una herramienta
 * deselecciona, y con una de dibujo armada ni el texto ni los elementos reciben
 * puntero (arrastrar encima dibuja, p. ej. un resaltado sobre el texto).
 */

const EMPTY_BLOCKS: readonly TextBlock[] = [];
const HIGHLIGHT_ONLY: readonly string[] = ["highlight"];

type Focus = { key: string; mode: "selected" | "editing"; seed?: string };
type CoverInfo = {
  key: string;
  color: string;
  uniform: boolean;
  /** Bordes finos (espacio de usuario) que la cobertura no pisa. */
  clip?: UserBox[];
  /** False si aun no habia canvas pintado: es un valor provisional que se vuelve a muestrear. */
  sampled: boolean;
};

/** Regiones enfocables de bloques y elementos (la barra flotante y el foco las buscan por aqui). */
const ELEMENT_REGION_SELECTOR = '[data-element-id][data-drag-mode="move"]';

/** Frames que `focusRegion` espera a que aparezca la region de un elemento recien creado. */
const FOCUS_REGION_MAX_FRAMES = 20;

type Creation = {
  pointerId: number;
  start: { x: number; y: number };
  kind: "text" | DrawTool;
};

type ImageNotice = { text: string; error: boolean };

export type EditWorkspaceProps = {
  file: File;
  session: UseEditSession;
  strings: EditStrings;
  /** Copy del flujo (aplanar pagina, escaneados, ajuste apagado). */
  flow: EditFlowStrings;
  onError?: (code: PdfErrorCode) => void;
  /**
   * (W5-U5) `false` = el ajuste «Editar el texto que ya trae el PDF» esta apagado:
   * los bloques del PDF ni se analizan ni se pueden tocar; siguen todas las
   * herramientas de AÑADIR y se pueden editar los textos propios.
   */
  existingText?: boolean;
  /** Pagina (base 0) con la que arranca (un borrador restaurado). */
  initialPage?: number;
  /** «Elegir otro archivo» cuando el documento no se puede leer. */
  onChooseAnother?: () => void;
  /**
   * (W5-U5) Lo que aplanar una pagina descarta de TODO el documento (formularios y/o marcadores):
   * la confirmacion de «Aplanar página» lo dice. `null`/ausente = nada que avisar.
   */
  flattenLoss?: { forms: boolean; outlines: boolean } | null;
  /** Avisa de la pagina visible y del total (para guardarlos en el borrador). */
  onPageChange?: (pageIndex: number, pageCount: number) => void;
};

export function EditWorkspace({
  file,
  session,
  strings,
  flow,
  onError,
  existingText = true,
  initialPage = 0,
  onPageChange,
  onChooseAnother,
  flattenLoss = null,
}: EditWorkspaceProps) {
  const s = strings.inline;
  const { doc, pageCount, error } = useEditDocument(file);
  const [pageState, setPageState] = useState(Math.max(0, Math.floor(initialPage)));
  // Una pagina restaurada que ya no existe cae a la ultima.
  const pageIndex = pageCount > 0 ? Math.min(pageState, pageCount - 1) : pageState;
  const setPageIndex = setPageState;
  const [flattenAsk, setFlattenAsk] = useState<{ page: number; open: boolean } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<Tool>("select");
  const [style, setStyle] = useState<EditStyle>(DEFAULT_EDIT_STYLE);
  const [draftShape, setDraftShape] = useState<EditShapeElement | null>(null);
  const [imageNotice, setImageNotice] = useState<ImageNotice | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [stripPref, setStripPref] = useState<boolean | null>(null);
  const [measured, setMeasured] = useState<{ metrics: PageMetrics; pageIndex: number } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [pending, setPending] = useState<TextEdit | null>(null);
  const [gesturing, setGesturing] = useState(false);
  const [coverInfo, setCoverInfo] = useState<CoverInfo | null>(null);
  /** Se incrementa cada vez que el canvas acaba de repintarse (zoom, ancho): el fondo se vuelve a leer. */
  const [renderTick, setRenderTick] = useState(0);
  const [draftRect, setDraftRect] = useState<PxRect | null>(null);
  /*
   * UNA sola region viva para todo el editor (`data-workspace-live`). Cada accion anuncia UN mensaje; los
   * anuncios de foco (el bloque 3 de 12...) se callan si acaban de anunciar la accion (borrar, duplicar...).
   * `n` cambia el nodo del texto para que un mensaje repetido («Texto borrado» dos veces) vuelva a leerse.
   */
  const [live, setLive] = useState({ text: "", n: 0 });
  const lastActionAt = useRef(0);
  const setMessage = useCallback((text: string) => {
    lastActionAt.current = Date.now();
    setLive((previous) => ({ text, n: previous.n + 1 }));
  }, []);
  const announceFocus = useCallback((text: string) => {
    if (Date.now() - lastActionAt.current < 500) return;
    setLive((previous) => ({ text, n: previous.n + 1 }));
  }, []);
  const pageText = usePageText(existingText ? doc : null, pageIndex);
  const coarse = useMediaQuery("(pointer: coarse)");
  const desktop = useMediaQuery("(min-width: 768px)");
  const stripId = useId();

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<SurfaceHandle>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** El foco estuvo dentro del lienzo por ultima vez (para no dejarlo en <body> al desmontarse el elemento enfocado). */
  const focusInsideRef = useRef(false);
  const touchTapRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  /** Mientras el foco pasa del editor al bloque, el `blur` resultante no vuelve a terminar la edicion. */
  const exitingRef = useRef(false);
  const creationRef = useRef<Creation | null>(null);

  const metrics = measured && measured.pageIndex === pageIndex ? measured.metrics : null;
  const blocks = existingText ? (pageText.analysis?.blocks ?? EMPTY_BLOCKS) : EMPTY_BLOCKS;

  useEffect(() => {
    if (error) onError?.(error);
  }, [error, onError]);

  const onPageChangeRef = useRef(onPageChange);
  useEffect(() => {
    onPageChangeRef.current = onPageChange;
  });
  useEffect(() => {
    onPageChangeRef.current?.(pageIndex, pageCount);
  }, [pageIndex, pageCount]);

  /* ---------------------------------------------------------------- *
   * Datos derivados
   * ---------------------------------------------------------------- */

  const pageEdits = useMemo(
    () =>
      session.items
        .filter((item): item is EditTextItem => item.kind === "text" && item.edit.pageIndex === pageIndex)
        .map((item) => item.edit),
    [session.items, pageIndex],
  );

  const pageElementItems = useMemo(
    () =>
      session.items.filter(
        (item): item is EditShapeItem | EditImageItem =>
          (item.kind === "shape" || item.kind === "image") && itemPageIndex(item) === pageIndex,
      ),
    [session.items, pageIndex],
  );
  const selectedElement = useMemo(() => {
    const item = session.selected;
    return item && (item.kind === "shape" || item.kind === "image") && itemPageIndex(item) === pageIndex
      ? item
      : null;
  }, [session.selected, pageIndex]);
  const selectedElementId = selectedElement?.id ?? null;
  /** Cambios por pagina (para la marca de las miniaturas y el aviso de pagina). */
  const pageCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of session.items) {
      if (item.kind === "flatten") continue; // el aplanado tiene su propia marca
      if (item.kind === "text" && !item.edit.blockId && item.edit.text.trim().length === 0) continue;
      const page = itemPageIndex(item);
      counts.set(page, (counts.get(page) ?? 0) + 1);
    }
    return counts;
  }, [session.items]);
  /** Paginas que se aplanaran al exportar (marca de miniaturas y de la hoja). */
  const flattenedSet = useMemo(
    () => new Set(flattenedPages({ items: session.items })),
    [session.items],
  );
  const flattenHere = useMemo(
    () => findFlattenItem({ items: session.items }, pageIndex),
    [session.items, pageIndex],
  );

  const focusKey = focus?.key ?? null;
  const focusBlock = useMemo(
    () => (focusKey ? blocks.find((block) => block.id === focusKey) : undefined),
    [blocks, focusKey],
  );
  const focusEdit = useMemo(() => {
    if (!focusKey) return undefined;
    if (pending && pending.id === focusKey) return pending;
    return pageEdits.find((edit) => (edit.blockId ?? edit.id) === focusKey);
  }, [pageEdits, pending, focusKey]);
  const focusCover =
    coverInfo && coverInfo.key === focusKey ? coverInfo : null;

  /** La edicion tal y como esta (o como nacera) para el bloque con foco. */
  const layout = useMemo(() => pageLayoutOf(metrics, blocks), [metrics, blocks]);
  const effective: TextEdit | null = useMemo(() => {
    if (focusEdit) return focusEdit;
    if (focusBlock) {
      return draftEditForBlock(focusBlock, {
        coverColor: focusCover?.color ?? "#ffffff",
        coverClip: focusCover?.clip,
        layout,
      });
    }
    return null;
  }, [focusEdit, focusBlock, focusCover, layout]);

  /* ---------------------------------------------------------------- *
   * Avisos en vivo de la barra: solape con un vecino y cobertura girada que lo cruza
   * ---------------------------------------------------------------- */

  const [overlap, setOverlap] = useState(false);
  const obstacles = effective?.obstacles;
  const effectiveText = effective?.text;
  const effectiveRotation = effective?.rotation ?? 0;
  const effectiveBoxKey = effective
    ? `${effective.box.x},${effective.box.y},${effective.box.width},${effective.box.height}`
    : "";
  const focusKeyNow = focus?.key ?? null;
  const focusModeNow = focus?.mode ?? null;
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const host = hostRef.current;
      if (!host || !metrics || !obstacles || obstacles.length === 0 || focusKeyNow === null) {
        setOverlap(false);
        return;
      }
      const el =
        focusModeNow === "editing"
          ? host.querySelector<HTMLElement>("[data-inline-editor]")
          : host.querySelector<HTMLElement>(`[data-text-view="${CSS.escape(focusKeyNow)}"]`);
      if (!el) {
        setOverlap(false);
        return;
      }
      // La tinta real ocupa lo que mide su contenido (puede crecer mas que la caja).
      const hostRect = host.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const tolerance = 1.5;
      // Un texto girado se compara por su rectangulo ORIENTADO (no por la envolvente del
      // elemento girado): un vecino que solo cae dentro de la envolvente no es un solape.
      let angle = (((metrics.geometry.rotation - effectiveRotation) % 360) + 360) % 360;
      if (angle > 180) angle -= 360;
      const inkWidth = Math.max(el.offsetWidth, el.scrollWidth, r.width);
      const inkHeight = Math.max(el.offsetHeight, el.scrollHeight, r.height);
      let ink: Array<{ x: number; y: number }>;
      if (Math.abs(angle) < 1e-9) {
        const left = r.left - hostRect.left;
        const top = r.top - hostRect.top;
        ink = [
          { x: left, y: top },
          { x: left + inkWidth, y: top },
          { x: left + inkWidth, y: top + inkHeight },
          { x: left, y: top + inkHeight },
        ];
      } else {
        const radians = (angle * Math.PI) / 180;
        const ux = Math.cos(radians);
        const uy = Math.sin(radians);
        // `transform-origin: 0 0`: el elemento crece desde su esquina; el centro de la
        // envolvente es el de su caja de maquetacion (`offsetWidth` x `offsetHeight`).
        const cx = (r.left + r.right) / 2 - hostRect.left;
        const cy = (r.top + r.bottom) / 2 - hostRect.top;
        const ox = cx - (el.offsetWidth / 2) * ux + (el.offsetHeight / 2) * uy;
        const oy = cy - (el.offsetWidth / 2) * uy - (el.offsetHeight / 2) * ux;
        ink = [
          { x: ox, y: oy },
          { x: ox + inkWidth * ux, y: oy + inkWidth * uy },
          { x: ox + inkWidth * ux - inkHeight * uy, y: oy + inkWidth * uy + inkHeight * ux },
          { x: ox - inkHeight * uy, y: oy + inkHeight * ux },
        ];
      }
      setOverlap(
        obstacles.some((obstacle) => {
          const o = userBoxToPx(metrics, obstacle.box);
          return polygonsOverlap(
            ink,
            [
              { x: o.left, y: o.top },
              { x: o.left + o.width, y: o.top },
              { x: o.left + o.width, y: o.top + o.height },
              { x: o.left, y: o.top + o.height },
            ],
            tolerance,
          );
        }),
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [obstacles, effectiveText, effectiveRotation, effectiveBoxKey, metrics, focusKeyNow, focusModeNow]);
  const coverCrossesNeighbor = useMemo(() => {
    if (!effective || !effective.cover.color) return false;
    const shape = coverShape(effective);
    return shape?.kind === "oriented" && shape.holes.length > 0;
  }, [effective]);

  /* ---------------------------------------------------------------- *
   * Anuncios de la region viva: deshacer/rehacer y zoom
   * ---------------------------------------------------------------- */

  const historyCursor = session.session.cursor;
  const historyEntries = session.session.history;
  const blocksNow = useRef(blocks);
  useEffect(() => {
    blocksNow.current = blocks;
  });
  const lastHistory = useRef({ cursor: historyCursor, entries: historyEntries });
  useEffect(() => {
    const previous = lastHistory.current;
    lastHistory.current = { cursor: historyCursor, entries: historyEntries };
    // Deshacer/rehacer SOLO mueven el cursor: la lista de entradas es la MISMA. Una accion nueva tras deshacer
    // descarta lo rehacible y deja el cursor un paso adelante con un largo igual (antes se anunciaba como «Rehecho»
    // y pisaba el anuncio real de la accion); restaurar un borrador cambia la lista entera.
    if (previous.entries !== historyEntries) return;
    let verb: "undone" | "redone" | null = null;
    let entry: (typeof historyEntries)[number] | undefined;
    if (historyCursor < previous.cursor) {
      verb = "undone";
      entry = historyEntries[historyCursor];
    } else if (historyCursor > previous.cursor) {
      verb = "redone";
      entry = historyEntries[historyCursor - 1];
    }
    if (!verb || !entry) return;
    const item =
      entry.after.find((candidate) => candidate.id === entry.itemId) ??
      entry.before.find((candidate) => candidate.id === entry.itemId);
    let what = s.historyFlatten;
    if (item && item.kind !== "flatten") {
      const type = item.kind === "text" ? "text" : item.kind === "image" ? "image" : item.element.type;
      if (item.kind === "text" && (entry.op === "add" || entry.op === "update" || entry.op === "remove")) {
        // Un texto: frases claras («cambio de texto en “…”», «texto nuevo»), no «cambiar el texto de texto».
        const label = strings.typeLabels.text.toLowerCase();
        const beforeItem = entry.before.find((candidate) => candidate.id === entry.itemId);
        const beforeText = beforeItem?.kind === "text" ? beforeItem.edit.text : "";
        const existing = item.edit.blockId !== undefined;
        // Borrar un bloque existente lo deja VACIO (`update` con texto vacio): es un borrado, y se cita lo que habia.
        const blockText = existing
          ? (blocksNow.current.find((candidate) => candidate.id === item.edit.blockId)?.text ?? "")
          : "";
        const emptied = existing && item.edit.text.trim() === "" && entry.op !== "remove";
        if (entry.op === "remove" || emptied) {
          what = s.historyText.removed(excerpt(beforeText.trim() !== "" ? beforeText : blockText, 40) || label);
        } else if (entry.op === "add" && !existing) {
          what = s.historyText.added;
        } else {
          what = s.historyText.changed(excerpt(item.edit.text, 40) || label);
        }
      } else {
        what = `${s.historyOps[entry.op]} ${strings.typeLabels[type].toLowerCase()}`;
      }
    }
    const text = verb === "undone" ? s.undone(what) : s.redone(what);
    const frame = window.requestAnimationFrame(() => setMessage(text));
    return () => window.cancelAnimationFrame(frame);
  }, [historyCursor, historyEntries, s, strings.typeLabels, setMessage]);

  const lastZoom = useRef(zoom);
  useEffect(() => {
    if (lastZoom.current === zoom) return;
    lastZoom.current = zoom;
    // Tras acercar o alejar, «Pagina 2 de 4. Sin cambios.» ya no es verdad: se anuncia el zoom (con calma por el pellizco).
    const timer = window.setTimeout(() => setMessage(s.zoomValue(Math.round(zoom * 100))), 350);
    return () => window.clearTimeout(timer);
  }, [zoom, s, setMessage]);

  /* El foco apunta a algo que ya no existe (deshacer lo quito): se suelta sin caer a <body>. */
  const entryExists = focusBlock !== undefined || focusEdit !== undefined;
  const orphan = focus !== null && !entryExists && pageText.status === "ready";
  useEffect(() => {
    if (!orphan) return;
    const frame = window.requestAnimationFrame(() => {
      setFocus(null);
      hostRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [orphan]);

  /* ---------------------------------------------------------------- *
   * Acceso al estado mas reciente desde los manejadores estables
   * ---------------------------------------------------------------- */

  const latest = useRef({
    session,
    metrics,
    blocks,
    pageEdits,
    pending,
    focus,
    coverInfo,
    pageIndex,
    pageCount,
    tool,
    style,
    strings: s,
    typeLabels: strings.typeLabels,
  });
  useEffect(() => {
    latest.current = {
      session,
      metrics,
      blocks,
      pageEdits,
      pending,
      focus,
      coverInfo,
      pageIndex,
      pageCount,
      tool,
      style,
      strings: s,
      typeLabels: strings.typeLabels,
    };
  });

  const regionOf = useCallback((key: string): HTMLElement | null => {
    const host = hostRef.current;
    if (!host) return null;
    const regions = host.querySelectorAll<HTMLElement>(ELEMENT_REGION_SELECTOR);
    for (const region of Array.from(regions)) if (region.dataset.elementId === key) return region;
    return null;
  }, []);

  const focusRegion = useCallback(
    (key: string | null) => {
      // El elemento recien creado (imagen, copia...) llega al DOM cuando React
      // pinta la accion, y con el hilo ocupado (decodificar una imagen grande,
      // un dispositivo lento) el primer frame puede llegar ANTES: sin region
      // todavia, el foco caia al lienzo y no volvia a moverse. Se reintenta unos
      // frames antes de rendirse; sin clave (o ya agotados) va al lienzo.
      let framesLeft = FOCUS_REGION_MAX_FRAMES;
      const attempt = () => {
        const target = key ? regionOf(key) : null;
        if (key && !target && framesLeft > 0) {
          framesLeft -= 1;
          window.requestAnimationFrame(attempt);
          return;
        }
        (target ?? hostRef.current)?.focus({ preventScroll: true });
      };
      window.requestAnimationFrame(attempt);
    },
    [regionOf],
  );

  const sampleCover = useCallback((block: TextBlock): CoverInfo => {
    // Las cajas de los demas bloques: ni recortan la cobertura ni cuentan como fondo.
    const neighbors = latest.current.blocks
      .filter((other) => other.id !== block.id)
      .map((other) => ({ id: other.id, box: other.box }));
    const sample =
      surfaceRef.current?.sampleBackground(
        blockCoverExtent(block, COVER_PADDING_PT, neighbors),
        blockCoverQuad(block, COVER_PADDING_PT) ?? undefined,
        neighbors.map((other) => other.box),
        block.box,
      ) ?? null;
    if (!sample) {
      // Aun no hay canvas pintado: valor provisional (se marca `sampled: false` y se repite al pintar).
      return { key: block.id, color: "#ffffff", uniform: true, sampled: false };
    }
    return {
      key: block.id,
      color: sample.color,
      uniform: sample.uniform,
      sampled: true,
      ...(sample.clip && sample.clip.length > 0 ? { clip: sample.clip } : {}),
    };
  }, []);

  const resolve = useCallback((key: string) => {
    const { blocks: list, pageEdits: edits, pending: draft } = latest.current;
    if (draft && draft.id === key) return { pending: draft, edit: draft, block: undefined };
    return {
      pending: undefined,
      edit: edits.find((edit) => (edit.blockId ?? edit.id) === key),
      block: list.find((block) => block.id === key),
    };
  }, []);

  /** Cobertura para crear la edicion de un bloque: la ya muestreada o una nueva lectura. */
  const coverFor = useCallback(
    (block: TextBlock): CoverInfo => {
      const { coverInfo: info } = latest.current;
      return info && info.key === block.id && info.sampled ? info : sampleCover(block);
    },
    [sampleCover],
  );

  /** La edicion con la que nace un bloque tocado (cobertura muestreada incluida; anota el fondo no liso). */
  const blockDraft = useCallback(
    (block: TextBlock, overrides?: Partial<TextEdit>): TextEdit => {
      const cover = coverFor(block);
      const { metrics: live, blocks: all } = latest.current;
      return draftEditForBlock(block, {
        coverColor: cover.color,
        coverUniform: cover.uniform,
        coverClip: cover.clip,
        layout: pageLayoutOf(live, all),
        overrides,
      });
    },
    [coverFor],
  );

  /* ---------------------------------------------------------------- *
   * Operaciones sobre una entrada (bloque o texto nuevo)
   * ---------------------------------------------------------------- */

  const updateText = useCallback(
    (key: string, text: string) => {
      const { session: live } = latest.current;
      const { pending: draft, edit, block } = resolve(key);
      if (draft) {
        if (text.trim().length > 0) {
          live.dispatch({ type: "add", item: textItem({ ...draft, text }) });
          setPending(null);
        } else {
          setPending({ ...draft, text });
        }
      } else if (edit) {
        // Reescribir lo mismo no es un cambio (ni entra en el historial).
        if (text === edit.text) return;
        live.dispatch({ type: "update", id: edit.id, patch: { text } });
      } else if (block) {
        // Un bloque con su mismo texto sigue siendo el original: no se crea edicion.
        if (text === block.text) return;
        live.dispatch({
          type: "add",
          item: textItem(blockDraft(block, { text })),
        });
      }
    },
    [resolve, blockDraft],
  );

  const restyleEntry = useCallback(
    (key: string, patch: RestylePatch) => {
      const { session: live } = latest.current;
      const { pending: draft, edit, block } = resolve(key);
      if (draft) {
        setPending({ ...draft, ...(patch as Partial<TextEdit>) });
      } else if (edit) {
        live.dispatch({ type: "restyle", id: edit.id, patch });
      } else if (block) {
        live.dispatch({
          type: "add",
          item: textItem(blockDraft(block, patch as Partial<TextEdit>)),
        });
      }
    },
    [resolve, blockDraft],
  );

  const moveEntry = useCallback(
    (key: string, dx: number, dy: number) => {
      const { session: live } = latest.current;
      const { pending: draft, edit, block } = resolve(key);
      if (draft) {
        setPending({ ...draft, box: { ...draft.box, x: draft.box.x + dx, y: draft.box.y + dy } });
      } else if (edit) {
        live.dispatch({ type: "move", id: edit.id, dx, dy });
      } else if (block) {
        const base = blockDraft(block);
        live.dispatch({
          type: "add",
          item: textItem({
            ...base,
            box: { ...base.box, x: base.box.x + dx, y: base.box.y + dy },
          }),
        });
      }
    },
    [resolve, blockDraft],
  );

  const resizeEntry = useCallback(
    (key: string, box: { x: number; y: number; width: number; height: number }) => {
      const { session: live } = latest.current;
      const { pending: draft, edit, block } = resolve(key);
      if (draft) {
        setPending({ ...draft, box });
      } else if (edit) {
        live.dispatch({ type: "resize", id: edit.id, box });
      } else if (block) {
        const base = blockDraft(block);
        live.dispatch({ type: "add", item: textItem({ ...base, box }) });
      }
    },
    [resolve, blockDraft],
  );

  const orderedKeys = useCallback((): string[] => {
    const { blocks: list, pageEdits: edits, pending: draft } = latest.current;
    const keys = blocksInReadingOrder(list).map((block) => block.id);
    for (const edit of edits) {
      const key = edit.blockId ?? edit.id;
      if (!keys.includes(key)) keys.push(key);
    }
    if (draft) keys.push(draft.id);
    return keys;
  }, []);

  /* ---------------------------------------------------------------- *
   * Foco y modos
   * ---------------------------------------------------------------- */

  /** Un texto propio que se deja vacio no sirve de nada: el borrador se descarta y la edicion se quita. */
  const discardIfEmpty = useCallback(
    (key: string) => {
      const { session: live } = latest.current;
      const { pending: draft, edit } = resolve(key);
      if (draft) {
        if (draft.text.trim().length === 0) setPending(null);
      } else if (edit && !edit.blockId && edit.text.trim().length === 0) {
        live.dispatch({ type: "remove", id: edit.id });
      }
    },
    [resolve],
  );

  const enter = useCallback(
    (key: string | null, mode: "selected" | "editing", seed?: string) => {
      const { session: live, focus: previous } = latest.current;
      if (previous && previous.key !== key) discardIfEmpty(previous.key);
      if (key === null) {
        setFocus(null);
        live.select(null);
        return;
      }
      const { block, edit } = resolve(key);
      if (block) setCoverInfo(sampleCover(block));
      setFocus({ key, mode, seed });
      live.select(edit?.id ?? null);
    },
    [resolve, sampleCover, discardIfEmpty],
  );

  // Tras repintar el canvas (primer render, zoom) el muestreo anterior pudo leer el canvas viejo
  // o ninguno: se repite para el bloque con foco. La decision no depende del zoom (px/pt).
  useEffect(() => {
    if (renderTick === 0) return;
    const { focus: current, blocks: all } = latest.current;
    const block = current ? all.find((b) => b.id === current.key) : undefined;
    if (!block) return;
    const next = sampleCover(block);
    setCoverInfo((previous) =>
      previous &&
      previous.key === next.key &&
      previous.sampled === next.sampled &&
      previous.color === next.color &&
      previous.uniform === next.uniform &&
      (previous.clip?.length ?? 0) === (next.clip?.length ?? 0)
        ? previous
        : next,
    );
  }, [renderTick, sampleCover]);

  const finishEditing = useCallback(
    (key: string, restoreFocus: boolean) => {
      const { session: live } = latest.current;
      const { pending: draft, edit } = resolve(key);
      if (draft && draft.text.trim().length === 0) {
        setPending(null);
        setFocus(null);
        if (restoreFocus) focusRegion(null);
        return;
      }
      if (edit && !draft && !edit.blockId && edit.text.trim().length === 0) {
        live.dispatch({ type: "remove", id: edit.id });
        setFocus(null);
        if (restoreFocus) focusRegion(null);
        return;
      }
      setFocus((current) =>
        current && current.key === key && current.mode === "editing"
          ? { key, mode: "selected" }
          : current,
      );
      if (restoreFocus) {
        // El foco pasa AL INSTANTE al bloque (el editor se desmonta en este mismo
        // ciclo): un golpe de tecla inmediato no cae en <body>.
        const region = regionOf(key);
        if (region) {
          exitingRef.current = true;
          region.focus({ preventScroll: true });
          window.requestAnimationFrame(() => {
            exitingRef.current = false;
          });
        } else {
          focusRegion(key);
        }
      }
    },
    [resolve, focusRegion, regionOf],
  );

  const removeEntry = useCallback(
    (key: string) => {
      const { session: live } = latest.current;
      const { pending: draft, edit, block } = resolve(key);
      if (draft) {
        setPending(null);
      } else if (edit && !edit.blockId) {
        live.dispatch({ type: "remove", id: edit.id });
      } else if (edit) {
        if (edit.text === "") return;
        live.dispatch({ type: "update", id: edit.id, patch: { text: "" } });
        setMessage(latest.current.strings.deleted);
        return;
      } else if (block) {
        live.dispatch({
          type: "add",
          item: textItem(blockDraft(block, { text: "" })),
        });
        setMessage(latest.current.strings.deleted);
        return;
      }
      // Texto propio quitado: el foco pasa al siguiente bloque, nunca a <body>.
      const keys = orderedKeys();
      const next = nextFocusKey(keys, key);
      setFocus(null);
      live.select(null);
      setMessage(latest.current.strings.deleted);
      focusRegion(next);
    },
    [resolve, blockDraft, orderedKeys, focusRegion, setMessage],
  );

  const duplicateEntry = useCallback(
    (key: string) => {
      const { session: live, metrics: m, pageIndex: page } = latest.current;
      const { pending: draft, edit, block } = resolve(key);
      const source: TextEdit | null =
        draft ?? edit ?? (block ? draftEditForBlock(block, { coverColor: null }) : null);
      if (!source || !m) return;
      const rect = userBoxToPx(m, source.box);
      const shift = userDeltaFromView(m, 0, rect.height + 8 * m.scale);
      const copy: TextEdit = {
        ...source,
        id: newEditId("tx"),
        pageIndex: page,
        box: { ...source.box, x: source.box.x + shift.dx, y: source.box.y + shift.dy },
        cover: { color: null, padding: 0 },
      };
      delete copy.blockId;
      delete copy.coverBox;
      delete copy.sourceFont;
      live.dispatch({ type: "add", item: textItem(copy) });
      setFocus({ key: copy.id, mode: "selected" });
      setMessage(latest.current.strings.duplicated);
      focusRegion(copy.id);
    },
    [resolve, focusRegion, setMessage],
  );

  /* ---------------------------------------------------------------- *
   * Manejadores de la capa (estables)
   * ---------------------------------------------------------------- */

  const handlers = useMemo<LayerHandlers>(
    () => ({
      onSelect: (key) => {
        if (key === null) {
          enter(null, "selected");
          return;
        }
        enter(key, "selected");
      },
      onBeginEdit: (key, seed) => enter(key, "editing", seed),
      onDelete: removeEntry,
      onNudge: (key, direction: NudgeDirection, big, resize) => {
        const { metrics: m } = latest.current;
        if (!m) return;
        const { edit, block } = resolve(key);
        if (!edit && !block) return;
        if (!resize) {
          const delta = nudgeDelta(m, direction, big);
          moveEntry(key, delta.dx, delta.dy);
          return;
        }
        const effectiveBox = edit
          ? edit
          : block
            ? draftEditForBlock(block, { coverColor: null })
            : null;
        if (!effectiveBox) return;
        const rect = userBoxToPx(m, effectiveBox.box);
        const step = (big ? 10 : 1) * m.scale;
        const next = { ...rect };
        if (direction === "left") next.width = Math.max(MIN_BOX_PT * m.scale, rect.width - step);
        if (direction === "right") next.width = rect.width + step;
        if (direction === "up") next.height = Math.max(MIN_BOX_PT * m.scale, rect.height - step);
        if (direction === "down") next.height = rect.height + step;
        const resized = pxRectToUserBox(m, next);
        resizeEntry(key, resized);
        setMessage(latest.current.strings.sizeAnnounce(Math.round(resized.width), Math.round(resized.height)));
      },
      onMove: (key, dxPx, dyPx) => {
        const { metrics: m } = latest.current;
        if (!m) return;
        const delta = userDeltaFromView(m, dxPx, dyPx);
        moveEntry(key, delta.dx, delta.dy);
      },
      onResize: (key, rect) => {
        const { metrics: m } = latest.current;
        if (!m) return;
        resizeEntry(key, pxRectToUserBox(m, rect));
      },
      onGesture: setGesturing,
      onTabIntoBar: () => {
        const bar = stageRef.current?.querySelector<HTMLElement>("[data-floating-bar]");
        const first = bar?.querySelector<HTMLElement>("button:not([disabled]), select:not([disabled])");
        if (!first) return false;
        first.focus();
        return true;
      },
    }),
    [enter, removeEntry, resolve, moveEntry, resizeEntry, setMessage],
  );

  /* ---------------------------------------------------------------- *
   * Imagenes y formas
   * ---------------------------------------------------------------- */

  /** Selecciona una imagen o forma: el foco de texto se suelta y el del teclado pasa a su region. */
  const selectElement = useCallback(
    (id: string) => {
      const { session: live, focus: previous } = latest.current;
      if (previous) discardIfEmpty(previous.key);
      setFocus(null);
      setCoverInfo(null);
      live.select(id);
      regionOf(id)?.focus({ preventScroll: true });
    },
    [discardIfEmpty, regionOf],
  );

  const itemOf = useCallback((id: string): EditShapeItem | EditImageItem | null => {
    const found = latest.current.session.items.find((item) => item.id === id);
    return found && (found.kind === "shape" || found.kind === "image") ? found : null;
  }, []);

  const nameOf = useCallback(
    (item: EditShapeItem | EditImageItem) =>
      elementName(item, latest.current.typeLabels, latest.current.strings),
    [],
  );

  const removeElement = useCallback(
    (id: string) => {
      const { session: live } = latest.current;
      const item = itemOf(id);
      if (!item) return;
      const regions = Array.from(
        hostRef.current?.querySelectorAll<HTMLElement>(ELEMENT_REGION_SELECTOR) ?? [],
      );
      const next = nextFocusKey(
        regions.map((region) => region.dataset.elementId ?? ""),
        id,
      );
      live.dispatch({ type: "remove", id });
      setMessage(latest.current.strings.elementDeleted(nameOf(item)));
      // El foco pasa al siguiente elemento (o a la hoja), nunca a <body>.
      focusRegion(next);
    },
    [itemOf, nameOf, focusRegion, setMessage],
  );

  const duplicateElement = useCallback(
    (id: string) => {
      const { session: live } = latest.current;
      const item = itemOf(id);
      if (!item) return;
      const op = duplicateOp(item);
      if (!op || op.type !== "add") return;
      live.dispatch(op);
      setMessage(latest.current.strings.elementDuplicated(nameOf(item)));
      focusRegion(op.item.id);
    },
    [itemOf, nameOf, focusRegion, setMessage],
  );

  const restyleElement = useCallback(
    (id: string, patch: RestylePatch) => {
      const { session: live } = latest.current;
      const item = itemOf(id);
      if (!item) return;
      live.dispatch({ type: "restyle", id, patch });
      // Lo que se cambia a un elemento es lo que nacera con el siguiente.
      const next = styleFromRestyle(item.element, patch as Record<string, unknown>);
      if (Object.keys(next).length > 0) setStyle((current) => ({ ...current, ...next }));
    },
    [itemOf],
  );

  const elementHandlers = useMemo<ElementHandlers>(
    () => ({
      onSelect: (id) => {
        if (id === null) {
          enter(null, "selected");
          hostRef.current?.focus({ preventScroll: true });
          return;
        }
        // Elegir un elemento (p. ej. un resaltado con el resaltador armado) suelta la herramienta.
        if (latest.current.tool !== "select") setTool("select");
        selectElement(id);
      },
      onMove: (id, dxPx, dyPx) => {
        const { metrics: m, session: live } = latest.current;
        if (!m) return;
        live.dispatch({ type: "move", id, dx: dxPx / m.cssWidth, dy: dyPx / m.cssHeight });
      },
      onResize: (id, rect) => {
        const { metrics: m, session: live } = latest.current;
        if (!m) return;
        live.dispatch({ type: "resize", id, box: pxRectToNormBox(m, rect) });
      },
      onReshape: (id, points) => {
        latest.current.session.dispatch({ type: "reshape", id, points });
      },
      onNudge: (id, direction: NudgeDirection, big, resize) => {
        const { metrics: m, session: live } = latest.current;
        const item = itemOf(id);
        if (!m || !item) return;
        const step = (big ? 10 : 1) * m.scale;
        const vx = direction === "left" ? -step : direction === "right" ? step : 0;
        const vy = direction === "up" ? -step : direction === "down" ? step : 0;
        if (!resize) {
          live.dispatch({ type: "move", id, dx: vx / m.cssWidth, dy: vy / m.cssHeight });
          return;
        }
        const el = item.element;
        if (item.kind === "shape" && el.type === "line") {
          // Alt + flechas en una linea mueven su segundo extremo.
          live.dispatch({
            type: "reshape",
            id,
            points: { x1: el.x1, y1: el.y1, x2: el.x2 + vx / m.cssWidth, y2: el.y2 + vy / m.cssHeight },
          });
          return;
        }
        if (el.type === "line") return;
        const min = MIN_BOX_PT * m.scale * 0.5;
        let width = el.width * m.cssWidth;
        let height = el.height * m.cssHeight;
        const horizontal = direction === "left" || direction === "right";
        if (item.kind === "image") {
          // Las imagenes conservan su proporcion: el lado que manda es el que se toca.
          const ratio = height / Math.max(1, width);
          if (horizontal) width = Math.max(min, width + vx);
          else width = Math.max(min, (height + vy) / ratio);
          height = width * ratio;
        } else {
          if (horizontal) width = Math.max(min, width + vx);
          else height = Math.max(min, height + vy);
        }
        live.dispatch({
          type: "resize",
          id,
          box: pxRectToNormBox(m, { left: el.x * m.cssWidth, top: el.y * m.cssHeight, width, height }),
        });
        setMessage(latest.current.strings.sizeAnnounce(Math.round(width / m.scale), Math.round(height / m.scale)));
      },
      onDelete: removeElement,
      onGesture: setGesturing,
      onTabIntoBar: () => {
        const bar = stageRef.current?.querySelector<HTMLElement>("[data-floating-bar]");
        const first = bar?.querySelector<HTMLElement>("button:not([disabled]), select:not([disabled])");
        if (!first) return false;
        first.focus();
        return true;
      },
    }),
    [enter, selectElement, itemOf, removeElement, setMessage],
  );

  /** Pone una imagen elegida o soltada en la pagina (en `at`, o en el centro de lo que se ve). */
  const placeImage = useCallback(
    async (file: Blob, at: NormPoint | null, multiple = false) => {
      const result = await readImageFile(file);
      const strs = latest.current.strings;
      if (!result.ok) {
        const reasons: Record<ImageRejection, string> = {
          type: strs.imageWrongType,
          size: strs.imageTooLarge(Math.round(MAX_IMAGE_BYTES / (1024 * 1024))),
          pixels: strs.imageTooManyPixels(Math.round(MAX_IMAGE_PIXELS / 1_000_000)),
          unreadable: strs.imageUnreadable,
          empty: strs.imageEmpty,
        };
        setImageNotice({ text: reasons[result.reason], error: true });
        setMessage(reasons[result.reason]);
        return false;
      }
      const { metrics: m, pageIndex: page, session: live } = latest.current;
      if (!m) return false;
      let center = at;
      if (!center) {
        const host = hostRef.current?.getBoundingClientRect();
        const sticky = document.querySelector<HTMLElement>("[data-canvas-sticky]")?.getBoundingClientRect();
        const viewport = window.visualViewport;
        center = host
          ? visibleCenterNorm(host, {
              top: sticky && sticky.height > 0 ? Math.max(0, sticky.bottom) : 0,
              bottom: viewport ? viewport.offsetTop + viewport.height : window.innerHeight,
              left: 0,
              right: window.innerWidth,
            })
          : { x: 0.5, y: 0.5 };
      }
      const element = imageElementAt({
        metrics: m,
        pageIndex: page,
        id: newEditId("im"),
        center,
        image: result.image,
      });
      live.dispatch(addImageOp(element));
      setImageNotice(null);
      setTool("select");
      setMessage(multiple ? `${strs.imagePlaced} ${strs.imageMultiple}` : strs.imagePlaced);
      focusRegion(element.id);
      return true;
    },
    [focusRegion, setMessage],
  );

  /** Arma una herramienta (o vuelve a Seleccionar): arma = suelta la seleccion y descarta lo que se dibujaba. */
  const chooseTool = useCallback(
    (next: Tool) => {
      creationRef.current = null;
      setDraftRect(null);
      setDraftShape(null);
      setImageNotice(null);
      setTool(next);
      // Al cambiar de herramienta el aviso anterior («Imagen colocada»...) deja de ser verdad.
      setMessage(next === "select" ? "" : latest.current.strings.toolHints[next]);
      if (next !== "select" && next !== "text") enter(null, "selected");
      if (next === "image") imageInputRef.current?.click();
    },
    [enter, setMessage],
  );

  /* Un pellizco cancela lo que se estuviera dibujando con el primer dedo. */
  useEffect(() => {
    const cancel = () => {
      creationRef.current = null;
      setDraftRect(null);
      setDraftShape(null);
    };
    window.addEventListener(PINCH_START_EVENT, cancel);
    return () => window.removeEventListener(PINCH_START_EVENT, cancel);
  }, []);

  /* ---------------------------------------------------------------- *
   * Editor inline
   * ---------------------------------------------------------------- */

  const onEditorExit = useCallback(
    (reason: InlineExitReason, related: Element | null) => {
      const current = latest.current.focus;
      if (!current || current.mode !== "editing") return;
      if (exitingRef.current) return;
      if (reason === "blur") {
        // Pasar a la barra flotante no termina la edicion.
        if (related?.closest("[data-floating-bar]")) return;
        finishEditing(current.key, related === null);
        return;
      }
      finishEditing(current.key, true);
    },
    [finishEditing],
  );

  const onHistory = useCallback((action: "undo" | "redo") => {
    const { session: live } = latest.current;
    if (action === "undo") live.undo();
    else live.redo();
  }, []);

  /* ---------------------------------------------------------------- *
   * Gestos de la pagina: texto nuevo y figuras
   * ---------------------------------------------------------------- */

  const localPoint = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onHostPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).hasAttribute("data-edit-canvas")) {
      return;
    }
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((tool === "text" || isDrawTool(tool)) && metrics) {
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Sin captura el trazo sigue mientras el puntero este encima.
      }
      const start = localPoint(event);
      creationRef.current = { pointerId: event.pointerId, start, kind: tool };
      if (tool === "text") setDraftRect({ left: start.x, top: start.y, width: 0, height: 0 });
      return;
    }
    if (tool === "image") return;
    // Clic en lo vacio: deselecciona (y termina la edicion). Con el dedo, al SOLTAR un toque corto:
    // el primer dedo de un desplazamiento o de un pellizco no cierra la barra.
    if (event.pointerType === "touch") {
      const point = localPoint(event);
      touchTapRef.current = { pointerId: event.pointerId, x: point.x, y: point.y };
    } else if (focus || session.selected) {
      enter(null, "selected");
    }
    hostRef.current?.focus({ preventScroll: true });
  };

  const onHostPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const creation = creationRef.current;
    if (!creation || creation.pointerId !== event.pointerId || !metrics) return;
    const point = localPoint(event);
    if (creation.kind === "text") {
      setDraftRect(newTextPxRect(metrics, creation.start, point));
      return;
    }
    if (isTap(creation.start, point)) {
      setDraftShape(null);
      return;
    }
    // Vista previa en vivo, con el estilo activo (sin formulario aparte).
    setDraftShape(
      shapeFromGesture({
        tool: creation.kind,
        metrics,
        pageIndex,
        id: "draft",
        start: pxToNorm(metrics, creation.start),
        end: pxToNorm(metrics, point),
        tap: false,
        style,
      }),
    );
  };

  const endCreation = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    const creation = creationRef.current;
    if (!creation || creation.pointerId !== event.pointerId) {
      // Fin de un toque en vacio con el dedo: si no se movio, deselecciona.
      const tap = touchTapRef.current;
      if (tap && tap.pointerId === event.pointerId) {
        touchTapRef.current = null;
        if (commit) {
          const point = localPoint(event);
          if (isTap(tap, point) && (focus || session.selected)) enter(null, "selected");
        }
      }
      return;
    }
    creationRef.current = null;
    setDraftRect(null);
    setDraftShape(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ya liberado.
    }
    if (!commit || !metrics) return;
    const point = localPoint(event);
    if (creation.kind === "text") {
      const rect = newTextPxRect(metrics, creation.start, point);
      const draft = newTextEditAt(metrics, pageIndex, rect, newEditId("tx"));
      setPending(draft);
      setFocus({ key: draft.id, mode: "editing" });
      setCoverInfo(null);
      setTool("select");
      return;
    }
    const element = shapeFromGesture({
      tool: creation.kind,
      metrics,
      pageIndex,
      id: newEditId("el"),
      start: pxToNorm(metrics, creation.start),
      end: pxToNorm(metrics, point),
      tap: isTap(creation.start, point),
      style,
    });
    // Un trazo por debajo de los minimos del motor no crea nada y deja la herramienta armada.
    if (!element) return;
    const item = shapeItem(element);
    session.dispatch({ type: "add", item });
    setTool("select");
    setMessage(s.elementAdded(elementName(item, strings.typeLabels, s)));
    focusRegion(element.id);
  };

  /* Esc durante un trazo lo cancela (sin crear nada). */
  const drawing = draftRect !== null || draftShape !== null;
  useEffect(() => {
    if (!drawing) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      creationRef.current = null;
      setDraftRect(null);
      setDraftShape(null);
      setTool("select");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drawing]);

  /* ---------------------------------------------------------------- *
   * Imagen: selector de archivo y arrastrar y soltar
   * ---------------------------------------------------------------- */

  const hasFiles = (event: ReactDragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const onHostDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  };

  const onHostDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropActive(false);
  };

  const onHostDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDropActive(false);
    const files = event.dataTransfer?.files;
    const file = firstImageCandidate(files);
    if (!file || !metrics) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // Sin coordenadas validas (algunos navegadores de accesibilidad) se coloca en el centro de lo que se ve.
    const at = Number.isFinite(x) && Number.isFinite(y) ? pxToNorm(metrics, { x, y }) : null;
    void placeImage(file, at, (files?.length ?? 0) > 1);
  };

  /* ---------------------------------------------------------------- *
   * Navegacion y zoom
   * ---------------------------------------------------------------- */

  const { applyZoom, pinchProps } = useZoomGestures({ stageRef, hostRef, clipRef, zoom, setZoom });

  /* ---------------------------------------------------------------- *
   * Aplanar pagina
   * ---------------------------------------------------------------- */

  const requestFlatten = () => setFlattenAsk({ page: pageIndex, open: true });

  /**
   * Tras la hoja de confirmacion el foco no puede quedar en <body> (el disparador pudo desmontarse: «Más» ya se cerro).
   * Cancelar: a «Más» de la barra (o al bloque, o al control de aplanar). Confirmar: al control de pagina aplanada.
   */
  const keepFocusAfterFlattenAsk = (confirmed: boolean) => {
    let attempts = 0;
    /** El primero que se ve (hay un control de escritorio y otro movil); sin maquetacion (jsdom), el primero montado. */
    const pick = (list: Array<HTMLElement | null | undefined>): HTMLElement | undefined => {
      const mounted = list.filter((element): element is HTMLElement => element instanceof HTMLElement && element.isConnected);
      return mounted.find((element) => element.getClientRects().length > 0) ?? mounted[0];
    };
    const tryFocus = () => {
      // Mientras la hoja de confirmacion sale (animacion) el foco aun esta en sus botones: se espera a que se desmonte.
      if (document.querySelector('[role="dialog"]')) {
        attempts += 1;
        if (attempts < 60) window.setTimeout(tryFocus, 50);
        return;
      }
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const toggles = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-flatten-toggle]") ?? []);
      const more = stageRef.current?.querySelector<HTMLElement>('[data-bar-action="more"]');
      const candidate = confirmed ? pick(toggles) : (pick([more]) ?? pick(toggles));
      if (candidate) {
        candidate.focus({ preventScroll: true });
        if (document.activeElement === candidate) return;
      }
      if (!confirmed && latest.current.focus) {
        focusRegion(latest.current.focus.key);
        if (document.activeElement !== document.body) return;
      }
      attempts += 1;
      if (attempts < 40) window.setTimeout(tryFocus, 50);
    };
    window.setTimeout(tryFocus, 350);
  };

  const flattenConfirmedRef = useRef(false);
  const confirmFlatten = () => {
    const page = flattenAsk?.page;
    if (page === undefined) return;
    flattenConfirmedRef.current = true;
    session.dispatch({ type: "add", item: flattenItem(page) });
    setMessage(flow.flattenedAnnounce(page + 1));
  };

  const unflattenPage = (id: string) => {
    session.dispatch({ type: "remove", id });
    setMessage(flow.unflattenedAnnounce(pageIndex + 1));
  };

  const goToPage = (index: number) => {
    const next = Math.min(Math.max(0, index), Math.max(0, pageCount - 1));
    if (next === pageIndex) return;
    // La region enfocada se desmonta con la pagina: el foco pasa a la hoja, nunca a <body>.
    const active = document.activeElement;
    if (active && hostRef.current?.contains(active)) hostRef.current.focus({ preventScroll: true });
    setPageIndex(next);
    setFocus(null);
    setPending(null);
    setCoverInfo(null);
    setDraftShape(null);
    creationRef.current = null;
    session.select(null);
    setMessage(
      s.pageStatus(next + 1, pageCount, pageCounts.get(next) ?? 0) +
        (flattenedSet.has(next) ? ` ${flow.flattenChip}.` : ""),
    );
  };

  /** Centro de lo que se ve de la hoja: el punto que se queda quieto al acercar con los botones. */
  const zoomAnchor = () => {
    const clip = clipRef.current?.getBoundingClientRect();
    const host = hostRef.current?.getBoundingClientRect();
    if (!clip || !host) return undefined;
    const top = Math.max(host.top, 0);
    const bottom = Math.min(host.bottom, window.innerHeight);
    return {
      clientX: clip.left + clip.width / 2,
      clientY: bottom > top ? (top + bottom) / 2 : host.top + host.height / 2,
    };
  };
  const zoomIn = () => applyZoom(ZOOM_STEPS.find((step) => step > zoom + 0.01) ?? zoom, zoomAnchor());
  const zoomOut = () =>
    applyZoom([...ZOOM_STEPS].reverse().find((step) => step < zoom - 0.01) ?? 1, zoomAnchor());

  const stripOpen = pageCount > 1 && (stripPref ?? desktop);

  /* ---------------------------------------------------------------- *
   * Teclado global del lienzo
   * ---------------------------------------------------------------- */

  const handleShortcut = (
    event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented" | "preventDefault"> & {
      target: EventTarget | null;
    },
  ) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target && isEditableElement(target)) return;
    const key = event.key.toLowerCase();
    const shortcut = TOOL_SHORTCUTS[key];
    if (shortcut && !event.shiftKey) {
      event.preventDefault();
      chooseTool(shortcut);
    } else if (event.key === "Escape" && tool !== "select") {
      event.preventDefault();
      chooseTool("select");
    } else if (
      event.key === "Escape" &&
      (focus !== null || session.selected !== null) &&
      !target?.closest("[data-element-id], [data-inline-editor], [data-floating-bar], [role=dialog]")
    ) {
      // Un trazo recien hecho o un clic fuera pueden dejar el foco en la paleta o en <body> (antes de que
      // el foco pase al elemento): Esc sigue soltando la seleccion. Con el foco en un elemento, el editor o
      // la barra, mandan sus propias teclas.
      event.preventDefault();
      enter(null, "selected");
      hostRef.current?.focus({ preventScroll: true });
    } else if (event.key === "[") {
      event.preventDefault();
      goToPage(pageIndex - 1);
    } else if (event.key === "]") {
      event.preventDefault();
      goToPage(pageIndex + 1);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomIn();
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomOut();
    }
  };

  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => handleShortcut(event);

  /* Los atajos tambien valen con el foco en <body> (tras un clic fuera o un trazo recien hecho),
     mientras el editor esta montado y sin hojas abiertas ni campos de texto. */
  const shortcutRef = useRef(handleShortcut);
  useEffect(() => {
    shortcutRef.current = handleShortcut;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const active = document.activeElement;
      if (active && active !== document.body) return; // con foco en otro sitio mandan sus propias teclas
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return; // hoja abierta
      shortcutRef.current(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  /* El foco nunca debe quedar en <body> si el elemento enfocado se desmonta (deshacer, cambiar de pagina). */
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      focusInsideRef.current = !!(event.target instanceof Node && rootRef.current?.contains(event.target));
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if ((!active || active === document.body) && focusInsideRef.current) {
        hostRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [session.items, pageIndex]);

  /* ---------------------------------------------------------------- *
   * Barras flotantes
   * ---------------------------------------------------------------- */

  const barState: BarTextState | null =
    effective && focus
      ? {
          fontKey: effective.fontKey,
          fontSize: effective.fontSize,
          bold: effective.bold,
          italic: effective.italic,
          color: effective.color,
          align: effective.align,
          coverColor: effective.cover.color,
          sourceFont: effective.sourceFont ?? focusBlock?.font,
          text: effective.text,
          mixedStyle: focusBlock?.mixedStyle === true,
          overlap,
          coverCrossesNeighbor,
        }
      : null;
  const replacesBlock = focusBlock !== undefined || focusEdit?.blockId !== undefined;
  const layoutKey = [
    pageIndex,
    zoom,
    metrics?.cssWidth ?? 0,
    focus?.key ?? "",
    focus?.mode ?? "",
    effective ? `${effective.box.x},${effective.box.y},${effective.box.width},${effective.box.height}` : "",
  ].join("|");

  const elementBarState: ElementBarState | null = selectedElement ? barStateOf(selectedElement) : null;
  const elementLayoutKey = [
    pageIndex,
    zoom,
    metrics?.cssWidth ?? 0,
    selectedElementId ?? "",
    selectedElement ? elementGeometryKey(selectedElement) : "",
  ].join("|");

  const focusBarBackToBlock = () => {
    if (!focus) return;
    if (focus.mode === "editing") {
      hostRef.current?.querySelector<HTMLElement>("[data-inline-editor]")?.focus();
    } else {
      focusRegion(focus.key);
    }
  };

  const tools: PaletteTool[] = buildPaletteTools(strings, style.checkMark);

  /* ---------------------------------------------------------------- *
   * Mensajes de estado
   * ---------------------------------------------------------------- */

  const analysis = pageText.analysis;
  /** La pagina no tiene capa de texto (escaneo): solo se puede AÑADIR sobre ella. */
  const scannedPage = existingText && !!analysis && !analysis.failed && !analysis.hasTextLayer;
  const statusText = !existingText
    ? flow.existingTextOff
    : pageText.status === "analyzing"
      ? s.analyzing
      : analysis?.failed
        ? s.analysisFailed
        : scannedPage
          ? s.scanned
          : "";
  const nonEditable = blocks.filter((block) => !block.editable).length;
  const hintText = imageNotice?.text ?? s.toolHints[tool];
  const glyphText = barState ? glyphNotice(barState, s) : "";

  /* Lo que la hoja avisa por si sola (escaneo, fallo, ajuste apagado, caracteres sin glifo) se dice en la region unica. */
  const announceAuto = analysis?.failed || scannedPage || !existingText ? statusText : "";
  useEffect(() => {
    if (!announceAuto) return;
    const frame = window.requestAnimationFrame(() => announceFocus(announceAuto));
    return () => window.cancelAnimationFrame(frame);
  }, [announceAuto, announceFocus]);
  useEffect(() => {
    if (!glyphText) return;
    const frame = window.requestAnimationFrame(() => announceFocus(glyphText));
    return () => window.cancelAnimationFrame(frame);
  }, [glyphText, announceFocus]);
  const armed = tool !== "select";
  const passiveText = isDrawTool(tool) || tool === "image";

  // El documento no se pudo leer (cabecera valida pero contenido danado): estado de error claro, sin lienzo ni spinner.
  if (error) {
    return (
      <div
        data-edit-workspace=""
        data-edit-failed=""
        className="surface-card rounded-ios-lg flex flex-col items-start gap-3 p-5"
      >
        <p role="status" className="text-subheadline text-foreground">
          {flow.documentFailed}
        </p>
        {onChooseAnother ? (
          <Button variant="secondary" size="md" onClick={onChooseAnother}>
            {flow.tryAnotherFile}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-edit-workspace=""
      onKeyDown={onRootKeyDown}
      className="space-y-3 max-md:pb-24"
    >
      <EditNavBar
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        pageIndex={pageIndex}
        pageCount={pageCount}
        onGoTo={goToPage}
        stripOpen={stripOpen}
        onToggleStrip={() => setStripPref(!stripOpen)}
        stripId={stripId}
        strings={strings}
        s={s}
        flatten={
          pageCount > 0
            ? {
                label: flattenHere ? flow.unflattenAction : flow.flattenAction,
                active: flattenHere !== undefined,
                onClick: flattenHere ? () => unflattenPage(flattenHere.id) : requestFlatten,
              }
            : undefined
        }
        hint={
          // Region de estado siempre montada; con una herramienta armada (o un aviso) CUELGA de la barra
          // como una pastilla: al aparecer no empuja la pagina (se hace clic en la paleta y la hoja no salta).
          <div
            data-tool-hint-box=""
            className={cn(
              armed || imageNotice
                ? "surface-card shadow-elevation-2 rounded-ios pointer-events-none absolute inset-x-0 top-[calc(100%+0.25rem)] z-10 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                : "sr-only",
            )}
          >
            <p
              data-tool-hint=""
              className={cn("min-w-0 flex-1 text-sm", imageNotice?.error ? "text-destructive-text" : "text-foreground")}
            >
              {hintText}
            </p>
            {tool === "image" ? (
              <Button
                variant="secondary"
                size="sm"
                data-image-pick=""
                className="pointer-events-auto"
                onClick={() => imageInputRef.current?.click()}
              >
                <ImagePlus aria-hidden="true" className="size-4" />
                {s.imagePick}
              </Button>
            ) : null}
          </div>
        }
      />

      {stripOpen ? (
        <PageStrip
          id={stripId}
          doc={doc}
          pageCount={pageCount}
          activeIndex={pageIndex}
          counts={pageCounts}
          flattened={flattenedSet}
          flattenMark={flow.flattenStripMark}
          onGo={goToPage}
          strings={s}
        />
      ) : null}

      {/* Region viva siempre montada: solo cambia su texto; la accion queda FUERA de ella. */}
      <div
        className={cn(
          statusText &&
            "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-ios border border-hairline bg-white/5 px-3 py-2",
        )}
      >
        <p
          data-analysis-status=""
          className={cn(statusText ? "min-w-0 flex-1 basis-60 text-sm text-muted-foreground" : "sr-only")}
        >
          {statusText}
        </p>
        {scannedPage ? (
          <Button
            variant="secondary"
            size="sm"
            data-scanned-add-text=""
            className="pointer-coarse:h-11 pointer-coarse:before:hidden"
            onClick={() => chooseTool("text")}
          >
            {flow.scannedAction}
          </Button>
        ) : null}
        {!existingText ? (
          <Link
            href="/settings"
            data-settings-link=""
            className={buttonClasses("secondary", "sm", "pointer-coarse:h-11 pointer-coarse:before:hidden")}
          >
            {flow.settingsLink}
          </Link>
        ) : null}
      </div>
      {nonEditable > 0 && pageText.status === "ready" ? (
        <p className="text-xs text-muted-foreground">{s.nonEditableCount(nonEditable)}</p>
      ) : null}

      {/* En movil la barra de paginas no tiene sitio para otro boton de 44 px: la accion va en su fila. */}
      {pageCount > 0 ? (
        <div className="md:hidden" data-page-actions="">
          <Button
            variant="ghost"
            size="sm"
            data-flatten-toggle=""
            data-flattened={flattenHere ? "" : undefined}
            className="pointer-coarse:h-11 pointer-coarse:before:hidden"
            onClick={flattenHere ? () => unflattenPage(flattenHere.id) : requestFlatten}
          >
            <Layers
              aria-hidden="true"
              className={cn("size-4", flattenHere && "text-signal-text")}
            />
            {flattenHere ? flow.unflattenAction : flow.flattenAction}
          </Button>
        </div>
      ) : null}


      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,.png,.jpg,.jpeg"
        data-image-input=""
        aria-hidden="true"
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          const picked = event.target.files?.[0] ?? null;
          event.target.value = "";
          if (picked) void placeImage(picked, null);
        }}
      />

      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <EditToolPalette
          tool={tool}
          tools={tools}
          onToolChange={(id) => chooseTool(isTool(id) ? id : "select")}
          actions={[
            {
              id: "undo",
              icon: Undo2,
              label: s.undo,
              keyShortcuts: "Control+Z Meta+Z",
              shortcutLabel: "Ctrl+Z",
              disabled: !session.canUndo,
              onClick: session.undo,
            },
            {
              id: "redo",
              icon: Redo2,
              label: s.redo,
              keyShortcuts: "Control+Shift+Z Meta+Shift+Z Control+Y",
              shortcutLabel: "Ctrl+Shift+Z",
              disabled: !session.canRedo,
              onClick: session.redo,
            },
          ]}
          label={s.paletteLabel}
          className="z-20 max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(9.25rem+env(safe-area-inset-bottom,0px))] max-md:grid max-md:grid-cols-5 max-md:rounded-none max-md:px-1 max-md:[&_[role=separator]]:hidden md:sticky md:top-24 md:w-12 md:shrink-0"
        />

        <div ref={stageRef} className="surface-card rounded-ios relative min-w-0 flex-1 p-3">
          <EditSurface
            doc={doc}
            pageIndex={pageIndex}
            zoom={zoom}
            hostRef={hostRef}
            clipRef={clipRef}
            handleRef={surfaceRef}
            onMetrics={(next, page) => setMeasured(next ? { metrics: next, pageIndex: page } : null)}
            onRendered={() => setRenderTick((tick) => tick + 1)}
            loadingLabel={s.loadingPage}
            failedLabel={s.pageFailed}
            stageLabel={s.stageLabel}
            hostProps={{
              tabIndex: -1,
              "data-tool": tool,
              ...pinchProps,
              onPointerDown: onHostPointerDown,
              onPointerMove: onHostPointerMove,
              onPointerUp: (event) => endCreation(event, true),
              onPointerCancel: (event) => endCreation(event, false),
              onDragOver: onHostDragOver,
              onDragLeave: onHostDragLeave,
              onDrop: onHostDrop,
              className: cn(
                dropActive ? "outline-2 outline-offset-2 outline-signal" : "outline-hidden",
                armed
                  ? cn("touch-none", tool === "image" ? "cursor-copy" : "cursor-crosshair")
                  : zoom > 1.01
                    ? "touch-pan-x touch-pan-y"
                    : "touch-pan-y",
              ),
            }}
          >
            {metrics ? (
              <TextBlockLayer
                metrics={metrics}
                blocks={blocks}
                edits={pageEdits}
                pending={pending}
                selectedKey={focus?.mode === "selected" ? focus.key : null}
                editingKey={focus?.mode === "editing" ? focus.key : null}
                editingCover={focusCover?.color ?? null}
                coarse={coarse}
                passive={passiveText}
                strings={s}
                handlers={handlers}
                onAnnounce={announceFocus}
              >
                <ElementLayer
                  metrics={metrics}
                  items={pageElementItems}
                  assets={session.session.assets}
                  selectedId={selectedElementId}
                  passive={armed}
                  interactiveTypes={tool === "highlight" ? HIGHLIGHT_ONLY : undefined}
                  coarse={coarse}
                  draft={draftShape}
                  strings={s}
                  typeLabels={strings.typeLabels}
                  handlers={elementHandlers}
                />
                {focus?.mode === "editing" && effective ? (
                  <InlineTextEditor
                    key={focus.key}
                    frame={textFrame(metrics, effective.box, effective.rotation)}
                    text={effective.text}
                    css={effective}
                    scale={metrics.scale}
                    label={s.editorLabel}
                    hint={s.editorHint}
                    seed={focus.seed}
                    onTextChange={(text) => updateText(focus.key, text)}
                    onExit={onEditorExit}
                    onHistory={onHistory}
                  />
                ) : null}
              </TextBlockLayer>
            ) : null}
            {flattenHere ? (
              <>
                <div
                  aria-hidden="true"
                  data-flatten-outline=""
                  className="pointer-events-none absolute inset-0 z-[6] outline-2 -outline-offset-2 outline-dashed outline-signal"
                />
                <div
                  data-flatten-chip=""
                  className="pointer-events-none absolute top-2 left-2 z-[8] flex items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-caption font-semibold text-foreground shadow-elevation-1"
                >
                  <Layers aria-hidden="true" className="size-3.5 text-signal-text" />
                  {flow.flattenChip}
                </div>
              </>
            ) : null}
            {draftRect ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute z-[7] border border-dashed border-signal bg-signal/10"
                style={{
                  left: draftRect.left,
                  top: draftRect.top,
                  width: draftRect.width,
                  height: Math.max(draftRect.height, NEW_TEXT_FONT_SIZE * (metrics?.scale ?? 1)),
                }}
              />
            ) : null}
          </EditSurface>

          <EditFloatingBar
            stageRef={stageRef}
            clipRef={clipRef}
            hostRef={hostRef}
            selectionId={gesturing ? null : focusKey}
            layoutKey={layoutKey}
            state={barState}
            replacesBlock={replacesBlock}
            originalRemoved={flattenHere !== undefined}
            backgroundNotUniform={focusCover?.uniform === false || focusEdit?.cover.uniform === false}
            strings={s}
            onRestyle={(patch) => focusKey && restyleEntry(focusKey, patch)}
            onDuplicate={() => focusKey && duplicateEntry(focusKey)}
            onDelete={() => focusKey && removeEntry(focusKey)}
            onEscape={focusBarBackToBlock}
            onTabBackward={focusBarBackToBlock}
            onTabForward={() => {
              if (!focusKey) return false;
              const keys = orderedKeys();
              const next = keys[keys.indexOf(focusKey) + 1];
              const region = next ? regionOf(next) : null;
              if (!region) return false;
              region.focus();
              return true;
            }}
            onFlattenRequested={flattenHere ? undefined : requestFlatten}
          />

          <ElementFloatingBar
            stageRef={stageRef}
            clipRef={clipRef}
            hostRef={hostRef}
            selectionId={gesturing || armed ? null : selectedElementId}
            layoutKey={elementLayoutKey}
            state={elementBarState}
            strings={s}
            onRestyle={(patch) => selectedElementId && restyleElement(selectedElementId, patch)}
            onDuplicate={() => selectedElementId && duplicateElement(selectedElementId)}
            onDelete={() => selectedElementId && removeElement(selectedElementId)}
            onEscape={() => selectedElementId && focusRegion(selectedElementId)}
            onTabBackward={() => selectedElementId && focusRegion(selectedElementId)}
            onTabForward={() => {
              if (!selectedElementId) return false;
              const regions = Array.from(
                hostRef.current?.querySelectorAll<HTMLElement>(ELEMENT_REGION_SELECTOR) ?? [],
              );
              const index = regions.findIndex((region) => region.dataset.elementId === selectedElementId);
              const next = regions[index + 1];
              if (!next) return false;
              next.focus();
              return true;
            }}
          />
        </div>
      </div>

      <div role="status" aria-live="polite" data-workspace-live="" className="sr-only">
        <span key={live.n}>{live.text}</span>
      </div>

      <ConfirmSheet
        open={flattenAsk?.open === true}
        onClose={() => {
          setFlattenAsk((current) => (current ? { ...current, open: false } : null));
          // `onConfirm` corre antes que `onClose`: aqui ya se sabe si se confirmo o se cancelo/cerro.
          const confirmed = flattenConfirmedRef.current;
          flattenConfirmedRef.current = false;
          keepFocusAfterFlattenAsk(confirmed);
        }}
        onConfirm={confirmFlatten}
        title={flow.flattenConfirmTitle((flattenAsk?.page ?? 0) + 1)}
        body={
          flattenLoss && (flattenLoss.forms || flattenLoss.outlines)
            ? `${flow.flattenConfirmBody} ${flow.flattenDropsNote(flattenLoss.forms, flattenLoss.outlines)}`
            : flow.flattenConfirmBody
        }
        confirmLabel={flow.flattenConfirmAction}
        cancelLabel={flow.flattenCancel}
        closeLabel={flow.flattenClose}
      />
    </div>
  );
}
