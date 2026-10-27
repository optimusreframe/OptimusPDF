import { createEdgeAutoScroller } from "@/lib/touch/edgeAutoScroll";
import { insertionIndexAt, type GridLayout } from "@/app/scan-to-pdf/gridLayout";

/** Milisegundos de pulsacion larga para empezar a arrastrar con el dedo desde el cuerpo de la tarjeta. */
export const LONG_PRESS_MS = 450;
const DRAG_THRESHOLD = 5;
const LONG_PRESS_SLOP = 8;

export type DragState = { ids: string[]; pointer: { x: number; y: number }; insertBefore: number };

export type DragLatest = {
  layout: GridLayout;
  pageIds: readonly string[];
  selection: ReadonlySet<string>;
  onDrop: (ids: string[], insertBefore: number) => void;
  announce: (text: string) => void;
  dragStart: (number: number) => string;
  dragCancel: string;
};

export type DragDeps = {
  latest: { current: DragLatest };
  container: { current: HTMLElement | null };
  /** Zona con desplazamiento propia que contiene la cuadricula (el auto-desplazamiento va sobre ella). */
  scroller: { current: HTMLElement | null };
  setDrag: (state: DragState | null) => void;
  suppressClick: { current: boolean };
};

export type PointerLike = { pointerId: number; clientX: number; clientY: number };

type Session = {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  client: { x: number; y: number };
  ids: string[];
  insertBefore: number;
};

/**
 * Sensor de arrastre de la cuadricula por eventos de puntero (no HTML5 DnD: no funciona con el tacto). Los oyentes de ventana van
 * en fase de CAPTURA. Con el dedo se arrastra desde el asa (arranca en cuanto se mueve) o con una pulsacion larga sobre la
 * miniatura (`bodyDown`); con raton o lapiz, desde cualquier punto tras 5 px. El auto-desplazamiento es por TIEMPO
 * (`createEdgeAutoScroller`). Escape cancela. Sin React: se prueba aparte.
 */
export function createGridDrag(deps: DragDeps) {
  let session: Session | null = null;
  let press: { timer: ReturnType<typeof setTimeout>; cleanup: () => void } | null = null;

  const point = (clientX: number, clientY: number) => {
    const box = deps.container.current?.getBoundingClientRect();
    return box ? { x: clientX - box.left, y: clientY - box.top } : { x: clientX, y: clientY };
  };

  const refresh = () => {
    if (!session || !session.active) return;
    const { layout, pageIds } = deps.latest.current;
    const local = point(session.client.x, session.client.y);
    session.insertBefore = insertionIndexAt(layout, pageIds.length, local.x, local.y);
    deps.setDrag({ ids: session.ids, pointer: { ...session.client }, insertBefore: session.insertBefore });
  };

  const scroller = createEdgeAutoScroller({
    pointer: () => (session?.active ? session.client : null),
    region: () => {
      const box = deps.scroller.current?.getBoundingClientRect();
      return box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right } : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    },
    scroll: (_dx, dy) => {
      const element = deps.scroller.current;
      if (!element) return { dx: 0, dy: 0 };
      const before = element.scrollTop;
      element.scrollTop = before + dy;
      return { dx: 0, dy: element.scrollTop - before };
    },
    onTick: refresh,
  });

  const begin = () => {
    if (!session) return;
    const { selection, pageIds, announce, dragStart } = deps.latest.current;
    session.ids = selection.has(session.id) ? pageIds.filter((id) => selection.has(id)) : [session.id];
    session.active = true;
    announce(dragStart(pageIds.indexOf(session.id) + 1));
    scroller.start();
    refresh();
  };

  function onMove(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return;
    session.client = { x: event.clientX, y: event.clientY };
    if (!session.active) {
      if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < DRAG_THRESHOLD) return;
      begin();
    }
    event.preventDefault();
    refresh();
  }

  function onUp(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return;
    if (session.active) {
      session.client = { x: event.clientX, y: event.clientY };
      refresh();
    }
    finish(true);
  }

  function onCancel(event: PointerEvent) {
    if (!session || event.pointerId !== session.pointerId) return;
    finish(false);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape" && session?.active) {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  }

  // Registrado desde el montaje (antes de cualquier toque): iOS solo respeta `preventDefault` en `touchmove` si el oyente ya existia.
  function onTouchMove(event: TouchEvent) {
    if (session?.active && event.cancelable) event.preventDefault();
  }
  window.addEventListener("touchmove", onTouchMove, { passive: false });

  function finish(commit: boolean) {
    const current = session;
    press?.cleanup();
    if (!current) return;
    session = null;
    scroller.stop();
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    deps.setDrag(null);
    if (!current.active) return;
    deps.suppressClick.current = true;
    setTimeout(() => {
      deps.suppressClick.current = false;
    }, 0);
    if (commit) deps.latest.current.onDrop(current.ids, current.insertBefore);
    else deps.latest.current.announce(deps.latest.current.dragCancel);
  }

  function start(event: PointerLike, id: string, immediate: boolean) {
    if (session) return;
    session = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false, client: { x: event.clientX, y: event.clientY }, ids: [id], insertBefore: 0 };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onKey, true);
    if (immediate) begin();
  }

  /** Dedo sobre el cuerpo de la tarjeta: si no se mueve durante LONG_PRESS_MS, empieza el arrastre. */
  function longPress(event: PointerLike, id: string, mark?: () => void) {
    press?.cleanup();
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const cancel = (move?: PointerEvent) => {
      if (move && move.type === "pointermove" && Math.hypot(move.clientX - startX, move.clientY - startY) < LONG_PRESS_SLOP) return;
      cleanup();
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("pointermove", cancel);
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
      if (press?.timer === timer) press = null;
    };
    const timer = setTimeout(() => {
      cleanup();
      if (session) return;
      start({ pointerId, clientX: startX, clientY: startY }, id, true);
      mark?.();
    }, LONG_PRESS_MS);
    press = { timer, cleanup };
    window.addEventListener("pointermove", cancel);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
  }

  function dispose() {
    finish(false);
    press?.cleanup();
    window.removeEventListener("touchmove", onTouchMove);
  }

  return { start, longPress, dispose, get active() { return session?.active === true; } };
}

export type GridDrag = ReturnType<typeof createGridDrag>;
