import type { GuardedFetchDeps } from "@/lib/htmlSnapshot/guardedFetch";
import type { TransportResponse } from "@/lib/htmlSnapshot/nodeTransport";
import { SnapshotError, SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";

/**
 * Presupuesto de peticiones SALIENTES de UN snapshot. Sin el, una pagina con cientos de recursos repartidos en muchos
 * servidores convierte una consulta en una avalancha de conexiones (amplificacion) y ocupa el hilo de resolucion de nombres.
 *
 *   - como mucho `maxOutboundRequests` (40) peticiones en total, contando CADA redireccion y cada recurso;
 *   - como mucho `maxHosts` (6) servidores distintos (cada nombre nuevo cuesta una resolucion DNS);
 *   - como mucho `maxOutboundConcurrent` (4) conexiones a la vez, y `maxOutboundPerHost` (2) contra un mismo servidor.
 *
 * Lo que se pasa de presupuesto falla como `unreachable`: para un recurso (imagen, hoja) solo lo omite; para la pagina o una
 * redireccion, aborta la consulta. La ocupacion de una conexion dura hasta que se termina de leer el cuerpo o se cierra.
 */
export class RequestBudget {
  private requests = 0;
  private readonly hosts = new Set<string>();
  private active = 0;
  private readonly perHost = new Map<string, number>();
  private readonly waiters: Array<{ host: string; start: () => void }> = [];

  constructor(
    private readonly limits: { requests: number; hosts: number; concurrent: number; perHost: number } = {
      requests: SNAPSHOT_LIMITS.maxOutboundRequests,
      hosts: SNAPSHOT_LIMITS.maxHosts,
      concurrent: SNAPSHOT_LIMITS.maxOutboundConcurrent,
      perHost: SNAPSHOT_LIMITS.maxOutboundPerHost,
    },
  ) {}

  /** Anota un servidor; si es el septimo distinto, falla. */
  noteHost(host: string): void {
    if (this.hosts.has(host)) return;
    if (this.hosts.size >= this.limits.hosts) throw new SnapshotError("unreachable");
    this.hosts.add(host);
  }

  /** Cuenta la peticion y espera un hueco de concurrencia. Devuelve la funcion que lo libera (idempotente). */
  async acquire(host: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new SnapshotError("timeout");
    this.noteHost(host);
    if (this.requests >= this.limits.requests) throw new SnapshotError("unreachable");
    this.requests += 1;

    if (this.canStart(host)) {
      this.take(host);
    } else {
      // `pump` reserva el hueco (`take`) antes de despertar a quien espera.
      await new Promise<void>((resolve, reject) => {
        const waiter = {
          host,
          start: () => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new SnapshotError("timeout"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(waiter);
      });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.perHost.set(host, (this.perHost.get(host) ?? 1) - 1);
      this.pump();
    };
  }

  private canStart(host: string): boolean {
    return this.active < this.limits.concurrent && (this.perHost.get(host) ?? 0) < this.limits.perHost;
  }

  private take(host: string): void {
    this.active += 1;
    this.perHost.set(host, (this.perHost.get(host) ?? 0) + 1);
  }

  /** Despierta al primero que ya puede empezar (por orden de llegada). */
  private pump(): void {
    for (let index = 0; index < this.waiters.length; index += 1) {
      const waiter = this.waiters[index];
      if (this.canStart(waiter.host)) {
        // Se reserva el hueco ANTES de despertarlo, para que otro no se lo quite entre medias.
        this.waiters.splice(index, 1);
        this.take(waiter.host);
        waiter.start();
        return;
      }
    }
  }
}

/**
 * Envuelve resolucion y transporte con el presupuesto. El hueco de concurrencia se ocupa mientras dura la peticion INCLUIDA la
 * lectura del cuerpo (se libera al terminar de leerlo o al cerrarlo).
 */
export function withRequestBudget(deps: GuardedFetchDeps, budget: RequestBudget): GuardedFetchDeps {
  return {
    resolve: (hostname, signal) => {
      budget.noteHost(hostname);
      return deps.resolve(hostname, signal);
    },
    transport: async (request) => {
      const release = await budget.acquire(request.url.hostname, request.signal);
      let response: TransportResponse;
      try {
        response = await deps.transport(request);
      } catch (error) {
        release();
        throw error;
      }
      return {
        status: response.status,
        headers: response.headers,
        body: (async function* () {
          try {
            yield* response.body;
          } finally {
            release();
          }
        })(),
        close: () => {
          release();
          response.close();
        },
      };
    },
  };
}
