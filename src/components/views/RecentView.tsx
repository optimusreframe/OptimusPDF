"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Clock, ShieldCheck } from "lucide-react";
import { useDocumentLibrary } from "@/app/documents/useDocumentLibrary";
import { discardItem } from "@/app/recent/discardDraft";
import { HistorySection } from "@/app/recent/HistorySection";
import { buildRecentRows, finishedRows, unfinishedRows } from "@/app/recent/recentIndex";
import { UnfinishedSection } from "@/app/recent/UnfinishedSection";
import { useUnfinishedWork } from "@/app/recent/useUnfinishedWork";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { GlassCard } from "@/components/ui/GlassCard";
import { useRecentEntries } from "@/hooks/useRecentEntries";
import { useI18n } from "@/lib/i18n";
import { clearRecentEntries } from "@/lib/recent";

/**
 * Recientes unificado (U0.6 + U2.6). Un solo indice derivado (`buildRecentRows`, sin almacen propio) junta los borradores
 * reales de Firmar, Editar PDF y PDF Pro con las entradas del historial que no apuntan a un borrador vivo, por fecha.
 * Se pinta en dos grupos: «Sin terminar» (con «Continuar», que RESTAURA el trabajo, y «Descartar») y «Historial»
 * (terminados: «Abrir herramienta», o «Abrir de nuevo» con la copia de Mis documentos si la huella coincide).
 * «Continuar» solo existe con un puntero `resume` verificable (`resumeLinks.ts`). Aviso fijo: solo en este navegador.
 */
export function RecentView() {
  const { t } = useI18n();
  const history = useRecentEntries();
  const unfinished = useUnfinishedWork();
  const library = useDocumentLibrary();
  const [announcement, setAnnouncement] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  /** Cuantas filas tenia el historial al borrar una: el foco se devuelve cuando el historial ya tiene menos (y no antes). */
  const refocusHistory = useRef<number | null>(null);

  // El historial espera a haber leido los borradores: antes no se sabe cuales de sus entradas ya salen en «Sin terminar»
  // (apareceria y desapareceria una fila) ni si hay algo que contar (no se anuncia «Aun no has procesado nada» a destiempo).
  const rows = useMemo(
    () => (unfinished.loaded ? buildRecentRows({ unfinished: unfinished.items, history, library: library.documents }) : []),
    [history, unfinished.items, unfinished.loaded, library.documents],
  );
  const draftRows = useMemo(() => unfinishedRows(rows), [rows]);
  const historyRows = useMemo(() => finishedRows(rows), [rows]);
  const showEmpty = unfinished.loaded && history.length === 0 && unfinished.items.length === 0;

  useEffect(() => {
    const before = refocusHistory.current;
    // La fila se quita al llegar el aviso del almacen, que puede tardar mas que otros repintados (p. ej. la biblioteca al
    // cargar): enfocar antes dejaria el foco en una fila que acaba de desaparecer.
    if (before === null || historyRows.length >= before) return;
    refocusHistory.current = null;
    const target = historyRef.current?.querySelector<HTMLElement>("a, button") ?? headingRef.current;
    target?.focus({ preventScroll: true });
  }, [historyRows]);

  async function clearEverything() {
    refocusHistory.current = null;
    await Promise.all(unfinished.items.map((item) => discardItem(item)));
    clearRecentEntries();
    await unfinished.refresh();
    setAnnouncement(t.recent.clearAllDone);
    headingRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="mx-auto max-w-[800px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <header className="mb-8">
        <h1 ref={headingRef} tabIndex={-1} className="text-title-1 text-foreground outline-none">
          {t.recent.title}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {t.recent.subtitle}
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-muted-foreground" data-recent-local="">
          <Badge variant="neutral">
            <ShieldCheck aria-hidden="true" className="size-3 shrink-0" />
            {t.recent.localOnly}
          </Badge>
          <span className="min-w-0">{t.recent.localOnlyHint}</span>
        </p>
      </header>

      {/* Region viva siempre montada: anuncia «Trabajo descartado», «Entrada borrada» y «Recientes borrado». */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <UnfinishedSection
        rows={draftRows}
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

      <div ref={historyRef}>
        <HistorySection
          rows={historyRows}
          documents={library.documents}
          onRemoved={() => {
            refocusHistory.current = historyRows.length;
            setAnnouncement(t.recent.removed);
          }}
        >
          <Button
            variant="destructive"
            size="md"
            className="mt-6"
            onClick={() => clearRecentEntries()}
          >
            {t.recent.clear}
          </Button>
        </HistorySection>
      </div>

      {rows.length > 0 ? (
        <div className="mt-6 border-t border-hairline pt-6" data-recent-clear-all="">
          <Button variant="destructive" size="md" onClick={() => setConfirmAll(true)}>
            {t.recent.clearAll}
          </Button>
        </div>
      ) : null}

      <ConfirmSheet
        open={confirmAll}
        onClose={() => setConfirmAll(false)}
        onConfirm={() => void clearEverything()}
        // Las filas desaparecen: el foco no vuelve al boton (lo coloca `clearEverything`).
        restoreFocusOnClose={() => false}
        title={t.recent.clearAllTitle}
        body={t.recent.clearAllBody}
        confirmLabel={t.recent.clearAllConfirm}
        cancelLabel={t.common.cancel}
        closeLabel={t.common.close}
      />
    </div>
  );
}
