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
};

/**
 * Barra inferior tactil de movil: las siete herramientas como botones de >= 44 px (icono + texto) que abren su
 * panel en una hoja (`aria-haspopup="dialog"`). En escritorio el mismo reparto son las pestañas de arriba.
 * Flechas / Inicio / Fin mueven el foco entre botones (un solo tabulador, roving tabindex).
 */
export function ProMobileDock({ language, openTab, onSelect, modeTab = null, modeTabs = [] }: ProMobileDockProps) {
  const shell = getProStrings(language).shell;
  const tabs = getProStrings(language).suite.tabs;
  const listRef = useRef<HTMLDivElement>(null);
  const [focusTab, setFocusTab] = useState<ProTabId>(openTab ?? "home");

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = PRO_TAB_IDS.indexOf(focusTab);
    let next = at;
    if (event.key === "ArrowRight") next = (at + 1) % PRO_TAB_IDS.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + PRO_TAB_IDS.length) % PRO_TAB_IDS.length;
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
      data-pro-region="tabs"
      data-pro-dock=""
      onKeyDown={onKeyDown}
      className="scrollbar-none flex shrink-0 items-stretch overflow-x-auto border-t border-hairline bg-background px-1 pb-[env(safe-area-inset-bottom,0px)]"
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
              "flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-caption-2 font-medium",
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
