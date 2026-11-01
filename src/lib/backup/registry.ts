import { SIGNATURES_MODULE_SPEC } from "@/lib/backup/modules/signatures";
// >>> U4.6 (Ajustes y Borradores): solo las specs, sin arrastrar las implementaciones
import { CLIENT_PROFILES_MODULE_SPEC, DRAFTS_MODULE_SPEC, SCAN_SESSIONS_MODULE_SPEC, SETTINGS_MODULE_SPEC } from "@/lib/backup/modules/moduleSpecs";
// <<< U4.6
// >>> U4.5 (Plantillas y documentos): solo la spec
import { LIBRARY_MODULE_SPEC } from "@/lib/backup/modules/libraryModuleSpec";
// <<< U4.5
import type { ModuleRegistry } from "@/lib/backup/types";

/**
 * Modulos que sabe leer y escribir esta version. Los demas modulos del
 * paquete que aun no tengan su spec aqui se ignoran con un aviso
 * `unknownModule`.
 */
export const DEFAULT_MODULE_REGISTRY: ModuleRegistry = {
  [SIGNATURES_MODULE_SPEC.name]: SIGNATURES_MODULE_SPEC,
  // >>> U4.6
  [SETTINGS_MODULE_SPEC.name]: SETTINGS_MODULE_SPEC,
  [DRAFTS_MODULE_SPEC.name]: DRAFTS_MODULE_SPEC,
  // <<< U4.6
  // >>> Sesiones del Escaner (respaldo): solo la spec
  [SCAN_SESSIONS_MODULE_SPEC.name]: SCAN_SESSIONS_MODULE_SPEC,
  // <<< Sesiones del Escaner
  // >>> Perfiles de cliente del autorrelleno (F3): solo la spec
  [CLIENT_PROFILES_MODULE_SPEC.name]: CLIENT_PROFILES_MODULE_SPEC,
  // <<< Perfiles de cliente
  // >>> U4.5
  [LIBRARY_MODULE_SPEC.name]: LIBRARY_MODULE_SPEC,
  // <<< U4.5
};
