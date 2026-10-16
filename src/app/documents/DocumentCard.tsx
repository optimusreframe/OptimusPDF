"use client";

import { Check, MoreHorizontal } from "lucide-react";
import { DocThumb } from "@/app/documents/DocThumb";
import { isTemplateStale } from "@/app/documents/documentsModel";
import { TemplateBadge } from "@/app/documents/TemplateBadge";
import { Button } from "@/components/ui/Button";
import { HIT_44 } from "@/components/ui/touchTarget";
import { cn } from "@/lib/cn";
import type { TemplateStatus } from "@/lib/docLibrary/templatesStore";
import type { DocumentEntry } from "@/lib/docLibrary/types";
import { useT } from "@/lib/i18n";

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export type DocumentCardProps = {
  doc: DocumentEntry;
  status: TemplateStatus | undefined;
  onSign: () => void;
  onConfigure: () => void;
  /** «Esta plantilla sigue valiendo» (solo se ofrece con la plantilla desactualizada). */
  onKeepTemplate?: () => void;
  /** Con `onToggle` la tarjeta lleva casilla de seleccion. */
  selected?: boolean;
  selectDisabled?: boolean;
  onToggle?: () => void;
  /** Con `onMore` la tarjeta lleva el boton del menu (renombrar, reemplazar, borrar). */
  onMore?: () => void;
  moreRef?: (element: HTMLButtonElement | null) => void;
};

/** Tarjeta de un documento de la biblioteca: la usan la pagina completa y la seccion compacta de Inicio. */
export function DocumentCard({ doc, status, onSign, onConfigure, onKeepTemplate, selected, selectDisabled, onToggle, onMore, moreRef }: DocumentCardProps) {
  const t = useT();
  const pages = doc.pageCount === 1 ? t.documents.pagesOne : fill(t.documents.pagesMany, { n: String(doc.pageCount) });
  const meta = [doc.docType, pages].filter(Boolean).join(" · ");
  // Se reemplazo el PDF y ya no coincide con la plantilla: ni ✓ ni «lista»; se avisa y se ofrece reconfigurar o confirmar.
  const stale = isTemplateStale(doc, status);
  return (
    <li data-document-id={doc.id} data-selected={selected ? "true" : undefined}>
      <div
        className={cn(
          "surface-card flex flex-col gap-3 rounded-ios p-3 md:p-4",
          selected && "border-signal/60",
        )}
      >
        <div className="flex items-start gap-3">
          {onToggle ? (
            <label className="relative -ml-1 flex size-11 shrink-0 cursor-pointer items-center justify-center">
              <input
                type="checkbox"
                checked={selected === true}
                disabled={selectDisabled}
                onChange={onToggle}
                aria-label={fill(t.documents.select, { name: doc.name })}
                className={cn(
                  "peer size-[22px] cursor-pointer appearance-none rounded-[7px] border border-hairline-strong bg-white/5",
                  "transition-[background-color,border-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                  "checked:border-signal checked:bg-signal active:scale-90 active:duration-[80ms]",
                  "forced-colors:border-[ButtonText] forced-colors:checked:border-[Highlight] forced-colors:checked:bg-[Highlight]",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                )}
              />
              <Check
                aria-hidden="true"
                strokeWidth={3}
                className="pointer-events-none absolute size-3.5 scale-50 text-[var(--color-on-signal)] opacity-0 transition-[scale,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)] peer-checked:scale-100 peer-checked:opacity-100 forced-colors:text-[HighlightText]"
              />
            </label>
          ) : null}
          <DocThumb doc={doc} />
          <div className="min-w-0 flex-1">
            <h3 className="text-subheadline font-semibold text-foreground [overflow-wrap:anywhere]" data-document-name="">
              {doc.name}
            </h3>
            <p className="mt-0.5 text-caption text-muted-foreground [overflow-wrap:anywhere]">{meta}</p>
            <TemplateBadge status={status} stale={stale} className="mt-1.5" />
            {stale ? (
              <p className="mt-1 text-footnote text-muted-foreground [overflow-wrap:anywhere]" data-template-stale-hint="">
                {t.documents.staleHint}
              </p>
            ) : null}
          </div>
          {onMore ? (
            <button
              ref={moreRef}
              type="button"
              aria-label={fill(t.documents.moreActions, { name: doc.name })}
              aria-haspopup="dialog"
              onClick={onMore}
              className={cn(
                HIT_44,
                "-mt-1.5 -mr-1.5 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
              )}
            >
              <MoreHorizontal aria-hidden="true" className="size-5" />
            </button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="md" wrap aria-label={fill(t.documents.signNamed, { name: doc.name })} onClick={onSign}>
            {t.documents.sign}
          </Button>
          <Button
            size="md"
            variant="secondary"
            wrap
            aria-label={fill(stale ? t.documents.reconfigureNamed : t.documents.configureNamed, { name: doc.name })}
            onClick={onConfigure}
          >
            {stale ? t.documents.reconfigure : t.documents.configure}
          </Button>
          {stale && onKeepTemplate ? (
            <Button
              size="md"
              variant="ghost"
              wrap
              aria-label={fill(t.documents.keepTemplateNamed, { name: doc.name })}
              onClick={onKeepTemplate}
              data-keep-template=""
            >
              {t.documents.keepTemplate}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
