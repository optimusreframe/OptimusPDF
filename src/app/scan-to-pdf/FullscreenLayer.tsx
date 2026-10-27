"use client";

import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { isFocusable } from "@/components/tool/useFocusTarget";
import { useIsClient } from "@/hooks/useIsClient";
import { cn } from "@/lib/cn";
import { LIVE_HOST_ATTR } from "@/app/scan-to-pdf/ScanLive";

/*
 * Mientras una capa a pantalla completa esta abierta, el resto de hijos de <body> (menos la propia capa y el contenedor de la
 * region viva; las capas de debajo quedan inert tambien) queda `inert`: sin foco, sin clics y fuera del arbol de accesibilidad. Se cuenta cuantas capas lo piden y
 * lo que ya era inert antes no se destapa nunca.
 */
const holds = new Map<Element, { count: number; wasInert: boolean }>();

function holdBackground(except: Element): () => void {
  const held: Element[] = [];
  for (const element of Array.from(document.body.children)) {
    if (element === except || element.hasAttribute(LIVE_HOST_ATTR)) continue;
    if (element.tagName === "SCRIPT" || element.tagName === "STYLE") continue;
    const hold = holds.get(element);
    if (hold) hold.count += 1;
    else {
      holds.set(element, { count: 1, wasInert: element.hasAttribute("inert") });
      element.setAttribute("inert", "");
    }
    held.push(element);
  }
  return () => {
    for (const element of held) {
      const hold = holds.get(element);
      if (!hold) continue;
      hold.count -= 1;
      if (hold.count > 0) continue;
      holds.delete(element);
      if (!hold.wasInert) element.removeAttribute("inert");
    }
  };
}

/*
 * Safari (y el tacto de iOS) NO da foco a un boton al pulsarlo: al abrir una capa `document.activeElement` es <body> y, al cerrarla,
 * no habria a donde devolver el foco. Se recuerda el ultimo control pulsado para devolverselo en ese caso.
 */
let lastPressed: { ref: WeakRef<HTMLElement>; at: number } | null = null;
let listening = false;
/** Un control pulsado hace menos de esto es el que abrio la capa (si no, se abrio con el teclado y vale el foco). */
const PRESS_FRESH_MS = 1500;

function listenForPresses(): void {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener(
    "pointerdown",
    (event) => {
      const control = (event.target as Element | null)?.closest?.<HTMLElement>("button, a[href], [role=button], input, select, textarea, [tabindex]");
      lastPressed = control ? { ref: new WeakRef(control), at: performance.now() } : null;
    },
    true,
  );
}

export type FullscreenLayerProps = {
  /** Nombre accesible del dialogo. */
  label: string;
  children: ReactNode;
  className?: string;
  /** Selector (dentro de la capa) del control que recibe el foco al abrirse. */
  initialFocus?: string;
  /** Escape. Sin el, Escape no hace nada. */
  onEscape?: () => void;
  /** Al cerrarse la capa devuelve el foco a lo que lo tenia al abrirse (por defecto, si). */
  restoreFocus?: boolean;
  /** Fondo de la capa. */
  tone?: "dark" | "surface";
  dataAttr?: string;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]):not([type="file"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Capa a pantalla completa (camara, editor de pagina, hoja completa): portal en <body>, fondo `inert` y foco gestionado.
 * Dialogo SIN `aria-modal` a proposito: el fondo ya esta inert y asi la region viva unica (fuera de la capa) se sigue oyendo.
 * Tab cicla dentro; Escape llama a `onEscape`.
 */
export function FullscreenLayer({ label, children, className, initialFocus, onEscape, restoreFocus = true, tone = "surface", dataAttr }: FullscreenLayerProps) {
  const isClient = useIsClient();
  const ref = useRef<HTMLDivElement>(null);
  const escapeRef = useRef(onEscape);
  useEffect(() => {
    escapeRef.current = onEscape;
  });

  // Efecto de LAYOUT: el fondo vuelve a ser accesible (y el foco se devuelve) en el mismo commit en que la capa sale, ANTES de que
  // el paso siguiente pida su foco; con un efecto pasivo el destino seguia `inert` un fotograma y el foco pasaba por <body>.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    listenForPresses();
    const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const pressed = lastPressed && performance.now() - lastPressed.at < PRESS_FRESH_MS ? (lastPressed.ref.deref() ?? null) : null;
    // Con raton o tacto manda el control pulsado (Safari no le da foco); con el teclado, el que tiene el foco.
    const opener = pressed ?? active;
    const release = holdBackground(root);
    const first = (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null) ?? Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find(isFocusable);
    (first ?? root).focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escapeRef.current && !event.defaultPrevented) {
        // Una capa encima (p. ej. el editor de esquinas) atiende su propio Escape: solo responde la ultima.
        const layers = document.querySelectorAll("[data-scan-layer]");
        if (layers[layers.length - 1] !== root) return;
        event.preventDefault();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const layers = document.querySelectorAll("[data-scan-layer]");
      if (layers[layers.length - 1] !== root) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isFocusable);
      if (items.length === 0) return;
      const active = document.activeElement;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (event.shiftKey && (active === firstItem || !root.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !root.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      release();
      if (restoreFocus && opener?.isConnected && isFocusable(opener)) opener.focus({ preventScroll: true });
    };
    // La capa se monta una vez; `initialFocus` y `restoreFocus` son constantes por uso.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClient]);

  if (!isClient) return null;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-scan-layer=""
      {...(dataAttr ? { [dataAttr]: "" } : {})}
      className={cn("fixed inset-0 z-50 flex flex-col outline-none", tone === "dark" ? "on-media bg-black text-white" : "bg-background text-foreground", className)}
    >
      {children}
    </div>,
    document.body,
  );
}
