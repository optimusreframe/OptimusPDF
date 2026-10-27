"use client";

import { useEffect, useState } from "react";

/**
 * `false` en el primer pintado y `true` despues de `tasks` tareas del navegador (un `setTimeout(0)` cada una). Sirve para
 * REPARTIR el primer pintado de una pantalla grande en varias tareas cortas: en WebKit, montar de golpe la lista de archivos, la
 * rejilla de miniaturas, la vista previa de hojas y todo el panel de opciones sumaba una tarea de 130-240 ms justo al elegir las
 * fotos. Lo imprescindible se pinta ya; lo que esta mas abajo, una tarea despues.
 */
export function useAfterTasks(tasks = 1): boolean {
  const [elapsed, setElapsed] = useState(tasks <= 0 ? tasks : 0);
  useEffect(() => {
    if (elapsed >= tasks) return;
    const id = setTimeout(() => setElapsed((current) => current + 1), 0);
    return () => clearTimeout(id);
  }, [elapsed, tasks]);
  return elapsed >= tasks;
}
