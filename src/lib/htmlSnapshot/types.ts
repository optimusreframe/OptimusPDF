/**
 * Tipos y limites compartidos de «HTML a PDF · Direccion web».
 *
 * Este modulo NO importa nada de Node: lo usan tanto la ruta de servidor (`POST /api/html-snapshot`) como el
 * navegador (validacion en vivo del campo y lectura de la respuesta).
 */

/** Codigos de error de la ruta. Son GENERICOS a proposito: nunca llevan detalles internos (IP, DNS, cabeceras). */
export type SnapshotErrorCode =
  | "invalid-url"
  | "blocked-address"
  | "unreachable"
  | "too-large"
  | "unsupported-type"
  | "timeout"
  | "rate-limited"
  /** La peticion no viene de la propia web (cabeceras `Origin` / `Sec-Fetch-Site`). */
  | "forbidden";

export const SNAPSHOT_ERROR_CODES: readonly SnapshotErrorCode[] = [
  "invalid-url",
  "blocked-address",
  "unreachable",
  "too-large",
  "unsupported-type",
  "timeout",
  "rate-limited",
  "forbidden",
];

export function isSnapshotErrorCode(value: unknown): value is SnapshotErrorCode {
  return typeof value === "string" && (SNAPSHOT_ERROR_CODES as readonly string[]).includes(value);
}

/** Error tipado que se lanza dentro del servidor y se traduce a `{ error }` + estado HTTP al responder. */
export class SnapshotError extends Error {
  readonly code: SnapshotErrorCode;
  constructor(code: SnapshotErrorCode) {
    super(code);
    this.name = "SnapshotError";
    this.code = code;
  }
}

/** Estado HTTP de cada codigo. */
export const SNAPSHOT_ERROR_STATUS: Record<SnapshotErrorCode, number> = {
  "invalid-url": 400,
  "blocked-address": 403,
  unreachable: 502,
  "too-large": 413,
  "unsupported-type": 415,
  timeout: 504,
  "rate-limited": 429,
  forbidden: 403,
};

/**
 * Avisos sobre lo que no se pudo incluir. Son CODIGOS (no frases): la interfaz los escribe en el idioma de la persona.
 * `count` es cuantos elementos afecta, cuando tiene sentido.
 */
export type SnapshotNoteCode =
  /** Imagenes que no se pudieron descargar o no eran un formato admitido. */
  | "images-skipped"
  /** Imagenes que quedaron fuera por pasar del maximo de imagenes por pagina. */
  | "images-limit"
  /** Imagenes omitidas (las mas grandes primero) para que la respuesta quepa en el tope de tamaño. */
  | "images-budget"
  /** Hojas de estilo que no se pudieron descargar o sobraban del maximo. */
  | "styles-skipped"
  /** La pagina declara tipografias propias: no se incluyen y se usan las del sistema. */
  | "fonts-omitted"
  /** La pagina trae JavaScript: no se ejecuta, asi que lo que dependa de el puede faltar. */
  | "scripts-ignored"
  /** Contenido incrustado (marcos, video, audio, objetos) que no se incluye. */
  | "embeds-omitted"
  /** Casi no hay contenido legible: lo normal en paginas que se arman con JavaScript. */
  | "little-content";

export type SnapshotNote = { code: SnapshotNoteCode; count?: number };

export type SnapshotResult = {
  /** Una sola pagina HTML autocontenida y ya saneada (CSS e imagenes incrustados). */
  html: string;
  /** Direccion final tras las redirecciones. */
  finalUrl: string;
  title: string;
  notes: SnapshotNote[];
};

export const SNAPSHOT_LIMITS = {
  /** Tamano maximo de la direccion (caracteres). */
  maxUrlLength: 2048,
  /** Tamano maximo del cuerpo JSON de la peticion (bytes). */
  maxRequestBytes: 4096,
  /** Tiempo total por peticion (pagina + recursos), en milisegundos. */
  totalTimeoutMs: 10_000,
  /** HTML de la pagina, ya DESCOMPRIMIDO. */
  maxPageBytes: 5 * 1024 * 1024,
  /** Cada hoja de estilo, ya descomprimida. */
  maxCssBytes: 1024 * 1024,
  /** Hojas de estilo en total (enlaces + `@import`). */
  maxStylesheets: 10,
  /** Profundidad maxima de `@import` anidados. */
  maxImportDepth: 3,
  /** Imagenes distintas que se descargan. */
  maxImages: 30,
  /** Cada imagen, ya descomprimida. */
  maxImageBytes: 2.5 * 1024 * 1024,
  /** Redirecciones que se siguen (a mano, validando cada salto). */
  maxRedirects: 5,
  /** Tamano maximo del HTML de la respuesta (Vercel limita las funciones a 4,5 MB). */
  maxResponseBytes: 3.5 * 1024 * 1024,
  /** Peticiones simultaneas por instancia. */
  maxConcurrent: 4,
  /** Peticiones por IP y minuto (limitador en memoria, de mejor esfuerzo). */
  perIpPerMinute: 10,
  /** Profundidad maxima de anidado de elementos que se conserva. */
  maxDepth: 400,
} as const;

/** Agente de usuario FIJO de todas las peticiones salientes. */
export const SNAPSHOT_USER_AGENT = "OptimusPDF-Snapshot/1.0";
