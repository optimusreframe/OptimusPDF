import type { EditDraftSummary } from "@/app/edit-pdf/editDrafts";
import type { ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import type { DraftEntry } from "@/app/sign-pdf/signDrafts";
import { isValidResumeId, resumeHref, type ResumeTarget } from "@/lib/resumeLinks";
import type { ToolSlug } from "@/lib/tools-registry";

/**
 * «Sin terminar» (Fase 0 «Firma agil», U0.6): los trabajos a medias que las herramientas guardaron como BORRADOR en
 * este navegador (con el documento, en IndexedDB). Recientes no inventa nada: lista lo que los tres almacenes tienen
 * (Firmar: documento suelto y sesiones de varios documentos; Editar PDF; PDF Pro) y cada fila lleva el enlace
 * `?resume=<tipo>:<id>` con el que la herramienta restaura el trabajo.
 *
 * Funcion pura (sin IndexedDB ni React): la lectura real vive en `useUnfinishedWork`.
 */
export type UnfinishedItem = {
  /** `<tipo>:<id>`: clave estable de la fila (y lo que apunta el historial). */
  key: string;
  target: ResumeTarget;
  slug: ToolSlug;
  fileName: string;
  /** ISO 8601 */
  savedAt: string;
  /** Firmar con varios documentos: cuantos. */
  documents?: number;
  /** Editar / PDF Pro: cambios hechos. */
  changes?: number;
  /** Href de «Continuar». */
  href: string;
  /** PDF Pro: el borrador del que sale la miniatura. */
  pro?: ProDraftSummary;
};

export type DraftSources = {
  sign: readonly DraftEntry[];
  edit: readonly EditDraftSummary[];
  pro: readonly ProDraftSummary[];
};

function make(target: ResumeTarget, rest: Omit<UnfinishedItem, "key" | "target" | "href">): UnfinishedItem {
  return { key: `${target.kind}:${target.id}`, target, href: resumeHref(target), ...rest };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Junta los tres almacenes en una sola lista, del mas reciente al mas antiguo. Se DESCARTA lo que la herramienta no
 * sabria restaurar (para no prometer un «Continuar» que no continua): ids que no cumplen la expresion del tipo, sesiones
 * sin documentos y borradores del editor sin cambios (el editor solo restaura con cambios). Los PDF con contrasena
 * nunca llegan aqui: ninguna herramienta guarda borrador de una copia descifrada.
 */
export function buildUnfinishedItems(sources: DraftSources): UnfinishedItem[] {
  const items: UnfinishedItem[] = [];

  for (const entry of sources.sign) {
    if (entry.kind === "session") {
      const meta = entry.meta;
      const first = meta.documents[0];
      const target: ResumeTarget = { kind: "session", id: meta.id };
      if (!first || !isValidResumeId("session", meta.id)) continue;
      items.push(
        make(target, {
          slug: "sign-pdf",
          fileName: text(meta.fileName) || text(first.fileName),
          savedAt: meta.savedAt,
          documents: meta.documents.length,
        }),
      );
    } else {
      const meta = entry.meta;
      const target: ResumeTarget = { kind: "sign", id: meta.id };
      if (!isValidResumeId("sign", meta.id)) continue;
      items.push(make(target, { slug: "sign-pdf", fileName: text(meta.fileName), savedAt: meta.savedAt }));
    }
  }

  for (const draft of sources.edit) {
    const target: ResumeTarget = { kind: "edit", id: draft.id };
    if (!isValidResumeId("edit", draft.id) || draft.pendingCount <= 0) continue;
    items.push(
      make(target, { slug: "edit-pdf", fileName: draft.fileName, savedAt: draft.savedAt, changes: draft.pendingCount }),
    );
  }

  for (const draft of sources.pro) {
    const target: ResumeTarget = { kind: "pro", id: draft.id };
    if (!isValidResumeId("pro", draft.id)) continue;
    items.push(
      make(target, { slug: "pdf-pro", fileName: draft.fileName, savedAt: draft.savedAt, changes: draft.steps, pro: draft }),
    );
  }

  // Misma fecha: el orden de llegada (Firmar, Editar, PDF Pro) se conserva (`sort` es estable).
  return items.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** El historial no repite un trabajo que ya se ofrece en «Sin terminar»: su puntero apunta a un borrador vivo. */
export function hiddenByUnfinished<T extends { resume?: ResumeTarget }>(
  entries: readonly T[],
  unfinished: readonly UnfinishedItem[],
): T[] {
  const live = new Set(unfinished.map((item) => item.key));
  return entries.filter((entry) => !(entry.resume && live.has(`${entry.resume.kind}:${entry.resume.id}`)));
}
