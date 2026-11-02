import http from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { pipeline, type Readable } from "node:stream";
import { parseIp, sameIp } from "@/lib/htmlSnapshot/ipGuard";
import { SnapshotError, SNAPSHOT_USER_AGENT } from "@/lib/htmlSnapshot/types";

/**
 * Transporte HTTP(S) REAL de la ruta de servidor (solo Node). Se inyecta en `guardedFetch`, que es quien decide QUE se
 * puede pedir; este modulo solo decide COMO se hace la conexion, y lo hace de forma que el DNS no se pueda cambiar a
 * mitad de camino (anti DNS-rebinding):
 *
 *   - `guardedFetch` resuelve el nombre, comprueba que TODAS las direcciones sean publicas y elige una;
 *   - aqui la conexion va a ESA direccion (la opcion `lookup` devuelve siempre la IP ya validada y nunca vuelve a
 *     preguntar al DNS), mientras que SNI, la validacion del certificado y la cabecera `Host` siguen usando el nombre;
 *   - al conectar se comprueba ademas que la direccion remota del socket es la validada.
 *
 * Sin cookies, sin autenticacion, sin cabeceras de la persona: solo un `User-Agent` fijo y `Accept`. Sin reutilizar
 * conexiones (`agent: false`, `Connection: close`). No registra nada.
 */

export type ResolvedAddress = { address: string; family: 4 | 6 };

export type TransportRequest = {
  url: URL;
  /** Direccion YA validada a la que hay que conectar. */
  address: ResolvedAddress;
  signal: AbortSignal;
  accept: string;
};

export type TransportResponse = {
  status: number;
  /** Nombres en minusculas. */
  headers: Record<string, string>;
  /** Cuerpo YA descomprimido, para leerlo con `for await`. Quien lo lee corta cuando llega a su limite. */
  body: AsyncIterable<Uint8Array>;
  /** Cierra la conexion y descarta lo que quede. */
  close: () => void;
};

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** `Content-Encoding` -> flujo de descompresion. Acepta solo los que se anuncian en `Accept-Encoding`. */
function decoderFor(encoding: string): ReturnType<typeof createGunzip> | null | "identity" {
  const value = encoding.trim().toLowerCase();
  if (value === "" || value === "identity") return "identity";
  if (value === "gzip" || value === "x-gzip") return createGunzip();
  if (value === "deflate") return createInflate();
  if (value === "br") return createBrotliDecompress();
  return null;
}

/**
 * Descomprime `source` segun `encoding`. Se exporta para poder probar la bomba de gzip SIN red: el flujo solo produce
 * datos cuando quien lo lee los pide, asi que cortar la lectura al llegar al limite detiene la descompresion.
 */
export function decodeBody(source: Readable, encoding: string): { stream: Readable; close: () => void } {
  const decoder = decoderFor(encoding);
  if (decoder === null) {
    source.destroy();
    throw new SnapshotError("unsupported-type");
  }
  if (decoder === "identity") return { stream: source, close: () => source.destroy() };
  pipeline(source, decoder, () => {
    /* los errores llegan al lector por el propio flujo */
  });
  return {
    stream: decoder,
    close: () => {
      decoder.destroy();
      source.destroy();
    },
  };
}

function flattenHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

export const nodeTransport: Transport = ({ url, address, signal, accept }) =>
  new Promise<TransportResponse>((resolve, reject) => {
    if (signal.aborted) {
      reject(new SnapshotError("timeout"));
      return;
    }
    const secure = url.protocol === "https:";
    const client = secure ? https : http;
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;

    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof SnapshotError ? error : new SnapshotError(signal.aborted ? "timeout" : "unreachable"));
    };

    const request = client.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        signal,
        headers: {
          "user-agent": SNAPSHOT_USER_AGENT,
          accept,
          "accept-encoding": "gzip, deflate, br",
          connection: "close",
        },
        // Anti DNS-rebinding: la conexion va SIEMPRE a la IP ya validada. Node 20+ pide `all: true` (autoSelectFamily).
        lookup: (_name, options, callback) => {
          const entry = { address: address.address, family: address.family };
          if (options && typeof options === "object" && (options as { all?: boolean }).all) {
            (callback as unknown as (error: null, addresses: typeof entry[]) => void)(null, [entry]);
          } else {
            callback(null, entry.address, entry.family);
          }
        },
      },
      (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        try {
          const headers = flattenHeaders(response.headers);
          const status = response.statusCode ?? 0;
          // Las redirecciones y los errores no necesitan cuerpo: se descarta sin leerlo ni descomprimirlo.
          if (status < 200 || status >= 300) {
            settled = true;
            resolve({
              status,
              headers,
              body: (async function* () {
                /* sin cuerpo */
              })(),
              close: () => {
                response.destroy();
                request.destroy();
              },
            });
            response.destroy();
            return;
          }
          const decoded = decodeBody(response, headers["content-encoding"] ?? "");
          settled = true;
          resolve({
            status,
            headers,
            body: decoded.stream as AsyncIterable<Uint8Array>,
            close: () => {
              decoded.close();
              request.destroy();
            },
          });
        } catch (error) {
          request.destroy();
          fail(error);
        }
      },
    );

    // La direccion remota tiene que ser la validada (defensa en profundidad frente a un `lookup` que se ignore).
    request.on("socket", (socket) => {
      socket.once("connect", () => {
        const remote = (socket.remoteAddress ?? "").replace(/^::ffff:/i, "");
        if (remote !== "" && parseIp(remote) && !sameIp(remote, address.address)) {
          request.destroy(new SnapshotError("blocked-address"));
        }
      });
    });
    request.on("error", fail);
    request.end();
  });
