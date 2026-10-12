import type { ComponentType } from "react";
import type { ProModeId, ProWarning } from "../proTypes";

/**
 * CONTRATO COMPARTIDO de los modos de PDF Pro (Wave 7 · U6/U7). Un modo es un componente con
 * sesion propia (Editar, Anotar, Firmar, Rellenar...) que se monta en la region central EN LUGAR
 * DEL VISOR y termina con «Aplicar» (UN snapshot) o «Descartar». NO cambiar estas firmas sin avisar.
 */
export type ProModeProps = {
  /** Documento actual (snapshot vigente). */
  file: File;
  bytes: Uint8Array;
  lang: "es" | "en";
  /** Crea UN snapshot con la etiqueta dada y devuelve al visor. Rechaza si no se pudo aplicar. */
  onApply: (
    bytes: Uint8Array,
    label: string,
    opts?: {
      warnings?: ProWarning[];
      /** Avisos ya redactados (fuente sustituida, original que permanece...): el host los muestra tras aplicar. */
      notices?: string[];
    },
  ) => Promise<void>;
  /** Descarta la sesion del modo (sin snapshot). */
  onCancel: () => void;
  /** El modo avisa de si tiene cambios sin aplicar (el host pregunta al salir). */
  onDirtyChange: (dirty: boolean) => void;
};

export type ProModeDefinition = {
  id: ProModeId;
  /** Pestana de PDF Pro que lo abre. */
  tab: "edit" | "annotate" | "sign" | "fill";
  /** Clave de etiqueta (en `PRO_STRINGS[lang].modes` u otra tabla del modo). */
  labelKey: string;
  Component: ComponentType<ProModeProps>;
  /** Herramienta suelta equivalente (informativo). */
  preferredTool?: string;
};
