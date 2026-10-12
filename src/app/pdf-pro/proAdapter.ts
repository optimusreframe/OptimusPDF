import type { Language } from "@/lib/i18n";
import { PdfError, isPdfFile, toPdfError } from "@/lib/pdf/core";
import { browserInputGuard, decryptInputCopy, isDecryptedCopy, type InputGuard } from "@/lib/pdf/inputGuard";
import type {
  ProOperation,
  ProRunOutcome,
  ProWarning,
  ProWorkingState,
} from "@/app/pdf-pro/proTypes";
import type { PdfErrorCode } from "@/lib/pdf/core";

/**
 * Adaptador de motores (Wave 7 · U2): lo que une los motores puros existentes
 * (`rotate.ts`, `compress.ts`... que piden `File` y devuelven `Blob`) con el documento de trabajo
 * (bytes → bytes). Tres piezas:
 *
 *  - `runOperation`: ejecuta UNA operacion con progreso 0..1, cancelacion (`AbortSignal`) y errores
 *    tipados (`toPdfError`, los mismos mensajes claros de W6). Un motor que no escucha la senal igual
 *    se corta: el resultado tardio se ignora.
 *  - `createProRunner`: serializa las ejecuciones de una pantalla con un `runId`; lanzar otra o
 *    cancelar descarta cualquier resultado atrasado de la anterior.
 *  - `checkProInput` / `exportWarnings`: la entrada (PDF malo, cifrado) y los avisos antes de guardar.
 */

export type ProRunOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  lang?: Language;
};

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** Envuelve un motor existente: `File` → motor → bytes. */
export async function runOperation<TOptions>(
  operation: ProOperation<TOptions>,
  bytes: Uint8Array,
  options: TOptions,
  run: ProRunOptions = {},
): Promise<ProRunOutcome> {
  const controller = new AbortController();
  const external = run.signal;
  let onExternalAbort: (() => void) | null = null;
  if (external) {
    if (external.aborted) return { ok: false, cancelled: true, code: "cancelled" };
    onExternalAbort = () => controller.abort();
    external.addEventListener("abort", onExternalAbort, { once: true });
  }

  let finished = false;
  const aborted = new Promise<"aborted">((resolve) => {
    if (controller.signal.aborted) resolve("aborted");
    else controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

  try {
    const work = operation.run(bytes, options, {
      signal: controller.signal,
      onProgress: (value) => {
        // Un progreso tardio (despues de cancelar o de terminar) no debe mover la interfaz.
        if (finished || controller.signal.aborted) return;
        run.onProgress?.(clamp01(value));
      },
      lang: run.lang ?? "es",
    });
    // Si gana la cancelacion, el resultado (o el error) tardio del motor se ignora sin ruido.
    work.catch(() => {});
    const winner = await Promise.race([work, aborted]);
    if (winner === "aborted" || controller.signal.aborted) {
      return { ok: false, cancelled: true, code: "cancelled" };
    }
    if (!winner.bytes || winner.bytes.byteLength === 0) {
      return { ok: false, cancelled: false, code: "corrupt" };
    }
    run.onProgress?.(1);
    return {
      ok: true,
      bytes: winner.bytes,
      pageCount: winner.pageCount,
      warnings: winner.warnings ?? [],
      report: winner.report,
    };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, cancelled: true, code: "cancelled" };
    const code = error instanceof PdfError ? error.code : toPdfError(error).code;
    if (code === "cancelled") return { ok: false, cancelled: true, code: "cancelled" };
    return { ok: false, cancelled: false, code };
  } finally {
    finished = true;
    if (external && onExternalAbort) external.removeEventListener("abort", onExternalAbort);
  }
}

export type ProRunnerOutcome = ProRunOutcome & {
  runId: number;
  /** Otra ejecucion (o una cancelacion) la reemplazo: su resultado no debe aplicarse. */
  stale: boolean;
};

export type ProRunner = {
  /** Lanza una operacion; cancela la que estuviera en curso. */
  run<TOptions>(
    operation: ProOperation<TOptions>,
    bytes: Uint8Array,
    options: TOptions,
    handlers?: { onProgress?: (progress: number) => void; lang?: Language },
  ): Promise<ProRunnerOutcome>;
  /** Cancela la ejecucion en curso (su resultado se descarta). */
  cancel(): void;
  readonly running: boolean;
  readonly currentRunId: number;
};

export function createProRunner(): ProRunner {
  let runId = 0;
  let controller: AbortController | null = null;
  return {
    async run(operation, bytes, options, handlers = {}) {
      controller?.abort();
      const mine = ++runId;
      const mineController = new AbortController();
      controller = mineController;
      const outcome = await runOperation(operation, bytes, options, {
        signal: mineController.signal,
        lang: handlers.lang,
        onProgress: (value) => {
          if (runId === mine) handlers.onProgress?.(value);
        },
      });
      const stale = runId !== mine;
      if (!stale && controller === mineController) controller = null;
      return stale ? { ok: false, cancelled: true, code: "cancelled", runId: mine, stale: true } : { ...outcome, runId: mine, stale: false };
    },
    cancel() {
      runId += 1;
      controller?.abort();
      controller = null;
    },
    get running() {
      return controller !== null;
    },
    get currentRunId() {
      return runId;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Entrada y avisos
 * ------------------------------------------------------------------ */

export type ProIntakeResult =
  /** El archivo se puede abrir. `file` es la copia de trabajo (descifrada si hacia falta). */
  | { status: "ready"; file: File; wasEncrypted: boolean; restrictionsOnly: boolean }
  /** Cifrado con contrasena de apertura: hay que pedirla (`decryptProFile`). */
  | { status: "password"; file: File }
  /** Cifrado que este navegador no abre (certificado digital...). */
  | { status: "unsupported"; code: PdfErrorCode; file: File }
  /** Vacio, no es PDF, danado... (`tooLarge` avisa pero no bloquea: lo decide quien llama). */
  | { status: "problem"; code: PdfErrorCode; file: File };

/**
 * Comprueba un archivo recien elegido con el MISMO `inputGuard` que el resto de herramientas.
 * Un PDF que solo restringe permisos se abre con una copia sin esas restricciones sin pedir nada.
 */
export async function checkProInput(file: File, guard: InputGuard = browserInputGuard): Promise<ProIntakeResult> {
  if (file.size > 0 && !isPdfFile(file)) return { status: "problem", code: "notPdf", file };
  let check;
  try {
    check = await guard(file);
  } catch {
    // La comprobacion no pudo con el archivo: se intenta abrir igualmente (el motor dira si no sirve).
    return plainReady(file);
  }
  if (check.status === "problem") {
    if (check.code === "tooLarge") return plainReady(file);
    return { status: "problem", code: check.code, file };
  }
  if (check.status === "unsupported") return { status: "unsupported", code: check.code, file };
  if (check.status === "encrypted") {
    if (check.needsPassword) return { status: "password", file };
    const attempt = await decryptInputCopy(file, "");
    if (attempt.status === "ok") {
      return { status: "ready", file: attempt.file, wasEncrypted: true, restrictionsOnly: true };
    }
    if (attempt.status === "unsupported") return { status: "unsupported", code: attempt.code, file };
    return { status: "password", file };
  }
  return plainReady(file);
}

/**
 * Un archivo que no hace falta descifrar. Si YA es una copia descifrada de otra herramienta (llega por el
 * traspaso con la marca de `inputGuard`) se sigue tratando como tal: ni se guarda borrador ni se olvida el aviso.
 */
function plainReady(file: File): ProIntakeResult {
  return { status: "ready", file, wasEncrypted: isDecryptedCopy(file), restrictionsOnly: false };
}

export type ProDecryptResult =
  | { status: "ready"; file: File }
  | { status: "wrongPassword" }
  | { status: "unsupported"; code: PdfErrorCode }
  | { status: "failed"; code: PdfErrorCode };

/** Descifra EN MEMORIA una copia con la contrasena (nunca se guarda). */
export async function decryptProFile(file: File, password: string): Promise<ProDecryptResult> {
  const attempt = await decryptInputCopy(file, password);
  if (attempt.status === "ok") return { status: "ready", file: attempt.file };
  return attempt;
}

/**
 * Avisos a mostrar ANTES de guardar o exportar. Las firmas digitales solo importan si hay cambios
 * sin guardar (exportar el original intacto no las invalida); el aviso de copia descifrada vale
 * siempre que el archivo estuviera cifrado.
 */
export function exportWarnings(state: ProWorkingState): ProWarning[] {
  const document = state.document;
  if (!document) return [];
  const warnings: ProWarning[] = [];
  if (state.dirty) {
    if (document.signatures === "active") warnings.push({ code: "signaturesInvalidated" });
    else if (document.signatures === "unknown") warnings.push({ code: "signaturesUnknown" });
  }
  if (document.wasEncrypted) warnings.push({ code: "decryptedCopy" });
  return warnings;
}
