"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { FilePlus2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { looksLikePdf, suggestedName, type ErrorKey } from "@/app/documents/documentsModel";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import { LIBRARY_LIMITS } from "@/lib/docLibrary/types";
import { useT } from "@/lib/i18n";

const FIELD =
  "h-12 w-full rounded-ios-sm border border-hairline bg-white/5 px-4 text-body text-foreground placeholder:text-muted-foreground " +
  "transition-[border-color,background-color] duration-[var(--duration-fast)] " +
  "focus:border-signal/60 focus:bg-white/8 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

/* ------------------------------------------------------------------ *
 * Anadir contrato
 * ------------------------------------------------------------------ */

export type AddSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Guarda el documento; devuelve la clave del error o `null` si salio bien (entonces la hoja se cierra). */
  onSave: (input: { file: File; name: string; docType: string }) => Promise<ErrorKey | null>;
};

export function AddDocumentSheet({ open, onClose, onSave }: AddSheetProps) {
  const t = useT();
  return (
    <Sheet open={open} onClose={onClose} title={t.documents.addTitle} closeLabel={t.common.close} initialFocus="[data-add-choose]">
      <AddForm onClose={onClose} onSave={onSave} />
    </Sheet>
  );
}

function AddForm({ onClose, onSave }: Pick<AddSheetProps, "onClose" | "onSave">) {
  const t = useT();
  const baseId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [docType, setDocType] = useState(t.documents.typeDefault);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saving, setSaving] = useState(false);

  function onPick(next: File | null) {
    if (!next) return;
    if (!looksLikePdf(next)) {
      setFile(null);
      setError("errorNotPdf");
      return;
    }
    setError(null);
    setFile(next);
    setName(suggestedName(next.name));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || saving) return;
    setSaving(true);
    setError(null);
    const failure = await onSave({ file, name, docType });
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  }

  const errorId = `${baseId}-error`;
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 pb-2" noValidate>
      <div>
        <p className="mb-1.5 text-footnote font-medium text-muted-foreground">{t.documents.fileLabel}</p>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          data-add-file=""
          aria-hidden="true"
          onChange={(event) => {
            onPick(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
          className="hidden"
          tabIndex={-1}
        />
        <Button
          variant="secondary"
          size="md"
          wrap
          fullWidth
          data-add-choose=""
          aria-describedby={file ? `${baseId}-picked` : undefined}
          onClick={() => inputRef.current?.click()}
        >
          <FilePlus2 aria-hidden="true" className="size-4 shrink-0" />
          {file ? t.documents.changeFile : t.documents.chooseFile}
        </Button>
        {file ? (
          <p id={`${baseId}-picked`} className="mt-2 text-footnote text-muted-foreground [overflow-wrap:anywhere]" data-add-picked="">
            {file.name}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor={`${baseId}-name`} className="mb-1.5 block text-footnote font-medium text-muted-foreground">
          {t.documents.nameLabel}
        </label>
        <input
          id={`${baseId}-name`}
          value={name}
          maxLength={LIBRARY_LIMITS.maxNameLength}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          disabled={!file}
          className={cn(FIELD, "disabled:opacity-50")}
        />
      </div>

      <div>
        <label htmlFor={`${baseId}-type`} className="mb-1.5 block text-footnote font-medium text-muted-foreground">
          {t.documents.typeLabel}
        </label>
        <input
          id={`${baseId}-type`}
          value={docType}
          maxLength={LIBRARY_LIMITS.maxNameLength}
          onChange={(event) => setDocType(event.target.value)}
          placeholder={t.documents.typeHint}
          autoComplete="off"
          disabled={!file}
          className={cn(FIELD, "disabled:opacity-50")}
        />
      </div>

      {error ? (
        <p id={errorId} data-add-error="" className="text-footnote text-destructive-text">
          {t.documents[error]}
        </p>
      ) : null}

      <Button type="submit" size="md" fullWidth wrap disabled={!file || name.trim() === "" || saving} aria-describedby={error ? errorId : undefined}>
        {saving ? t.documents.saving : t.documents.saveDocument}
      </Button>
    </form>
  );
}

/* ------------------------------------------------------------------ *
 * Menu de un documento (renombrar, reemplazar, borrar) y renombrar
 * ------------------------------------------------------------------ */

const ROW =
  "flex h-12 w-full items-center gap-3 rounded-ios-sm px-3 text-left text-callout font-medium transition-colors " +
  "hover:bg-white/8 active:bg-white/12 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal";

export function DocumentMenuSheet({
  name,
  open,
  onClose,
  onRename,
  onReplace,
  onDelete,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  onRename: () => void;
  onReplace: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  return (
    <Sheet open={open} onClose={onClose} title={fill(t.documents.moreActionsTitle, { name })} closeLabel={t.common.close} initialFocus="[data-menu-first]">
      <ul className="flex flex-col gap-0.5 pb-2" data-document-menu="">
        <li>
          <button type="button" data-menu-first="" className={ROW} onClick={onRename}>
            <Pencil aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {t.documents.rename}
          </button>
        </li>
        <li>
          <button type="button" className={ROW} onClick={onReplace}>
            <RefreshCw aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {t.documents.replace}
          </button>
        </li>
        <li>
          <button type="button" className={cn(ROW, "text-destructive-text")} onClick={onDelete}>
            <Trash2 aria-hidden="true" className="size-4 shrink-0" />
            {t.documents.delete}
          </button>
        </li>
      </ul>
    </Sheet>
  );
}

export function RenameSheet({
  open,
  initialName,
  onClose,
  onSave,
}: {
  open: boolean;
  initialName: string;
  onClose: () => void;
  onSave: (name: string) => Promise<ErrorKey | null>;
}) {
  const t = useT();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t.documents.renameTitle}
      closeLabel={t.common.close}
      initialFocus="[data-rename-field]"
      restoreFocusOnClose={() => false}
    >
      <RenameForm initialName={initialName} onClose={onClose} onSave={onSave} />
    </Sheet>
  );
}

function RenameForm({ initialName, onClose, onSave }: { initialName: string; onClose: () => void; onSave: (name: string) => Promise<ErrorKey | null> }) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving || name.trim() === "") return;
    setSaving(true);
    const failure = await onSave(name);
    setSaving(false);
    if (failure) setError(failure);
    else onClose();
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4 pb-2" noValidate>
      <div>
        <label htmlFor={`${id}-name`} className="mb-1.5 block text-footnote font-medium text-muted-foreground">
          {t.documents.nameLabel}
        </label>
        <input
          id={`${id}-name`}
          data-rename-field=""
          value={name}
          maxLength={LIBRARY_LIMITS.maxNameLength}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          className={FIELD}
        />
      </div>
      {error ? <p className="text-footnote text-destructive-text">{t.documents[error]}</p> : null}
      <Button type="submit" size="md" fullWidth disabled={name.trim() === "" || saving}>
        {t.documents.save}
      </Button>
    </form>
  );
}
