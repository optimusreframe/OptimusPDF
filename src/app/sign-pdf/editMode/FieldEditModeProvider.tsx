"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useEditModeStrings } from "@/app/sign-pdf/editMode/editModeStrings";
import { readOpenOnEnterPref, writeOpenOnEnterPref } from "@/app/sign-pdf/editMode/editModePrefs";

/*
 * Modo «Editar campos» a pantalla completa (W3-B1): estado y "cascaron" modal.
 *
 * El proveedor vive POR ENCIMA del lienzo (en `SignToolClient` y en `SignEmbedded`): el lienzo se remonta al cambiar de
 * documento, y el modo no debe cerrarse ni perder el foco por eso. El proveedor es dueno de:
 *  - si el modo esta abierto (`active`) y del nodo `container` donde el lienzo pinta su pantalla completa (portal en
 *    `<body>`, `position: fixed`, `100dvh`);
 *  - el comportamiento modal: el resto de la pagina queda `inert` y sin scroll, el foco se queda dentro (Tab da la vuelta) y
 *    al salir vuelve al boton que abrio el modo;
 *  - la preferencia «abrir asi siempre» (solo con puntero tactil).
 * Nada de esto toca el historial del navegador: «Atras» sigue siendo el de siempre (la guarda de salida de Firmar).
 *
 * Lo que se EDITA no vive aqui: el modo usa el MISMO `DocumentCanvas` y la misma sesion; cerrar el modo no pierde nada
 * (el autoguardado de borradores no se entera de que el modo existe).
 */

export type FieldEditHost = {
  active: boolean;
  /** Nodo donde el lienzo pinta el modo, o `null` mientras el modo esta cerrado (o aun no se monto). */
  container: HTMLElement | null;
  open: (opener?: Element | null) => void;
  close: () => void;
  /** «Abrir asi siempre» (solo con puntero tactil). */
  openOnEnter: boolean;
  setOpenOnEnter: (on: boolean) => void;
  /** El lienzo avisa de que se muestra: abre el modo solo si la persona lo pidio y el puntero es tactil. Una vez por sesion. */
  offerAutoOpen: () => void;
  /** Alta y baja de un lienzo montado: si el modo esta abierto y ya no queda ninguno, se cierra solo. */
  registerCanvas: () => () => void;
};

const FieldEditContext = createContext<FieldEditHost | null>(null);

/** `null` fuera de un proveedor (Rellenar, editor de plantillas, pruebas sueltas): el lienzo no ofrece el modo. */
export function useFieldEditMode(): FieldEditHost | null {
  return useContext(FieldEditContext);
}

/* ------------------------------------------------------------------ *
 * Fondo inerte y scroll bloqueado
 * ------------------------------------------------------------------ */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Marca `inert` a todo lo que cuelga de `<body>` salvo `except` y devuelve como deshacerlo (sin destapar lo que ya era inerte). */
function makeBackgroundInert(except: Element): () => void {
  const marked: Element[] = [];
  for (const element of Array.from(document.body.children)) {
    if (element === except || element.tagName === "SCRIPT" || element.tagName === "STYLE") continue;
    if (element.hasAttribute("inert")) continue;
    element.setAttribute("inert", "");
    marked.push(element);
  }
  return () => {
    for (const element of marked) element.removeAttribute("inert");
  };
}

export function FieldEditModeProvider({ children }: { children: ReactNode }) {
  const strings = useEditModeStrings();
  const [active, setActive] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [openOnEnter, setOpenOnEnterState] = useState<boolean>(() =>
    typeof window === "undefined" ? false : readOpenOnEnterPref(),
  );

  const activeRef = useRef(false);
  const openerRef = useRef<Element | null>(null);
  const autoOfferedRef = useRef(false);
  const openOnEnterRef = useRef(openOnEnter);
  const canvasCountRef = useRef(0);

  useEffect(() => {
    activeRef.current = active;
    openOnEnterRef.current = openOnEnter;
  });

  const open = useCallback((opener?: Element | null) => {
    if (activeRef.current) return;
    openerRef.current = opener ?? (document.activeElement instanceof Element ? document.activeElement : null);
    activeRef.current = true;
    setActive(true);
  }, []);

  const close = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    setActive(false);
  }, []);

  const setOpenOnEnter = useCallback((on: boolean) => {
    openOnEnterRef.current = on;
    setOpenOnEnterState(on);
    writeOpenOnEnterPref(on);
  }, []);

  const offerAutoOpen = useCallback(() => {
    if (autoOfferedRef.current || activeRef.current || !openOnEnterRef.current) return;
    autoOfferedRef.current = true;
    if (typeof window.matchMedia !== "function" || !window.matchMedia("(pointer: coarse)").matches) return;
    openerRef.current = null;
    activeRef.current = true;
    setActive(true);
  }, []);

  const registerCanvas = useCallback(() => {
    canvasCountRef.current += 1;
    return () => {
      canvasCountRef.current -= 1;
      // Un cambio de documento desmonta un lienzo y monta otro en el mismo instante: se espera un momento antes de dar el
      // modo por huerfano (sin lienzo detras la pantalla completa taparia la aplicacion sin nada que hacer).
      window.setTimeout(() => {
        if (activeRef.current && canvasCountRef.current <= 0) {
          activeRef.current = false;
          setActive(false);
        }
      }, 120);
    };
  }, []);

  /* Mientras esta abierto: fondo inerte, sin scroll, foco dentro y, al salir, de vuelta al boton de entrada. */
  useEffect(() => {
    if (!active || !container) return;
    const releaseInert = makeBackgroundInert(container);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.setAttribute("data-field-edit", "");

    const focusFirst = window.requestAnimationFrame(() => {
      if (container.contains(document.activeElement)) return;
      const done = container.querySelector<HTMLElement>("[data-edit-done]");
      (done ?? container).focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      // Dentro de una hoja o de la barra de sugerencias (fuera del contenedor) manda su propio manejo del foco.
      const origin = event.target instanceof Node ? event.target : null;
      if (origin && !container.contains(origin)) return;
      const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getAttribute("aria-hidden") !== "true" && element.offsetParent !== null,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === container)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };
    container.addEventListener("keydown", onKeyDown);

    return () => {
      window.cancelAnimationFrame(focusFirst);
      container.removeEventListener("keydown", onKeyDown);
      releaseInert();
      document.body.style.overflow = previousOverflow;
      document.documentElement.removeAttribute("data-field-edit");
      // El boton de entrada se desmonto y se volvio a montar (la pagina mostraba un marcador): se busca el nuevo.
      const opener = openerRef.current;
      window.requestAnimationFrame(() => {
        const target =
          opener instanceof HTMLElement && opener.isConnected
            ? opener
            : document.querySelector<HTMLElement>("[data-edit-entry]");
        target?.focus({ preventScroll: true });
      });
    };
  }, [active, container]);

  const host = useMemo<FieldEditHost>(
    () => ({
      active,
      container: active ? container : null,
      open,
      close,
      openOnEnter,
      setOpenOnEnter,
      offerAutoOpen,
      registerCanvas,
    }),
    [active, container, open, close, openOnEnter, setOpenOnEnter, offerAutoOpen, registerCanvas],
  );

  return (
    <FieldEditContext.Provider value={host}>
      {children}
      {active && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={setContainer}
              role="dialog"
              aria-modal="true"
              aria-label={strings.frameLabel}
              tabIndex={-1}
              data-field-edit-mode=""
              className="fixed inset-0 z-[45] h-dvh touch-manipulation overflow-hidden bg-background text-foreground outline-none"
            />,
            document.body,
          )
        : null}
    </FieldEditContext.Provider>
  );
}
