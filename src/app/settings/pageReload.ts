/** Recarga la página (aparte para poder sustituirla en las pruebas: jsdom no deja redefinir `window.location`). */
export function reloadPage(): void {
  window.location.reload();
}
