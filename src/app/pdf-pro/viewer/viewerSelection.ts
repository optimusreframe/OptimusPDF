/*
 * Seleccion de paginas (Wave 7 · U3), logica pura compartida por el almacen, el visor y las miniaturas:
 * Ctrl/Cmd+clic alterna, Shift+clic selecciona el rango desde el ancla, clic sencillo no cambia nada.
 */

export type SelectionGesture = { ctrl: boolean; shift: boolean };

export function isSelectionGesture(event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelectionGesture | null {
  if (event.shiftKey) return { ctrl: false, shift: true };
  if (event.ctrlKey || event.metaKey) return { ctrl: true, shift: false };
  return null;
}

export function toggled(current: ReadonlySet<number>, index: number): Set<number> {
  const next = new Set(current);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  return next;
}

export function rangeBetween(from: number, to: number): Set<number> {
  const [low, high] = from <= to ? [from, to] : [to, from];
  const next = new Set<number>();
  for (let i = low; i <= high; i += 1) next.add(i);
  return next;
}

export function allPages(count: number): Set<number> {
  const next = new Set<number>();
  for (let i = 0; i < count; i += 1) next.add(i);
  return next;
}

/** Resume la seleccion en texto de lectura para una region viva o una etiqueta («1, 3-5, 9»). */
export function describeSelection(pages: Iterable<number>): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i + 1 ? `${sorted[i] + 1}-${sorted[j] + 1}` : j === i + 1 ? `${sorted[i] + 1}, ${sorted[j] + 1}` : `${sorted[i] + 1}`);
    i = j + 1;
  }
  return parts.join(", ");
}
