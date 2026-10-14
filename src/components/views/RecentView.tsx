"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Clock, FileText } from "lucide-react";
import { UnfinishedSection } from "@/app/recent/UnfinishedSection";
import { hiddenByUnfinished } from "@/app/recent/unfinishedWork";
import { useUnfinishedWork } from "@/app/recent/useUnfinishedWork";
import { Button, buttonClasses } from "@/components/ui/Button";
import { GlassCard } from "@/components/ui/GlassCard";
import { useRecentEntries } from "@/hooks/useRecentEntries";
import { formatDateTime } from "@/lib/formatDate";
import { useI18n, localeTag } from "@/lib/i18n";
import { clearRecentEntries } from "@/lib/recent";
import { TOOL_SLUGS, toolHref, type ToolSlug } from "@/lib/tools-registry";

function isKnownSlug(slug: string): slug is ToolSlug {
  return (TOOL_SLUGS as readonly string[]).includes(slug);
}

/**
 * Recientes (U0.6): arriba «Sin terminar» (los borradores reales de Firmar, Editar PDF y PDF Pro, con «Continuar» que
 * RESTAURA el trabajo y «Descartar»); debajo «Historial» (nombre, herramienta y fecha). Una entrada del historial no
 * tiene nada que restaurar: ofrece «Abrir herramienta», nunca «Continuar».
 */
export function RecentView() {
  const { t, language } = useI18n();
  const history = useRecentEntries();
  const unfinished = useUnfinishedWork();
  const [announcement, setAnnouncement] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  const locale = localeTag(language);
  // El historial espera a haber leido los borradores: antes no se sabe cuales de sus entradas ya salen en «Sin terminar»
  // (apareceria y desapareceria una fila) ni si hay algo que contar (no se anuncia «Aun no has procesado nada» a destiempo).
  const visibleHistory = useMemo(
    () => (unfinished.loaded ? hiddenByUnfinished(history, unfinished.items) : []),
    [history, unfinished.items, unfinished.loaded],
  );
  const showEmpty = unfinished.loaded && history.length === 0 && unfinished.items.length === 0;

  return (
    <div className="mx-auto max-w-[800px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header className="mb-8">
        <h1 ref={headingRef} tabIndex={-1} className="text-title-1 text-foreground outline-none">
          {t.recent.title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t.recent.subtitle}
        </p>
      </header>

      {/* Region viva siempre montada: anuncia «Trabajo descartado». */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <UnfinishedSection
        items={unfinished.items}
        refresh={unfinished.refresh}
        onDiscarded={() => setAnnouncement(t.recent.discarded)}
        fallbackFocus={headingRef}
      />

      {showEmpty ? (
        <GlassCard className="flex flex-col items-center px-6 py-14 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-white/6">
            <Clock aria-hidden="true" className="size-5 text-muted-foreground" />
          </span>
          <p className="mt-4 text-sm text-muted-foreground">{t.recent.empty}</p>
          <Link
            href="/"
            className={`${buttonClasses("secondary", "md")} mt-6`}
          >
            {t.recent.emptyCta}
          </Link>
        </GlassCard>
      ) : null}

      {visibleHistory.length > 0 ? (
        <section aria-labelledby="recent-history-title" data-recent-history="">
          <h2 id="recent-history-title" className="text-title-3 text-foreground">
            {t.recent.historyTitle}
          </h2>
          <p className="mt-1 mb-3 text-subheadline text-muted-foreground">{t.recent.historyHint}</p>
          <ul className="space-y-2">
            {visibleHistory.map((entry) => {
              const known = isKnownSlug(entry.slug);
              const name = known
                ? t.tools[entry.slug].name
                : entry.slug;
              return (
                <li key={entry.id}>
                  <div className="surface-card flex flex-wrap items-center gap-3 rounded-ios p-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                      <FileText
                        aria-hidden="true"
                        className="size-4 text-signal-text"
                      />
                    </span>
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="truncate text-sm font-medium text-foreground" title={entry.fileName}>
                        {entry.fileName}
                      </p>
                      <p className="text-caption text-muted-foreground">
                        {[name, formatDateTime(entry.date, locale)].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    {known ? (
                      <Link
                        href={toolHref(entry.slug)}
                        className={buttonClasses("ghost", "md")}
                      >
                        {t.recent.openTool}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          <Button
            variant="destructive"
            size="md"
            className="mt-6"
            onClick={() => clearRecentEntries()}
          >
            {t.recent.clear}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
