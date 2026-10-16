/**
 * Tipos, limites y errores del contenedor de respaldo («OptimusPDF Package»,
 * `docs/PLAN-FIRMA-AGIL.md` §9.3). Sin dependencias de runtime: lo importan
 * `package.ts`, el registro de modulos y cada modulo, y asi no hay ciclos.
 */

/** Limites de la importacion (§9.3). Comprobados ANTES de inflar nada. */
export const PACKAGE_LIMITS = {
  /** Tamaño del archivo recibido (y de lo descifrado). */
  maxFileBytes: 250 * 1024 * 1024,
  /** Entradas del zip (carpetas incluidas). */
  maxEntries: 2000,
  /** Suma de tamaños descomprimidos declarados en el directorio central. */
  maxUncompressedBytes: 250 * 1024 * 1024,
  /** Relacion maxima descomprimido:comprimido (se aplica por encima de `ratioFloorBytes`). */
  maxRatio: 100,
  /** Por debajo de esto un ratio alto es inofensivo (un JSON diminuto) y no se exige. */
  ratioFloorBytes: 1024 * 1024,
  /** `manifest.json` (2000 entradas de `files` ocupan ~400 KB). */
  maxManifestBytes: 1024 * 1024,
  /** `envelope.json` de un paquete cifrado. */
  maxEnvelopeBytes: 4 * 1024,
  /** Profundidad maxima de anidamiento de cualquier JSON del paquete. */
  maxJsonDepth: 16,
  /** Longitud maxima de una ruta del zip. */
  maxPathLength: 200,
  /** Modulos distintos en el manifiesto. */
  maxModules: 32,
} as const;

export type PackageErrorCode =
  /** El archivo no es un zip utilizable (o no es del tipo esperado). */
  | "badZip"
  | "tooLarge"
  | "tooManyEntries"
  /** Directorio central con tamaños/ratio imposibles (bomba o mentira). */
  | "bomb"
  /** Ruta con `..`, absoluta, con caracteres de control, etc. */
  | "unsafePath"
  | "duplicateEntry"
  | "invalidManifest"
  | "invalidJson"
  /** Formato del CONTENEDOR mas nuevo que el soportado. */
  | "newerFormat"
  | "needsPassword"
  | "wrongPassword"
  | "corrupt"
  /** Sin `crypto.subtle` (http no seguro). */
  | "unavailable"
  /** `buildPackage` recibio algo que no puede empaquetar. */
  | "invalidModule";

/** Mensajes fijos en español: nunca incluyen datos del archivo. */
export const PACKAGE_ERROR_MESSAGES: Record<PackageErrorCode, string> = {
  badZip: "El archivo no es un paquete de OptimusPDF válido.",
  tooLarge: "El paquete es demasiado grande.",
  tooManyEntries: "El paquete tiene demasiados archivos.",
  bomb: "El paquete no es seguro de abrir.",
  unsafePath: "El paquete contiene rutas no permitidas.",
  duplicateEntry: "El paquete tiene archivos repetidos.",
  invalidManifest: "El paquete está dañado o no se reconoce.",
  invalidJson: "El paquete está dañado o no se reconoce.",
  newerFormat: "Creado con una versión más nueva de OptimusPDF; actualiza la página.",
  needsPassword: "El paquete está cifrado: escribe su contraseña.",
  wrongPassword: "La contraseña no es correcta o el archivo está dañado.",
  corrupt: "El paquete cifrado está dañado.",
  unavailable: "Este navegador no permite cifrar o descifrar aquí.",
  invalidModule: "No se pudo preparar el paquete.",
};

export class PackageError extends Error {
  readonly code: PackageErrorCode;
  constructor(code: PackageErrorCode) {
    super(PACKAGE_ERROR_MESSAGES[code]);
    this.name = "PackageError";
    this.code = code;
  }
}

/** Mensaje al rechazar un MODULO cuya `schemaVersion` es mayor que la soportada. */
export const NEWER_VERSION_MESSAGE =
  "Creado con una versión más nueva de OptimusPDF; actualiza la página.";

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

export type PackageFileInput = {
  /** Ruta dentro del zip, p. ej. `signatures/index.json`. */
  path: string;
  data: Uint8Array;
  /** Tipo informativo (`application/json`, `image/png`...). Nunca decide nada al importar. */
  type: string;
};

export type PackageMetaValue = number | string | boolean;

export type PackageModuleInput = {
  name: string;
  schemaVersion: number;
  /** Datos informativos del manifiesto (`count`...). Solo escalares. */
  meta?: Record<string, PackageMetaValue>;
  files: PackageFileInput[];
};

/** Lo que el contenedor necesita saber de cada modulo (lo declara el propio modulo). */
export type PackageModuleSpec = {
  name: string;
  /** Version de esquema MAS NUEVA que sabe leer esta version de la app. */
  schemaVersion: number;
  /** Carpetas de primer nivel del zip que pertenecen al modulo. */
  folders: readonly string[];
  /** Tope de bytes de cada archivo NO json del modulo (se comprueba antes de inflar). */
  maxFileBytes: number;
  /** Tope de bytes de cada `.json` del modulo. */
  maxJsonBytes: number;
};

export type ModuleRegistry = Record<string, PackageModuleSpec>;

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export type PackageFileStatus =
  | "ok"
  | "sha256Mismatch"
  | "sizeMismatch"
  | "missing"
  | "tooLarge"
  | "unreadable";

export type PackageFileRead = {
  path: string;
  type: string;
  /** Bytes verificados; `null` si el archivo no esta `ok`. */
  bytes: Uint8Array | null;
  /** SHA-256 que declara el manifiesto. */
  sha256: string;
  status: PackageFileStatus;
};

export type PackageModuleStatus = "ok" | "newerVersion";

export type PackageModuleData = {
  name: string;
  /** `schemaVersion` declarada por el paquete. */
  declaredSchemaVersion: number;
  status: PackageModuleStatus;
  /** Para `newerVersion`: el texto a mostrar. */
  message?: string;
  meta: Record<string, PackageMetaValue>;
  /** Vacio si el modulo no se pudo leer (`newerVersion`). */
  files: Map<string, PackageFileRead>;
};

export type PackageWarning = {
  code: "unknownModule" | "ignoredEntry" | "unlistedFile" | "ignoredFile";
  path?: string;
  module?: string;
};

export type PackageReadResult = {
  formatVersion: number;
  createdAt: string;
  app: { version?: string; build?: string };
  encrypted: boolean;
  modules: PackageModuleData[];
  warnings: PackageWarning[];
};
