"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { PRO_TAB_ICONS, PRO_TAB_IDS, type ProTabId } from "@/app/pdf-pro/ProTabs";
import type { Language } from "@/lib/i18n";

export type ProMobileDockProps = {
  language: Language;
  /** Pestaña cuyo panel esta abierto (la hoja), o `null` si esta cerrada. */
  openTab: ProTabId | null;
  onSelect: (tab: ProTabId) => void;
  /** (W7-U6) Pestaña cuyo modo (Editar, Anotar...) ocupa ahora la region central, o `null`. */
  modeTab?: ProTabId | null;
  /** (W7-U6) Pestañas que abren un modo en la region central (no una hoja): sin `aria-haspopup`. */
  modeTabs?: readonly ProTabId[];
  /**
   * Raíl lateral (movil horizontal, sin alto para una barra inferior): los botones van en columna y la barra se
   * pega al borde izquierdo respetando la isla/notch (`safe-area-inset-left`).
   */
  rail?: boolean;
};

/**
 * Barra inferior tactil de movil: las siete herramientas como botones de >= 44 px (icono + texto) que abren su
 * panel en una hoja (`aria-haspopup="dialog"`). En escritorio el mismo reparto son las pestañas de arriba.
 * Flechas / Inicio / Fin mueven el foco entre botones (un solo tabulador, roving tabindex).
 */
export function ProMobileDock({ language, openTab, onSelect, modeTab = null, modeTabs = [], rail = false }: ProMobileDockProps) {
  const shell = getProStrings(language).shell;
  const tabs = getProStrings(language).suite.tabs;
  const listRef = useRef<HTMLDivElement>(null);
  const [focusTab, setFocusTab] = useState<ProTabId>(openTab ?? "home");

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = PRO_TAB_IDS.indexOf(focusTab);
    let next = at;
    const forward = rail ? "ArrowDown" : "ArrowRight";
    const backward = rail ? "ArrowUp" : "ArrowLeft";
    if (event.key === forward) next = (at + 1) % PRO_TAB_IDS.length;
    else if (event.key === backward) next = (at - 1 + PRO_TAB_IDS.length) % PRO_TAB_IDS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PRO_TAB_IDS.length - 1;
    else return;
    event.preventDefault();
    setFocusTab(PRO_TAB_IDS[next]);
    listRef.current?.querySelector<HTMLElement>(`[data-dock="${PRO_TAB_IDS[next]}"]`)?.focus();
  };

  return (
    <div
      ref={listRef}
      role="toolbar"
      aria-label={shell.dockLabel}
      aria-orientation={rail ? "vertical" : undefined}
      data-pro-region="tabs"
      data-pro-dock=""
      data-rail={rail ? "" : undefined}
      onKeyDown={onKeyDown}
      className={cn(
        "scrollbar-none flex shrink-0 bg-background",
        rail
          ? "w-[calc(3.5rem+env(safe-area-inset-left,0px))] flex-col items-stretch overflow-y-auto overscroll-contain border-r border-hairline pl-[env(safe-area-inset-left,0px)]"
          : "snap-x items-stretch overflow-x-auto overscroll-x-contain border-t border-hairline px-1 pb-[env(safe-area-inset-bottom,0px)]",
      )}
    >
      {PRO_TAB_IDS.map((id) => {
        const Icon = PRO_TAB_ICONS[id];
        const isMode = modeTabs.includes(id);
        const active = openTab === id || (isMode && modeTab === id);
        return (
          <button
            key={id}
            type="button"
            data-dock={id}
            aria-haspopup={isMode ? undefined : "dialog"}
            aria-expanded={isMode ? undefined : active}
            aria-current={isMode && active ? "page" : undefined}
            tabIndex={id === focusTab ? 0 : -1}
            onFocus={() => setFocusTab(id)}
            onClick={() => onSelect(id)}
            className={cn(
              // (M5 · N3) Celda de 48 px como minimo (`basis-12`, sin encoger): el ancho minimo auto de un item flex es el de su
              // etiqueta, asi que «Convertir» o «Proteger» nunca se salen de su celda ni tocan a la vecina (la clase anterior,
              // `min-w-[max(3rem,min-content)]`, no era CSS valido y no hacia nada). Con 7 celdas la suma supera 312 px a 320 y el
              // dock se DESPLAZA (con ajuste a cada celda) en vez de apretarlas a 38-41 px; a 375/393 px caben las siete.
              rail
                ? "flex min-h-14 w-full shrink-0 flex-col items-center justify-center gap-0.5 px-0.5 text-caption-2 font-medium"
                : "flex min-h-14 flex-[1_0_3rem] snap-start flex-col items-center justify-center gap-0.5 px-1 text-caption-2 font-medium",
              "focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]",
              active ? "text-signal-text forced-colors:text-[Highlight]" : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
            <span className="whitespace-nowrap">{tabs[id]}</span>
          </button>
        );
      })}
    </div>
  );
}
