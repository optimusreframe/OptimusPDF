/*
 * Orden de los turnos de la ceremonia (Firma agil · Fase 1 · U1.3). Puro: la sesion guarda solo una lista de ids de
 * firmante (`SignSession.turnOrder`); la cola de la ceremonia (`ceremonyQueue`) sale en el orden de la lista de
 * firmantes y aqui se reordena sin tocar esa lista (el color y el nombre por defecto de cada firmante dependen de su
 * posicion, y un turno distinto no debe cambiarlos).
 */

/**
 * La cola en el orden pedido: primero los firmantes que `order` nombra, tal como los nombra; despues los que no, en su
 * orden de siempre. Ids repetidos o que no estan en la cola se ignoran. Sin orden devuelve la misma cola.
 */
export function orderedQueue<T extends { id: string }>(queue: readonly T[], order?: readonly string[] | null): T[] {
  if (!order || order.length === 0) return [...queue];
  const byId = new Map(queue.map((item) => [item.id, item]));
  const out: T[] = [];
  for (const id of order) {
    const item = byId.get(id);
    if (item && !out.includes(item)) out.push(item);
  }
  for (const item of queue) if (!out.includes(item)) out.push(item);
  return out;
}

/**
 * Lo que viene de fuera (un borrador de IndexedDB, de una version anterior o manipulado) no se da por bueno: una lista
 * de ids de firmantes que existen, sin repetidos, o nada.
 */
export function sanitizeTurnOrder(raw: unknown, signerIds: readonly string[]): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value === "string" && signerIds.includes(value) && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Sube (`-1`) o baja (`+1`) un firmante un puesto. Devuelve la lista completa de ids en el orden nuevo, o `null` si no
 * hay nada que mover (esta en el extremo o no esta en la cola).
 */
export function moveTurn(queueIds: readonly string[], signerId: string, delta: -1 | 1): string[] | null {
  const index = queueIds.indexOf(signerId);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= queueIds.length) return null;
  const next = [...queueIds];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
