/**
 * Formatos de SALIDA del convertidor de imagenes y lo que cada uno permite.
 *
 * Puro (sin DOM): el navegador solo aporta `OutputSupport`, el resultado de probar que `canvas.toBlob` de ESTE navegador
 * codifica cada formato (`browserBackend.ts`). Un navegador que no sabe codificar un formato no falla: devuelve un PNG, asi
 * que sin esa prueba la persona pediria WebP y recibiria un PNG con extension `.webp`.
 */

export const OUTPUT_FORMATS = ["jpeg", "png", "webp", "avif", "bmp"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export type OutputFormatInfo = {
  readonly id: OutputFormat;
  readonly mime: string;
  /** Extension del archivo de salida (sin punto). */
  readonly extension: string;
  /** Etiqueta corta de la interfaz (los nombres de formato no se traducen). */
  readonly label: string;
  /** Pierde datos al codificar: tiene sentido pedir calidad. */
  readonly lossy: boolean;
  /** Guarda transparencia. Los que no, aplanan la imagen sobre el color de fondo elegido. */
  readonly alpha: boolean;
};

export const OUTPUT_FORMAT_INFO: Readonly<Record<OutputFormat, OutputFormatInfo>> = {
  jpeg: { id: "jpeg", mime: "image/jpeg", extension: "jpg", label: "JPG", lossy: true, alpha: false },
  png: { id: "png", mime: "image/png", extension: "png", label: "PNG", lossy: false, alpha: true },
  webp: { id: "webp", mime: "image/webp", extension: "webp", label: "WebP", lossy: true, alpha: true },
  avif: { id: "avif", mime: "image/avif", extension: "avif", label: "AVIF", lossy: true, alpha: true },
  bmp: { id: "bmp", mime: "image/bmp", extension: "bmp", label: "BMP", lossy: false, alpha: false },
};

export function isOutputFormat(value: unknown): value is OutputFormat {
  return typeof value === "string" && (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/** Que formatos sabe crear este navegador. */
export type OutputSupport = Readonly<Record<OutputFormat, boolean>>;

/**
 * Antes de probar el navegador: JPG, PNG y BMP se dan por buenos (JPG y PNG los codifica todo navegador; BMP lo escribe
 * `bmp.ts` sin ayuda del navegador) y WebP/AVIF no, porque dependen del motor (Safari no codifica WebP; Chromium no codifica AVIF).
 */
export const BASELINE_SUPPORT: OutputSupport = { jpeg: true, png: true, webp: false, avif: false, bmp: true };

/** El formato pierde la transparencia: la imagen se aplana sobre el color de fondo. */
export function needsBackground(format: OutputFormat): boolean {
  return !OUTPUT_FORMAT_INFO[format].alpha;
}

/** Formatos que se ofrecen en la interfaz, en orden estable; el resto son los que este navegador no sabe crear (con su motivo). */
export function splitFormats(support: OutputSupport): { available: OutputFormat[]; unavailable: OutputFormat[] } {
  const available: OutputFormat[] = [];
  const unavailable: OutputFormat[] = [];
  for (const format of OUTPUT_FORMATS) (support[format] ? available : unavailable).push(format);
  return { available, unavailable };
}

/** Si `wanted` no se puede crear, el primero que si (JPG siempre). Evita quedarse con una opcion que ya no existe. */
export function resolveFormat(wanted: OutputFormat, support: OutputSupport): OutputFormat {
  if (support[wanted]) return wanted;
  return OUTPUT_FORMATS.find((format) => support[format]) ?? "jpeg";
}

/** Calidad de la interfaz (1-100) a la del lienzo (0-1), acotada: fuera de rango no se confia en el valor. */
export function qualityToUnit(quality: number): number {
  if (!Number.isFinite(quality)) return 0.9;
  return Math.min(1, Math.max(0.01, quality / 100));
}
