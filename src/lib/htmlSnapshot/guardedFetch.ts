import { isBlockedParsedIp, parseIp } from "@/lib/htmlSnapshot/ipGuard";
import type { ResolvedAddress, Transport } from "@/lib/htmlSnapshot/nodeTransport";
import { SnapshotError, SNAPSHOT_LIMITS } from "@/lib/htmlSnapshot/types";
import { validateSnapshotUrl } from "@/lib/htmlSnapshot/urlGuard";

/**
 * Descarga de UNA direccion con todas las defensas de la ruta. Es el unico camino por el que el servidor sale a
 * Internet: la pagina, cada hoja de estilo y cada imagen pasan por aqui, y cada salto de una redireccion tambien.
 *
 * Por cada peticion (y por cada redireccion, hasta 5, seguidas A MANO):
 *   1. `validateSnapshotUrl`: esquema, puerto, usuario, nombre y IP literal.
 *   2. `resolve`: DNS (A y AAAA a la vez). Si ALGUNA direccion devuelta es privada, loopback, de enlace local, CGNAT,
 *      multicast, reservada, mapeada IPv4 o NAT64, se rechaza TODA la respuesta (un nombre con una publica y una
 *      privada tambien cae).
 *   3. El `transport` conecta a la IP ya validada, no al nombre (anti DNS-rebinding).
 *   4. Estado 2xx; tipo de contenido dentro de la lista de este tipo de recurso; cuerpo leido con tope en bytes
 *      DESCOMPRIMIDOS (se corta la lectura al pasarse, sin fiarse de `Content-Length`).
 * Todo cuelga de una senal de plazo: pasado el tiempo total, la conexion se cierra.
 */

export type Resolver = (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>;

export type FetchKind = "page" | "css" | "image";

export type GuardedFetchDeps = {
  resolve: Resolver;
  transport: Transport;
};

export type GuardedFetchResult = {
  /** Direccion final (tras las redirecciones). */
  url: URL;
  /** Tipo MIME sin parametros, en minusculas. */
  mime: string;
  /** Valor completo de `Content-Type` (para el charset). */
  contentType: string;
  bytes: Uint8Array;
};

const ACCEPT: Record<FetchKind, string> = {
  page: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  css: "text/css,*/*;q=0.1",
  image: "image/*,*/*;q=0.1",
};

const PAGE_MIMES = new Set(["text/html", "application/xhtml+xml"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function mimeAllowed(kind: FetchKind, mime: string): boolean {
  if (kind === "page") return PAGE_MIMES.has(mime);
  if (kind === "css") return mime === "text/css";
  return /^image\/[a-z0-9.+-]+$/.test(mime);
}

/** Resuelve `hostname` y exige que TODAS las direcciones sean publicas. Devuelve la primera. */
async function resolveSafe(
  hostname: string,
  literalIp: string | null,
  deps: GuardedFetchDeps,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  if (literalIp) {
    const parsed = parseIp(literalIp);
    if (!parsed || isBlockedParsedIp(parsed)) throw new SnapshotError("blocked-address");
    return { address: literalIp, family: parsed.family };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await deps.resolve(hostname, signal);
  } catch (error) {
    throw error instanceof SnapshotError ? error : new SnapshotError(signal.aborted ? "timeout" : "unreachable");
  }
  if (addresses.length === 0) throw new SnapshotError("unreachable");
  for (const entry of addresses) {
    const parsed = parseIp(entry.address);
    if (!parsed || isBlockedParsedIp(parsed)) throw new SnapshotError("blocked-address");
  }
  return addresses[0];
}

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number, close: () => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) {
        close();
        throw new SnapshotError("too-large");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    close();
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function guardedFetch(
  rawUrl: string,
  kind: FetchKind,
  options: { maxBytes: number },
  deps: GuardedFetchDeps,
  signal: AbortSignal,
): Promise<GuardedFetchResult> {
  let current = rawUrl;

  for (let hop = 0; hop <= SNAPSHOT_LIMITS.maxRedirects; hop += 1) {
    if (signal.aborted) throw new SnapshotError("timeout");

    const checked = validateSnapshotUrl(current);
    if (!checked.ok) throw new SnapshotError(checked.code);
    // El fragmento no viaja nunca al servidor.
    const target = new URL(checked.url.href);
    target.hash = "";

    const address = await resolveSafe(checked.hostname, checked.literalIp, deps, signal);

    let response;
    try {
      response = await deps.transport({ url: target, address, signal, accept: ACCEPT[kind] });
    } catch (error) {
      throw error instanceof SnapshotError ? error : new SnapshotError(signal.aborted ? "timeout" : "unreachable");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers["location"];
      response.close();
      if (!location || hop === SNAPSHOT_LIMITS.maxRedirects) throw new SnapshotError("unreachable");
      try {
        // Cada salto vuelve al principio del bucle y se valida entero (esquema, puerto, nombre, DNS, IP).
        current = new URL(location, target).href;
      } catch {
        throw new SnapshotError("unreachable");
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      response.close();
      throw new SnapshotError("unreachable");
    }

    const contentType = response.headers["content-type"] ?? "";
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (!mimeAllowed(kind, mime)) {
      response.close();
      throw new SnapshotError("unsupported-type");
    }
    // `Content-Length` solo sirve para cortar antes cuando no hay compresion; el limite real es el de bytes leidos.
    const declared = Number(response.headers["content-length"]);
    if (!response.headers["content-encoding"] && Number.isFinite(declared) && declared > options.maxBytes) {
      response.close();
      throw new SnapshotError("too-large");
    }

    try {
      const bytes = await readCapped(response.body, options.maxBytes, response.close);
      return { url: target, mime, contentType, bytes };
    } catch (error) {
      throw error instanceof SnapshotError ? error : new SnapshotError(signal.aborted ? "timeout" : "unreachable");
    }
  }
  throw new SnapshotError("unreachable");
}
