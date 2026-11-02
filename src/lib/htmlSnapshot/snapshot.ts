import { buildSnapshot, type ResourceFetcher } from "@/lib/htmlSnapshot/buildSnapshot";
import { decodeText } from "@/lib/htmlSnapshot/decodeText";
import { guardedFetch, type GuardedFetchDeps } from "@/lib/htmlSnapshot/guardedFetch";
import { SnapshotError, SNAPSHOT_LIMITS, type SnapshotResult } from "@/lib/htmlSnapshot/types";
import { memoizeResolver } from "@/lib/htmlSnapshot/dnsResolver";

/**
 * De una direccion a la instantanea: descarga la pagina (con `guardedFetch`), construye el HTML autocontenido y ya
 * saneado (`buildSnapshot`) y devuelve `{ html, finalUrl, title, notes }`. Un unico plazo total cubre pagina y recursos.
 *
 * Los fallos de un RECURSO (una imagen que no carga, una hoja que da 404) no tumban la instantanea: se omiten y se anotan.
 * Los de la PAGINA si (`invalid-url`, `blocked-address`, `unreachable`, `too-large`, `unsupported-type`, `timeout`).
 */
export async function createSnapshot(
  address: string,
  deps: GuardedFetchDeps,
  external?: AbortSignal,
): Promise<SnapshotResult> {
  const deadline = AbortSignal.timeout(SNAPSHOT_LIMITS.totalTimeoutMs);
  const signal = external ? AbortSignal.any([deadline, external]) : deadline;
  // La misma IP ya validada para la pagina y todos sus recursos del mismo servidor.
  const guarded: GuardedFetchDeps = { transport: deps.transport, resolve: memoizeResolver(deps.resolve) };

  try {
    const page = await guardedFetch(address, "page", { maxBytes: SNAPSHOT_LIMITS.maxPageBytes }, guarded, signal);
    const html = decodeText(page.bytes, page.contentType, "html");

    const fetchResource: ResourceFetcher = async (url, kind) => {
      try {
        const result = await guardedFetch(
          url,
          kind,
          { maxBytes: kind === "css" ? SNAPSHOT_LIMITS.maxCssBytes : SNAPSHOT_LIMITS.maxImageBytes },
          guarded,
          signal,
        );
        return { ok: true, bytes: result.bytes, mime: result.mime, contentType: result.contentType, url: result.url.href };
      } catch {
        // Cualquier fallo de un recurso (bloqueado, grande, lento...) solo lo omite.
        return { ok: false };
      }
    };

    const built = await buildSnapshot({ html, pageUrl: page.url.href, fetchResource });
    return { html: built.html, finalUrl: page.url.href, title: built.title, notes: built.notes };
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    // Errores internos (p. ej. un arbol anidado a miles de niveles): genericos, sin detalles.
    throw new SnapshotError(signal.aborted ? "timeout" : "unreachable");
  }
}
