/**
 * Comparativa de tamaño de «Guardar»: la base «sin optimizar» es la estimacion de «Original» del MISMO calculo (`estimateSize`), no
 * una cifra aparte (antes salia un peso que no coincidia con el del PDF «Original»). Cuando el ajuste elegido pesa casi lo mismo
 * que Original (dentro del 5 %), comparar enseñaria una diferencia inventada: se dice que ya esta optimizado.
 */
export const ALREADY_OPTIMIZED_TOLERANCE = 0.05;

export function isAlreadyOptimized(optimizedBytes: number, originalBytes: number, tolerance = ALREADY_OPTIMIZED_TOLERANCE): boolean {
  if (!(originalBytes > 0) || !(optimizedBytes >= 0)) return false;
  return Math.abs(optimizedBytes - originalBytes) / originalBytes <= tolerance;
}
