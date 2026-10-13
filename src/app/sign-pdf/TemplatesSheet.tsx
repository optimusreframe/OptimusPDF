"use client";

import { useState } from "react";
import { LayoutTemplate, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Sheet } from "@/components/ui/Sheet";
import { useI18n, localeTag } from "@/lib/i18n";
import {
  deleteTemplate,
  useSignTemplates,
  type SignTemplate,
} from "@/app/sign-pdf/signTemplates";
import type { SignStrings } from "@/app/sign-pdf/strings";

export type TemplatesSheetProps = {
  open: boolean;
  onClose: () => void;
  onApply: (template: SignTemplate) => void;
  /** Con varios documentos: aplica la plantilla a TODOS (firmantes una vez, huecos repetidos por documento). Ausente = un solo documento. */
  onApplyAll?: (template: SignTemplate) => void;
  strings: SignStrings;
};

/**
 * A diferencia de `DraftsSheet.tsx` (IndexedDB, asincrono), las
 * plantillas viven en `localStorage` via `useSignTemplates` (mismo
 * patron sincrono que `valueHistory.ts`) -- no hace falta ningun estado
 * de carga.
 */
export function TemplatesSheet({
  open,
  onClose,
  onApply,
  onApplyAll,
  strings,
}: TemplatesSheetProps) {
  const { t, language } = useI18n();
  const templates = useSignTemplates();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const formatter = new Intl.DateTimeFormat(localeTag(language), {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const toDelete =
    templates.find((template) => template.id === confirmDeleteId) ?? null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={strings.templatesTitle}
      closeLabel={t.common.close}
    >
      {templates.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {strings.templatesEmpty}
        </p>
      ) : (
        <ul className="space-y-2 pb-2">
          {templates.map((template) => (
            <li key={template.id}>
              <div className="surface-card rounded-ios-sm flex flex-wrap items-center gap-3 p-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                  <LayoutTemplate
                    aria-hidden="true"
                    className="size-4 text-signal"
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {template.name}
                  </p>
                  <p className="text-caption text-muted-foreground">
                    {strings.templatesSavedAt(
                      formatter.format(new Date(template.savedAt)),
                    )}
                    {" · "}
                    {strings.templatesSummary(
                      template.signers.length,
                      template.fields.length,
                      template.textFields.length,
                    )}
                  </p>
                </div>
                <Button size="sm" onClick={() => onApply(template)}>
                  {strings.templatesApply}
                </Button>
                <button
                  type="button"
                  aria-label={strings.templatesDelete(template.name)}
                  onClick={() => setConfirmDeleteId(template.id)}
                  className="shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:text-destructive"
                >
                  <Trash2 aria-hidden="true" className="size-4" />
                </button>
                {onApplyAll ? (
                  <Button
                    variant="secondary"
                    size="md"
                    fullWidth
                    onClick={() => onApplyAll(template)}
                  >
                    {strings.templatesApplyAll}
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmSheet
        open={toDelete !== null}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (toDelete) deleteTemplate(toDelete.id);
        }}
        title={strings.templatesConfirmDeleteTitle}
        body={strings.templatesConfirmDeleteBody}
        confirmLabel={strings.templatesDelete(toDelete?.name ?? "")}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />
    </Sheet>
  );
}
