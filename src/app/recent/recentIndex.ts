import { hiddenByUnfinished, type UnfinishedItem } from "@/app/recent/unfinishedWork";
import type { RecentEntry } from "@/lib/recent";
import { continueHrefFor, isValidResumeId, type ResumeTarget } from "@/lib/resumeLinks";

/**
 * Recientes unificado (Fase 2, U2.6): UN indice DERIVADO (no es un almacen nuevo: no guarda nada) que junta
 *
 *   - los borradores reales de Firmar, Editar y PDF Pro (`UnfinishedItem`, ya leidos por `useUnfinishedWork`) y
 *   - las entradas del historial (`RecentEntry`, solo nombre + herramienta + fecha) que NO apuntan a un borrador vivo,
 *
 * ordenados por fecha (lo mas reciente primero). «Mis documentos» NO aporta filas: un documento de la biblioteca no es
 * «reciente» por existir; solo se consulta para «Abrir de nuevo» (la copia guardada con la misma huella).
 *
 * REGLA: una fila solo ofrece «Continuar» (`continueHref`) con un puntero `resume` VERIFICABLE (`continueHrefFor`).
 * Funcion pura (sin React ni IndexedDB).
 */
export type RecentRowStatus = "unfinished" | "finished";

export type RecentRow = {
  /** `draft:<tipo>:<id>` o `history:<id>`: clave estable de la fila. */
  key: string;
  origin: "draft" | "history";
  status: RecentRowStatus;
  slug: string;
  fileName: string;
  /** ISO 8601 (puede venir corrupta del historial: se ordena al final). */
  date: string;
  documents?: number;
  changes?: number;
  /** Solo borradores: el borrador vivo. */
  draft?: UnfinishedItem;
  /** Solo historial: id de la entrada (para «Borrar»). */
  entryId?: string;
  /** Destino de «Continuar»: SOLO si el puntero es verificable. */
  continueHref: string | null;
  /** Historial con puntero a un borrador que ya no esta: el puntero tal cual (saneado), para buscar la copia. */
  missingDraft: ResumeTarget | null;
  /** Documento de «Mis documentos» con la misma huella que el trabajo: se puede abrir de nuevo con su copia. */
  library: { id: string; name: string } | null;
};

export type LibraryRef = { id: string; name: string; fingerprint: { exact: string } };

/** Herramientas a las que «Mis documentos» sabe abrirles su copia (hoy solo Firmar: el traspaso es de Firmar). */
export const REOPEN_FROM_LIBRARY_SLUGS: readonly string[] = ["sign-pdf"];

function time(date: string): number {
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** La huella exacta (SHA-256) con la que el trabajo se guardo: el `id` del puntero de Firmar, Editar y PDF Pro. */
function exactOf(target: ResumeTarget | null): string | null {
  return target && target.kind !== "session" && isValidResumeId(target.kind, target.id) ? target.id : null;
}

export function buildRecentRows(input: {
  unfinished: readonly UnfinishedItem[];
  history: readonly RecentEntry[];
  library?: readonly LibraryRef[];
}): RecentRow[] {
  const library = input.library ?? [];
  const rows: RecentRow[] = [];

  for (const item of input.unfinished) {
    rows.push({
      key: `draft:${item.key}`,
      origin: "draft",
      status: "unfinished",
      slug: item.slug,
      fileName: item.fileName,
      date: item.savedAt,
      documents: item.documents,
      changes: item.changes,
      draft: item,
      continueHref: continueHrefFor(item.slug, item.target),
      missingDraft: null,
      library: null,
    });
  }

  for (const entry of hiddenByUnfinished(input.history, input.unfinished)) {
    const exact = exactOf(entry.resume ?? null);
    const match =
      exact && REOPEN_FROM_LIBRARY_SLUGS.includes(entry.slug)
        ? library.find((doc) => doc.fingerprint.exact === exact)
        : undefined;
    rows.push({
      key: `history:${entry.id}`,
      origin: "history",
      status: "finished",
      slug: entry.slug,
      fileName: entry.fileName,
      date: entry.date,
      entryId: entry.id,
      // Un historial nunca restaura: su trabajo (si lo hubo) ya no esta, o seria una fila de «Sin terminar».
      continueHref: null,
      missingDraft: entry.resume ?? null,
      library: match ? { id: match.id, name: match.name } : null,
    });
  }

  // Estable: a igual fecha se conserva el orden de llegada (borradores antes que historial).
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => time(b.row.date) - time(a.row.date) || a.index - b.index)
    .map(({ row }) => row);
}

export const unfinishedRows = (rows: readonly RecentRow[]) => rows.filter((row) => row.status === "unfinished");
export const finishedRows = (rows: readonly RecentRow[]) => rows.filter((row) => row.status === "finished");
