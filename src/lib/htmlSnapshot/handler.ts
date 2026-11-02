import { dnsResolver } from "@/lib/htmlSnapshot/dnsResolver";
import type { GuardedFetchDeps } from "@/lib/htmlSnapshot/guardedFetch";
import { parseIp } from "@/lib/htmlSnapshot/ipGuard";
import { nodeTransport } from "@/lib/htmlSnapshot/nodeTransport";
import { createRateLimiter, type RateLimiter } from "@/lib/htmlSnapshot/rateLimit";
import { createSnapshot } from "@/lib/htmlSnapshot/snapshot";
import {
  SNAPSHOT_ERROR_STATUS,
  SNAPSHOT_LIMITS,
  SnapshotError,
  type SnapshotErrorCode,
} from "@/lib/htmlSnapshot/types";
import { validateSnapshotUrl } from "@/lib/htmlSnapshot/urlGuard";

/**
 * Logica de `POST /api/html-snapshot` (la ruta solo la enchufa). Defensas de esta capa, en el orden en que se aplican:
 *
 *   1. `Sec-Fetch-Site: same-origin` o `Origin` con el mismo host. OJO: esto NO autentica ni protege nada frente a un atacante:
 *      cualquier cliente que no sea un navegador pone esas cabeceras a mano. Solo evita que OTRAS PAGINAS usen la ruta desde el
 *      navegador de sus visitantes (y las peticiones de curiosos). La proteccion contra el abuso es el limite de tasa del
 *      firewall de la plataforma, no esta comprobacion.
 *   2. `Content-Type: application/json` y cuerpo de 4 KB como maximo (se corta la lectura, no se fia de Content-Length).
 *   3. Limitador por IP (10/minuto) y tope de 2 peticiones simultaneas por instancia. Ambos son EN MEMORIA y de mejor esfuerzo:
 *      por instancia, se reinician en frio y no se comparten (ver `rateLimit.ts`).
 *   4. Validacion de la direccion (`validateSnapshotUrl`) y, dentro de `createSnapshot`, todas las de `guardedFetch`.
 *
 * Nunca se registra la direccion ni el contenido (ni `console.*`). Todas las respuestas llevan `Cache-Control: no-store`.
 * Los errores son un codigo generico y un estado HTTP: nada de IP, DNS ni cabeceras internas.
 */

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function errorResponse(code: SnapshotErrorCode): Response {
  return Response.json({ error: code }, { status: SNAPSHOT_ERROR_STATUS[code], headers: RESPONSE_HEADERS });
}

function isSameSite(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite) return fetchSite === "same-origin";
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0].trim();
  return host !== "" && originHost === host;
}

/**
 * Clave del limitador. NO se confia en lo que el cliente pueda escribir: se usan las cabeceras que fija la plataforma
 * (`x-vercel-forwarded-for`, luego `x-real-ip`) y, solo si no estan (desarrollo, otro alojamiento), el ULTIMO valor de
 * `x-forwarded-for` (el que anade el proxy mas cercano; el primero lo puede inventar el cliente). Una IPv6 se agrupa por su /64
 * (quien tiene un /64 dispone de 2^64 direcciones y rotaria de clave en cada peticion). Lo que no sea una IP valida comparte la
 * clave `unknown`: el numero de claves no lo decide el atacante.
 */
export function clientKey(request: Request): string {
  const headers = request.headers;
  const candidate =
    headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() ||
    "";
  const ip = parseIp(candidate);
  if (!ip) return "unknown";
  if (ip.family === 4) return candidate;
  return `v6:${ip.bytes.slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export type SnapshotHandlerDeps = Partial<GuardedFetchDeps> & {
  limiter?: RateLimiter;
  maxConcurrent?: number;
};

export function createSnapshotHandler(deps: SnapshotHandlerDeps = {}): (request: Request) => Promise<Response> {
  const fetchDeps: GuardedFetchDeps = {
    resolve: deps.resolve ?? dnsResolver,
    transport: deps.transport ?? nodeTransport,
  };
  const limiter =
    deps.limiter ?? createRateLimiter({ limit: SNAPSHOT_LIMITS.perIpPerMinute, windowMs: 60_000 });
  const maxConcurrent = deps.maxConcurrent ?? SNAPSHOT_LIMITS.maxConcurrent;
  let active = 0;

  return async function handle(request: Request): Promise<Response> {
    try {
      if (!isSameSite(request)) return errorResponse("forbidden");
      if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
        return errorResponse("invalid-url");
      }
      if (!limiter.allow(clientKey(request))) return errorResponse("rate-limited");

      const text = await readLimitedText(request, SNAPSHOT_LIMITS.maxRequestBytes);
      if (text === null) return errorResponse("invalid-url");
      let address: unknown;
      try {
        address = (JSON.parse(text) as { url?: unknown } | null)?.url;
      } catch {
        return errorResponse("invalid-url");
      }
      if (typeof address !== "string") return errorResponse("invalid-url");

      const checked = validateSnapshotUrl(address);
      if (!checked.ok) return errorResponse(checked.code);

      if (active >= maxConcurrent) return errorResponse("rate-limited");
      active += 1;
      try {
        const result = await createSnapshot(checked.url.href, fetchDeps, request.signal);
        return Response.json(result, { headers: RESPONSE_HEADERS });
      } finally {
        active -= 1;
      }
    } catch (error) {
      return errorResponse(error instanceof SnapshotError ? error.code : "unreachable");
    }
  };
}
