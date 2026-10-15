/**
 * Guarda de navegacion OPT-IN (Fase 0 «Firma agil», U0.3): una pantalla con trabajo sin terminar (Firmar PDF) registra una
 * funcion y los enlaces internos de la aplicacion (`GuardedLink`) la consultan antes de navegar. Sin guarda registrada
 * (todas las demas herramientas, y Firmar sin progreso) no cambia nada: la navegacion sigue su curso.
 *
 * Es un registro de modulo, no un contexto de React: la consulta ocurre en el clic (`onNavigate` de `next/link`), no al
 * pintar, y asi la cabecera, la barra lateral y el pie no se vuelven a renderizar cuando cambia el estado de la guarda.
 *
 * Contrato de la guarda: recibe el destino (`href`) y un `proceed` que, si se llama, repite ESA navegacion saltandose la
 * guarda (lo usa la hoja «¿Salir de la firma?» al pulsar «Salir»). Devuelve `true` para CANCELAR la navegacion en curso
 * (y decidir ella cuando seguir) y `false` para dejarla pasar.
 */
export type NavigationGuard = (href: string, proceed: () => void) => boolean;

let current: NavigationGuard | null = null;
let bypassDepth = 0;

/** Registra la guarda (una sola a la vez: gana la ultima). Devuelve la funcion que la retira. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

/** `true` = hay que cancelar la navegacion hacia `href` (la guarda se encarga de preguntar y, si procede, de llamar a `proceed`). */
export function interceptNavigation(href: string, proceed: () => void): boolean {
  if (bypassDepth > 0 || current === null) return false;
  return current(href, proceed);
}

/** Ejecuta `action` (la navegacion que `proceed` repite) sin que la guarda la vuelva a detener. */
export function runWithoutNavigationGuard(action: () => void): void {
  bypassDepth += 1;
  try {
    action();
  } finally {
    bypassDepth -= 1;
  }
}

/** Solo para tests: deja el registro como al arrancar. */
export function __resetNavigationGuardForTests(): void {
  current = null;
  bypassDepth = 0;
}
