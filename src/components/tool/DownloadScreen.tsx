"use client";

import { useId, type ReactNode, type Ref } from "react";
import { motion } from "motion/react";
import { Check, Download, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ToolCard } from "@/components/tool/ToolCard";
import {
  PartialFailureReport,
  hasPartialFailures,
} from "@/components/tool/PartialFailureReport";
import type { BatchReport } from "@/lib/pdf/batchReport";
import { useI18n, localeTag } from "@/lib/i18n";
import { springs, withCrossFadeOpacity } from "@/lib/motion";
import { formatFileSize } from "@/lib/pdf/core";
import { getRelatedTools, type ToolSlug } from "@/lib/tools-registry";

export type DownloadScreenProps = {
  slug: ToolSlug;
  filename: string;
  size: number;
  onDownload: () => void;
  onStartOver: () => void;
  /** Ref al boton primario (Descargar): ToolShell le da el foco al terminar. */
  downloadButtonRef?: Ref<HTMLButtonElement>;
  /**
   * Informe de un procesado por lotes. Opcional: sin el, o sin fallos, la
   * pantalla es exactamente la de siempre. Con fallos parciales muestra
   * cuales documentos no se pudieron procesar (los demas ya van en el
   * archivo descargable).
   */
  report?: BatchReport;
  /** Resumen de lo hecho, ya traducido (opcional). */
  summary?: string;
  /** Avisos de la exportacion, ya traducidos (opcional): lista accesible. */
  notices?: { title: string; items: string[] };
  /** Accion para seguir con el resultado en otro sitio («Seguir en PDF Pro»), bajo «Descargar». */
  continueAction?: ReactNode;
};

/**
 * Pantalla de completado: una accion primaria evidente (Descargar) y la
 * secundaria discreta (Empezar de nuevo). La marca de exito aparece con
 * un spring sin rebote (no hubo gesto) y la tarjeta sube con fundido;
 * bajo reduced motion todo es fundido. Despues, herramientas relacionadas.
 */
export function DownloadScreen({
  slug,
  filename,
  size,
  onDownload,
  onStartOver,
  downloadButtonRef,
  report,
  summary,
  notices,
  continueAction,
}: DownloadScreenProps) {
  const { t, language } = useI18n();
  const reportId = useId();
  const summaryId = useId();
  const noticesId = useId();
  const noticeItems = notices?.items ?? [];
  const showReport = hasPartialFailures(report);
  const describedBy =
    [
      summary ? summaryId : null,
      // El titulo y CADA aviso, uno por uno. Nunca el grupo ni la lista que los contienen: Chromium calcula la descripcion
      // de un elemento referenciado con TODO su contenido (aunque lleve `aria-labelledby`), asi que referenciar el grupo y
      // ademas su lista hacia que el lector de pantalla leyera cada aviso dos veces al llegar a «Descargar».
      ...(noticeItems.length > 0
        ? [`${noticesId}-title`, ...noticeItems.map((_, index) => `${noticesId}-item-${index}`)]
        : []),
      showReport ? reportId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const related = getRelatedTools(slug, 3);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={withCrossFadeOpacity(springs.gentle)}
    >
      <section
        aria-labelledby="download-title"
        className="surface-card flex flex-col items-center rounded-ios-lg px-6 py-12 text-center md:py-16"
      >
        <motion.span
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={withCrossFadeOpacity(springs.snappy)}
          className="flex size-16 items-center justify-center rounded-full bg-success/15 text-success"
        >
          <Check aria-hidden="true" className="size-8" strokeWidth={2.5} />
        </motion.span>

        <h2 id="download-title" className="mt-5 text-title-1 text-foreground">
          {t.tool.doneTitle}
        </h2>
        <p className="mt-1.5 max-w-sm text-callout text-muted-foreground">
          {t.tool.doneSubtitle}
        </p>

        <div className="mt-6 max-w-full">
          <p className="truncate text-subheadline font-medium text-foreground">
            {filename}
          </p>
          <p className="mt-0.5 text-footnote text-muted-foreground tabular-nums">
            {t.tool.resultSize} · {formatFileSize(size, localeTag(language))}
          </p>
        </div>

        {summary ? (
          <p
            id={summaryId}
            data-download-summary=""
            className="mt-4 max-w-md text-subheadline text-foreground"
          >
            {summary}
          </p>
        ) : null}

        {noticeItems.length > 0 && notices ? (
          <div
            id={noticesId}
            role="group"
            aria-labelledby={`${noticesId}-title`}
            data-download-notices=""
            className="mt-5 w-full max-w-lg rounded-ios border border-hairline bg-white/5 p-4 text-left"
          >
            <h3
              id={`${noticesId}-title`}
              className="flex items-center gap-2 text-subheadline font-semibold text-foreground"
            >
              <Info aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              {notices.title}
            </h3>
            <ul id={`${noticesId}-list`} className="mt-2 list-disc space-y-1.5 pl-5 text-footnote text-muted-foreground">
              {noticeItems.map((item, index) => (
                <li key={item} id={`${noticesId}-item-${index}`}>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {report && showReport ? (
          <PartialFailureReport report={report} id={reportId} />
        ) : null}

        <Button
          ref={downloadButtonRef}
          size="lg"
          className="mt-7 min-w-56"
          onClick={onDownload}
          aria-describedby={describedBy}
        >
          <Download aria-hidden="true" className="size-5" />
          {t.tool.download}
        </Button>

        {continueAction}

        <Button
          variant="ghost"
          size="md"
          className="mt-2 text-muted-foreground hover:text-foreground"
          onClick={onStartOver}
        >
          <RotateCcw aria-hidden="true" className="size-4" />
          {t.tool.startOver}
        </Button>
      </section>

      <section className="mt-10" aria-labelledby="related-title">
        <h3 id="related-title" className="ui-label mb-3 text-muted-foreground">
          {t.tool.relatedTitle}
        </h3>
        <ul className="grid gap-3 sm:grid-cols-3">
          {related.map((tool) => (
            <li key={tool.slug}>
              <ToolCard tool={tool} compact />
            </li>
          ))}
        </ul>
      </section>
    </motion.div>
  );
}
