import { Resolver as DnsResolver } from "node:dns/promises";
import type { ResolvedAddress } from "@/lib/htmlSnapshot/nodeTransport";
import type { Resolver } from "@/lib/htmlSnapshot/guardedFetch";
import { SnapshotError } from "@/lib/htmlSnapshot/types";

/**
 * Resolucion DNS real con `dns.Resolver` (c-ares), NO con `getaddrinfo` (`dns.lookup`). `lookup` usa el hilo del sistema (el
 * `threadpool` de libuv, 4 hilos compartidos con el sistema de archivos y la compresion): unos pocos nombres lentos lo agotan y
 * congelan todo lo demas. c-ares es asincrono, no usa ese pool y admite un plazo corto y pocos reintentos propios.
 *
 *   - A y AAAA a la vez (`resolve4` + `resolve6`); el fallo de uno (ENODATA) no importa si el otro responde. Un CNAME se sigue solo.
 *   - Plazo de 2 s por intento y 2 intentos; el plazo total de la peticion cancela lo que quede (`cancel()`).
 *   - c-ares NO lee `/etc/hosts`: los nombres de maquinas locales no se resuelven (aqui es una ventaja). `validateSnapshotUrl` ya
 *     rechaza `localhost` y similares antes de llegar.
 *
 * Cada llamada usa su PROPIO `Resolver` para que cancelar una consulta no afecte a otras.
 */
export const DNS_TIMEOUT_MS = 2000;
export const DNS_TRIES = 2;

export const dnsResolver: Resolver = async (hostname, signal) => {
  const resolver = new DnsResolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
  const onAbort = () => resolver.cancel();
  if (signal.aborted) throw new SnapshotError("timeout");
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses: ResolvedAddress[] = [];
    if (v4.status === "fulfilled") for (const address of v4.value) addresses.push({ address, family: 4 });
    if (v6.status === "fulfilled") for (const address of v6.value) addresses.push({ address, family: 6 });
    if (addresses.length === 0) throw new SnapshotError(signal.aborted ? "timeout" : "unreachable");
    return addresses;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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
