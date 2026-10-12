/** Recarga la pagina. Vive aparte para poder sustituirlo en las pruebas (jsdom no implementa `location.reload`). */
export function reloadPage(): void {
  window.location.reload();
}
