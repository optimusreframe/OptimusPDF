/**
 * Limitador de peticiones por clave (IP) en MEMORIA, de ventana fija. Es de mejor esfuerzo y asi hay que decirlo: cada
 * instancia sin servidor tiene su propia memoria, se reinicia con los arranques en frio y no se comparte entre
 * instancias, de modo que quien reparte sus peticiones entre instancias lo esquiva. Frena el abuso casual y los bucles
 * descontrolados; la PROTECCION REAL contra el abuso es una regla de limite de tasa en el firewall de la plataforma (Vercel),
 * que no depende de esta memoria.
 *
 * La tabla no crece sin limite: al llenarse se descartan primero las claves caducadas y, si sigue llena, las MAS ANTIGUAS (un
 * `Map` conserva el orden de insercion). Nunca se vacia entera: eso permitiria a quien llene la tabla con claves falsas
 * borrar su propio contador (y el de todos) y saltarse el limite.
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
      if (!hits.has(key) && hits.size >= maxKeys) {
        for (const [stored, entry] of hits) if (entry.resetAt <= current) hits.delete(stored);
        if (hits.size >= maxKeys) {
          // Sigue llena de claves vigentes: se descarta el 10 % mas antiguo.
          let toDrop = Math.max(1, Math.ceil(maxKeys / 10));
          for (const stored of hits.keys()) {
            hits.delete(stored);
            toDrop -= 1;
            if (toDrop === 0) break;
          }
        }
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
