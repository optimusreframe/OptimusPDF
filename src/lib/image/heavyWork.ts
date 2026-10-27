/**
 * Semaforo de trabajo pesado con fotos: mientras se PREPARAN las fotos del PDF (decodificar/reducir/codificar, cientos de MB
 * en un iPhone), las miniaturas que aun esten en cola esperan. Asi nunca hay dos decodificaciones de fotos grandes a la vez
 * (la memoria del navegador no las admite) y el progreso del PDF no compite con las miniaturas de las fotos que siguen
 * cargandose.
 */
let depth = 0;
let waiters: Array<() => void> = [];

/** Empieza un trabajo pesado; devuelve la funcion que lo termina (idempotente). */
export function beginHeavyWork(): () => void {
  depth += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    depth -= 1;
    if (depth === 0) {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    }
  };
}

/** Se resuelve cuando no hay ningun trabajo pesado en marcha (de inmediato si ya no lo hay). */
export function whenNoHeavyWork(): Promise<void> {
  if (depth === 0) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}
