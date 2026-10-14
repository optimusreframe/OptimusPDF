"use client";

import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { FileText, Trash2 } from "lucide-react";
import { deleteEditDraft } from "@/app/edit-pdf/editDrafts";
import { deleteProDraft } from "@/app/pdf-pro/proDrafts";
import { useDraftThumbnails } from "@/app/pdf-pro/session/useDraftThumbnails";
import type { UnfinishedItem } from "@/app/recent/unfinishedWork";
import { deleteDraft, deleteSessionDraft } from "@/app/sign-pdf/signDrafts";
import { buttonClasses } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { HIT_44 } from "@/components/ui/touchTarget";
import { localeTag, useI18n } from "@/lib/i18n";
import { formatDateTime } from "@/lib/formatDate";

/** Miniaturas: solo de las primeras (leer cada borrador entero para dibujar un icono no compensa en una lista larga). */
const THUMBNAIL_LIMIT = 4;

/** Borra el borrador real de la herramienta (bytes y metadatos). Ninguna de estas funciones lanza. */
async function discardItem(item: UnfinishedItem): Promise<void> {
  switch (item.target.kind) {
    case "session":
      await deleteSessionDraft(item.target.id);
      return;
    case "sign":
      await deleteDraft(item.target.id);
      return;
    case "edit":
      await deleteEditDraft(item.target.id);
      return;
    case "pro":
      await deleteProDraft(item.target.id);
      return;
  }
}

/**
 * «Sin terminar»: los trabajos a medias que las herramientas guardaron como borrador en este navegador. Cada fila trae
 * «Continuar» (la herramienta restaura el trabajo desde `?resume=`) y «Descartar» (con confirmacion: borra el borrador).
 * Tras descartar, el foco pasa al primer control de la lista o, si ya no queda ninguna fila, a `fallbackFocus`.
 */
export function UnfinishedSection({
  items,
  refresh,
  onDiscarded,
  fallbackFocus,
}: {
  items: readonly UnfinishedItem[];
  refresh: () => Promise<void>;
  onDiscarded: () => void;
  fallbackFocus: RefObject<HTMLElement | null>;
}) {
  const { t, language } = useI18n();
  const baseId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const refocusRef = useRef(false);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const proDrafts = useMemo(
    () => items.flatMap((item) => (item.pro ? [item.pro] : [])).slice(0, THUMBNAIL_LIMIT),
    [items],
  );
  const thumbs = useDraftThumbnails(proDrafts);
  const toDiscard = items.find((item) => item.key === confirmKey) ?? null;

  useEffect(() => {
    if (!refocusRef.current) return;
    refocusRef.current = false;
    const target = listRef.current?.querySelector<HTMLElement>("a, button") ?? fallbackFocus.current;
    target?.focus({ preventScroll: true });
  }, [items, fallbackFocus]);

  if (items.length === 0 && !confirmKey) return null;

  const locale = localeTag(language);
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many.replace("{n}", String(n)));

  return (
    <section aria-labelledby={`${baseId}-title`} data-recent-unfinished="" className="mb-10">
      <h2 id={`${baseId}-title`} className="text-title-3 text-foreground">
        {t.recent.unfinishedTitle}
      </h2>
      <p className="mt-1 mb-3 text-subheadline text-muted-foreground">{t.recent.unfinishedHint}</p>
      <ul ref={listRef} className="space-y-2">
        {items.map((item) => {
          const infoId = `${baseId}-${item.key.replace(/[^a-z0-9-]/gi, "_")}`;
          const thumb = item.pro ? thumbs[item.pro.id] : null;
          const meta = [
            t.tools[item.slug].name,
            formatDateTime(item.savedAt, locale),
            item.documents !== undefined && item.documents > 1
              ? plural(item.documents, t.recent.documentsOne, t.recent.documentsMany)
              : null,
            item.changes !== undefined && item.changes > 0
              ? plural(item.changes, t.recent.changesOne, t.recent.changesMany)
              : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <li key={item.key} data-unfinished-key={item.key}>
              <div className="surface-card flex flex-wrap items-center gap-3 rounded-ios p-3">
                {thumb ? (
                  // Miniatura local (data URL de la primera pagina): no es una imagen remota que `next/image` optimice.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={thumb}
                    alt=""
                    aria-hidden="true"
                    data-unfinished-thumb=""
                    className="h-12 w-10 shrink-0 rounded-lg border border-hairline bg-white object-cover object-top"
                  />
                ) : (
                  <span className="flex h-12 w-10 shrink-0 items-center justify-center rounded-lg border border-hairline bg-white/5">
                    <FileText aria-hidden="true" className="size-4 text-signal-text" />
                  </span>
                )}
                <div id={infoId} className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-subheadline font-semibold text-foreground" title={item.fileName}>
                    {item.fileName}
                  </p>
                  <p className="text-caption text-muted-foreground">{meta}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Link
                    href={item.href}
                    prefetch={false}
                    aria-describedby={infoId}
                    className={buttonClasses("secondary", "md")}
                  >
                    {t.common.continueLabel}
                  </Link>
                  <button
                    type="button"
                    aria-label={t.recent.discard.replace("{name}", item.fileName)}
                    onClick={() => setConfirmKey(item.key)}
                    className={`${HIT_44} flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-destructive-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal`}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <ConfirmSheet
        open={toDiscard !== null}
        onClose={() => setConfirmKey(null)}
        onConfirm={() => {
          if (!toDiscard) return;
          refocusRef.current = true;
          void discardItem(toDiscard)
            .then(() => refresh())
            .then(onDiscarded);
        }}
        // La fila desaparece: el foco no vuelve a su boton (lo coloca el efecto de arriba).
        restoreFocusOnClose={() => !refocusRef.current}
        title={t.recent.discardTitle.replace("{name}", toDiscard?.fileName ?? "")}
        body={t.recent.discardBody}
        confirmLabel={t.recent.discardConfirm}
        cancelLabel={t.common.cancel}
        closeLabel={t.common.close}
      />
    </section>
  );
}
