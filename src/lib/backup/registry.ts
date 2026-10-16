import { SIGNATURES_MODULE_SPEC } from "@/lib/backup/modules/signatures";
import type { ModuleRegistry } from "@/lib/backup/types";

/**
 * Modulos que sabe leer y escribir esta version. Los demas modulos del
 * paquete (plantillas+documentos, ajustes, borradores: U4.5-U4.7) se anadiran
 * aqui con su spec; mientras tanto un paquete que los traiga los ignora con
 * un aviso `unknownModule`.
 */
export const DEFAULT_MODULE_REGISTRY: ModuleRegistry = {
  [SIGNATURES_MODULE_SPEC.name]: SIGNATURES_MODULE_SPEC,
};
