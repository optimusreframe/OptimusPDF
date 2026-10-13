"use client";

import { useI18n } from "@/lib/i18n";
import { ExportCancelButton } from "@/app/pdf-pro/export/ExportCancelButton";
import { getExportStrings } from "@/app/pdf-pro/export/exportStrings";
import { useExportStore } from "@/app/pdf-pro/export/useExportStore";

/**
 * Indicador GLOBAL de la exportacion en curso (Wave 9), en la barra superior de la suite: se ve y se puede cancelar
 * desde cualquier pestaña, modo u hoja mientras una exportacion corre; si no corre, no pinta nada.
 *
 *  - Una pildora en su propia fila bajo el nombre del documento (la barra superior se parte en dos mientras dura, igual
 *    en escritorio, tableta y movil: asi nunca le quita sitio al nombre ni a «Descargar» ni llega al dock inferior):
 *    «Exportando a Word…», el porcentaje (siempre visible), «Cancelar» de 44 px y, como filete en su borde inferior,
 *    la barra (`role="progressbar"`).
 *  - NO es una region viva: los anuncios (terminar, cancelar, error) salen por la unica region de PDF Pro. El
 *    porcentaje cambia sin anunciarse (un lector de pantalla lo lee al recorrer el indicador).
 *  - Si «Cancelar» desaparece teniendo el foco (se pulso, o la exportacion termino sola) el foco pasa al titulo del
 *    documento en el mismo commit (`ExportCancelButton`), nunca a <body>.
 */
export function ExportIndicator() {
  const { language } = useI18n();
  const { store, state } = useExportStore();
  const job = state.job;
  if (!job || job.phase !== "running") return null;
  const own = getExportStrings(language);
  const format = own.formatsShort[job.formatId];
  const percent = Math.round(job.progress * 100);
  const label = own.indicator.running(format);
  return (
    // Fila propia (hijo directo de la barra, que se parte en dos): la pildora no la llena en pantallas anchas.
    <div className="order-last flex basis-full pb-1">
      <div
        role="group"
        aria-label={own.indicator.group}
        data-export-indicator=""
        data-export-format={job.formatId}
        className="relative flex min-h-11 w-full min-w-0 items-center gap-2 rounded-full border border-hairline bg-white/5 pl-4 pr-1 sm:w-[26rem] sm:max-w-full"
      >
        <span className="min-w-0 flex-1 truncate text-footnote text-foreground" title={label}>
          {label}
        </span>
        <span className="shrink-0 text-footnote text-foreground tabular-nums">{own.indicator.percent(percent)}</span>
        <ExportCancelButton
          variant="ghost"
          size="md"
          className="shrink-0 rounded-full px-3 text-subheadline"
          aria-label={own.indicator.cancelLabel(format)}
          onCancel={() => store.cancel()}
          // El titulo del documento (tabIndex -1) es el destino habitual de la suite cuando un control desaparece.
          returnFocusTo={(button) => button.closest<HTMLElement>('[data-pro-region="top"]')?.querySelector<HTMLElement>("h1")}
        >
          {own.indicator.cancel}
        </ExportCancelButton>
        <span
          role="progressbar"
          aria-label={own.indicator.progressLabel(format)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="pointer-events-none absolute inset-x-4 bottom-[3px] h-0.5 overflow-hidden rounded-full bg-white/10 forced-colors:border forced-colors:border-[CanvasText]"
        >
          <span
            className="block h-full w-full origin-left rounded-full bg-signal transition-transform duration-300 ease-out motion-reduce:transition-none forced-colors:bg-[Highlight]"
            style={{ transform: `scaleX(${job.progress})` }}
          />
        </span>
      </div>
    </div>
  );
}
