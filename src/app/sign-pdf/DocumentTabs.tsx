"use client";

import type { Ref } from "react";
import { Check, CircleDashed } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DocId } from "@/app/sign-pdf/docSet";
import type { SignStrings } from "@/app/sign-pdf/strings";

/** Indicador por documento (p. ej. «Solo yo»: firma colocada / pendiente). Nunca solo color: icono y texto. */
export type DocumentBadge = { label: string; done: boolean };

export type DocumentTabsProps = {
  docs: readonly { id: DocId; name: string }[];
  activeId: DocId;
  onSelect: (id: DocId) => void;
  strings: SignStrings;
  /** Para que quien conduce el foco (Alt + Re Pag / Av Pag) lo lleve al documento activo. */
  navRef?: Ref<HTMLElement>;
  /** Indicador de cada documento; ausente = sin indicadores (la lista de siempre). */
  badges?: Readonly<Record<DocId, DocumentBadge | undefined>>;
  /**
   * La region viva de aqui NO anuncia: otra (la de la vista continua, que dice
   * tambien la pagina) se ocupa. Sigue en el DOM con el mismo texto.
   */
  quietLive?: boolean;
};

/**
 * Selector del documento ACTIVO de una ronda con varios. El orden de la cola
 * y quitar documentos lo da la lista de archivos del shell; esto solo elige
 * sobre cual se trabaja. El activo lleva `aria-current`; la region viva dice
 * «Documento 2 de 3: Contrato B» al cambiar (tambien con el teclado).
 * Objetivos de al menos 44 px.
 */
export function DocumentTabs({
  docs,
  activeId,
  onSelect,
  strings,
  navRef,
  badges,
  quietLive = false,
}: DocumentTabsProps) {
  const activeIndex = Math.max(
    0,
    docs.findIndex((doc) => doc.id === activeId),
  );
  const active = docs[activeIndex];

  return (
    <div className="space-y-2">
      <nav ref={navRef} aria-label={strings.documentsLabel}>
        <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 pointer-coarse:gap-2">
          {docs.map((doc, index) => {
            const current = doc.id === activeId;
            const badge = badges?.[doc.id];
            return (
              <li key={doc.id} className="shrink-0">
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => onSelect(doc.id)}
                  className={cn(
                    "min-h-11 max-w-[16rem] truncate rounded-ios-sm border px-3 text-footnote font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                    current
                      ? "border-signal/60 bg-signal/15 text-foreground"
                      : "border-white/10 bg-white/5 text-muted-foreground hover:border-white/25 hover:text-foreground",
                  )}
                >
                  {badge ? (
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 truncate">
                        {strings.documentTab(index + 1, doc.name)}
                      </span>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1 text-caption-2",
                          badge.done ? "text-success-text" : "text-muted-foreground",
                        )}
                      >
                        {badge.done ? (
                          <Check aria-hidden="true" className="size-3" />
                        ) : (
                          <CircleDashed aria-hidden="true" className="size-3" />
                        )}
                        {badge.label}
                      </span>
                    </span>
                  ) : (
                    strings.documentTab(index + 1, doc.name)
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <p className="hidden text-caption text-muted-foreground md:block">
        {strings.documentSwitchHint}
      </p>
      <p
        role="status"
        aria-live={quietLive ? "off" : "polite"}
        aria-atomic="true"
        className="sr-only"
      >
        {active
          ? strings.documentLive(activeIndex + 1, docs.length, active.name)
          : ""}
      </p>
    </div>
  );
}
