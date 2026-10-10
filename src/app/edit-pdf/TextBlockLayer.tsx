"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/cn";
import { layoutResizeHandles } from "@/app/edit-pdf/resizeHandles";
import { expandHitTargets, IDEAL_TARGET_PX, type Insets } from "@/app/sign-pdf/canvasGeometry";
import {
  DOUBLE_TAP_DISTANCE_PX,
  DOUBLE_TAP_MS,
  MIN_BOX_PT,
  TAP_MOVE_THRESHOLD_PX,
  excerpt,
  resizePxRect,
  textFrame,
  userBoxToPx,
  type NudgeDirection,
  type PageMetrics,
  type PxRect,
  type ResizeHandle,
} from "@/app/edit-pdf/editCanvasMath";
import { frameStyle, textBoxStyle } from "@/app/edit-pdf/InlineTextEditor";
import { PINCH_START_EVENT } from "@/app/edit-pdf/useZoomGestures";
import { moveForKey, moveTarget, type LayerMove } from "@/app/edit-pdf/layerNavigation";
import type { EditInlineStrings } from "@/app/edit-pdf/strings";
import { coverShape } from "@/lib/pdf/editCover";
import { orientedClipPath } from "@/app/edit-pdf/coverClip";
import { blocksInReadingOrder } from "@/lib/pdf/textBlocks";
import type { TextBlock, TextEdit } from "@/lib/pdf/editTypes";

/*
 * Capa de bloques de texto sobre la hoja (W5-U4a).
 *
 * Cada bloque (extraido o anadido) es una REGION accesible (`role="button"`,
 * enfocable) con una zona de toque ampliada a 44 px con puntero grueso
 * (`expandHitTargets`). Teclado: Intro/F2 o teclear edita, Supr borra, flechas
 * mueven (Mayus = paso grande; Alt + flechas cambian el tamano), Esc
 * deselecciona, Tab/Mayus+Tab recorren los bloques en ORDEN DE LECTURA con una
 * region viva «Bloque 3 de 12: texto…». Los bloques no editables se ven
 * atenuados (borde discontinuo), muestran el motivo y no se pueden entrar a
 * editar.
 *
 * Rendimiento: cada entrada es un componente memoizado cuyas props solo cambian
 * si cambia SU bloque, SU edicion o su estado de foco; los gestos (mover,
 * redimensionar) viven en la propia entrada. Teclear en un bloque no vuelve a
 * pintar los demas.
 */

export type LayerEntryData = {
  key: string;
  block?: TextBlock;
  edit?: TextEdit;
  /** Texto nuevo aun no incluido en la sesion (sin cambios en el historial). */
  pending?: boolean;
};

export type LayerHandlers = {
  onSelect: (key: string | null) => void;
  onBeginEdit: (key: string, seed?: string) => void;
  onDelete: (key: string) => void;
  /** `resize`: Alt + flecha (cambia el tamano en vez de mover). */
  onNudge: (key: string, direction: NudgeDirection, big: boolean, resize: boolean) => void;
  /** Soltar un arrastre de movimiento (px de la hoja). */
  onMove: (key: string, dxPx: number, dyPx: number) => void;
  onResize: (key: string, rect: PxRect) => void;
  /** Hay un arrastre en curso (la barra flotante se oculta). */
  onGesture: (active: boolean) => void;
  /** Tab desde el bloque seleccionado: `true` si el foco ya paso a la barra. */
  onTabIntoBar: (key: string) => boolean;
};

export type TextBlockLayerProps = {
  metrics: PageMetrics;
  blocks: readonly TextBlock[];
  /** Ediciones de texto de la pagina (con o sin `blockId`). */
  edits: readonly TextEdit[];
  pending: TextEdit | null;
  selectedKey: string | null;
  editingKey: string | null;
  /** Color de cobertura provisional del bloque en edicion que aun no tiene edicion. */
  editingCover: string | null;
  coarse: boolean;
  /**
   * (W5-U4b) Una herramienta de dibujo esta armada: los bloques no reciben puntero
   * (arrastrar encima dibuja, p. ej. un resaltado sobre el texto) pero siguen
   * siendo alcanzables por teclado.
   */
  passive?: boolean;
  strings: EditInlineStrings;
  handlers: LayerHandlers;
  /**
   * (W5-U5) Si se da, los anuncios («Bloque 3 de 12», «No editable») salen por la region
   * viva UNICA del editor y la capa no pinta la suya.
   */
  onAnnounce?: (text: string) => void;
  /** Editor inline y demas piezas que van encima. */
  children?: ReactNode;
};

/** Contadores de pintado por entrada, para la prueba de rendimiento. */
export const entryRenderCounts = new Map<string, number>();

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const EDITING_RING: Insets = { top: 12, right: 12, bottom: 12, left: 12 };

type Gesture =
  | { kind: "move"; dx: number; dy: number }
  | { kind: "resize"; rect: PxRect };

type EntryProps = {
  entryKey: string;
  block: TextBlock | undefined;
  edit: TextEdit | undefined;
  pending: boolean;
  index: number;
  total: number;
  metrics: PageMetrics;
  selected: boolean;
  editing: boolean;
  editingCover: string | null;
  inset: Insets | undefined;
  coarse: boolean;
  passive: boolean;
  strings: EditInlineStrings;
  hintId: string;
  handlers: LayerHandlers;
  announce: (text: string) => void;
  tap: (key: string, x: number, y: number, at: number) => boolean;
  /** (W5-U5) Unica parada de Tab de la capa (roving tabindex). */
  tabStop: boolean;
  /** (W5-U5) Mueve el foco a otra entrada en orden de lectura. */
  navigate: (key: string, move: LayerMove) => void;
  /** (W5-U5) Recuerda la ultima entrada enfocada: es la parada de Tab. */
  onFocusEntry: (key: string) => void;
};

function entryName(
  strings: EditInlineStrings,
  block: TextBlock | undefined,
  edit: TextEdit | undefined,
): string {
  const text = edit ? edit.text : (block?.text ?? "");
  const short = excerpt(text, 120);
  if (short.length === 0) return strings.emptyTextName;
  return edit && !edit.blockId ? strings.newTextName(short) : strings.blockName(short);
}

/**
 * Reenvia un toque sin arrastre al elemento de bloque que queda bajo el tirador (W5-U5, N3): los tiradores
 * externos de un bloque bajo pueden caer sobre el siguiente y no deben impedir seleccionarlo.
 */
function passThroughTap(event: ReactPointerEvent<HTMLElement>): void {
  const doc = event.currentTarget.ownerDocument;
  if (typeof doc.elementsFromPoint !== "function") return;
  const stack = doc.elementsFromPoint(event.clientX, event.clientY);
  const target = stack.find((el) => el.closest("[data-resize-handle]") === null && el.closest("[data-element-kind]") !== null);
  const region = target?.closest<HTMLElement>("[data-element-kind]");
  if (!region || region.hasAttribute("data-pending")) return;
  const Ctor = (doc.defaultView?.PointerEvent ?? doc.defaultView?.MouseEvent) as typeof PointerEvent | undefined;
  if (!Ctor) return;
  const init = {
    bubbles: true,
    cancelable: true,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isPrimary: true,
    button: 0,
  };
  region.dispatchEvent(new Ctor("pointerdown", init));
  region.dispatchEvent(new Ctor("pointerup", init));
}

function BlockEntryImpl(props: EntryProps) {
  const {
    entryKey,
    block,
    edit,
    pending,
    index,
    total,
    metrics,
    selected,
    editing,
    editingCover,
    inset,
    coarse,
    passive,
    strings,
    hintId,
    handlers,
    announce,
    tap,
    tabStop,
    navigate,
    onFocusEntry,
  } = props;
  // Solo instrumentacion de pruebas: en produccion no se acumula nada.
  if (process.env.NODE_ENV !== "production") {
    entryRenderCounts.set(entryKey, (entryRenderCounts.get(entryKey) ?? 0) + 1);
  }

  const editable = edit !== undefined || block?.editable !== false;
  const reason = !editable && block?.readOnlyReason ? strings.reasons[block.readOnlyReason] : null;
  const box = edit?.box ?? block!.box;
  const rotation = edit?.rotation ?? block!.rotation;
  const frame = useMemo(
    () => textFrame(metrics, box, rotation),
    [metrics, box, rotation],
  );
  const envelope = useMemo(() => userBoxToPx(metrics, box), [metrics, box]);
  const axisAligned = rotation % 90 === 0;

  const coverColor = edit ? edit.cover.color : editing ? editingCover : null;
  const coverRect = useMemo(() => {
    if (!coverColor) return null;
    // La MISMA forma que pinta el exportador (`coverShape`): caja ampliada, o el
    // rectangulo orientado si el texto original esta girado un angulo libre.
    const source = edit ?? (block ? { box: block.box, cover: { color: coverColor, padding: 1 } } : null);
    const shape = source ? coverShape(source) : null;
    if (!shape) return null;
    if (shape.kind === "rect") {
      const rect = userBoxToPx(metrics, shape.box);
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height } as CSSProperties;
    }
    const radians = (shape.rotation * Math.PI) / 180;
    const cx = shape.origin.x + (shape.width / 2) * Math.cos(radians) - (shape.height / 2) * Math.sin(radians);
    const cy = shape.origin.y + (shape.width / 2) * Math.sin(radians) + (shape.height / 2) * Math.cos(radians);
    const center = userBoxToPx(metrics, { x: cx, y: cy, width: 0, height: 0 });
    const width = shape.width * metrics.scale;
    const height = shape.height * metrics.scale;
    let angle = (((metrics.geometry.rotation - shape.rotation) % 360) + 360) % 360;
    if (angle > 180) angle -= 360;
    const clipPath = orientedClipPath(shape, metrics.scale);
    return {
      left: center.left - width / 2,
      top: center.top - height / 2,
      width,
      height,
      transform: `rotate(${angle}deg)`,
      ...(clipPath ? { clipPath } : {}),
    } as CSSProperties;
  }, [coverColor, edit, block, metrics]);

  const [gesture, setGesture] = useState<Gesture | null>(null);
  const editOnClickRef = useRef(false);
  const gestureRef = useRef<{
    kind: "move" | "resize";
    handle?: ResizeHandle;
    pointerId: number;
    startX: number;
    startY: number;
    moved: boolean;
    cancelled: boolean;
    pointerType: string;
    startRect: PxRect;
  } | null>(null);

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    kind: "move" | "resize",
    handle?: ResizeHandle,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    editOnClickRef.current = false;
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Sin captura el gesto sigue mientras el puntero este encima.
    }
    gestureRef.current = {
      kind,
      handle,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      cancelled: false,
      pointerType: event.pointerType,
      startRect: { ...envelope },
    };
  };

  const finishGesture = () => {
    gestureRef.current = null;
    setGesture(null);
    handlers.onGesture(false);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== event.pointerId || g.cancelled) return;
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (!g.moved) {
      if (Math.hypot(dx, dy) <= TAP_MOVE_THRESHOLD_PX) return;
      g.moved = true;
      handlers.onGesture(true);
    }
    if (g.kind === "move") {
      setGesture({ kind: "move", dx, dy });
    } else if (g.handle) {
      setGesture({
        kind: "resize",
        rect: resizePxRect(
          g.startRect,
          g.handle,
          dx,
          dy,
          MIN_BOX_PT * metrics.scale,
          { width: metrics.cssWidth, height: metrics.cssHeight },
        ),
      });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== event.pointerId) return;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ya liberado.
    }
    const dx = event.clientX - g.startX;
    const dy = event.clientY - g.startY;
    if (g.cancelled) {
      finishGesture();
      return;
    }
    if (g.moved) {
      if (g.kind === "move") {
        if (editable && (dx !== 0 || dy !== 0)) handlers.onMove(entryKey, dx, dy);
      } else if (g.handle) {
        handlers.onResize(
          entryKey,
          resizePxRect(g.startRect, g.handle, dx, dy, MIN_BOX_PT * metrics.scale, {
            width: metrics.cssWidth,
            height: metrics.cssHeight,
          }),
        );
      }
      finishGesture();
      return;
    }
    finishGesture();
    if (g.kind === "resize") {
      // Un toque sin arrastre sobre un tirador no hace nada propio: lo recibe lo que hay debajo (otro bloque que
      // el tirador externo de este tape), como si el tirador no existiera.
      passThroughTap(event);
      return;
    }
    // Toque: en un dedo, la seleccion llega ahora (arrastrar era desplazar la pagina).
    if (!editable) {
      announce(strings.notEditable(reason ?? ""));
      return;
    }
    if (editing) return;
    if (g.pointerType !== "mouse") {
      // Con el dedo, tocar un bloque ya seleccionado lo edita (un doble toque preciso cuesta).
      // Se edita en el `click` que sigue: el navegador mueve el foco al bloque con los
      // eventos de raton de compatibilidad, DESPUES de `pointerup`, y le quitaria el
      // foco al editor recien abierto.
      if (selected) editOnClickRef.current = true;
      else handlers.onSelect(entryKey);
      return;
    }
    if (tap(entryKey, event.clientX, event.clientY, event.timeStamp)) {
      handlers.onBeginEdit(entryKey);
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    const g = gestureRef.current;
    if (!g || g.pointerId !== event.pointerId) return;
    finishGesture();
  };

  /*
   * Red de seguridad (N1): un gesto en curso SIEMPRE termina de forma determinista. Si el elemento que capturaba el
   * puntero desaparece o el navegador lo suelta, el `pointerup`/`pointercancel` llega a `window` y el gesto se confirma
   * (con la ultima posicion) o se cancela; nunca queda colgado con una vista previa que no se guarda. Va en burbuja,
   * despues de React: si el manejador del elemento ya lo cerro, `gestureRef` es null y esto no hace nada.
   */
  const gestureLive = gesture !== null;
  useEffect(() => {
    if (!gestureLive) return;
    const onUp = (event: PointerEvent) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;
      if (!g.cancelled && g.moved) {
        const dx = event.clientX - g.startX;
        const dy = event.clientY - g.startY;
        if (g.kind === "move") {
          if (editable && (dx !== 0 || dy !== 0)) handlers.onMove(entryKey, dx, dy);
        } else if (g.handle) {
          handlers.onResize(
            entryKey,
            resizePxRect(g.startRect, g.handle, dx, dy, MIN_BOX_PT * metrics.scale, {
              width: metrics.cssWidth,
              height: metrics.cssHeight,
            }),
          );
        }
      }
      finishGesture();
    };
    const onCancel = (event: PointerEvent) => {
      const g = gestureRef.current;
      if (!g || g.pointerId !== event.pointerId) return;
      finishGesture();
    };
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    // `finishGesture` y los datos del bloque se leen frescos en cada render del efecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gestureLive, handlers, entryKey, editable, metrics]);

  /* Esc cancela el arrastre en curso. */
  const dragging = gesture !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (gestureRef.current) gestureRef.current.cancelled = true;
      setGesture(null);
      handlers.onGesture(false);
    };
    // Un pellizco con dos dedos cancela el arrastre del primero.
    const onPinch = () => {
      if (gestureRef.current) gestureRef.current.cancelled = true;
      setGesture(null);
      handlers.onGesture(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(PINCH_START_EVENT, onPinch);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(PINCH_START_EVENT, onPinch);
    };
  }, [dragging, handlers]);

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    begin(event, "resize", event.currentTarget.dataset.resizeHandle as ResizeHandle);
  };

  const onRegionPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!editable) {
      event.stopPropagation();
      return;
    }
    // Con raton o lapiz, el clic selecciona al instante; con el dedo, al soltar.
    if (event.pointerType !== "touch" && !selected && !editing) handlers.onSelect(entryKey);
    begin(event, "move");
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const arrow: Record<string, NudgeDirection> = {
      ArrowLeft: "left",
      ArrowRight: "right",
      ArrowUp: "up",
      ArrowDown: "down",
    };
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      if (editable) handlers.onBeginEdit(entryKey);
      else announce(strings.notEditable(reason ?? ""));
    } else if (event.key === " ") {
      event.preventDefault();
      if (editable) handlers.onSelect(entryKey);
      else announce(strings.notEditable(reason ?? ""));
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (!editable) return;
      event.preventDefault();
      handlers.onDelete(entryKey);
    } else if (arrow[event.key] && !event.ctrlKey && !event.metaKey) {
      // Seleccionado (o con Mayus / Alt): las flechas MUEVEN o redimensionan. Si solo
      // tiene el foco, las flechas recorren los bloques en orden de lectura.
      if (selected || event.altKey || event.shiftKey) {
        if (!editable) return;
        event.preventDefault();
        handlers.onNudge(entryKey, arrow[event.key], event.shiftKey, event.altKey);
      } else {
        event.preventDefault();
        navigate(entryKey, moveForKey(event.key)!);
      }
    } else if (
      (event.key === "Home" || event.key === "End" || event.key === "PageUp" || event.key === "PageDown") &&
      plain
    ) {
      event.preventDefault();
      navigate(entryKey, moveForKey(event.key)!);
    } else if (event.key === "Escape") {
      handlers.onSelect(null);
    } else if (event.key === "Tab" && !event.shiftKey && selected) {
      if (handlers.onTabIntoBar(entryKey)) event.preventDefault();
    } else if (plain && event.key.length === 1 && editable) {
      event.preventDefault();
      handlers.onBeginEdit(entryKey, event.key);
    }
  };

  const moveDx = gesture?.kind === "move" ? gesture.dx : 0;
  const moveDy = gesture?.kind === "move" ? gesture.dy : 0;
  const liveEnvelope: PxRect =
    gesture?.kind === "resize"
      ? gesture.rect
      : { ...envelope, left: envelope.left + moveDx, top: envelope.top + moveDy };
  const liveFrame =
    gesture?.kind === "resize"
      ? {
          ...frame,
          left: gesture.rect.left,
          top: gesture.rect.top,
          width: gesture.rect.width,
          minHeight: gesture.rect.height,
          height: gesture.rect.height,
        }
      : { ...frame, left: frame.left + moveDx, top: frame.top + moveDy };

  const hit = editing ? EDITING_RING : (inset ?? NO_INSETS);
  const name = entryName(strings, block, edit);
  const label = reason ? `${name}. ${strings.notEditable(reason)}` : name;
  const hasText = edit !== undefined && edit.text.length > 0;
  const emptied = edit !== undefined && edit.text.trim().length === 0;
  const showHandles = (selected || editing) && editable && axisAligned && !pending;

  // (W5-U5, N3) En un bloque estrecho o bajo los tiradores de 44 px tapan el centro y no se puede volver a tocar para
  // editarlo: se encogen segun ancho Y alto y, si aun asi no caben, pasan fuera de la caja (ver resizeHandles.ts).
  // Zona de toque: la region (caja + margen, recortada por los vecinos) UNIDA al cuadrado de 44 x 44 centrado en el
  // centro del bloque: un glifo de 1 x 2 px con un vecino pegado tiene una region asimetrica, pero su cuadrado de
  // toque sigue siendo suyo y los tiradores externos van fuera de ambos.
  // (N1) Durante un redimensionado el CONJUNTO de tiradores (cuales, modo, tamano, lado) queda congelado con el layout
  // del inicio del gesto: si se recalculase con la caja en vivo, un tirador externo sin sitio en su lado se desmontaria a
  // mitad del arrastre, nunca llegaria el `pointerup` y el cambio se perderia. Cada tirador solo SIGUE a su esquina.
  const layoutBase: PxRect = gesture?.kind === "resize" ? envelope : liveEnvelope;
  const touchZone = ((): PxRect => {
    const region: PxRect = {
      left: layoutBase.left - hit.left,
      top: layoutBase.top - hit.top,
      width: layoutBase.width + hit.left + hit.right,
      height: layoutBase.height + hit.top + hit.bottom,
    };
    if (!coarse) return region;
    const cx = layoutBase.left + layoutBase.width / 2;
    const cy = layoutBase.top + layoutBase.height / 2;
    const half = IDEAL_TARGET_PX / 2;
    const left = Math.min(region.left, cx - half);
    const top = Math.min(region.top, cy - half);
    const right = Math.max(region.left + region.width, cx + half);
    const bottom = Math.max(region.top + region.height, cy + half);
    return { left, top, width: right - left, height: bottom - top };
  })();
  const handleLayout = layoutResizeHandles(layoutBase, {
    ideal: coarse ? IDEAL_TARGET_PX : 28,
    minInside: coarse ? 28 : 16,
    pageWidth: metrics.cssWidth,
    zone: touchZone,
  });
  /** Cuanto se ha movido la esquina de cada tirador durante el redimensionado en curso. */
  const cornerShift = (name: ResizeHandle): { dx: number; dy: number } => {
    if (gesture?.kind !== "resize") return { dx: 0, dy: 0 };
    const west = name === "nw" || name === "sw";
    const north = name === "nw" || name === "ne";
    return {
      dx: west ? liveEnvelope.left - envelope.left : liveEnvelope.left + liveEnvelope.width - (envelope.left + envelope.width),
      dy: north ? liveEnvelope.top - envelope.top : liveEnvelope.top + liveEnvelope.height - (envelope.top + envelope.height),
    };
  };
  const handleHit = handleLayout.size;
  const moveLeft =
    handleLayout.mode === "external"
      ? touchZone.left + touchZone.width / 2 - handleHit / 2
      : liveEnvelope.left - handleHit / 2;
  const moveTop = (handleLayout.mode === "external" ? touchZone.top : liveEnvelope.top) - handleHit - 2;

  return (
    <>
      {coverRect ? (
        <div
          aria-hidden="true"
          data-cover={entryKey}
          data-cover-holes={coverRect.clipPath ? "" : undefined}
          className="pointer-events-none absolute z-[1]"
          style={{ ...coverRect, backgroundColor: coverColor ?? undefined }}
        />
      ) : null}

      {!editing && (hasText || selected || gesture) ? (
        <div
          aria-hidden="true"
          data-text-view={entryKey}
          className={cn("pointer-events-none z-[2] whitespace-pre-line")}
          style={{
            ...(edit ? textBoxStyle(liveFrame, edit, metrics.scale) : { ...frameStyle(liveFrame), fontSize: 0 }),
            outline: selected ? "2px solid var(--color-signal)" : undefined,
            outlineOffset: 2,
          }}
        >
          {edit?.text}
        </div>
      ) : null}

      <div
        role="button"
        tabIndex={tabStop ? 0 : -1}
        aria-label={label}
        aria-pressed={editable ? selected : undefined}
        aria-disabled={editable ? undefined : true}
        aria-describedby={hintId}
        aria-keyshortcuts={editable ? "Enter Delete ArrowUp ArrowDown Home End" : "ArrowUp ArrowDown Home End"}
        title={reason ? strings.notEditable(reason) : undefined}
        data-element-kind="text"
        data-element-id={entryKey}
        data-drag-mode="move"
        data-selected={selected ? "" : undefined}
        data-editing={editing ? "" : undefined}
        data-not-editable={editable ? undefined : ""}
        data-emptied={emptied ? "" : undefined}
        data-pending={pending ? "" : undefined}
        onPointerDown={onRegionPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClick={() => {
          if (!editOnClickRef.current) return;
          editOnClickRef.current = false;
          handlers.onBeginEdit(entryKey);
        }}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          onFocusEntry(entryKey);
          const base = strings.blockLive(index + 1, total, excerpt(edit ? edit.text : (block?.text ?? ""), 80) || strings.emptyTextName);
          announce(reason ? `${base}. ${strings.notEditable(reason)}` : base);
        }}
        className={cn(
          "group absolute z-[3]",
          passive ? "pointer-events-none" : "pointer-events-auto",
          editable ? "cursor-pointer" : "cursor-not-allowed",
          // El dedo desplaza la pagina salvo que el bloque ya este seleccionado.
          selected || editing ? "touch-none" : "touch-pan-y",
        )}
        style={{
          left: liveEnvelope.left - hit.left,
          top: liveEnvelope.top - hit.top,
          width: liveEnvelope.width + hit.left + hit.right,
          height: liveEnvelope.height + hit.top + hit.bottom,
        }}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute rounded-[3px] transition-[background-color,box-shadow] duration-[var(--duration-fast)]",
            "group-focus-visible:outline-2 group-focus-visible:outline-offset-2 outline-signal",
            editable
              ? !selected &&
                  !editing &&
                  "group-hover:bg-signal/12 group-hover:shadow-[inset_0_0_0_1px_var(--color-signal)]"
              : "border border-dashed border-black/55 group-hover:bg-black/8",
            emptied && editable && "border border-dashed border-black/55",
          )}
          style={{ left: hit.left, top: hit.top, right: hit.right, bottom: hit.bottom }}
        />
      </div>

      {showHandles
        ? handleLayout.handles.map((box) => {
            const shift = cornerShift(box.handle);
            return (
            <div
              key={box.handle}
              aria-hidden="true"
              data-resize-handle={box.handle}
              data-handle-mode={handleLayout.mode}
              onPointerDown={onHandlePointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              className={cn(
                "absolute z-[5] touch-none",
                passive ? "pointer-events-none" : "pointer-events-auto",
                box.handle === "nw" || box.handle === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize",
              )}
              style={{ left: box.left + shift.dx, top: box.top + shift.dy, width: box.size, height: box.size }}
            >
              <span
                className="absolute size-2.5 rounded-full border-2 border-signal bg-white"
                style={{ left: box.dotX - 5, top: box.dotY - 5 }}
              />
            </div>
            );
          })
        : null}

      {editing && editable && !pending ? (
        <div
          aria-hidden="true"
          data-move-handle=""
          onPointerDown={(event) => begin(event, "move")}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          className="pointer-events-auto absolute z-[5] flex cursor-grab touch-none items-center justify-center text-signal-text"
          style={{
            left: moveLeft,
            top: moveTop,
            width: handleHit,
            height: handleHit,
          }}
        >
          <span className="flex size-6 items-center justify-center rounded-full bg-white shadow-elevation-1 ring-1 ring-black/20">
            <GripVertical aria-hidden="true" className="size-4 text-black/70" />
          </span>
        </div>
      ) : null}
    </>
  );
}

const BlockEntry = memo(BlockEntryImpl);

/** Ordena los bloques en orden de lectura y añade al final los textos propios. */
export function buildEntries(
  blocks: readonly TextBlock[],
  edits: readonly TextEdit[],
  pending: TextEdit | null,
): LayerEntryData[] {
  const byBlock = new Map<string, TextEdit>();
  for (const edit of edits) if (edit.blockId) byBlock.set(edit.blockId, edit);
  const entries: LayerEntryData[] = [];
  const known = new Set<string>();
  for (const block of blocksInReadingOrder(blocks)) {
    known.add(block.id);
    entries.push({ key: block.id, block, edit: byBlock.get(block.id) });
  }
  for (const edit of edits) {
    if (edit.blockId && known.has(edit.blockId)) continue;
    entries.push({ key: edit.blockId ?? edit.id, edit });
  }
  if (pending) entries.push({ key: pending.id, edit: pending, pending: true });
  return entries;
}

export function TextBlockLayer({
  metrics,
  blocks,
  edits,
  pending,
  selectedKey,
  editingKey,
  editingCover,
  coarse,
  passive = false,
  strings,
  handlers,
  onAnnounce,
  children,
}: TextBlockLayerProps) {
  const hintId = useId();
  const [live, setLive] = useState("");
  const lastTap = useRef<{ key: string; x: number; y: number; at: number } | null>(null);

  const entries = useMemo(
    () => buildEntries(blocks, edits, pending),
    [blocks, edits, pending],
  );

  /* Roving tabindex: UNA sola parada de Tab para toda la capa (la ultima entrada enfocada,
     o la seleccionada, o la primera); las flechas recorren el resto. */
  const rootRef = useRef<HTMLDivElement>(null);
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  const keys = useMemo(() => entries.map((entry) => entry.key), [entries]);
  const stopKey =
    (lastFocused !== null && keys.includes(lastFocused) && lastFocused) ||
    (selectedKey !== null && keys.includes(selectedKey) && selectedKey) ||
    (editingKey !== null && keys.includes(editingKey) && editingKey) ||
    keys[0] ||
    null;
  const keysRef = useRef(keys);
  useEffect(() => {
    keysRef.current = keys;
  });
  const navigate = useCallback((from: string, move: LayerMove) => {
    const list = keysRef.current;
    const index = list.indexOf(from);
    if (index < 0) return;
    const target = list[moveTarget(index, list.length, move)];
    if (!target || target === from) return;
    const regions = rootRef.current?.querySelectorAll<HTMLElement>('[data-element-kind="text"][data-drag-mode="move"]');
    for (const region of Array.from(regions ?? [])) {
      if (region.dataset.elementId === target) {
        region.focus({ preventScroll: false });
        return;
      }
    }
  }, []);
  const onFocusEntry = useCallback((key: string) => setLastFocused(key), []);

  const insets = useMemo(() => {
    if (!coarse) return new Map<string, Insets>();
    return expandHitTargets(
      blocks.map((block) => {
        const rect = userBoxToPx(metrics, block.box);
        return {
          id: block.id,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        };
      }),
      { width: metrics.cssWidth, height: metrics.cssHeight },
      IDEAL_TARGET_PX,
    );
  }, [blocks, metrics, coarse]);

  const announce = useCallback(
    (text: string) => {
      if (onAnnounce) onAnnounce(text);
      else setLive(text);
    },
    [onAnnounce],
  );
  const tap = useCallback((key: string, x: number, y: number, at: number) => {
    const previous = lastTap.current;
    const isDouble =
      previous !== null &&
      previous.key === key &&
      at - previous.at <= DOUBLE_TAP_MS &&
      Math.hypot(x - previous.x, y - previous.y) <= DOUBLE_TAP_DISTANCE_PX;
    lastTap.current = isDouble ? null : { key, x, y, at };
    return isDouble;
  }, []);

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={strings.layerLabel}
      data-block-layer=""
      className="pointer-events-none absolute inset-0 isolate"
    >
      {entries.map((entry, index) => (
        <BlockEntry
          key={entry.key}
          entryKey={entry.key}
          block={entry.block}
          edit={entry.edit}
          pending={entry.pending === true}
          index={index}
          total={entries.length}
          metrics={metrics}
          selected={selectedKey === entry.key}
          editing={editingKey === entry.key}
          editingCover={editingKey === entry.key ? editingCover : null}
          inset={insets.get(entry.key)}
          coarse={coarse}
          passive={passive}
          strings={strings}
          hintId={hintId}
          handlers={handlers}
          announce={announce}
          tap={tap}
          tabStop={entry.key === stopKey}
          navigate={navigate}
          onFocusEntry={onFocusEntry}
        />
      ))}
      {children}
      <span id={hintId} className="sr-only">
        {strings.blockHint}
      </span>
      {onAnnounce ? null : (
        <div role="status" aria-live="polite" data-block-live="" className="sr-only">
          {live}
        </div>
      )}
    </div>
  );
}
