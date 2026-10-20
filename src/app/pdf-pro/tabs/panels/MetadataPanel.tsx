"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { OptionSection, TextField, ToggleRow } from "@/components/tool/OptionControls";
import { useI18n } from "@/lib/i18n";
import { hasAnyMetadata, readMetadata } from "@/lib/pdf/metadata";
import { formFromInfo, type MetadataFormFields } from "@/app/pdf-pro/ops/metadataForm";
import type { ProMetadataOptions } from "@/app/pdf-pro/ops/docOperations";
import type { DocPanelProps } from "@/app/pdf-pro/tabs/docToolTypes";
import { getProStrings } from "@/app/pdf-pro/proStrings";

function DateField({
  label,
  clearLabel,
  value,
  onChange,
}: {
  label: string;
  clearLabel: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="ui-label mb-1.5 block text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="datetime-local"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-11 min-w-0 flex-1 rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground pointer-coarse:text-base tabular-nums transition-colors focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
        />
        <Button variant="secondary" size="md" aria-label={`${clearLabel}: ${label}`} onClick={() => onChange("")} aria-disabled={value === "" || undefined}>
          {clearLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Panel de «Metadatos»: lee los del snapshot actual al abrirse (y tras cada cambio del documento) y deja
 * editarlos o eliminarlos todos. Solo se escribe lo que cambia (`patchFromForm`).
 */
export function MetadataPanel({ options, setOptions, ctx }: DocPanelProps<ProMetadataOptions>) {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.metadata;
  const [status, setStatus] = useState<{ snapshotId: string; state: "loading" | "ready" | "failed" }>({
    snapshotId: "",
    state: "loading",
  });
  const setOptionsRef = useRef(setOptions);
  useEffect(() => {
    setOptionsRef.current = setOptions;
  });

  useEffect(() => {
    let cancelled = false;
    readMetadata(ctx.bytes)
      .then((info) => {
        if (cancelled) return;
        setOptionsRef.current({ original: info, form: formFromInfo(info) });
        setStatus({ snapshotId: ctx.snapshotId, state: "ready" });
      })
      .catch(() => {
        if (!cancelled) setStatus({ snapshotId: ctx.snapshotId, state: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [ctx.bytes, ctx.snapshotId]);

  const current = status.snapshotId === ctx.snapshotId ? status.state : "loading";
  const setField = (patch: Partial<MetadataFormFields>) => setOptions({ form: { ...options.form, ...patch } });
  const original = options.original;

  return (
    <>
      <OptionSection>
        <SegmentedControl<"set" | "strip">
          label={s.modeLabel}
          value={options.mode}
          onChange={(mode) => setOptions({ mode })}
          options={[
            { value: "set", label: s.modeSet },
            { value: "strip", label: s.modeStrip },
          ]}
        />
      </OptionSection>

      {current === "loading" ? (
        <p aria-busy="true" className="text-sm text-muted-foreground">
          {s.loading}
        </p>
      ) : null}
      {current === "failed" ? <p className="text-sm text-destructive">{s.loadFailed}</p> : null}

      {current === "ready" && options.mode === "set" ? (
        <>
          <OptionSection>
            <TextField label={s.fieldTitle} value={options.form.title} maxLength={300} onChange={(title) => setField({ title })} />
            <TextField label={s.fieldAuthor} value={options.form.author} maxLength={300} onChange={(author) => setField({ author })} />
            <TextField label={s.fieldSubject} value={options.form.subject} maxLength={500} onChange={(subject) => setField({ subject })} />
            <TextField
              label={s.fieldKeywords}
              value={options.form.keywords}
              maxLength={500}
              hint={s.fieldKeywordsHint}
              onChange={(keywords) => setField({ keywords })}
            />
            <TextField label={s.fieldCreator} value={options.form.creator} maxLength={300} onChange={(creator) => setField({ creator })} />
            <TextField label={s.fieldProducer} value={options.form.producer} maxLength={300} onChange={(producer) => setField({ producer })} />
          </OptionSection>
          <OptionSection>
            <DateField label={s.fieldCreated} clearLabel={s.clearDate} value={options.form.creationDate} onChange={(creationDate) => setField({ creationDate })} />
            <DateField label={s.fieldModified} clearLabel={s.clearDate} value={options.form.modificationDate} onChange={(modificationDate) => setField({ modificationDate })} />
          </OptionSection>
          {original?.hasXmp ? (
            <OptionSection>
              <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {s.xmpNote}
              </p>
              <ToggleRow label={s.keepXmp} checked={options.keepXmp} onChange={(keepXmp) => setOptions({ keepXmp })} />
            </OptionSection>
          ) : null}
          {original && original.customKeys.length > 0 ? (
            <p className="text-xs leading-relaxed text-muted-foreground">{s.customNote(original.customKeys.length)}</p>
          ) : null}
        </>
      ) : null}

      {current === "ready" && options.mode === "strip" ? (
        <OptionSection title={s.stripTitle}>
          <p className="text-sm leading-relaxed text-muted-foreground">{s.stripBody}</p>
          {original && !hasAnyMetadata(original) ? <p className="text-sm text-foreground">{s.stripNothing}</p> : null}
        </OptionSection>
      ) : null}
    </>
  );
}
