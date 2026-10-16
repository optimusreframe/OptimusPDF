/*
 * Marcas sobre los `File` de la ronda para la aplicacion automatica de plantillas (Fase 2 · U2.4). Viven en `WeakMap`/
 * `WeakSet` ligadas al objeto `File`, como el `DocId` (`docIdOf`): no ensucian la sesion y se van con el archivo.
 *
 *  - «restaurado»: el archivo llego de un borrador, una configuracion importada o un «Deshacer» de documentos quitados. Lo
 *    que traiga ese trabajo MANDA: nunca se le aplica una plantilla ni el automapeo por encima.
 *  - «de la biblioteca»: el archivo se abrio desde «Mis documentos» (traspaso); su plantilla es la del documento, sin
 *    buscar por huella.
 */

const restored = new WeakSet<File>();
const fromLibrary = new WeakMap<File, string>();

export function markRestored(files: readonly File[]): void {
  for (const file of files) restored.add(file);
}

export function isRestored(file: File): boolean {
  return restored.has(file);
}

export function markFromLibrary(file: File, documentId: string): void {
  fromLibrary.set(file, documentId);
}

export function libraryIdOf(file: File): string | null {
  return fromLibrary.get(file) ?? null;
}
