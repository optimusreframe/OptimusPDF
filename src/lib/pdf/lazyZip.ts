import type JSZipType from "jszip";

/**
 * jszip bajo demanda: quien solo necesita un ZIP al EXPORTAR no debe meter la libreria en el paquete inicial de la
 * pagina. Uso: `const JSZip = await loadJSZip(); const zip = new JSZip();`
 */
export async function loadJSZip(): Promise<typeof JSZipType> {
  const loaded = await import("jszip");
  return (loaded.default ?? loaded) as typeof JSZipType;
}
