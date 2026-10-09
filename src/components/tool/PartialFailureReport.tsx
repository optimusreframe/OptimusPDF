"use client";

import { AlertTriangle } from "lucide-react";
import type { BatchReport } from "@/lib/pdf/batchReport";
import { useT } from "@/lib/i18n";

function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/** `true` si el informe trae al menos un documento que fallo. */
export function hasPartialFailures(report: BatchReport | undefined): boolean {
  return !!report && report.failed.length > 0;
}

export type PartialFailureReportProps = {
  report: BatchReport;
  /** Id del contenedor: `DownloadScreen` lo enlaza con `aria-describedby` del boton Descargar. */
  id?: string;
};

/**
 * "2 de 3 documentos firmados. No se pudo firmar: Contrato B (motivo)".
 *
 * Solo se pinta si hubo fallos (si no, devuelve `null` y la pantalla de
 * descarga queda exactamente como siempre). `role="status"` como el resto
 * de avisos de ToolShell; ademas, `DownloadScreen` enlaza este bloque al
 * boton Descargar con `aria-describedby`, porque la pantalla nace con el
 * contenido ya puesto y varios lectores de pantalla no anuncian una region
 * viva que aparece rellena.
 */
export function PartialFailureReport({ report, id }: PartialFailureReportProps) {
  const t = useT();
  if (report.failed.length === 0) return null;

  const title = fillTemplate(t.tool.partialReportTitle, {
    ok: String(report.ok.length),
    total: String(report.ok.length + report.failed.length),
  });

  return (
    <div
      id={id}
      role="status"
      data-testid="partial-failure-report"
      className="mt-6 w-full max-w-md rounded-ios border border-destructive/35 bg-destructive/10 p-4 text-left"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-5 shrink-0 text-destructive"
        />
        <div className="min-w-0 flex-1">
          <p className="text-subheadline font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-subheadline text-muted-foreground">
            {t.tool.partialReportIntro}
          </p>
          <ul className="mt-2 space-y-1 text-subheadline text-foreground">
            {report.failed.map((item) => (
              <li key={item.id} className="break-words">
                {fillTemplate(t.tool.partialReportItem, {
                  name: item.name,
                  reason: t.tool.errors[item.code],
                })}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
