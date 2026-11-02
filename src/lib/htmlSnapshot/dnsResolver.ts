import { lookup } from "node:dns/promises";
import type { ResolvedAddress } from "@/lib/htmlSnapshot/nodeTransport";
import type { Resolver } from "@/lib/htmlSnapshot/guardedFetch";
import { SnapshotError } from "@/lib/htmlSnapshot/types";

/**
 * Resolucion DNS real: A y AAAA a la vez (`all: true`), en el orden en que las devuelve el sistema (`verbatim`). El
 * plazo de la peticion corta la espera. `lookup` pasa por `getaddrinfo`, asi que tambien respeta `/etc/hosts`: un nombre
 * que apunte a 127.0.0.1 se detecta por la IP, no por el nombre.
 */
export const dnsResolver: Resolver = async (hostname, signal) => {
  const lookupPromise = lookup(hostname, { all: true, verbatim: true });
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new SnapshotError("timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // Si se gana la carrera por el plazo, `lookup` termina solo despues; su rechazo tardio no debe quedar sin atender.
  lookupPromise.catch(() => undefined);
  const results = await Promise.race([lookupPromise, aborted]);
  return results.map((entry): ResolvedAddress => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));
};

/** Memoriza las resoluciones DENTRO de una misma peticion: la pagina y sus recursos usan la misma IP validada. */
export function memoizeResolver(resolver: Resolver): Resolver {
  const cache = new Map<string, Promise<ResolvedAddress[]>>();
  return (hostname, signal) => {
    let pending = cache.get(hostname);
    if (!pending) {
      pending = resolver(hostname, signal);
      cache.set(hostname, pending);
      pending.catch(() => cache.delete(hostname));
    }
    return pending;
  };
}
