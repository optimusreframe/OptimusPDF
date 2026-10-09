import type { PdfErrorCode } from "@/lib/pdf/core";

/**
 * Informe de un procesado por lotes (varios documentos en una sola
 * ejecucion, p. ej. "Firmar PDF" con varios documentos). Lo rellena el motor
 * y lo muestra `DownloadScreen` solo si hubo fallos parciales.
 *
 * Vive aparte de `ToolShell` (componente) y de `signBatch` (motor) para que
 * ambos lo compartan sin depender el uno del otro.
 */
export type BatchReportOk = {
  /** Identificador estable del documento (el que dio quien llamo). */
  id: string;
  /** Nombre original del documento, tal como lo ve el usuario. */
  name: string;
  /** Nombre final de la entrada en el ZIP (o del PDF unico). */
  filename: string;
};

export type BatchReportFailed = {
  id: string;
  name: string;
  /** Motivo, traducible con `t.tool.errors[code]`. */
  code: PdfErrorCode;
};

export type BatchReport = {
  ok: BatchReportOk[];
  failed: BatchReportFailed[];
};
