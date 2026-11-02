/**
 * Limitador de peticiones por clave (IP) en MEMORIA, de ventana fija. Es de mejor esfuerzo y asi hay que decirlo: cada
 * instancia sin servidor tiene su propia memoria, se reinicia con los arranques en frio y no se comparte entre
 * instancias. Frena el abuso casual y los bucles descontrolados; para un ataque distribuido haria falta un almacen
 * compartido (fuera del alcance: la herramienta no guarda nada).
 */
export type RateLimiter = { allow: (key: string) => boolean };

export function createRateLimiter(options: {
  limit: number;
  windowMs: number;
  maxKeys?: number;
  now?: () => number;
}): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 5000;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return {
    allow(key) {
      const current = now();
      // Poda: la tabla nunca crece sin limite.
      if (hits.size >= maxKeys) {
        for (const [stored, entry] of hits) if (entry.resetAt <= current) hits.delete(stored);
        if (hits.size >= maxKeys) hits.clear();
      }
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= current) {
        hits.set(key, { count: 1, resetAt: current + options.windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= options.limit;
    },
  };
}
