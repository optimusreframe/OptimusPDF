import type { ComponentType } from "react";
import type { Language } from "@/lib/i18n";
import type { ToolSlug } from "@/lib/tools-registry";
import { getProStrings } from "@/app/pdf-pro/proStrings";

/**
 * Registro de exportaciones de la pestaña «Convertir» (Wave 7 · U5 deja el contenedor; U8 las implementa).
 *
 * Hoy hay DOS marcadores funcionales (imagenes y texto): describen la exportacion y abren la herramienta
 * suelta equivalente en otra pestaña. Para implementar una, U8 llama a `registerProExport` con la MISMA
 * `id` y un `run`: la tarjeta pasa a mostrar «Exportar» y descarga lo que devuelva. Nada mas cambia.
 */

export type ProExportResult = { blob: Blob; filename: string };

/** Contexto de una exportacion: el documento y las opciones elegidas en su mini-panel. */
export type ProExportContext = {
  name: string;
  language: Language;
  signal: AbortSignal;
  onProgress: (progress: number) => void;
  /** Opciones del mini-panel (`defaultOptions` si la tarjeta no tiene panel). */
  options?: unknown;
  /** Paginas elegidas en el visor o el organizador (0-based). */
  selectedPages?: readonly number[];
  pageCount?: number;
  /** El snapshot actual como `File` (los motores de conversion lo piden asi). */
  file?: File;
};

/** Props del mini-panel de opciones de una exportacion (tipado por formato en `ExportOptionPanels`). */
export type ProExportOptionsProps = {
  language: Language;
  // El registro es heterogeneo (una exportacion por formato): cada panel recibe SUS opciones.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOptions: (patch: any) => void;
  pageCount: number;
  selectedPages: readonly number[];
};

export type ProExport = {
  /** Id estable (`images`, `text`...). */
  id: string;
  title: (language: Language) => string;
  body: (language: Language) => string;
  /** Herramienta suelta equivalente (mientras no haya `run`). */
  slug: ToolSlug;
  /** La exportacion necesita red (se marca «Requiere conexión»). */
  requiresNetwork: boolean;
  /** Implementacion real (U8). Sin ella la tarjeta es un marcador. */
  run?(bytes: Uint8Array, context: ProExportContext): Promise<ProExportResult>;
  /** Opciones por defecto del mini-panel (una copia nueva por tarjeta). */
  defaultOptions?: () => unknown;
  /** Mini-panel de opciones; sin el, la tarjeta exporta directamente. */
  Options?: ComponentType<ProExportOptionsProps>;
  /** Motivo por el que NO se puede exportar con estas opciones (`null` = se puede). */
  validate?(options: unknown, info: { language: Language; pageCount: number; selectedPages: readonly number[] }): string | null;
  /** Las opciones elegidas necesitan red (OCR de respaldo). Sin esto vale `requiresNetwork`. */
  needsNetwork?(options: unknown): boolean;
};

const exportsById = new Map<string, ProExport>();
const order: string[] = [];

function put(entry: ProExport): void {
  if (!exportsById.has(entry.id)) order.push(entry.id);
  exportsById.set(entry.id, entry);
}

const DEFAULT_EXPORTS: readonly ProExport[] = [
  {
    id: "images",
    title: (language) => getProStrings(language).docTools.convert.imagesTitle,
    body: (language) => getProStrings(language).docTools.convert.imagesBody,
    slug: "pdf-to-jpg",
    requiresNetwork: false,
  },
  {
    id: "text",
    title: (language) => getProStrings(language).docTools.convert.textTitle,
    body: (language) => getProStrings(language).docTools.convert.textBody,
    slug: "pdf-to-text",
    requiresNetwork: false,
  },
];
for (const entry of DEFAULT_EXPORTS) put(entry);

/** Registra (o reemplaza, por `id`) una exportacion. */
export function registerProExport(entry: ProExport): void {
  put(entry);
}

/** Exportaciones en el orden de registro. */
export function getProExports(): ProExport[] {
  return order.map((id) => exportsById.get(id)!).filter(Boolean);
}

/** Solo para pruebas: deja el registro como al cargar el modulo. */
export function __resetProExportsForTests(): void {
  exportsById.clear();
  order.length = 0;
  for (const entry of DEFAULT_EXPORTS) put(entry);
}
