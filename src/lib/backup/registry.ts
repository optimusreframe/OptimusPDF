import { SIGNATURES_MODULE_SPEC } from "@/lib/backup/modules/signatures";
// >>> U4.6 (Ajustes y Borradores): solo las specs, sin arrastrar las implementaciones
import { DRAFTS_MODULE_SPEC, SETTINGS_MODULE_SPEC } from "@/lib/backup/modules/moduleSpecs";
// <<< U4.6
import type { ModuleRegistry } from "@/lib/backup/types";

/**
 * Modulos que sabe leer y escribir esta version. Los demas modulos del
 * paquete (plantillas+documentos: U4.5) se anadiran aqui con su spec;
 * mientras tanto un paquete que los traiga los ignora con un aviso
 * `unknownModule`.
 */
export const DEFAULT_MODULE_REGISTRY: ModuleRegistry = {
  [SIGNATURES_MODULE_SPEC.name]: SIGNATURES_MODULE_SPEC,
  // >>> U4.6
  [SETTINGS_MODULE_SPEC.name]: SETTINGS_MODULE_SPEC,
  [DRAFTS_MODULE_SPEC.name]: DRAFTS_MODULE_SPEC,
  // <<< U4.6
};
