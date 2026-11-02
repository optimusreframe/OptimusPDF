import type { GuardedFetchDeps } from "@/lib/htmlSnapshot/guardedFetch";
import type { ResolvedAddress, Transport, TransportRequest, TransportResponse } from "@/lib/htmlSnapshot/nodeTransport";

/**
 * Entorno SIN RED para las pruebas del servidor: un DNS falso (nombre -> direcciones) y un transporte falso (URL ->
 * respuesta). Registra cada conexion para poder comprobar a QUE IP se conecto y que no se hizo ninguna que no debia.
 */
export type FakeResponse = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | AsyncIterable<Uint8Array>;
};

export type Env = GuardedFetchDeps & {
  calls: TransportRequest[];
  lookups: string[];
  closed: number;
};

export function textBody(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function* chunked(bytes: Uint8Array, size = 16 * 1024): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}

export function makeEnv(options: {
  dns?: Record<string, ResolvedAddress[]>;
  routes: Record<string, FakeResponse | ((request: TransportRequest) => FakeResponse)>;
}): Env {
  const calls: TransportRequest[] = [];
  const lookups: string[] = [];
  const env: Env = {
    calls,
    lookups,
    closed: 0,
    resolve: async (hostname) => {
      lookups.push(hostname);
      const found = options.dns?.[hostname] ?? [{ address: "93.184.216.34", family: 4 }];
      return found;
    },
    transport: (async (request: TransportRequest): Promise<TransportResponse> => {
      calls.push(request);
      const key = request.url.href;
      const route = options.routes[key];
      if (!route) throw new Error(`sin ruta falsa para ${key}`);
      const spec = typeof route === "function" ? route(request) : route;
      const body = spec.body ?? "";
      const iterable: AsyncIterable<Uint8Array> =
        typeof body === "string" ? chunked(textBody(body)) : body instanceof Uint8Array ? chunked(body) : body;
      return {
        status: spec.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...(spec.headers ?? {}) },
        body: iterable,
        close: () => {
          env.closed += 1;
        },
      };
    }) as Transport,
  };
  return env;
}

export const noAbort = new AbortController().signal;
