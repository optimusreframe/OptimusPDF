import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { Language } from "@/lib/i18n";
import type { PageMm } from "@/app/pdf-pro/ops/cropMath";
import type { ProOperation, ProSignatureState } from "@/app/pdf-pro/proTypes";
import type { DocToolId } from "@/app/pdf-pro/tabs/docToolsStrings";

/**
 * Contrato de una herramienta de documento de PDF Pro (Wave 7 · U5): la operacion (`ProOperation`) mas
 * lo que la interfaz necesita para ofrecerla con la misma forma que las demas (opciones iniciales,
 * «se puede aplicar» con motivo, etiqueta del snapshot, panel y vista previa).
 */

/** Lo que un panel puede saber del documento de trabajo (snapshot actual). */
export type DocToolContext = {
  language: Language;
  fileName: string;
  pageCount: number;
  byteLength: number;
  bytes: Uint8Array;
  snapshotId: string;
  signatures: ProSignatureState;
  wasEncrypted: boolean;
  /** Medidas de la primera pagina en mm, o `null` mientras no se leen / si no se pudieron leer. */
  firstPage: PageMm | null;
};

export type DocToolCheck = { ok: true } | { ok: false; reason: string };

export type DocPanelProps<T> = {
  options: T;
  setOptions: (patch: Partial<T>) => void;
  ctx: DocToolContext;
};

export type DocResultProps = { report: unknown; ctx: DocToolContext };

export type DocToolDefinition<T> = {
  id: DocToolId;
  /** Pestaña donde se ofrece. */
  tab: "home" | "protect";
  icon: LucideIcon;
  operation: ProOperation<T>;
  /** La operacion necesita red (se avisa «Requiere conexión»). */
  needsNetwork?: boolean;
  defaults(ctx: DocToolContext): T;
  canRun(options: T, ctx: DocToolContext): DocToolCheck;
  /** Etiqueta del snapshot («Marca de agua “CONFIDENCIAL”»). */
  describe(options: T, ctx: DocToolContext): string;
  Panel: ComponentType<DocPanelProps<T>>;
  /**
   * Opciones para dibujar la vista previa sobre la PRIMERA pagina sola, o `null` si esa pagina no se ve
   * afectada. Sin esta funcion no hay vista previa.
   */
  previewOptions?(options: T, ctx: DocToolContext): T | null;
  /** Resumen tras aplicar (p. ej. el ahorro de Comprimir). */
  Result?: ComponentType<DocResultProps>;
};
