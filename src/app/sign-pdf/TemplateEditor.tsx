"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Redo2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/cn";
import { loadPdf } from "@/lib/pdf/core";
import { autoMapFile } from "@/lib/pdf/autoMapFile";
import { getDataKeys } from "@/lib/docLibrary/dataKeys";
import type { DocTemplate, VariantKey } from "@/lib/docLibrary/templateTypes";
import type { Language } from "@/lib/i18n";
import {
  DocumentCanvas,
  nextFieldId,
  nextTextFieldId,
  type CanvasSelection,
  type PlacementTool,
} from "@/app/sign-pdf/DocumentCanvas";
import type { SignStrings } from "@/app/sign-pdf/strings";
import {
  acceptSuggestion,
  applyDetection,
  canMatchPrevious,
  canvasSigners,
  changeKey,
  commitHistory,
  copyVariant,
  fieldCount,
  foldSlots,
  foldTextFields,
  hasSignFields,
  initialsBase,
  initialsPages,
  matchPreviousPage,
  newHistory,
  patchTextField,
  projectVariant,
  redoHistory,
  repeatInitialsIn,
  setRoleLabel,
  signersOf,
  undoHistory,
  type EditorContent,
  type Suggestion,
} from "@/app/sign-pdf/templateEditorModel";
import { saveTemplateToLibrary, type SaveSuccess } from "@/app/sign-pdf/templateLibrary";
import type { SaveFailure } from "@/app/sign-pdf/templateLibrary";

/*
 * Modo «Configurar plantilla» (Fase 2 · U2.3): el MISMO `DocumentCanvas` de Firmar, sin ceremonia, para decir una vez donde
 * firma y donde pone sus iniciales cada firmante de un contrato. Se guarda como PDF base + plantilla en la biblioteca de
 * este navegador; la proxima vez que se cargue el mismo documento los campos aparecen solos.
 *
 * El editor trabaja sobre un `EditorContent` con historial (deshacer / rehacer). El lienzo ve los roles como firmantes
 * («Asegurado», «Co-asegurado») y la variante visible decide cuantos (1 o 2). Todo lo que no es el lienzo es aqui:
 * roles editables, iniciales en todas las paginas (o en un rango, o igualadas a la anterior), campos de texto con etiqueta
 * y origen de dato, deteccion automatica con sugerencias, y guardar.
 */

export type EditorOutcome = { saved: SaveSuccess | null; sign: boolean };

export type TemplateEditorProps = {
  file: File;
  language: Language;
  strings: SignStrings;
  /** Contenido de partida (la plantilla guardada, o lo que se hizo en Firmar). */
  initial: EditorContent;
  /** Variante que se ve al abrir. */
  initialVariant: VariantKey;
  /** Documento de la biblioteca al que pertenece, si ya existe. */
  documentId: string | null;
  /** Plantilla que se edita (se guarda como version nueva); `null` = plantilla nueva. */
  template: Pick<DocTemplate, "id" | "rev"> | null;
  onClose: (outcome: EditorOutcome) => void;
};

const NOOP = () => {};
const EMPTY_VALUES: Record<string, string> = {};
const FIELD_INPUT =
  "h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal";

type DetectState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error" }
  | { status: "done"; placed: number; suggested: number; capped: boolean; marker: number };

export function TemplateEditor({ file, language, strings, initial, initialVariant, documentId, template, onClose }: TemplateEditorProps) {
  const t = strings.template.editor;
  const titleId = useId();
  const nameId = useId();
  const [history, setHistory] = useState(() => newHistory(initial));
  const content = history.present;
  const [name, setName] = useState(initial.name);
  const [variantKey, setVariantKey] = useState<VariantKey>(initialVariant);
  const variant = content.variants[variantKey];
  const [tool, setTool] = useState<PlacementTool>("select");
  const [pageIndex, setPageIndex] = useState(0);
  const [selection, setSelection] = useState<CanvasSelection | null>(null);
  const [activeRole, setActiveRole] = useState(initial.roles[0].key);
  const [pageCount, setPageCount] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [detect, setDetect] = useState<DetectState>({ status: "idle" });
  const [range, setRange] = useState({ from: "1", to: "" });
  const [announcement, setAnnouncement] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SaveSuccess | null>(null);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const identity = useRef({ documentId, template });
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify({ content: initial, name: initial.name }));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const detectAbort = useRef<AbortController | null>(null);

  const mint = useMemo(() => ({ sign: nextFieldId, text: nextTextFieldId }), []);
  const dirty = JSON.stringify({ content, name }) !== savedSnapshot;

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: false });
    let cancelled = false;
    void loadPdf(file)
      .then((pdf) => {
        if (!cancelled) setPageCount(pdf.getPageCount());
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      detectAbort.current?.abort();
    };
  }, [file]);

  useEffect(() => {
    if (!announcement) return;
    const timer = setTimeout(() => setAnnouncement(""), 6000);
    return () => clearTimeout(timer);
  }, [announcement]);

  const say = useCallback((text: string) => {
    setAnnouncement(text);
    setNote(text);
  }, []);

  /* --- Cambios --- */

  const commit = useCallback((next: EditorContent, key?: string | null) => {
    setHistory((current) => commitHistory(current, next, { key }));
    setSaved(null);
    setFailure(null);
  }, []);

  const signers = useMemo(() => canvasSigners(content.roles, variantKey), [content.roles, variantKey]);
  const projected = useMemo(() => projectVariant(variant, content.roles), [variant, content.roles]);
  const effectiveActive = signers.some((signer) => signer.id === activeRole) ? activeRole : signers[0].id;

  const withVariant = useCallback(
    (next: typeof variant): EditorContent => ({ ...content, variants: { ...content.variants, [variantKey]: next } }),
    [content, variantKey],
  );

  const onSlotsChange = (slots: typeof projected.slots) => {
    const next = foldSlots(variant, slots, content.roles);
    commit(withVariant(next), changeKey(variant, next));
  };
  const onTextFieldsChange = (fields: typeof projected.textFields) => {
    const next = foldTextFields(variant, fields);
    commit(withVariant(next), changeKey(variant, next));
  };

  const undo = () => {
    setHistory(undoHistory);
    setSaved(null);
    say(t.undone);
  };
  const redo = () => {
    setHistory(redoHistory);
    setSaved(null);
    say(t.redone);
  };

  /* --- Iniciales --- */

  const signersCount = signersOf(variantKey);
  const baseCandidates = initialsPages(variant, signersCount);
  const basePage = initialsBase(variant, signersCount, pageIndex) ? pageIndex : (baseCandidates[0] ?? -1);

  const repeat = (fromPage: number, toPage: number | "all") => {
    if (basePage < 0) {
      setTool("initials");
      say(t.initialsNeedBase);
      return;
    }
    const outcome = repeatInitialsIn(content, variantKey, { basePage, fromPage, toPage, pageCount: Math.max(pageCount, basePage + 1) });
    if ("error" in outcome) {
      say(outcome.error === "range" ? t.rangeInvalid : outcome.error === "tooMany" ? t.tooManyFields : t.initialsNeedBase);
      return;
    }
    commit(outcome.content);
    say(t.initialsRepeated(outcome.pages.length, signersCount));
  };

  const applyRange = () => {
    const from = Number.parseInt(range.from, 10);
    const to = Number.parseInt(range.to === "" ? String(pageCount) : range.to, 10);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || (pageCount > 0 && to > pageCount)) {
      say(t.rangeInvalid);
      return;
    }
    repeat(from - 1, to - 1);
  };

  const matchPrevious = () => {
    const next = matchPreviousPage(content, variantKey, pageIndex);
    if (!next) {
      say(t.matchPreviousNone);
      return;
    }
    commit(next);
    say(t.matchedPrevious(pageIndex + 1));
  };

  /* --- Variantes --- */

  const otherKey: VariantKey = variantKey === "1" ? "2" : "1";
  const canCopyFromOther = fieldCount(variant) === 0 && fieldCount(content.variants[otherKey]) > 0;
  const copyFromOther = () => {
    const next = copyVariant(content, otherKey, variantKey, Math.max(pageCount, 1));
    if (!next) return;
    commit(next);
    say(t.variantCopied(signersOf(variantKey)));
  };

  const changeVariant = (key: VariantKey) => {
    setVariantKey(key);
    setSelection(null);
    setSuggestions([]);
    say(t.variantShown(signersOf(key)));
  };

  /* --- Detectar --- */

  const runDetect = async () => {
    detectAbort.current?.abort();
    const controller = new AbortController();
    detectAbort.current = controller;
    setDetect({ status: "running" });
    setAnnouncement(t.detecting);
    try {
      const result = await autoMapFile(file, { signers: signersCount, locale: language }, controller.signal);
      if (controller.signal.aborted) return;
      const outcome = applyDetection(content, variantKey, result);
      if (outcome.placed > 0) commit(outcome.content);
      setSuggestions(outcome.suggestions);
      const capped = result.warnings.some((warning) => warning.code === "document-field-cap");
      setDetect({ status: "done", placed: outcome.placed, suggested: outcome.suggested, capped, marker: outcome.placed > 0 ? history.past.length + 1 : -1 });
      setAnnouncement(capped ? `${t.detected(outcome.placed, outcome.suggested)} ${t.detectCapped}` : t.detected(outcome.placed, outcome.suggested));
    } catch {
      if (!controller.signal.aborted) setDetect({ status: "error" });
    }
  };

  const acceptOne = (suggestion: Suggestion) => {
    commit(acceptSuggestion(content, suggestion, mint));
    setSuggestions((list) => list.filter((item) => item.id !== suggestion.id));
    say(t.suggestionAccepted);
  };
  const acceptAll = () => {
    let next = content;
    for (const suggestion of suggestions) next = acceptSuggestion(next, suggestion, mint);
    commit(next);
    setSuggestions([]);
    say(t.suggestionsAccepted(suggestions.length));
  };

  /* --- Campo de texto seleccionado --- */

  const selectedText = selection?.kind === "text" ? variant.textFields.find((field) => field.id === selection.id) : undefined;
  const dataKeys = useMemo(() => getDataKeys(), []);

  /* --- Guardar --- */

  /** `asNew`: «Guardar como documento nuevo» tras un conflicto (se borro o cambio el documento en otra pestana). */
  const save = async (asNew = false) => {
    if (saving) return;
    setFailure(null);
    const label = name.trim();
    if (label === "") {
      setFailure("invalid");
      setNote(t.nameRequired);
      document.getElementById(nameId)?.focus();
      return;
    }
    if (!hasSignFields(content)) {
      setNote(t.nothingToSave);
      setAnnouncement(t.nothingToSave);
      return;
    }
    setSaving(true);
    const snapshot = { ...content, name: label };
    const result = asNew
      ? await saveTemplateToLibrary({ file, content: snapshot, documentId: null, template: null, asNewDocument: true })
      : await saveTemplateToLibrary({ file, content: snapshot, documentId: identity.current.documentId, template: identity.current.template });
    setSaving(false);
    if (!result.ok) {
      setFailure(result.reason);
      setNote(null);
      setAnnouncement(t.saveFailed(result.reason));
      return;
    }
    identity.current = { documentId: result.document.id, template: { id: result.template.id, rev: result.template.rev } };
    setSavedSnapshot(JSON.stringify({ content, name }));
    setSaved(result);
    setNote(null);
    setAnnouncement(t.saved(result.pages));
  };

  const requestClose = () => {
    if (dirty) setLeaveOpen(true);
    else onClose({ saved, sign: false });
  };

  /* --- Atajos: deshacer / rehacer con el teclado (fuera de los campos de texto) --- */

  const rootRef = useRef<HTMLElement>(null);
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  useEffect(() => {
    undoRef.current = undo;
    redoRef.current = redo;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (event.shiftKey) redoRef.current();
      else undoRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const persistenceText =
    saved?.persistence === null || saved === null ? null : saved.persistence.granted ? t.persistenceGranted : saved.persistence.supported ? t.persistenceDenied : t.persistenceUnsupported;

  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const showUndoDetect = detect.status === "done" && detect.marker === history.past.length && detect.placed > 0;

  return (
    <section ref={rootRef} aria-labelledby={titleId} data-template-editor="" className="mx-auto w-full max-w-[1200px] space-y-4 px-4 pb-10 pt-3 md:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_12rem]">
          <h2 id={titleId} ref={headingRef} tabIndex={-1} className="text-title-2 text-foreground outline-none">
            {t.title}
          </h2>
          <p className="mt-1 text-footnote text-muted-foreground [overflow-wrap:anywhere]">{t.subtitle(file.name, pageCount)}</p>
        </div>
        <Button variant="secondary" size="md" onClick={requestClose} aria-label={t.close}>
          <X aria-hidden="true" className="size-4" />
          {t.close}
        </Button>
      </header>

      <p className="rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-2.5 text-footnote leading-relaxed text-muted-foreground">{t.privacy}</p>

      {/* Region viva UNICA del editor. */}
      <p role="status" aria-live="polite" className="sr-only" data-template-live="">
        {announcement}
      </p>

      <div className="surface-card rounded-ios space-y-4 p-4">
        <div>
          <label htmlFor={nameId} className="block pb-1 text-footnote font-medium text-foreground">
            {t.nameLabel}
          </label>
          <input id={nameId} type="text" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder={t.namePlaceholder} className={FIELD_INPUT} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          {content.roles.map((role, index) => (
            <div key={role.key}>
              <label htmlFor={`${nameId}-role-${index}`} className="block pb-1 text-footnote font-medium text-foreground">
                {t.roleLabel(index + 1)}
              </label>
              <input
                id={`${nameId}-role-${index}`}
                type="text"
                value={role.label}
                maxLength={60}
                onChange={(event) => commit(setRoleLabel(content, index, event.target.value), `role:${index}`)}
                className={FIELD_INPUT}
              />
            </div>
          ))}
        </div>

        <div>
          <SegmentedControl<VariantKey>
            label={t.variantLabel}
            value={variantKey}
            onChange={changeVariant}
            options={[
              { value: "1", label: t.variantOne },
              { value: "2", label: t.variantTwo },
            ]}
          />
          <p className="mt-2 text-footnote leading-relaxed text-muted-foreground">{t.variantHint(signersCount, fieldCount(variant))}</p>
          {canCopyFromOther ? (
            <Button variant="secondary" size="md" wrap className="mt-2" onClick={copyFromOther}>
              {t.copyFromOther(signersOf(otherKey))}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t.toolsLabel}>
        <Button variant="secondary" size="md" disabled={!canUndo} onClick={undo}>
          <Undo2 aria-hidden="true" className="size-4" />
          {t.undo}
        </Button>
        <Button variant="secondary" size="md" disabled={!canRedo} onClick={redo}>
          <Redo2 aria-hidden="true" className="size-4" />
          {t.redo}
        </Button>
        <Button variant="secondary" size="md" wrap disabled={detect.status === "running"} onClick={() => void runDetect()}>
          {detect.status === "running" ? t.detecting : t.detect}
        </Button>
      </div>

      {detect.status === "done" || detect.status === "error" ? (
        <div className="rounded-ios-sm border border-white/14 bg-elevated px-3.5 py-3">
          {detect.status === "error" ? (
            <p className="text-footnote text-muted-foreground">{t.detectFailed}</p>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-[1_1_12rem] text-footnote leading-relaxed text-foreground">{t.detected(detect.placed, detect.suggested)}</p>
              {showUndoDetect ? (
                <Button variant="ghost" size="md" onClick={undo}>
                  {t.undo}
                </Button>
              ) : null}
              {detect.capped ? <p className="min-w-0 basis-full text-footnote leading-relaxed text-foreground" data-detect-capped="">{t.detectCapped}</p> : null}
            </div>
          )}
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <section aria-label={t.suggestionsTitle(suggestions.length)} className="surface-card rounded-ios space-y-2 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-headline text-foreground">{t.suggestionsTitle(suggestions.length)}</h3>
            <Button variant="secondary" size="md" onClick={acceptAll}>
              {t.acceptAll}
            </Button>
          </div>
          <ul className="space-y-2">
            {suggestions.map((suggestion) => {
              const value = suggestion.field.value;
              const page = value.pageIndex;
              const what = suggestion.field.kind === "sign" ? t.signKind(suggestion.field.value.type, content.roles[suggestion.field.value.roleIndex]?.label ?? "") : t.textKind(suggestion.field.value.type, suggestion.field.value.label);
              return (
                <li key={suggestion.id} className="flex flex-col gap-2 rounded-ios-sm border border-white/10 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                  <span className="min-w-0 flex-1 text-footnote text-foreground [overflow-wrap:anywhere]">{t.suggestionRow(page + 1, what)}</span>
                  <span className="flex flex-wrap gap-2">
                    <Button variant="ghost" size="md" onClick={() => setPageIndex(page)} aria-label={t.goToPageFor(page + 1, what)}>
                      {t.goToPage(page + 1)}
                    </Button>
                    <Button variant="secondary" size="md" onClick={() => acceptOne(suggestion)} aria-label={t.acceptFor(page + 1, what)}>
                      {t.accept}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="surface-card rounded-ios space-y-3 p-4">
        <h3 className="text-headline text-foreground">{t.initialsTitle}</h3>
        <p className="text-footnote leading-relaxed text-muted-foreground">{signersCount === 2 ? t.initialsHintTwo : t.initialsHintOne}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Button variant="primary" size="md" wrap disabled={pageCount === 0} onClick={() => repeat(0, "all")}>
            {t.repeatAll}
          </Button>
          <Button variant="secondary" size="md" wrap disabled={!canMatchPrevious(content, variantKey, pageIndex)} onClick={matchPrevious}>
            {t.matchPrevious}
          </Button>
        </div>
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center text-footnote font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">{t.rangeLegend}</summary>
          <div className="flex flex-wrap items-end gap-2 pt-1">
            <label className="text-footnote text-muted-foreground">
              {t.rangeFrom}
              <input inputMode="numeric" className={cn(FIELD_INPUT, "mt-1 w-24")} value={range.from} onChange={(event) => setRange((r) => ({ ...r, from: event.target.value.replace(/\D/g, "").slice(0, 4) }))} />
            </label>
            <label className="text-footnote text-muted-foreground">
              {t.rangeTo}
              <input inputMode="numeric" className={cn(FIELD_INPUT, "mt-1 w-24")} value={range.to} placeholder={pageCount > 0 ? String(pageCount) : ""} onChange={(event) => setRange((r) => ({ ...r, to: event.target.value.replace(/\D/g, "").slice(0, 4) }))} />
            </label>
            <Button variant="secondary" size="md" wrap disabled={pageCount === 0} onClick={applyRange}>
              {t.repeatRange}
            </Button>
          </div>
        </details>
      </div>

      {selectedText ? (
        <div className="surface-card rounded-ios space-y-3 p-4" data-text-field-panel="">
          <h3 className="text-headline text-foreground">{t.textFieldTitle}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`${nameId}-label`} className="block pb-1 text-footnote font-medium text-foreground">
                {t.fieldLabel}
              </label>
              <input
                id={`${nameId}-label`}
                type="text"
                value={selectedText.label}
                maxLength={120}
                onChange={(event) => commit(patchTextField(content, variantKey, selectedText.id ?? "", { label: event.target.value }), `label:${selectedText.id}`)}
                className={FIELD_INPUT}
              />
            </div>
            <div>
              <label htmlFor={`${nameId}-key`} className="block pb-1 text-footnote font-medium text-foreground">
                {t.dataKeyLabel}
              </label>
              <select
                id={`${nameId}-key`}
                value={selectedText.dataKey ?? ""}
                onChange={(event) => commit(patchTextField(content, variantKey, selectedText.id ?? "", { dataKey: event.target.value === "" ? null : event.target.value }))}
                className={FIELD_INPUT}
              >
                <option value="">{t.dataKeyNone}</option>
                {dataKeys.map((definition) => (
                  <option key={definition.key} value={definition.key}>
                    {definition.label[language]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {selectedText.type === "date" ? (
            <label className="flex min-h-11 items-center gap-3 text-footnote text-foreground">
              <input
                type="checkbox"
                className="size-5"
                checked={selectedText.rule === "today"}
                onChange={(event) => commit(patchTextField(content, variantKey, selectedText.id ?? "", { rule: event.target.checked ? "today" : null }))}
              />
              {t.ruleToday}
            </label>
          ) : null}
        </div>
      ) : null}

      {note ? (
        <p className="text-footnote leading-relaxed text-foreground" data-template-note="">
          {note}
        </p>
      ) : null}

      <DocumentCanvas
        file={file}
        signers={signers}
        activeSignerId={effectiveActive}
        onActiveSignerIdChange={setActiveRole}
        tool={tool}
        onToolChange={setTool}
        slots={projected.slots}
        onSlotsChange={onSlotsChange}
        textFields={projected.textFields}
        onTextFieldsChange={onTextFieldsChange}
        values={EMPTY_VALUES}
        onValueChange={NOOP}
        pageIndex={pageIndex}
        onPageIndexChange={setPageIndex}
        selection={selection}
        onSelectionChange={setSelection}
        editingId={null}
        onEditingIdChange={NOOP}
        strings={strings}
        keyboardNavEnabled
        undoDeleteEnabled
        richFieldTypesEnabled
        pinchZoomEnabled
      />

      <div className="surface-card rounded-ios space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button size="lg" wrap disabled={saving} onClick={() => void save()}>
            {saving ? t.saving : template || saved ? t.saveNewVersion : t.save}
          </Button>
          {saved ? (
            <Button variant="secondary" size="md" wrap onClick={() => onClose({ saved, sign: true })}>
              {t.signNow}
            </Button>
          ) : null}
        </div>
        {saved ? (
          <div className="space-y-1" data-template-saved="">
            <p className="text-subheadline font-semibold text-foreground">{t.saved(saved.pages)}</p>
            {persistenceText ? <p className="text-footnote text-muted-foreground">{persistenceText}</p> : null}
          </div>
        ) : null}
        {failure ? (
          <p className="text-footnote text-destructive-text" data-template-error="">
            {t.saveFailed(failure)}
          </p>
        ) : null}
        {failure === "conflict" ? (
          <Button variant="secondary" size="md" wrap disabled={saving} onClick={() => void save(true)} data-template-save-as-new="">
            {t.saveAsNew}
          </Button>
        ) : null}
      </div>

      <ConfirmSheet
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        onConfirm={() => onClose({ saved, sign: false })}
        title={t.leaveTitle}
        body={t.leaveBody}
        confirmLabel={t.leaveConfirm}
        cancelLabel={t.leaveStay}
        closeLabel={strings.confirmClose}
      />
    </section>
  );
}
