"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  usePresence,
  useTransform,
  type AnimationPlaybackControls,
} from "motion/react";
import { LiveSinkProvider } from "@/components/tool/liveRouting";
import { useIsClient } from "@/hooks/useIsClient";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { cn } from "@/lib/cn";
import {
  createVelocityTracker,
  crossFadeTransition,
  resolveSheetRelease,
  rubberband,
  springs,
  type VelocityTracker,
} from "@/lib/motion";

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  closeLabel: string;
  children: ReactNode;
  className?: string;
  /**
   * En un telefono en apaisado el ancho ya supera el punto de corte `md` y
   * el panel se confundiria con un escritorio (tarjeta centrada y
   * estrecha). Con esto activado, el panel pasa a pantalla completa en
   * touch —cualquier orientacion, hasta tablet— en vez de esa tarjeta: lo
   * usa el contenido que necesita el hueco real entero, como el lienzo de
   * firma.
   */
  mobileFullscreen?: boolean;
  /**
   * Al cerrarse, la hoja devuelve el foco a lo que lo tenia al abrirla. Si la accion que la cierra YA movio el foco a
   * otro sitio (p. ej. duplicar un texto lo deja en la copia), esta funcion devuelve `false` y la hoja no se lo quita.
   * Es una funcion (no una prop booleana) porque la hoja que sale conserva las props con que se renderizo por ultima vez.
   */
  restoreFocusOnClose?: () => boolean;
  /**
   * Selector CSS (dentro de la hoja) del control que recibe el foco al abrirla; sin el, o si no existe, lo recibe el
   * propio panel. Los formularios lo usan para abrir con el cursor en su primer campo (en un campo de texto,
   * ademas, queda seleccionado su contenido).
   */
  initialFocus?: string;
};

/**
 * Puntero grueso (dedo, no raton/trackpad) y ancho de escritorio-pequeño
 * hacia abajo: cubre telefono en cualquier giro y tablet, sin arrastrar a
 * un monitor tactil de escritorio a la pantalla completa.
 */
export const MOBILE_FULLSCREEN_QUERY =
  "(pointer: coarse) and (max-width: 1024px)";

/** Movimiento minimo (px) antes de decidir que un toque es un arrastre. */
const DRAG_HYSTERESIS = 8;

/*
 * Pila de hojas abiertas (W2-B). Las hojas se apilan (Opciones -> Plantillas
 * -> confirmacion) y cada una escucha Escape en `window`: sin coordinacion, un
 * solo Escape las cerraba TODAS. Cada hoja se registra al montarse y se retira
 * al desmontarse; Escape lo atiende solo la superior que no este ya cerrandose
 * (asi un segundo Escape, mientras la superior aun sale, ya cierra la
 * siguiente). `handledEscapes` evita que, en el mismo evento, la hoja de
 * debajo se vea a si misma como superior tras marcar la de arriba como
 * cerrandose.
 */
type SheetEntry = { closing: boolean };
const sheetStack: SheetEntry[] = [];
const handledEscapes = new WeakSet<Event>();

function topOpenSheet(): SheetEntry | undefined {
  for (let index = sheetStack.length - 1; index >= 0; index -= 1) {
    if (!sheetStack[index].closing) return sheetStack[index];
  }
  return undefined;
}

/* El scroll del fondo se bloquea una sola vez para toda la pila. */
let scrollLocks = 0;
let savedBodyOverflow = "";

/**
 * Bottom sheet con el tacto de iOS.
 *
 * - Entra y sale por el mismo camino (desde abajo), con spring sin rebote
 *   cuando no hay gesto. La salida se anima incluso si la cierra el padre
 *   (`open=false`): AnimatePresence mantiene el ultimo render hasta que la
 *   animacion termina.
 * - Se arrastra 1:1 desde el asa, la cabecera y —con dedo— la superficie
 *   (si el contenido no esta desplazado). Pointer Events con captura,
 *   respetando el punto de agarre; rubber-band al tirar hacia arriba.
 * - Al soltar: proyecta el momentum, decide por el signo de la velocidad
 *   (`resolveSheetRelease`) y continua con la velocidad heredada.
 * - Interrumpible: agarrarlo mientras entra o se cierra lo detiene y lo
 *   sigue desde el valor en pantalla.
 * - Scrim ligado al desplazamiento; Escape, foco atrapado y restaurado.
 * - Reduced motion: fundido en vez de desplazamiento; el arrastre sigue
 *   siendo 1:1 (es manipulacion directa) y el snap es instantaneo.
 */
export function Sheet(props: SheetProps) {
  const isClient = useIsClient();
  if (!isClient) return null;
  return createPortal(
    <AnimatePresence>
      {props.open ? <SheetPanel key="sheet" {...props} /> : null}
    </AnimatePresence>,
    document.body,
  );
}

type DragState = {
  pointerId: number;
  startClientY: number;
  startY: number;
  fromHeader: boolean;
  inScroller: boolean;
  active: boolean;
  tracker: VelocityTracker;
  /** Quita los listeners de window del gesto. */
  cleanup: () => void;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  "select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function SheetPanel({
  onClose,
  title,
  closeLabel,
  children,
  className,
  mobileFullscreen = false,
  restoreFocusOnClose,
  initialFocus,
}: Omit<SheetProps, "open">) {
  const [isPresent, safeToRemove] = usePresence();
  const reduced = useReducedMotionPref();
  const coarseAndNarrow = useMediaQuery(MOBILE_FULLSCREEN_QUERY);
  const fullscreen = mobileFullscreen && coarseAndNarrow;
  const isMobile = useIsMobile();
  /* Bottom sheet (movil, no fullscreen): el material se prolonga bajo el borde. */
  const extended = isMobile && !fullscreen;

  const panelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  /*
   * Desplazamiento vertical (px) y opacidad (solo reduced motion). El
   * valor inicial ya esta fuera de pantalla (o invisible): asi el primer
   * render nunca muestra el panel abierto antes de que arranque la
   * entrada; el layout effect afina la distancia real.
   */
  const y = useMotionValue(reduced ? 0 : window.innerHeight);
  const opacity = useMotionValue(reduced ? 0 : 1);
  /* Recorrido hasta salir de pantalla; se mide al montar y al redimensionar. */
  const distanceRef = useRef(1);
  const scrimOpacity = useTransform(
    [y, opacity],
    ([offset, alpha]: number[]) =>
      alpha * clamp01(1 - offset / Math.max(1, distanceRef.current)),
  );

  const animationRef = useRef<AnimationPlaybackControls | null>(null);
  /* Cada cierre lleva un token: interrumpirlo invalida su callback. */
  const closeTokenRef = useRef(0);
  /* `onClose` ya se llamo por un gesto/cierre propio: no hay salida pendiente. */
  const dismissedRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const measure = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const top = rect.top - y.get();
    distanceRef.current = Math.max(1, window.innerHeight - top);
  }, [y]);

  /* Registro en la pila de hojas (ver `sheetStack`). */
  const entryRef = useRef<SheetEntry>({ closing: false });
  useEffect(() => {
    const entry = entryRef.current;
    sheetStack.push(entry);
    return () => {
      const index = sheetStack.indexOf(entry);
      if (index !== -1) sheetStack.splice(index, 1);
    };
  }, []);

  const stopAnimation = useCallback(() => {
    animationRef.current?.stop();
    animationRef.current = null;
    closeTokenRef.current += 1;
    // Interrumpir (agarrar, volver a abrir) cancela cualquier cierre en curso.
    entryRef.current.closing = false;
  }, []);

  /* ---------------------------------------------------------------- *
   * Entrada / salida
   * ---------------------------------------------------------------- */

  const restoreFocusRef = useRef(restoreFocusOnClose);
  useEffect(() => {
    restoreFocusRef.current = restoreFocusOnClose;
  });
  const previousFocusRef = useRef<Element | null>(null);
  const focusRestoredRef = useRef(false);
  /** Devuelve el foco a quien abrio la hoja (una sola vez por cierre). Lo decide la accion que cierra la hoja. */
  const restoreFocus = useCallback(() => {
    if (focusRestoredRef.current) return;
    focusRestoredRef.current = true;
    // Se lee al CERRAR (no al montar): lo decide la accion que cierra la hoja.
    if (restoreFocusRef.current && !restoreFocusRef.current()) return;
    const previouslyFocused = previousFocusRef.current;
    if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
      previouslyFocused.focus({ preventScroll: true });
    }
  }, []);
  const mountedRef = useRef(false);
  // Entrada (y re-entrada si el padre vuelve a abrir mientras salia).
  // Layout effect: el primer frame ya debe estar fuera de pantalla.
  useLayoutEffect(() => {
    if (!isPresent) return;
    measure();
    dismissedRef.current = false;
    stopAnimation();
    if (!mountedRef.current) {
      mountedRef.current = true;
      if (reduced) {
        opacity.set(0);
        animationRef.current = animate(opacity, 1, crossFadeTransition);
        return;
      }
      y.set(distanceRef.current);
    }
    if (reduced) {
      y.set(0);
      animationRef.current = animate(opacity, 1, crossFadeTransition);
    } else {
      animationRef.current = animate(y, 0, springs.gentle);
    }
    // `reduced`, `measure` y `stopAnimation` son estables para el ciclo de
    // vida que nos interesa: solo reaccionamos a cambios de presencia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  // Salida cuando el padre cierra (`open=false`). Va en un efecto pasivo
  // a proposito: AnimatePresence registra la clave saliente en SU layout
  // effect (que corre despues del nuestro), y un `safeToRemove` anterior
  // a ese registro se ignora.
  useEffect(() => {
    if (isPresent) return;
    // El foco vuelve a quien abrio la hoja AHORA, con el panel todavia en el DOM: si se hiciera al desmontar (limpieza
    // del efecto de foco), React quitaria el panel con el foco dentro y el foco pasaria por <body> hasta que corriera
    // esa limpieza (otra tarea: con CPU lenta se veia un fotograma; un lector de pantalla lo anuncia).
    restoreFocus();
    // Si ya salimos por un gesto/cierre propio, solo hay que desmontar;
    // si no, salida por el mismo camino de la entrada.
    if (dismissedRef.current) {
      safeToRemove?.();
      return;
    }
    stopAnimation();
    entryRef.current.closing = true;
    // Mientras anima la salida la hoja sigue en el DOM con `aria-modal`: se marca para que los atajos globales
    // (Ctrl/Cmd+S, Ctrl/Cmd+K…) no la cuenten como modal abierta (Wave 8 · backlog b).
    panelRef.current?.setAttribute("data-sheet-closing", "");
    const token = closeTokenRef.current;
    const done = () => {
      if (closeTokenRef.current === token) safeToRemove?.();
    };
    animationRef.current = reduced
      ? animate(opacity, 0, { ...crossFadeTransition, onComplete: done })
      : animate(y, distanceRef.current, { ...springs.gentle, onComplete: done });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPresent]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(onResize) : null;
    observer?.observe(panel);
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [measure]);

  useEffect(() => () => stopAnimation(), [stopAnimation]);

  /**
   * Cierre iniciado desde el propio sheet (asa, scrim, X, Escape, gesto):
   * anima la salida y, al terminar, avisa al padre con `onClose`.
   */
  const requestClose = useCallback(
    (velocity = 0) => {
      if (!isPresent || dismissedRef.current) return;
      stopAnimation();
      entryRef.current.closing = true;
      panelRef.current?.setAttribute("data-sheet-closing", "");
      const token = closeTokenRef.current;
      const finish = () => {
        if (closeTokenRef.current !== token) return;
        dismissedRef.current = true;
        onCloseRef.current();
      };
      if (reduced) {
        animationRef.current = animate(opacity, 0, {
          ...crossFadeTransition,
          onComplete: finish,
        });
        return;
      }
      const decision = resolveSheetRelease({
        offset: y.get(),
        velocity,
        distance: distanceRef.current,
      });
      animationRef.current = animate(y, distanceRef.current, {
        ...decision.transition,
        onComplete: finish,
      });
    },
    [isPresent, opacity, reduced, stopAnimation, y],
  );

  /* ---------------------------------------------------------------- *
   * Teclado, scroll del fondo y foco
   * ---------------------------------------------------------------- */

  useEffect(() => {
    if (!isPresent) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || handledEscapes.has(event)) return;
      // Solo la hoja superior (no cerrandose) atiende Escape.
      if (topOpenSheet() !== entryRef.current) return;
      handledEscapes.add(event);
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isPresent, requestClose]);

  useEffect(() => {
    if (scrollLocks === 0) savedBodyOverflow = document.body.style.overflow;
    scrollLocks += 1;
    document.body.style.overflow = "hidden";
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = savedBodyOverflow;
    };
  }, []);

  // Si el padre vuelve a abrir mientras salia, el foco vuelve a la hoja.
  useEffect(() => {
    if (isPresent && focusRestoredRef.current) {
      focusRestoredRef.current = false;
      panelRef.current?.focus({ preventScroll: true });
    }
  }, [isPresent]);
  useEffect(() => {
    previousFocusRef.current = document.activeElement;
    const panel = panelRef.current;
    const target = initialFocus ? panel?.querySelector<HTMLElement>(initialFocus) : null;
    (target ?? panel)?.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement && target.type === "text") target.select();
    // Respaldo: si la hoja se desmonta sin pasar por la salida (el padre la quita de golpe), se devuelve aqui.
    return () => restoreFocus();
    // Solo al abrir: el foco inicial se decide una vez (`initialFocus` no cambia durante la vida de la hoja).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /* ---------------------------------------------------------------- *
   * Arrastre
   *
   * Los movimientos se escuchan en `window` desde el pointerdown: asi el
   * gesto no se pierde si el primer movimiento (antes de la histeresis)
   * saca el puntero del panel, como al agarrarlo por el borde mientras
   * se cierra. La captura del puntero se toma solo cuando el arrastre se
   * activa, para que un toque sin movimiento siga siendo un click normal
   * en los botones de dentro.
   * ---------------------------------------------------------------- */

  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setScrollable(scroller.scrollHeight > scroller.clientHeight + 1);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => dragRef.current?.cleanup(), []);

  // Mientras el panel esta desplazado (cerrandose o arrastrado) el
  // contenido no debe ceder el gesto al navegador: si se agarra por el
  // contenido con desborde, `pan-y` provocaria un pointercancel. Se escribe
  // imperativamente en cada cambio de `y` (sin re-render).
  useEffect(() => {
    const apply = (offset: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      scroller.style.touchAction = offset > 0.5 || !scrollable ? "none" : "pan-y";
    };
    apply(y.get());
    return y.on("change", apply);
  }, [y, scrollable]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!isPresent || dragRef.current) return;
    const panel = event.currentTarget;
    // Una hoja hija (Plantillas dentro de Opciones) va en un portal, pero sus
    // eventos React burbujean hasta aqui: sin esto, arrastrar la hoja superior
    // arrastraba tambien a la de debajo y un arrastre largo cerraba las dos.
    if (!panel.contains(event.target as Node)) return;
    const target = event.target as Node;
    // Zonas que gestionan su propio gesto (el lienzo de firma): un trazo con
    // excursion vertical no debe arrastrar la hoja ni cerrarla al soltar.
    if (event.target instanceof Element && event.target.closest("[data-sheet-no-drag]")) {
      return;
    }
    const fromHeader = headerRef.current?.contains(target) ?? false;
    const inScroller = scrollerRef.current?.contains(target) ?? false;
    // Con raton, el contenido se selecciona y se hace scroll: solo se
    // arrastra desde el asa/cabecera. Con dedo o lapiz, desde todo.
    if (event.pointerType === "mouse" && !fromHeader) return;
    // Interrumpe lo que este animando y sigue desde el valor en pantalla.
    stopAnimation();
    const tracker = createVelocityTracker();
    tracker.push(y.get(), event.timeStamp);

    const onMove = (move: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== move.pointerId) return;
      const delta = move.clientY - drag.startClientY;

      if (!drag.active) {
        if (Math.abs(delta) < DRAG_HYSTERESIS) return;
        const scroller = scrollerRef.current;
        const contentScrolls = scroller
          ? scroller.scrollHeight > scroller.clientHeight + 1
          : false;
        const scrolled = scroller ? scroller.scrollTop > 0 : false;
        const canDrag =
          drag.fromHeader ||
          !drag.inScroller ||
          !contentScrolls ||
          drag.startY > 0 ||
          (delta > 0 && !scrolled);
        if (!canDrag) {
          drag.cleanup();
          dragRef.current = null;
          return;
        }
        drag.active = true;
        // Re-basa el origen para que el primer frame no salte los 8 px de
        // histeresis: el panel arranca exactamente bajo el dedo.
        drag.startClientY = move.clientY;
        panel.setPointerCapture(move.pointerId);
      }

      const raw = drag.startY + (move.clientY - drag.startClientY);
      const panelHeight = panel.offsetHeight || distanceRef.current;
      const next = raw < 0 ? rubberband(raw, panelHeight) : raw;
      y.set(next);
      drag.tracker.push(next, move.timeStamp);
    };

    const onEnd = (end: PointerEvent, cancelled: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== end.pointerId) return;
      drag.cleanup();
      dragRef.current = null;
      if (!drag.active) {
        // Un toque sin arrastre interrumpio lo que estuviera animando
        // (entrada o cierre): el panel vuelve a su sitio desde donde esta.
        if (y.get() !== 0 && !animationRef.current) {
          animationRef.current = animate(
            y,
            0,
            reduced ? { type: false } : springs.default,
          );
        }
        return;
      }
      if (panel.hasPointerCapture(end.pointerId)) {
        panel.releasePointerCapture(end.pointerId);
      }
      if (cancelled) {
        // El navegador reclamo el gesto (scroll): no hay intencion de
        // cerrar que decidir por posicion. El panel vuelve a su sitio.
        stopAnimation();
        animationRef.current = animate(
          y,
          0,
          reduced ? { type: false } : springs.default,
        );
        return;
      }
      const velocity = drag.tracker.velocity(end.timeStamp);
      const decision = resolveSheetRelease({
        offset: y.get(),
        velocity,
        distance: distanceRef.current,
        reduced,
      });
      if (decision.action === "dismiss") {
        requestClose(velocity);
        return;
      }
      stopAnimation();
      if (reduced) {
        y.set(0);
        return;
      }
      animationRef.current = animate(y, 0, decision.transition);
    };

    const onUp = (end: PointerEvent) => onEnd(end, false);
    const onCancel = (end: PointerEvent) => onEnd(end, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    dragRef.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startY: y.get(),
      fromHeader,
      inScroller,
      active: false,
      tracker,
      cleanup: () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
      },
    };
  };

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex justify-center",
        fullscreen ? "items-stretch" : "items-end md:items-center",
      )}
    >
      <motion.div
        aria-hidden="true"
        data-sheet-scrim=""
        onClick={() => requestClose()}
        style={{ opacity: scrimOpacity }}
        className="absolute inset-0 bg-[var(--color-scrim)]"
      />
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ y, opacity }}
        onKeyDown={trapFocus}
        onPointerDown={onPointerDown}
        className={cn(
          "relative flex w-full flex-col outline-none will-change-transform [touch-action:none]",
          fullscreen
            ? "h-full"
            : "max-h-[88vh] rounded-t-ios-lg shadow-elevation-3 md:max-w-lg md:rounded-ios-lg",
          className,
        )}
      >
        <div
          className={cn(
            "material-thick flex min-h-0 flex-1 flex-col forced-colors:border-[CanvasText]",
            fullscreen ? "rounded-none border-0" : "rounded-[inherit]",
          )}
          /* Inline a proposito: `border-b-0` va antes que `material-thick` en
             la cascada y el shorthand `border` del material lo pisaria. */
          style={extended ? { borderBottomWidth: 0 } : undefined}
        >
          <div
            ref={headerRef}
            className="flex shrink-0 cursor-grab flex-col select-none active:cursor-grabbing"
            style={{
              paddingTop: fullscreen
                ? "calc(0.5rem + env(safe-area-inset-top, 0px))"
                : undefined,
            }}
          >
            {fullscreen ? null : (
              <div className="flex items-center justify-center pt-2 pb-1 md:hidden">
                <span
                  aria-hidden="true"
                  className="h-[5px] w-9 rounded-full bg-foreground/25 forced-colors:bg-[CanvasText]"
                />
              </div>
            )}
            <div className="flex items-center justify-between gap-3 pr-2.5 pb-1 pl-5 md:pt-2">
              {title ? (
                <h2 className="min-w-0 truncate text-headline text-foreground">
                  {title}
                </h2>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => requestClose()}
                aria-label={closeLabel}
                /* Sin `outline-none`: en Tailwind v4 fija --tw-outline-style en `none` y el
                   `focus-visible:outline-2` hereda ese `none` (anillo invisible, W1-C). */
                className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
              >
                <span
                  aria-hidden="true"
                  className="flex size-[30px] items-center justify-center rounded-full bg-white/10 text-muted-foreground forced-colors:border forced-colors:border-[ButtonText] transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-hover:bg-white/15 group-hover:text-foreground group-active:scale-90 group-active:duration-[80ms]"
                >
                  <X className="size-4" strokeWidth={2.5} />
                </span>
              </button>
            </div>
          </div>
          <div
            ref={scrollerRef}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5"
            /* Si el contenido cabe, el dedo arrastra el sheet desde cualquier
               punto (touch-action none: el navegador no reclama el gesto).
               Si desborda, el contenido hace scroll nativo (pan-y) y el
               sheet se arrastra desde el asa/cabecera. */
            style={{
              paddingBottom: "calc(1.5rem + env(safe-area-inset-bottom, 0px))",
            }}
          >
            {/* Una region fuera del dialogo no llega a un lector de pantalla con `aria-modal`: aqui dentro cada
                mensaje vive en su propia region (sin el sumidero de PDF Pro). */}
            <LiveSinkProvider value={null}>{children}</LiveSinkProvider>
          </div>
        </div>
        {extended ? (
          /* Extension del material bajo el borde: al tirar hacia arriba
             (rubber-band) no se ve el scrim por debajo del panel. */
          <div
            aria-hidden="true"
            className="material-thick absolute inset-x-0 top-full h-24 shadow-none"
            style={{ borderTopWidth: 0 }}
          />
        ) : null}
      </motion.div>
    </div>
  );
}
