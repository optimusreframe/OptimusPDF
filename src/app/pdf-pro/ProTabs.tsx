"use client";

import { useRef, type KeyboardEvent } from "react";
import { FileOutput, Highlighter, House, LayoutGrid, Lock, Signature, SquarePen, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import type { Language } from "@/lib/i18n";

export const PRO_TAB_IDS = ["home", "pages", "edit", "annotate", "sign", "protect", "convert"] as const;
export type ProTabId = (typeof PRO_TAB_IDS)[number];

export function proTabDomId(base: string, id: ProTabId): string {
  return `${base}-tab-${id}`;
}

export function proPanelDomId(base: string): string {
  return `${base}-panel`;
}

/** Icono de cada pestaña (la barra inferior de movil y la paleta de comandos). */
export const PRO_TAB_ICONS: Record<ProTabId, LucideIcon> = {
  home: House,
  pages: LayoutGrid,
  edit: SquarePen,
  annotate: Highlighter,
  sign: Signature,
  protect: Lock,
  convert: FileOutput,
};

/**
 * Pestañas de la suite (patron WAI-ARIA de pestañas con activacion automatica): flechas, Inicio y
 * Fin mueven el foco y la seleccion; un solo `tab` en el orden de tabulacion (roving tabindex).
 * Cada pestaña mide 44 px de alto.
 */
export function ProTabs({
  language,
  value,
  onChange,
  baseId,
  controlsPanel = true,
}: {
  language: Language;
  value: ProTabId;
  onChange: (tab: ProTabId) => void;
  baseId: string;
  /** El panel existe en el DOM: si esta plegado, `aria-controls` no puede apuntar a un id inexistente. */
  controlsPanel?: boolean;
}) {
  const s = getProStrings(language).suite;
  const listRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = PRO_TAB_IDS.indexOf(value);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % PRO_TAB_IDS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + PRO_TAB_IDS.length) % PRO_TAB_IDS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = PRO_TAB_IDS.length - 1;
    else return;
    event.preventDefault();
    const id = PRO_TAB_IDS[next];
    onChange(id);
    listRef.current?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      data-pro-region="tabs"
      aria-label={s.tabsLabel}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className="scrollbar-none flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-hairline px-2 md:px-3"
    >
      {PRO_TAB_IDS.map((id) => {
        const selected = id === value;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={proTabDomId(baseId, id)}
            data-tab={id}
            aria-selected={selected}
            aria-controls={controlsPanel ? proPanelDomId(baseId) : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            className={cn(
              "relative flex h-11 shrink-0 items-center px-3.5 text-subheadline font-medium whitespace-nowrap",
              "transition-colors duration-[var(--duration-fast)]",
              "focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal",
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s.tabs[id]}
            {selected ? (
              <span
                aria-hidden="true"
                className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-signal forced-colors:bg-[Highlight]"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
