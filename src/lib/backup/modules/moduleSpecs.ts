import { MAX_DOCUMENT_BYTES } from "@/app/sign-pdf/signLimits";
import { CURRENT_DRAFTS_SCHEMA } from "@/lib/backup/migrations/drafts";
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

export const SETTINGS_MODULE = "settings";
export const DRAFTS_MODULE = "drafts";

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
