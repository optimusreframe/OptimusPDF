import type { ToolSlug } from "@/lib/tools-registry";

/**
 * Traspaso de un archivo entre herramientas (Wave 7 · U1): «Abrir en PDF Pro» /
 * «Seguir en PDF Pro» de `ToolShell`.
 *
 * Es un store A NIVEL DE MODULO, en memoria de la pestana: sobrevive a una navegacion de cliente
 * (`<Link>`, `router.push`) porque el modulo no se recarga, y desaparece con una recarga completa.
 * NUNCA se persiste (ni localStorage ni IndexedDB) y nunca sale del dispositivo: el `File` pasa de
 * una pantalla a la otra por referencia. Un solo hueco: un nuevo `setHandoff` reemplaza al anterior;
 * `takeHandoff` lo consume (se lee una unica vez), asi que recargar `/pdf-pro` o volver atras no
 * reabre un archivo viejo.
 */
export type ProHandoff = {
  /** El archivo (un PDF; PDF Pro lo vuelve a validar al recibirlo). */
  file: File;
  /** Herramienta de origen (para el rotulo «Abierto desde …»). */
  from: ToolSlug;
  /** PDF que habia en la herramienta de origen (solo se abre el primero: PDF Pro avisa de que hay mas). */
  total: number;
};

let pending: ProHandoff | null = null;

/** Deja un archivo listo para que PDF Pro lo recoja. Reemplaza al que hubiera. */
export function setHandoff(file: File, from: ToolSlug, total = 1): void {
  pending = { file, from, total: Math.max(1, Math.floor(total)) };
}

/** Recoge (y vacia) el archivo pendiente, o `null` si no hay. */
export function takeHandoff(): ProHandoff | null {
  const handoff = pending;
  pending = null;
  return handoff;
}

/** Hay un archivo esperando (sin consumirlo). */
export function hasHandoff(): boolean {
  return pending !== null;
}

/** Descarta el archivo pendiente sin abrirlo. */
export function clearHandoff(): void {
  pending = null;
}
