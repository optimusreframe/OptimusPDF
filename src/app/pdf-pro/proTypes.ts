import type { Language } from "@/lib/i18n";
import type { PdfErrorCode, ProgressCallback } from "@/lib/pdf/core";

/**
 * CONTRATO COMPARTIDO de PDF Pro (Wave 7 · U2). Solo tipos y constantes: las unidades
 * siguientes (shell y visor, paginas, herramientas de documento, modos Editar/Anotar y
 * Firmar/Rellenar, exportar) se apoyan en esto y NO deben cambiar su forma sin avisar.
 *
 * Modelo: el documento de trabajo es un HISTORIAL LINEAL de snapshots con bytes
 * inmutables. Las operaciones de documento completo y de paginas hacen commit al instante;
 * los modos con sesion propia (Editar, Anotar, Firmar...) trabajan sobre el snapshot actual y,
 * al pulsar «Aplicar», crean UN snapshot (`source: "mode-apply"`).
 */

/** Modos con sesion propia (cada uno hace «Aplicar» = un snapshot). */
export type ProModeId = "edit" | "annotate" | "sign" | "fill" | "redact" | "crop" | "pages";

export const PRO_MODE_IDS: readonly ProModeId[] = [
  "edit",
  "annotate",
  "sign",
  "fill",
  "redact",
  "crop",
  "pages",
] as const;

/** Como nacio un snapshot: al abrir el archivo, por una operacion o al aplicar un modo. */
export type ProSnapshotSource = "open" | "operation" | "mode-apply";

export type ProSnapshot = {
  id: string;
  /** Bytes del PDF en ese momento. INMUTABLES: nunca se modifican, se crea otro snapshot. */
  bytes: Uint8Array;
  /** Texto corto ya traducido («Rotar 90°», «Original»). */
  label: string;
  /** Marca de tiempo (ms desde epoch). */
  createdAt: number;
  pageCount: number;
  byteLength: number;
  source: ProSnapshotSource;
  /** Operacion que lo creo (`ProOperation.id`), si la hubo. */
  opId?: string;
  /**
   * Etiquetas (de la mas antigua a la mas nueva) de los pasos que el presupuesto de memoria descarto JUSTO antes de
   * este: deshacer desde aqui los salta, asi que se anuncian («Deshecho: Rotar, Marca de agua») en vez de saltarlos
   * en silencio.
   */
  skippedLabels?: readonly string[];
  /**
   * Wave 8: los bytes estan VOLCADOS a disco (IndexedDB) y `bytes` esta vacio hasta que se recuperen al deshacer o
   * rehacer. El snapshot ACTUAL nunca esta volcado: `currentSnapshot().bytes` siempre es el PDF entero.
   */
  offloaded?: boolean;
};

/** Estado de las firmas digitales del PDF abierto (`unknown` nunca se lee como «sin firmas»). */
export type ProSignatureState = "none" | "active" | "unknown";

/** Una linea del historial restaurado de un borrador (solo informativa: sin bytes). */
export type ProHistoryNote = {
  label: string;
  createdAt: number;
  source: ProSnapshotSource;
  opId?: string;
};

/** Datos de un documento recuperado de un borrador. */
export type ProRestoredInfo = {
  /** ISO 8601 del guardado del borrador. */
  savedAt: string;
  /** Pasos que tenia el historial al guardarse (el anterior no se puede deshacer). */
  history: readonly ProHistoryNote[];
};

export type ProDocument = {
  /** Id de esta sesion de trabajo (cambia al abrir otro archivo). */
  id: string;
  /** Nombre del archivo (con extension). */
  name: string;
  /** El usuario eligio este nombre en «Guardar como…»: se descarga tal cual, sin el sufijo `-pro`. */
  renamed?: boolean;
  /** Historial lineal, del mas antiguo al mas nuevo. El primero es siempre el original abierto. */
  snapshots: readonly ProSnapshot[];
  /** Indice del snapshot actual dentro de `snapshots`. */
  cursor: number;
  /** Snapshot que se guardo/exporto por ultima vez (`dirty` = el actual es otro). `null` = nunca. */
  savedSnapshotId: string | null;
  /** SHA-256 hex del archivo ABIERTO (clave del borrador), o `null` sin `crypto.subtle`. */
  fingerprint: string | null;
  /** El archivo estaba cifrado: se trabaja con una copia descifrada en memoria. */
  wasEncrypted: boolean;
  signatures: ProSignatureState;
  /** Snapshots descartados por el presupuesto de memoria (0 = historial completo). */
  trimmedCount: number;
  openedAt: number;
  /** Presente si el documento se recupero de un borrador. */
  restored?: ProRestoredInfo;
  /**
   * Wave 8: el volcado del historial a disco fallo (sin IndexedDB, cuota agotada, paso perdido): el historial vive
   * solo en memoria y se recorta por bytes como antes. Se muestra como aviso (`historyOffloadUnavailable`).
   */
  historyOffloadFailed?: boolean;
};

/** Lo que consumen los componentes (`useProWorkingDoc`). Referencia estable mientras nada cambia. */
export type ProWorkingState = {
  document: ProDocument | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Hay cambios sin guardar (el snapshot actual no es el ultimo guardado/exportado). */
  dirty: boolean;
  pageCount: number;
  /** Ultimo anuncio para la region viva unica; `id` crece con cada uno (repite el mismo texto si hace falta). */
  announcement: { id: number; text: string } | null;
  /** Modos con sesion propia activos (`registerMode`). */
  activeModes: readonly ProModeId[];
  /** Algun modo activo tiene su propio deshacer: Ctrl+Z global NO actua. */
  ownUndoActive: boolean;
  /** Wave 8: se estan recuperando de disco los bytes del paso al que se va (deshacer/rehacer en curso). */
  restoring: boolean;
  /**
   * Wave 8 (D7): hay un paso EN VUELO (una operacion corriendo o una confirmacion encolada que aun no esta en el
   * historial). Cerrar o cambiar de documento ahora cuenta como cambios pendientes: se pide confirmar.
   */
  stepInFlight: boolean;
};

/** Avisos (ya estructurados; el texto sale de `proWarningText`). */
export type ProWarningCode =
  /** Hay firmas digitales activas y los cambios las invalidan. */
  | "signaturesInvalidated"
  /** No se pudo comprobar si hay firmas digitales. */
  | "signaturesUnknown"
  /** Se trabaja con una copia descifrada: la contrasena no se guardara. */
  | "decryptedCopy"
  /** El historial mas antiguo se descarto por falta de memoria. */
  | "historyTrimmed"
  /** El resultado salio igual que la entrada (sin cambios). */
  | "unchanged"
  /** El documento pesa mas de 100 MB: las operaciones pueden tardar y usar mucha memoria. */
  | "largeDocument"
  /** El documento pesa mas de 150 MB: no se guarda borrador automatico. */
  | "noDraftTooBig"
  /** El historial en memoria se acerca al presupuesto: los pasos mas antiguos se descartaran. */
  | "memoryHigh"
  /** Wave 8: no se pudo volcar el historial a disco: vive solo en memoria y se recortara por bytes. */
  | "historyOffloadUnavailable";

export type ProWarning = {
  code: ProWarningCode;
  params?: Record<string, string | number>;
};

export type ProOperationKind = "document" | "pages" | "mode" | "import" | "export";

export type ProOperationContext = {
  /** Se aborta al cancelar. Los motores que no la escuchen ven su resultado tardio ignorado. */
  signal: AbortSignal;
  /** Progreso 0..1. */
  onProgress: ProgressCallback;
  lang: Language;
};

export type ProOperationResult = {
  bytes: Uint8Array;
  warnings?: ProWarning[];
  /** Informe libre de la operacion (p. ej. «3 paginas»). */
  report?: unknown;
  /** Si la operacion ya conoce el numero de paginas, evita recontarlo. */
  pageCount?: number;
};

/**
 * Descriptor de operacion. `run` es un METODO (no una propiedad) a proposito: asi un
 * `ProOperation<{degrees:number}>` cabe en una lista de `ProOperation<unknown>`.
 */
export type ProOperation<TOptions = void> = {
  /** Id estable (`rotate-all`, `compress`...). Se guarda en `ProSnapshot.opId`. */
  id: string;
  /** Clave de la etiqueta en `PRO_STRINGS[lang].operations`. */
  labelKey: string;
  kind: ProOperationKind;
  /**
   * La operacion no cambia el numero de paginas: el commit reutiliza el del snapshot anterior en vez
   * de recontarlas (ahorra cargar el PDF entero otra vez).
   */
  preservesPageCount?: boolean;
  run(bytes: Uint8Array, opts: TOptions, ctx: ProOperationContext): Promise<ProOperationResult>;
};

/** Resultado de ejecutar una operacion con el adaptador. */
export type ProRunOutcome =
  | {
      ok: true;
      bytes: Uint8Array;
      pageCount?: number;
      warnings: ProWarning[];
      report?: unknown;
    }
  | { ok: false; cancelled: true; code: "cancelled" }
  | { ok: false; cancelled: false; code: PdfErrorCode };
