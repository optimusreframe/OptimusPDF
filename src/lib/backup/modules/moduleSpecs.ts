import { MAX_DOCUMENT_BYTES } from "@/app/sign-pdf/signLimits";
import { CURRENT_CLIENT_PROFILES_SCHEMA } from "@/lib/backup/migrations/clientProfiles";
import { CURRENT_DRAFTS_SCHEMA } from "@/lib/backup/migrations/drafts";
import { CURRENT_SCAN_SESSIONS_SCHEMA } from "@/lib/backup/migrations/scanSessions";
import { CURRENT_SETTINGS_SCHEMA } from "@/lib/backup/migrations/settings";
import type { PackageModuleSpec } from "@/lib/backup/types";

/**
 * Especificaciones (solo constantes) de los modulos «Ajustes» y «Borradores» (U4.6). Viven aparte de sus
 * implementaciones para que `registry.ts` —que carga todo lector de paquetes— no arrastre los almacenes de borradores ni
 * los validadores: el registro solo necesita saber que carpetas y topes tiene cada modulo.
 */

/** `settings.json` real ocupa < 2 KiB: 64 KiB sobran y un paquete hostil no hace trabajo de mas. */
export const MAX_SETTINGS_JSON_BYTES = 64 * 1024;
/** 200 etiquetas x 5 valores x ~500 caracteres cabe de sobra en 512 KiB. */
export const MAX_VALUE_HISTORY_JSON_BYTES = 512 * 1024;
/** Indice + sesiones de Editar: acotado (los PDF y las imagenes tienen su propio tope). */
export const MAX_DRAFTS_JSON_BYTES = 8 * 1024 * 1024;
/** El tope de un PDF dentro de un borrador (el mismo de Firmar y de las herramientas). */
export const MAX_DRAFT_PDF_BYTES = MAX_DOCUMENT_BYTES;

/**
 * Sesiones en curso del Escaner (`scan-sessions/index.json` + una foto original por pagina). Las miniaturas y el resultado
 * procesado NO viajan: se vuelven a calcular desde el original y sus parametros al abrir la sesion. El indice de 50 sesiones
 * x 1 000 paginas con el texto reconocido (<= 10 000 caracteres por pagina) cabe de sobra en 24 MiB.
 */
export const MAX_SCAN_SESSIONS_JSON_BYTES = 24 * 1024 * 1024;
/** Una foto original (una camara de 100 Mpx guarda JPEG de ~30-50 MB): por encima de esto no es una pagina de escaneo. */
export const MAX_SCAN_ORIGINAL_BYTES = 64 * 1024 * 1024;

/**
 * Perfiles de cliente del autorrelleno (`client-profiles/profiles.json`): <= 20 perfiles x <= 40 valores de <= 500 caracteres
 * (~100 KB en el peor caso real); 1 MiB deja margen para el escapado y un paquete hostil no hace trabajo de mas.
 */
export const MAX_CLIENT_PROFILES_JSON_BYTES = 1024 * 1024;

export const SETTINGS_MODULE = "settings";
export const DRAFTS_MODULE = "drafts";
/**
 * Nombre del modulo EN EL PAQUETE. El contenedor solo admite `^[a-z][a-z0-9-]{0,31}$` (una sola carpeta, sin mayusculas), asi
 * que el `scanSessions` de la interfaz y de `globalPackage.ts` viaja como `scan-sessions`.
 */
export const SCAN_SESSIONS_MODULE = "scan-sessions";
/** Nombre en el paquete de los perfiles de cliente; en la interfaz y en `globalPackage.ts` es `clientProfiles`. */
export const CLIENT_PROFILES_MODULE = "client-profiles";

export const SETTINGS_MODULE_SPEC: PackageModuleSpec = {
  name: SETTINGS_MODULE,
  schemaVersion: CURRENT_SETTINGS_SCHEMA,
  folders: ["settings"],
  // Este modulo no lleva archivos que no sean JSON.
  maxFileBytes: 1024,
  maxJsonBytes: MAX_VALUE_HISTORY_JSON_BYTES,
};

export const DRAFTS_MODULE_SPEC: PackageModuleSpec = {
  name: DRAFTS_MODULE,
  schemaVersion: CURRENT_DRAFTS_SCHEMA,
  folders: ["drafts"],
  maxFileBytes: MAX_DRAFT_PDF_BYTES,
  maxJsonBytes: MAX_DRAFTS_JSON_BYTES,
};

export const SCAN_SESSIONS_MODULE_SPEC: PackageModuleSpec = {
  name: SCAN_SESSIONS_MODULE,
  schemaVersion: CURRENT_SCAN_SESSIONS_SCHEMA,
  folders: ["scan-sessions"],
  maxFileBytes: MAX_SCAN_ORIGINAL_BYTES,
  maxJsonBytes: MAX_SCAN_SESSIONS_JSON_BYTES,
};

export const CLIENT_PROFILES_MODULE_SPEC: PackageModuleSpec = {
  name: CLIENT_PROFILES_MODULE,
  schemaVersion: CURRENT_CLIENT_PROFILES_SCHEMA,
  folders: ["client-profiles"],
  // Este modulo no lleva archivos que no sean JSON.
  maxFileBytes: 1024,
  maxJsonBytes: MAX_CLIENT_PROFILES_JSON_BYTES,
};
