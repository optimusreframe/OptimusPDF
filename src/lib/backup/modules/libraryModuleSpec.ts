import { CURRENT_LIBRARY_SCHEMA } from "@/lib/backup/migrations/library";
import { LIBRARY_LIMITS } from "@/lib/docLibrary/types";
import type { PackageModuleSpec } from "@/lib/backup/types";

/**
 * Especificacion (solo constantes) del modulo «Plantillas + Documentos» (U4.5). Vive aparte de `library.ts` (como
 * `moduleSpecs.ts` con Ajustes y Borradores) para que `registry.ts` —que carga todo lector de paquetes— no arrastre los
 * almacenes de la biblioteca ni los validadores: el registro solo necesita saber que carpetas y topes tiene el modulo.
 */

export const LIBRARY_MODULE = "library";
/** `documents/index.json` (50 huellas de hasta 200 paginas ≈ 7 MB) y cada plantilla: 16 MiB dejan holgura. */
export const MAX_LIBRARY_JSON_BYTES = 16 * 1024 * 1024;

export const LIBRARY_MODULE_SPEC: PackageModuleSpec = {
  name: LIBRARY_MODULE,
  schemaVersion: CURRENT_LIBRARY_SCHEMA,
  folders: ["documents", "templates"],
  maxFileBytes: LIBRARY_LIMITS.maxDocumentBytes,
  maxJsonBytes: MAX_LIBRARY_JSON_BYTES,
};
