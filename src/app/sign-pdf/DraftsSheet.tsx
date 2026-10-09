"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FileText, Files, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useI18n, localeTag } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import {
  deleteDraftEntry,
  listAllDrafts,
  subscribeToDrafts,
  type DraftEntry,
} from "@/app/sign-pdf/signDrafts";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type DraftsSheetProps = {
  open: boolean;
  onClose: () => void;
  onResume: (entry: DraftEntry) => void;
  strings: SignStrings;
};

/** Nombres de los documentos de un borrador, en el orden de la cola. */
export function draftDocumentNames(entry: DraftEntry): string[] {
  return entry.kind === "session"
    ? entry.meta.documents.map((doc) => doc.fileName)
    : [entry.meta.fileName];
}

function entryKey(entry: DraftEntry): string {
  return `${entry.kind}:${entry.meta.id}`;
}

/**
 * IndexedDB es asincrono: a diferencia del resto de los stores de este
 * proyecto (`recent.ts`/`valueHistory.ts`, sincronos via localStorage,
 * compatibles con `useSyncExternalStore`), esta lista se resuelve con un
 * `useState`/`useEffect` normal y se refresca ante `subscribeToDrafts`
 * (incluye cambios anunciados por otra pestaña).
 *
 * Lista dos clases de borrador: un documento suelto (v1) y una SESION de
 * varios documentos, que se muestra como UNA fila con «N documentos» y los
 * nombres truncados (el nombre completo, en el tooltip).
 */
export function DraftsSheet({ open, onClose, onResume, strings }: DraftsSheetProps) {
  const { t, language } = useI18n();
  const [drafts, setDrafts] = useState<DraftEntry[] | null>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  /** Tras borrar, el foco no puede quedarse en el boton que desaparece. */
  const refocusAfterDeleteRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = () => {
      void listAllDrafts().then((next) => {
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

  const toDelete =
    drafts?.find((entry) => entryKey(entry) === confirmDeleteKey) ?? null;
  const toDeleteLabel = toDelete ? draftDocumentNames(toDelete).join(", ") : "";

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={strings.draftsTitle}
      closeLabel={t.common.close}
    >
      <div ref={listRef}>
        {drafts === null ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : drafts.length === 0 ? (
          <p
            data-drafts-empty=""
            tabIndex={-1}
            className="py-4 text-sm text-muted-foreground outline-none"
          >
            {strings.draftsEmpty}
          </p>
        ) : (
          <ul className="space-y-2 pb-2">
            {drafts.map((entry) => {
              const names = draftDocumentNames(entry);
              const label = names.join(", ");
              const isSession = entry.kind === "session";
              const infoId = `${baseId}-${entryKey(entry)}`;
              return (
                <li key={entryKey(entry)}>
                  <div className="glass rounded-ios-sm flex flex-wrap items-center gap-3 p-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                      {isSession ? (
                        <Files aria-hidden="true" className="size-4 text-signal" />
                      ) : (
                        <FileText aria-hidden="true" className="size-4 text-signal" />
                      )}
                    </span>
                    <div id={infoId} className="min-w-0 flex-1 basis-40">
                      <p
                        className="truncate text-sm font-medium text-foreground"
                        title={label}
                      >
                        {label}
                      </p>
                      <p className="text-caption text-muted-foreground">
                        {isSession ? (
                          <>
                            {strings.draftsDocuments(entry.meta.documentCount)}
                            {" · "}
                          </>
                        ) : null}
                        {strings.draftsSavedAt(
                          formatter.format(new Date(entry.meta.savedAt)),
                        )}
                        {" · "}
                        {formatFileSize(entry.meta.fileSize, localeTag(language))}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="md"
                        aria-describedby={infoId}
                        onClick={() => onResume(entry)}
                      >
                        {strings.draftsResume}
                      </Button>
                      <button
                        type="button"
                        aria-label={strings.draftsDelete(label)}
                        onClick={() => setConfirmDeleteKey(entryKey(entry))}
                        className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
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
        onClose={() => setConfirmDeleteKey(null)}
        onConfirm={() => {
          if (!toDelete) return;
          refocusAfterDeleteRef.current = true;
          void deleteDraftEntry(toDelete);
        }}
        title={strings.draftsConfirmDeleteTitle}
        body={
          toDelete?.kind === "session"
            ? strings.draftsConfirmDeleteSessionBody(toDelete.meta.documentCount)
            : strings.draftsConfirmDeleteBody
        }
        confirmLabel={strings.draftsDelete(toDeleteLabel)}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </Sheet>
  );
}
