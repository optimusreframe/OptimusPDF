"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { errorCopy } from "@/components/tool/errorCopy";
import { StatusRegion, useRoutedAnnouncement } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { useI18n, type Language } from "@/lib/i18n";
import { toPdfError } from "@/lib/pdf/core";
import type { DetectedField } from "@/lib/pdf/detectFields";
import { readFillForm, writeFillForm, type FormFieldInfo } from "@/lib/pdf/fillForm";
import { signPdfMulti } from "@/lib/pdf/sign";
import { recordValue } from "@/lib/valueHistory";
import { memoryKeyOf } from "@/app/sign-pdf/fieldMemory";
import { DocumentCanvas, type PlacementTool } from "@/app/sign-pdf/DocumentCanvas";
import { useCanvasSequence } from "@/app/sign-pdf/DocumentSequence";
import { DetectionStatus, PendingFieldsNotice, ReuseValuesPrompt } from "@/app/sign-pdf/DocumentSessionParts";
import { useDocumentSession, type SessionOptions } from "@/app/sign-pdf/useDocumentSession";
import {
  EmbeddedBar,
  EmbeddedSessionShell,
  ModeHeader,
  useBusyFocus,
  useEmbeddedShell,
  useFocusReturn,
  useModeHostBridge,
  type EmbeddedPhase,
} from "@/app/sign-pdf/embeddedChrome";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { FILL_EMBEDDED_STRINGS, withFillWording, type FillEmbeddedStrings } from "@/app/sign-pdf/fillEmbeddedStrings";
import {
  buildFillPlan,
  checkboxFieldsFrom,
  choiceSeedFrom,
  readOnlyIds,
  seedValuesFrom,
} from "@/app/sign-pdf/fillPlan";
import { embeddedWarnings, type SignEmbeddedFacts } from "@/app/sign-pdf/SignEmbedded";
import { SIGN_EMBEDDED_STRINGS } from "@/app/sign-pdf/signEmbeddedStrings";
import { CanvasCompactContext } from "@/app/sign-pdf/canvasCompact";
import { ProModeApplyError } from "@/app/pdf-pro/modes/modeContext";
import { proWarningText } from "@/app/pdf-pro/proStrings";
import type { ProWarning } from "@/app/pdf-pro/proTypes";

/**
 * Rellenar DENTRO de PDF Pro (Wave 7 · U7): el lienzo de Firmar sin firmas (campos de texto, fecha, casilla e
 * iniciales; huecos sugeridos con su interruptor; texto libre) mas los campos AcroForm REALES del PDF.
 *
 * Al aplicar, los valores de los campos reales se ESCRIBEN en el propio formulario (`/V` + apariencia,
 * `fillForm.ts`) y siguen siendo campos (o se aplanan, si se pide); lo que no es un campo real (sugerencias,
 * texto libre, un campo real que se movio de sitio) se DIBUJA sobre la pagina como en Firmar (`signPdfMulti`).
 * Texto y casillas se rellenan sobre la pagina; radios, desplegables y listas, en un panel propio (el lienzo no
 * los edita: limite declarado de la herramienta suelta, resuelto aqui). Crea UN snapshot
 * «Formulario rellenado (N campos)».
 *
 * La sesion, la identidad del documento y el aviso de sesion descartada son los de `SignEmbedded`
 * (`embeddedChrome.tsx`): la sesion pertenece al snapshot con que se abrio y no se guarda como borrador.
 */

export type FillEmbeddedProps = {
  file: File;
  bytes?: Uint8Array;
  lang: Language;
  onApply: (bytes: Uint8Array, label: string, opts?: { warnings?: ProWarning[] }) => Promise<void>;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  facts?: SignEmbeddedFacts;
};

type FillOptions = SessionOptions & {
  fieldPageIndex: number;
  placementTool: PlacementTool;
  editingTextFieldId: string | null;
  /** Valor de radios, desplegables y listas (por `id` de `FormFieldInfo`). */
  choiceValues: Record<string, string>;
  flatten: boolean;
};

const INITIAL_OPTIONS: FillOptions = {
  signature: "",
  textFields: [],
  textValues: {},
  textFieldsDetectedFor: null,
  selectedFieldId: null,
  selectedTextFieldId: null,
  editingTextFieldId: null,
  fieldPageIndex: 0,
  placementTool: "select",
  choiceValues: {},
  flatten: false,
};

const CLEARED_STATE: Partial<FillOptions> = {
  textFields: [],
  textValues: {},
  textFieldsDetectedFor: null,
  selectedFieldId: null,
  selectedTextFieldId: null,
  editingTextFieldId: null,
  fieldPageIndex: 0,
  autoFilled: {},
};

type FormState =
  | { status: "loading" }
  | { status: "ready"; fields: FormFieldInfo[] }
  | { status: "unreadable" };

export function FillEmbedded({ file, bytes, lang, onApply, onCancel, onDirtyChange, facts }: FillEmbeddedProps) {
  const e = FILL_EMBEDDED_STRINGS[lang];
  return (
    <EmbeddedSessionShell file={file} bytes={bytes} resetNotice={e.sessionReset} onDirtyChange={onDirtyChange}>
      <FillEmbeddedSession initialFile={file} lang={lang} onApply={onApply} onCancel={onCancel} facts={facts} />
    </EmbeddedSessionShell>
  );
}

type SessionProps = {
  initialFile: File;
  lang: Language;
  onApply: FillEmbeddedProps["onApply"];
  onCancel: () => void;
  facts?: SignEmbeddedFacts;
};

function FillEmbeddedSession({ initialFile, lang, onApply, onCancel, facts }: SessionProps) {
  const {
    identity,
    getIdentity,
    phase,
    setPhase: onPhase,
    setDirty: onDirty,
    notice,
    dismissNotice: onDismissNotice,
  } = useEmbeddedShell();
  const { t } = useI18n();
  const e = FILL_EMBEDDED_STRINGS[lang];
  const strings = useMemo(() => withFillWording(lang), [lang]);
  const [file] = useState(initialFile);
  const applyRef = useRef<() => Promise<boolean>>(async () => false);
  // «Cancelar» del anfitrion mientras se aplica: el PDF que se esta generando se descarta al terminar.
  const cancelledRef = useRef(false);
  const { hosted, hostBusy, initialPage, reportPage } = useModeHostBridge(
    () => applyRef.current(),
    () => {
      cancelledRef.current = true;
    },
  );
  const [options, setOptionsState] = useState<FillOptions>(() => ({ ...INITIAL_OPTIONS, fieldPageIndex: initialPage }));
  const setOptions = useCallback((patch: Partial<FillOptions>) => {
    setOptionsState((previous) => ({ ...previous, ...patch }));
  }, []);
  const [form, setForm] = useState<FormState>({ status: "loading" });
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const phaseRef = useRef<EmbeddedPhase>("editing");
  const mountedRef = useRef(true);
  const rootRef = useRef<HTMLElement>(null);
  const statusId = useId();
  const noticeRouted = useRoutedAnnouncement(notice ?? "");

  const keyboardNavEnabled = useSignPdfFeatureFlag("keyboardNav");
  const fieldsCompleteNoticeEnabled = useSignPdfFeatureFlag("fieldsCompleteNotice");
  const undoDeleteEnabled = useSignPdfFeatureFlag("undoDelete");
  const richFieldTypesEnabled = useSignPdfFeatureFlag("richFieldTypes");
  const pinchZoomEnabled = useSignPdfFeatureFlag("pinchZoom");
  const sequence = useCanvasSequence();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useFocusReturn(rootRef);

  const session = useDocumentSession<FillOptions>({
    file,
    options,
    setOptions,
    clearedState: CLEARED_STATE,
  });

  /* ---- Campos reales del formulario: lectura unica y siembra de valores ---- */

  useEffect(() => {
    let cancelled = false;
    readFillForm(file)
      .then((info) => {
        if (cancelled) return;
        setForm({ status: "ready", fields: info.fields });
        const checkboxes = checkboxFieldsFrom(info.fields);
        const seeds = seedValuesFrom(info.fields);
        const choices = choiceSeedFrom(info.fields);
        setOptionsState((previous) => {
          const known = new Set(previous.textFields.map((field) => field.id));
          return {
            ...previous,
            textFields: [...previous.textFields, ...checkboxes.filter((field) => !known.has(field.id))],
            // Lo que la persona ya escribio (mientras se leia) manda sobre el valor del PDF.
            textValues: { ...seeds, ...previous.textValues },
            choiceValues: { ...choices, ...previous.choiceValues },
          };
        });
      })
      .catch(() => {
        if (!cancelled) setForm({ status: "unreadable" });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const formFields = useMemo(() => (form.status === "ready" ? form.fields : []), [form]);
  const hidden = useMemo(() => readOnlyIds(formFields), [formFields]);
  const visibleTextFields = useMemo(
    () => options.textFields.filter((field) => !hidden.has(field.id)),
    [options.textFields, hidden],
  );
  const hiddenTextFields = useMemo(
    () => options.textFields.filter((field) => hidden.has(field.id)),
    [options.textFields, hidden],
  );
  const onCanvasFieldsChange = (next: DetectedField[]) => session.onTextFieldsChange([...hiddenTextFields, ...next]);

  const plan = useMemo(
    () =>
      buildFillPlan({
        textFields: options.textFields,
        textValues: options.textValues,
        formFields,
        choiceValues: options.choiceValues,
        language: lang,
      }),
    [options.textFields, options.textValues, formFields, options.choiceValues, lang],
  );
  const hasForm = formFields.length > 0;
  const ready = plan.fieldCount > 0 || (options.flatten && hasForm);
  const formStatusText =
    form.status === "loading"
      ? e.loadingForm
      : form.status === "unreadable"
        ? e.formUnreadable
        : hasForm
          ? e.formFound(formFields.length)
          : e.noForm;
  const dirty = plan.fieldCount > 0 || options.flatten;

  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);

  const warnings = useMemo(() => embeddedWarnings(facts), [facts]);

  const changePhase = useCallback(
    (next: EmbeddedPhase) => {
      phaseRef.current = next;
      onPhase(next);
    },
    [onPhase],
  );

  /**
   * Escribe los valores en el formulario (`/V` + apariencia) y dibuja el resto, y se lo da a `onApply`. Devuelve
   * `true` si se aplico. Los fallos propios son `ProModeApplyError` (con anfitrion) o un mensaje local.
   */
  const runApply = async (): Promise<boolean> => {
    if (phaseRef.current !== "editing") return false;
    const fail = (message: string): false => {
      if (hosted) throw new ProModeApplyError(message);
      setError(message);
      return false;
    };
    if (!ready) return fail(e.notReady);
    changePhase("applying");
    cancelledRef.current = false;
    setError(null);
    setProgress(0);
    let current: Uint8Array;
    try {
      const source = new Uint8Array(await file.arrayBuffer());
      current = source;
      if (plan.writes.length > 0 || options.flatten) {
        const written = await writeFillForm(
          new Blob([current as unknown as BlobPart], { type: "application/pdf" }),
          plan.writes,
          { flatten: options.flatten },
          (value) => {
            if (mountedRef.current) setProgress(value * 0.6);
          },
        );
        if (written.skipped.length > 0) {
          if (mountedRef.current) changePhase("editing");
          return fail(e.skippedFields(written.skipped.length));
        }
        current = written.bytes;
      }
      if (plan.placements.length > 0) {
        const drawn = await signPdfMulti(
          new File([current as unknown as BlobPart], file.name, { type: "application/pdf" }),
          { placements: plan.placements },
          (value) => {
            if (mountedRef.current) setProgress(0.6 + value * 0.4);
          },
        );
        current = new Uint8Array(await drawn.arrayBuffer());
      }
    } catch (caught) {
      if (mountedRef.current) changePhase("editing");
      return fail(`${e.applyFailed} ${errorCopy(t, toPdfError(caught).code).message}`);
    }
    if (cancelledRef.current) {
      cancelledRef.current = false;
      if (mountedRef.current) changePhase("editing");
      return false;
    }
    // El documento cambio mientras se escribia el formulario: no se encadena sobre otro.
    if (getIdentity() !== identity) {
      if (mountedRef.current) changePhase("editing");
      return fail(e.staleResult);
    }
    // La memoria va por ETIQUETA (la del campo o la que sugiere el nombre del campo del formulario), no por el texto del rotulo.
    for (const field of options.textFields) {
      const key = memoryKeyOf(field);
      const value = options.textValues[field.id]?.trim();
      if (!key || !value || (field.type ?? "text") !== "text") continue;
      // Lo que puso el autorrelleno ya esta en la memoria por su origen.
      if (options.autoFilled?.[field.id] === "filled") continue;
      recordValue(key, value);
    }
    const label = plan.fieldCount > 0 ? e.labelFilled(plan.fieldCount) : e.labelFlattened;
    try {
      await onApply(current, label, warnings.length > 0 ? { warnings } : undefined);
    } catch (caught) {
      if (mountedRef.current) changePhase("editing");
      if (hosted) throw caught;
      if (mountedRef.current) setError(e.applyFailed);
      return false;
    }
    // `onApply` resolvio: el documento se aplico. El anfitrion sustituye el modo al crear el snapshot, pero React lo
    // desmonta DESPUES de este punto: si pasado ese instante sigue montado con el mismo documento, la sesion continua.
    window.setTimeout(() => {
      if (mountedRef.current && getIdentity() === identity) changePhase("editing");
    }, 0);
    return true;
  };
  useEffect(() => {
    applyRef.current = runApply;
  });
  useEffect(() => {
    reportPage(options.fieldPageIndex);
  }, [reportPage, options.fieldPageIndex]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = phase === "applying" || hostBusy;
  useBusyFocus(scrollRef, busy);

  const choiceFields = formFields.filter(
    (info) => info.kind === "radio" || info.kind === "dropdown" || info.kind === "list",
  );

  return (
    <CanvasCompactContext.Provider value>
    <section
      ref={rootRef}
      aria-label={e.regionLabel}
      tabIndex={-1}
      data-pro-mode="fill"
      data-phase={phase}
      data-hosted={hosted ? "" : undefined}
      className="flex h-full min-h-0 flex-1 flex-col outline-none"
    >
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2 max-md:scroll-pb-32 md:px-4"
        data-pro-mode-scroll=""
        inert={busy}
      >
        <div className="mx-auto w-full max-w-[1100px] space-y-3">
          <h2 className="sr-only">{e.title}</h2>
          <ModeHeader
            status={
              <StatusRegion as="p" text={formStatusText} className="text-footnote text-foreground" data-fill-form-status="">
                {formStatusText}
              </StatusRegion>
            }
            notesLabel={SIGN_EMBEDDED_STRINGS[lang].notesLabel}
            notes={[e.howItWorks, e.sessionNote]}
            warningsLabel={e.warningsTitle}
            warningsCount={SIGN_EMBEDDED_STRINGS[lang].warningsCount}
            warnings={warnings.map((warning) => ({
              code: warning.code,
              short: SIGN_EMBEDDED_STRINGS[lang].warningShort[
                warning.code as keyof (typeof SIGN_EMBEDDED_STRINGS)["es"]["warningShort"]
              ],
              full: proWarningText(lang, warning),
            }))}
          />

          {notice ? (
            <div
              role={noticeRouted ? undefined : "status"}
              className="flex items-center justify-between gap-3 rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5"
            >
              <span className="text-footnote text-foreground">{notice}</span>
              <Button variant="ghost" size="sm" onClick={onDismissNotice}>
                {strings.confirmClose}
              </Button>
            </div>
          ) : null}

          <section className="flex flex-col gap-4">
            <DetectionStatus
              detecting={session.detecting}
              failed={session.detectionFailed}
              // Una sola cifra de campos: la de `readFillForm` (arriba); el recuento de la deteccion no se repite.
              detectedCount={0}
              strings={strings}
            />
            {session.reuseMatches ? (
              <ReuseValuesPrompt
                matches={session.reuseMatches}
                textFields={options.textFields}
                onAccept={session.acceptReuse}
                onDecline={session.declineReuse}
                strings={strings}
              />
            ) : null}

            <DocumentCanvas
              file={file}
              signers={[]}
              activeSignerId={null}
              onActiveSignerIdChange={() => {}}
              tool={options.placementTool}
              onToolChange={(placementTool) => setOptions({ placementTool })}
              slots={[]}
              onSlotsChange={() => {}}
              textFields={visibleTextFields}
              onTextFieldsChange={onCanvasFieldsChange}
              values={options.textValues}
              onValueChange={session.onTextValueChange}
              pageIndex={options.fieldPageIndex}
              onPageIndexChange={(fieldPageIndex) => setOptions({ fieldPageIndex })}
              selection={session.canvasSelection}
              onSelectionChange={session.onCanvasSelectionChange}
              editingId={options.editingTextFieldId}
              onEditingIdChange={(editingTextFieldId) => setOptions({ editingTextFieldId })}
              strings={strings}
              keyboardNavEnabled={keyboardNavEnabled}
              undoDeleteEnabled={undoDeleteEnabled}
              richFieldTypesEnabled={richFieldTypesEnabled}
              pinchZoomEnabled={pinchZoomEnabled}
              sequence={sequence}
              tagging={session.tagging}
            />
            {session.autoFillToast}

            <PendingFieldsNotice
              missing={fieldsCompleteNoticeEnabled ? session.textFieldsMissing : 0}
              strings={strings}
            />
          </section>

          {choiceFields.length > 0 ? (
            <ChoiceFields
              fields={choiceFields}
              values={options.choiceValues}
              onChange={(id, value) =>
                setOptionsState((previous) => ({ ...previous, choiceValues: { ...previous.choiceValues, [id]: value } }))
              }
              strings={e}
              idPrefix={statusId}
            />
          ) : null}

          {hasForm ? (
            <div className="rounded-ios-sm border border-hairline bg-white/3 px-3 py-2.5">
              <label className="flex min-h-11 cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={options.flatten}
                  onChange={(event) => setOptions({ flatten: event.target.checked })}
                  className="mt-1 size-5 shrink-0 accent-[var(--color-signal)]"
                  data-fill-flatten=""
                />
                <span className="min-w-0">
                  <span className="block text-callout font-semibold text-foreground">{e.flattenLabel}</span>
                  <span className="block text-footnote leading-relaxed text-muted-foreground">{e.flattenHint}</span>
                </span>
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <EmbeddedBar
        phase={phase}
        progress={progress}
        ready={ready}
        readyText={e.ready}
        notReadyText={e.notReady}
        error={error}
        statusId={statusId}
        applyLabel={e.apply}
        discardLabel={e.discard}
        applyingLabel={e.applying}
        onApply={() => void runApply().catch(() => {})}
        onCancel={onCancel}
        hosted={hosted}
      >
        {plan.unsupported.length > 0 ? (
          <StatusRegion as="p" text={e.unsupportedChars(plan.unsupported.join(" "))} className="mt-1 text-footnote text-muted-foreground" data-fill-unsupported="">
            {e.unsupportedChars(plan.unsupported.join(" "))}
          </StatusRegion>
        ) : null}
        {plan.truncated > 0 ? (
          <StatusRegion as="p" text={e.willTruncate(plan.truncated)} className="mt-1 text-footnote text-muted-foreground" data-fill-truncated="">
            {e.willTruncate(plan.truncated)}
          </StatusRegion>
        ) : null}
      </EmbeddedBar>
    </section>
    </CanvasCompactContext.Provider>
  );
}

/**
 * `min-h-11` no basta en un `<select>` desplegable: Safari (WebKit) ignora `min-height` en el menu nativo y lo deja en
 * ~23 px (por debajo de los 44 px tactiles). Los desplegables llevan ademas `h-11`; las listas (`size` > 1) no, para que
 * `height` no les aplaste las filas.
 */
const DROPDOWN_HEIGHT_CLASS = "h-11";

const CONTROL_CLASS =
  "min-h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-callout pointer-coarse:text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-60";

/** Radios, desplegables y listas: el lienzo no los edita, asi que se eligen con controles nativos. */
function ChoiceFields({
  fields,
  values,
  onChange,
  strings,
  idPrefix,
}: {
  fields: FormFieldInfo[];
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
  strings: FillEmbeddedStrings;
  idPrefix: string;
}) {
  return (
    <section aria-labelledby={`${idPrefix}-choices`} className="space-y-3 rounded-ios-sm border border-hairline bg-white/3 px-3 py-3" data-fill-choices="">
      <div>
        <h3 id={`${idPrefix}-choices`} className="text-headline text-foreground">
          {strings.choicesTitle}
        </h3>
        <p className="mt-0.5 text-footnote text-muted-foreground">{strings.choicesHint}</p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {fields.map((info) => {
          const value = values[info.id] ?? info.value;
          const controlId = `${idPrefix}-${info.id}`;
          const where = strings.choicePage(info.pageIndex + 1);
          if (info.kind === "radio") {
            return (
              <fieldset key={info.id} disabled={info.readOnly} className="min-w-0" data-fill-choice={info.id}>
                <legend className="text-callout font-semibold text-foreground">
                  {info.name} <span className="text-footnote font-normal text-muted-foreground">· {where}</span>
                </legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {[...(info.options ?? []), ""].map((option) => (
                    <label
                      key={option || "none"}
                      className="flex min-h-11 cursor-pointer items-center gap-2 rounded-ios-sm border border-white/14 bg-white/5 px-3 text-callout"
                    >
                      <input
                        type="radio"
                        name={controlId}
                        checked={value === option}
                        onChange={() => onChange(info.id, option)}
                        className="size-5 accent-[var(--color-signal)]"
                      />
                      {option || strings.choiceNone}
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          }
          const multiple = info.kind === "list" && info.multiSelect === true;
          const selected = multiple ? (value ? value.split("\n") : []) : value;
          const options = info.options ?? [];
          const extra = info.kind === "dropdown" && info.editable && value && !options.includes(value) ? [value] : [];
          return (
            <div key={info.id} className="min-w-0" data-fill-choice={info.id}>
              <label htmlFor={controlId} className="block pb-1 text-callout font-semibold text-foreground">
                {info.name} <span className="text-footnote font-normal text-muted-foreground">· {where}</span>
              </label>
              <select
                id={controlId}
                className={info.kind === "list" ? CONTROL_CLASS : `${CONTROL_CLASS} ${DROPDOWN_HEIGHT_CLASS}`}
                disabled={info.readOnly}
                multiple={multiple}
                size={info.kind === "list" ? Math.min(Math.max(options.length, 2), 6) : undefined}
                value={selected}
                onChange={(event) =>
                  onChange(
                    info.id,
                    multiple
                      ? Array.from(event.target.selectedOptions, (option) => option.value).join("\n")
                      : event.target.value,
                  )
                }
              >
                {multiple ? null : <option value="">{strings.choiceNone}</option>}
                {[...options, ...extra].map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </section>
  );
}
