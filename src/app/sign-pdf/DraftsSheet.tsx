"use client";

import { useEffect, useState } from "react";
import { FileText, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useI18n, localeTag } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import {
  deleteDraft,
  listDrafts,
  subscribeToDrafts,
  type DraftMeta,
} from "@/app/sign-pdf/signDrafts";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type DraftsSheetProps = {
  open: boolean;
  onClose: () => void;
  onResume: (id: string) => void;
  strings: SignStrings;
};

/**
 * IndexedDB es asincrono: a diferencia del resto de los stores de este
 * proyecto (`recent.ts`/`valueHistory.ts`, sincronos via localStorage,
 * compatibles con `useSyncExternalStore`), esta lista se resuelve con un
 * `useState`/`useEffect` normal y se refresca ante `subscribeToDrafts`
 * (incluye cambios anunciados por otra pestaña).
 */
export function DraftsSheet({ open, onClose, onResume, strings }: DraftsSheetProps) {
  const { t, language } = useI18n();
  const [drafts, setDrafts] = useState<DraftMeta[] | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = () => {
      void listDrafts().then((next) => {
        if (!cancelled) setDrafts(next);
      });
    };
    refresh();
    const unsubscribe = subscribeToDrafts(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [open]);

  const formatter = new Intl.DateTimeFormat(localeTag(language), {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const toDelete = drafts?.find((draft) => draft.id === confirmDeleteId) ?? null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={strings.draftsTitle}
      closeLabel={t.common.close}
    >
      {drafts === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : drafts.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {strings.draftsEmpty}
        </p>
      ) : (
        <ul className="space-y-2 pb-2">
          {drafts.map((draft) => (
            <li key={draft.id}>
              <div className="glass rounded-ios-sm flex items-center gap-3 p-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                  <FileText aria-hidden="true" className="size-4 text-signal" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {draft.fileName}
                  </p>
                  <p className="text-caption text-muted-foreground">
                    {strings.draftsSavedAt(formatter.format(new Date(draft.savedAt)))}
                    {" · "}
                    {formatFileSize(draft.fileSize, localeTag(language))}
                  </p>
                </div>
                <Button size="sm" onClick={() => onResume(draft.id)}>
                  {strings.draftsResume}
                </Button>
                <button
                  type="button"
                  aria-label={strings.draftsDelete(draft.fileName)}
                  onClick={() => setConfirmDeleteId(draft.id)}
                  className="shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmSheet
        open={toDelete !== null}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (toDelete) void deleteDraft(toDelete.id);
        }}
        title={strings.draftsConfirmDeleteTitle}
        body={strings.draftsConfirmDeleteBody}
        confirmLabel={strings.draftsDelete(toDelete?.fileName ?? "")}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </Sheet>
  );
}
