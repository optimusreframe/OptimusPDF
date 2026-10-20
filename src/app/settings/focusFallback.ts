/**
 * Tras cerrar una hoja, `Sheet` devuelve el foco al botón que la abrió. Si ese botón YA NO EXISTE (el aviso de respaldo
 * desaparece al terminar el respaldo), el foco caería a `<body>`. Esto espera a que la hoja termine de salir (su animación)
 * y, solo si el foco sigue en `<body>`, lo lleva a `target()`. No hace nada si el foco ya está en otra parte.
 */
export function focusFallbackWhenIdle(target: () => HTMLElement | null | undefined, timeoutMs = 2500): void {
  const started = Date.now();
  const tick = () => {
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
      if (Date.now() - started < timeoutMs) window.setTimeout(tick, 60);
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body) target()?.focus({ preventScroll: true });
  };
  window.setTimeout(tick, 60);
}
