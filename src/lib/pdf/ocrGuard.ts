import { PdfError, classifyOcrError } from "@/lib/pdf/core";

/**
 * Guarda de INACTIVIDAD para arrancar el motor de OCR (tesseract.js). Si no hay red a la CDN, el worker
 * falla dentro de su propio hilo (`importScripts ... failed to load`) y `createWorker` no resuelve NI
 * rechaza nunca: la conversion se quedaba esperando para siempre. Aqui se rechaza si pasan `stallMs` sin
 * ninguna senal de vida (el `logger` de tesseract avisa con cada avance de la descarga, asi que una
 * conexion lenta pero activa NO se corta), o de inmediato si se cancela.
 */

export const OCR_STALL_MS = 20_000;

/** Error de «el motor de OCR no responde»: se clasifica como fallo de red (lo mas probable). */
export class OcrStalledError extends PdfError {
  constructor(stallMs: number) {
    super("ocrNetworkFailure", `OCR engine did not respond for ${Math.round(stallMs / 1000)} s`);
    this.name = "OcrStalledError";
  }
}

export type StallGuardOptions<T> = {
  stallMs?: number;
  signal?: AbortSignal;
  /** Se llama con el resultado si llega DESPUES de haberse rendido la guarda (para liberarlo). */
  dispose?: (value: T) => void;
};

export function runWithStallGuard<T>(
  start: (touch: () => void) => Promise<T>,
  options: StallGuardOptions<T> = {},
): Promise<T> {
  const stallMs = options.stallMs ?? OCR_STALL_MS;
  const { signal } = options;

  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PdfError("cancelled"));
      return;
    }

    let settled = false;
    let lastActivity = Date.now();
    const touch = () => {
      lastActivity = Date.now();
    };

    const finish = () => {
      settled = true;
      clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      finish();
      reject(error);
    };
    const onAbort = () => fail(new PdfError("cancelled"));

    const timer = setInterval(
      () => {
        if (Date.now() - lastActivity >= stallMs) fail(new OcrStalledError(stallMs));
      },
      Math.max(50, Math.min(500, stallMs / 4)),
    );
    signal?.addEventListener("abort", onAbort, { once: true });

    start(touch).then(
      (value) => {
        if (settled) {
          options.dispose?.(value);
          return;
        }
        finish();
        resolve(value);
      },
      (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

export type TesseractWorker = Awaited<ReturnType<typeof import("tesseract.js").createWorker>>;

/**
 * Crea el worker de tesseract.js (compartido por Reconocer texto, PDF a texto/Word/Markdown, Traducir
 * y Resumir). Es lo unico que hace peticiones de red a la CDN (motor e idioma), asi que es lo expuesto
 * a un corte: cada intento va con la guarda de inactividad (`OCR_STALL_MS`, 20 s sin senales) y un
 * fallo se clasifica como `ocrNetworkFailure`/`ocrEngineFailure` (mensaje claro, no el generico). UN
 * reintento si el primer intento FALLA rapido; un motor mudo (ya se esperaron 20 s) o una cancelacion
 * no se reintentan.
 */
export async function createOcrWorker(
  language: string,
  logger: (message: { status: string; progress: number }) => void = () => {},
  signal?: AbortSignal,
): Promise<TesseractWorker> {
  const attempt = (): Promise<TesseractWorker> =>
    runWithStallGuard(
      async (touch) => {
        const tesseract = await import("tesseract.js");
        return tesseract.createWorker(language, tesseract.OEM.LSTM_ONLY, {
          logger: (message) => {
            touch();
            logger(message);
          },
        });
      },
      {
        signal,
        // Si el motor llega tarde, ya nadie lo usa: se libera.
        dispose: (late) => void late.terminate().catch(() => {}),
      },
    );
  try {
    return await attempt();
  } catch (error) {
    if (error instanceof PdfError) throw error;
    try {
      return await attempt();
    } catch (second) {
      if (second instanceof PdfError) throw second;
      throw new PdfError(classifyOcrError(second), "OCR engine could not be created");
    }
  }
}
