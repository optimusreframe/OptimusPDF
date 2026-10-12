"use client";

import { useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, X } from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { ChoiceGroup, NumberField } from "@/components/tool/OptionControls";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Sheet } from "@/components/ui/Sheet";
import { useI18n } from "@/lib/i18n";
import { toPdfError, formatFileSize, type PdfErrorCode } from "@/lib/pdf/core";
import { localeTag } from "@/lib/i18n";
import type { ImageLayout, ImageMargin, ImagePageSize } from "@/lib/pdf/imagesToPdf";
import { STRINGS as JPG_TO_PDF_STRINGS } from "@/app/jpg-to-pdf/strings";
import {
  DEFAULT_BLANK_OPTIONS,
  MAX_BLANK_PAGES,
  clampBlankPages,
  createBlankPdf,
  type BlankDocumentOptions,
} from "@/app/pdf-pro/create/blankPdf";
import { getCreateStrings } from "@/app/pdf-pro/create/createStrings";
import {
  DEFAULT_NEW_IMAGE_LAYOUT,
  MAX_NEW_IMAGES,
  createPdfFromImages,
  isImageFile,
} from "@/app/pdf-pro/create/fromImages";

/**
 * Hojas de «crear» de PDF Pro (Wave 7 · U8): nuevo PDF desde imagenes (orden, tamaño y margen) y nuevo documento en
 * blanco (tamaño, orientacion y numero de paginas). Ambas entregan un `File` que la suite abre como documento nuevo.
 */

type CreatedHandler = (file: File) => void;

/* ------------------------------ desde imagenes ------------------------------ */

export function NewFromImagesSheet({
  open,
  initialFiles,
  onClose,
  onCreated,
}: {
  open: boolean;
  initialFiles: readonly File[];
  onClose: () => void;
  onCreated: CreatedHandler;
}) {
  const { t, language } = useI18n();
  const s = getCreateStrings(language).images;
  return (
    <Sheet open={open} onClose={onClose} title={s.title} closeLabel={t.common.close}>
      <ImagesForm key={initialFiles.map((file) => `${file.name}:${file.size}`).join("|")} initialFiles={initialFiles} onClose={onClose} onCreated={onCreated} />
    </Sheet>
  );
}

function ImagesForm({
  initialFiles,
  onClose,
  onCreated,
}: {
  initialFiles: readonly File[];
  onClose: () => void;
  onCreated: CreatedHandler;
}) {
  const { t, language } = useI18n();
  const create = getCreateStrings(language);
  const s = create.images;
  const jpg = JPG_TO_PDF_STRINGS[language];
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>(() => initialFiles.filter(isImageFile).slice(0, MAX_NEW_IMAGES));
  const [skipped, setSkipped] = useState<string[]>(() => initialFiles.filter((file) => !isImageFile(file)).map((file) => file.name));
  const [layout, setLayout] = useState<ImageLayout>({ ...DEFAULT_NEW_IMAGE_LAYOUT });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const copy = error ? errorCopy(t, error) : null;

  const move = (index: number, delta: -1 | 1) =>
    setFiles((previous) => {
      const next = [...previous];
      const target = index + delta;
      if (target < 0 || target >= next.length) return previous;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const add = (incoming: File[]) => {
    const accepted = incoming.filter(isImageFile);
    setSkipped(incoming.filter((file) => !isImageFile(file)).map((file) => file.name));
    setFiles((previous) => [...previous, ...accepted].slice(0, MAX_NEW_IMAGES));
  };

  const submit = async () => {
    if (busy || files.length === 0) return;
    setBusy(true);
    setProgress(0);
    setError(null);
    try {
      const file = await createPdfFromImages(files, layout, s.fileName, setProgress);
      onCreated(file);
    } catch (caught) {
      setError(toPdfError(caught).code);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 pb-2" data-new-from-images="">
      <p className="text-subheadline text-muted-foreground">{s.body}</p>

      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-new-images-input=""
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <Button variant="secondary" size="md" fullWidth onClick={() => input.current?.click()} aria-disabled={busy || undefined}>
        <ImagePlus aria-hidden="true" className="size-4" />
        {files.length === 0 ? s.pick : s.pickMore}
      </Button>

      {skipped.length > 0 ? (
        <p role="note" className="text-xs leading-relaxed text-muted-foreground">
          {skipped.slice(0, 3).map((name) => s.notImage(name)).join(" ")}
        </p>
      ) : null}
      {files.length >= MAX_NEW_IMAGES ? <p className="text-xs text-muted-foreground">{s.tooMany(MAX_NEW_IMAGES)}</p> : null}

      {files.length === 0 ? (
        <p className="text-footnote text-muted-foreground">{s.none}</p>
      ) : (
        <div>
          <p className="ui-label mb-2 text-muted-foreground">
            {s.listLabel} · {s.count(files.length)}
          </p>
          <ol aria-label={s.listLabel} className="max-h-56 space-y-1 overflow-y-auto">
            {files.map((file, index) => (
              <li
                key={`${file.name}:${file.size}:${file.lastModified}:${index}`}
                className="flex min-h-11 items-center gap-1 rounded-ios-sm border border-hairline bg-white/5 pl-3"
              >
                <span className="min-w-0 flex-1 truncate text-subheadline text-foreground" title={file.name}>
                  {index + 1}. {file.name}
                </span>
                <span className="hidden shrink-0 text-caption text-muted-foreground sm:inline">
                  {formatFileSize(file.size, localeTag(language))}
                </span>
                <IconButton label={s.moveUp(file.name)} disabled={index === 0 || busy} onClick={() => move(index, -1)}>
                  <ArrowUp aria-hidden="true" className="size-4" />
                </IconButton>
                <IconButton label={s.moveDown(file.name)} disabled={index === files.length - 1 || busy} onClick={() => move(index, 1)}>
                  <ArrowDown aria-hidden="true" className="size-4" />
                </IconButton>
                <IconButton label={s.remove(file.name)} disabled={busy} onClick={() => setFiles((previous) => previous.filter((_, position) => position !== index))}>
                  <X aria-hidden="true" className="size-4" />
                </IconButton>
              </li>
            ))}
          </ol>
        </div>
      )}

      <ChoiceGroup<ImagePageSize>
        label={jpg.pageSizeLabel}
        value={layout.pageSize}
        columns={3}
        choices={[
          { value: "a4", label: jpg.pageSizeA4 },
          { value: "letter", label: jpg.pageSizeLetter },
          { value: "fit", label: jpg.pageSizeFit },
        ]}
        onChange={(pageSize) => setLayout((previous) => ({ ...previous, pageSize }))}
        hint={layout.pageSize === "fit" ? jpg.fitNote : undefined}
      />
      <ChoiceGroup<ImageMargin>
        label={jpg.marginLabel}
        value={layout.margin}
        columns={3}
        choices={[
          { value: "none", label: jpg.marginNone },
          { value: "small", label: jpg.marginSmall },
          { value: "large", label: jpg.marginLarge },
        ]}
        onChange={(margin) => setLayout((previous) => ({ ...previous, margin }))}
      />

      {busy ? <ProgressBar value={progress * 100} label={s.creating} /> : null}
      <ErrorBanner
        show={copy !== null}
        errorKey={error ?? undefined}
        title={copy?.title ?? ""}
        message={copy?.message ?? ""}
        hint={copy?.hint}
        actions={errorActions(t, error)}
        dismissLabel={t.common.close}
        onDismiss={() => setError(null)}
        className="mb-0"
      />
      <div className="flex flex-col gap-2">
        <Button size="md" fullWidth aria-disabled={busy || files.length === 0 || undefined} onClick={() => void submit()} data-new-images-create="">
          {busy ? s.creating : s.create}
        </Button>
        <Button size="md" variant="ghost" fullWidth onClick={onClose}>
          {create.cancel}
        </Button>
      </div>
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (!disabled) onClick();
      }}
      className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground aria-disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
    >
      {children}
    </button>
  );
}

/* ------------------------------ en blanco ------------------------------ */

export function NewBlankSheet({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: CreatedHandler;
}) {
  const { t, language } = useI18n();
  const s = getCreateStrings(language).blank;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={s.title}
      closeLabel={t.common.close}
      initialFocus={'[data-new-blank] [role="radio"][aria-checked="true"]'}
    >
      <BlankForm key={String(open)} onClose={onClose} onCreated={onCreated} />
    </Sheet>
  );
}

function BlankForm({ onClose, onCreated }: { onClose: () => void; onCreated: CreatedHandler }) {
  const { t, language } = useI18n();
  const create = getCreateStrings(language);
  const s = create.blank;
  const [options, setOptions] = useState<BlankDocumentOptions>({ ...DEFAULT_BLANK_OPTIONS });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PdfErrorCode | null>(null);
  const copy = error ? errorCopy(t, error) : null;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = await createBlankPdf(options);
      onCreated(new File([bytes as unknown as BlobPart], s.fileName, { type: "application/pdf" }));
    } catch (caught) {
      setError(toPdfError(caught).code);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 pb-2" data-new-blank="">
      <p className="text-subheadline text-muted-foreground">{s.body}</p>
      <ChoiceGroup<"a4" | "letter">
        label={s.sizeLabel}
        value={options.size}
        columns={2}
        choices={[
          { value: "a4", label: s.a4 },
          { value: "letter", label: s.letter },
        ]}
        onChange={(size) => setOptions((previous) => ({ ...previous, size }))}
      />
      <ChoiceGroup<"portrait" | "landscape">
        label={s.orientationLabel}
        value={options.orientation}
        columns={2}
        choices={[
          { value: "portrait", label: s.portrait },
          { value: "landscape", label: s.landscape },
        ]}
        onChange={(orientation) => setOptions((previous) => ({ ...previous, orientation }))}
      />
      <div>
        <NumberField
          label={s.pagesLabel}
          value={options.pages}
          min={1}
          max={MAX_BLANK_PAGES}
          onChange={(pages) => setOptions((previous) => ({ ...previous, pages: clampBlankPages(pages) }))}
        />
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{s.pagesHint(MAX_BLANK_PAGES)}</p>
      </div>
      <ErrorBanner
        show={copy !== null}
        errorKey={error ?? undefined}
        title={copy?.title ?? ""}
        message={copy?.message ?? ""}
        hint={copy?.hint}
        actions={errorActions(t, error)}
        dismissLabel={t.common.close}
        onDismiss={() => setError(null)}
        className="mb-0"
      />
      <div className="flex flex-col gap-2">
        <Button size="md" fullWidth aria-disabled={busy || undefined} onClick={() => void submit()} data-new-blank-create="">
          {s.create}
        </Button>
        <Button size="md" variant="ghost" fullWidth onClick={onClose}>
          {create.cancel}
        </Button>
      </div>
    </div>
  );
}
