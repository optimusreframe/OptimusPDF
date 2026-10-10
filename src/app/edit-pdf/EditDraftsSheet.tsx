"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { localeTag, useI18n } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import {
  deleteEditDraft,
  listEditDrafts,
  subscribeToEditDrafts,
  type EditDraftSummary,
} from "@/app/edit-pdf/editDrafts";
import type { EditFlowStrings } from "@/app/edit-pdf/flowStrings";

/*
 * «Ver borradores» del editor (Wave 5 · U5), con el patron de `DraftsSheet` de
 * Firmar: lista del mas reciente al mas antiguo (nombre del documento, fecha,
 * numero de cambios, paginas y peso), «Retomar» y «Eliminar» (con confirmacion).
 * Objetivos de 44 px. La lista se refresca sola cuando cambia un borrador (tambien
 * desde otra pestana). Tras eliminar, el foco no puede quedarse en el boton que
 * desaparece: pasa al primer boton de la lista o al texto de «vacio».
 */

export type EditDraftsSheetProps = {
  open: boolean;
  onClose: () => void;
  onResume: (draft: EditDraftSummary) => void;
  flow: EditFlowStrings;
};

export function EditDraftsSheet({ open, onClose, onResume, flow }: EditDraftsSheetProps) {
  const { t, language } = useI18n();
  const [drafts, setDrafts] = useState<EditDraftSummary[] | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const refocusAfterDeleteRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = () => {
      void listEditDrafts().then((next) => {
        if (!cancelled) setDrafts(next);
      });
    };
    refresh();
    const unsubscribe = subscribeToEditDrafts(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open]);

  useEffect(() => {
    if (!refocusAfterDeleteRef.current || drafts === null) return;
    refocusAfterDeleteRef.current = false;
    const target =
      listRef.current?.querySelector<HTMLElement>("button") ??
      listRef.current?.querySelector<HTMLElement>("[data-drafts-empty]");
    target?.focus({ preventScroll: true });
  }, [drafts]);

  const formatter = new Intl.DateTimeFormat(localeTag(language), {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const toDelete = drafts?.find((draft) => draft.id === confirmId) ?? null;

  return (
    <Sheet open={open} onClose={onClose} title={flow.draftsTitle} closeLabel={t.common.close}>
      <div ref={listRef} data-edit-drafts="">
        {drafts === null ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : drafts.length === 0 ? (
          <p
            data-drafts-empty=""
            tabIndex={-1}
            className="py-4 text-subheadline text-muted-foreground outline-none"
          >
            {flow.draftsEmpty}
          </p>
        ) : (
          <ul className="space-y-2 pb-2">
            {drafts.map((draft) => {
              const infoId = `${baseId}-${draft.id}`;
              const meta = [
                flow.draftsSavedAt(formatter.format(new Date(draft.savedAt))),
                flow.draftsChanges(draft.pendingCount),
                draft.pageCount !== null ? flow.draftsPages(draft.pageCount) : null,
                formatFileSize(draft.fileSize, localeTag(language)),
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <li key={draft.id} data-draft-id={draft.id}>
                  <div className="surface-card rounded-ios-sm flex flex-wrap items-center gap-3 p-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                      <FileText aria-hidden="true" className="size-4 text-signal-text" />
                    </span>
                    <div id={infoId} className="min-w-0 flex-1 basis-40">
                      <p className="truncate text-subheadline font-medium text-foreground" title={draft.fileName}>
                        {draft.fileName}
                      </p>
                      <p className="text-caption text-muted-foreground">{meta}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button size="md" aria-describedby={infoId} onClick={() => onResume(draft)}>
                        {flow.draftsResume}
                      </Button>
                      <button
                        type="button"
                        aria-label={flow.draftsDelete(draft.fileName)}
                        onClick={() => setConfirmId(draft.id)}
                        className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-destructive-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmSheet
        open={toDelete !== null}
        onClose={() => setConfirmId(null)}
        onConfirm={() => {
          if (!toDelete) return;
          refocusAfterDeleteRef.current = true;
          void deleteEditDraft(toDelete.id);
        }}
        title={flow.draftsConfirmDeleteTitle}
        body={flow.draftsConfirmDeleteBody}
        confirmLabel={flow.draftsDelete(toDelete?.fileName ?? "")}
        cancelLabel={flow.confirmCancel}
        closeLabel={flow.confirmClose}
      />
    </Sheet>
  );
}
