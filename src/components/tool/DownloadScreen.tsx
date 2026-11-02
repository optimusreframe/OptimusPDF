"use client";

import { useId, useMemo, useState, type ReactNode, type Ref } from "react";
import { motion } from "motion/react";
import { Check, Download, FileText, Info, RotateCcw, Share } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ToolCard } from "@/components/tool/ToolCard";
import {
  PartialFailureReport,
  hasPartialFailures,
} from "@/components/tool/PartialFailureReport";
import { canShareResult, shareResult } from "@/components/tool/shareResult";
import { useIsClient } from "@/hooks/useIsClient";
import { useMediaQuery } from "@/hooks/useMediaQuery";
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
  /**
   * El resultado. Opcional: con el, en un movil/tableta cuyo navegador puede compartir archivos aparece «Compartir o guardar…»
   * (hoja de compartir del sistema) como plan B de la descarga, que no funciona en todos los contextos de iOS (web instalada,
   * navegadores internos). Sin el, o sin soporte, la pantalla es la de siempre.
   */
  blob?: Blob;
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
  /**
   * Frase bajo «Listo», ya traducida. Por defecto «Tu documento esta preparado para descargar.»: una herramienta cuyo resultado
   * no es un documento (un video, imagenes, un audio) pasa la suya para no llamar «documento» a lo que no lo es.
   */
  subtitle?: string;
  /** Avisos de la exportacion, ya traducidos (opcional): lista accesible. */
  notices?: { title: string; items: string[] };
  /** Segunda descarga discreta (p. ej. el registro `.json` de Firmar PDF), bajo «Descargar». */
  secondaryDownload?: { label: string; onDownload: () => void };
  /** Accion para seguir con el resultado en otro sitio («Seguir en PDF Pro»), bajo «Descargar». */
  continueAction?: ReactNode;
  /**
   * Opciones propias del resultado, justo bajo «Descargar» y dentro de la tarjeta (p. ej. la casilla «Borrar el borrador de
   * esta firma» y la opcion «E-sign» de Firmar PDF). Ancho acotado y alineadas a la izquierda, como un formulario.
   */
  extras?: ReactNode;
};

/**
 * Pantalla de completado: una accion primaria evidente (Descargar) y la
 * secundaria discreta (Empezar de nuevo). La marca de exito aparece con
 * un spring sin rebote (no hubo gesto) y la tarjeta sube con fundido;
 * bajo reduced motion todo es fundido. Despues, herramientas relacionadas.
 */
const SHARE_COPY = {
  es: { label: "Compartir o guardar…", failed: "No se pudo abrir la hoja de compartir; se ha descargado el archivo." },
  en: { label: "Share or save…", failed: "The share sheet could not open; the file was downloaded instead." },
} as const;

export function DownloadScreen({
  slug,
  filename,
  size,
  onDownload,
  onStartOver,
  blob,
  downloadButtonRef,
  report,
  summary,
  subtitle,
  notices,
  secondaryDownload,
  continueAction,
  extras,
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

  // Plan B movil: la hoja de compartir. Solo con puntero grueso (dedo) y si el navegador puede compartir ESTE archivo.
  const isClient = useIsClient();
  const coarse = useMediaQuery("(pointer: coarse)");
  const shareFile = useMemo(
    () => (isClient && coarse && blob ? new File([blob], filename, { type: blob.type }) : null),
    [isClient, coarse, blob, filename],
  );
  const canShare = shareFile !== null && canShareResult(shareFile);
  const [shareFailed, setShareFailed] = useState(false);
  const share = async () => {
    if (!shareFile) return;
    const outcome = await shareResult(shareFile);
    // Cerrar la hoja sin elegir destino no es un fallo; si el sistema la rechaza, el archivo se descarga como siempre.
    if (outcome === "failed") {
      setShareFailed(true);
      onDownload();
    } else {
      setShareFailed(false);
    }
  };
  const shareCopy = SHARE_COPY[language];

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
          {subtitle ?? t.tool.doneSubtitle}
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
          wrap
          // 14 rem de ancho minimo, sin pasar nunca del de la tarjeta (con la letra al 150 % 14 rem = 336 px y la tarjeta mide 240).
          className="mt-7 min-w-[min(14rem,100%)]"
          onClick={onDownload}
          aria-describedby={describedBy}
        >
          <Download aria-hidden="true" className="size-5" />
          {t.tool.download}
        </Button>

        {canShare ? (
          <Button variant="secondary" size="md" className="mt-3" onClick={() => void share()} data-download-share="">
            <Share aria-hidden="true" className="size-4" />
            {shareCopy.label}
          </Button>
        ) : null}
        <p role="status" aria-live="polite" className={shareFailed ? "mt-2 max-w-sm text-footnote text-muted-foreground" : "sr-only"}>
          {shareFailed ? shareCopy.failed : null}
        </p>

        {extras ? (
          <div
            data-download-extras=""
            className="mt-4 flex w-full max-w-md flex-col items-stretch gap-3 text-left"
          >
            {extras}
          </div>
        ) : null}

        {secondaryDownload ? (
          <Button
            variant="ghost"
            size="md"
            wrap
            className="mt-2 text-muted-foreground hover:text-foreground"
            onClick={secondaryDownload.onDownload}
          >
            <FileText aria-hidden="true" className="size-4" />
            {secondaryDownload.label}
          </Button>
        ) : null}

        {continueAction}

        <Button
          variant="ghost"
          size="md"
          wrap
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
