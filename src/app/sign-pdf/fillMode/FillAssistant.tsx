"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronsRight,
  Clock,
  FileText,
  ListChecks,
  SkipForward,
  Tag,
  Undo2,
  User,
  X,
} from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useOptionalLanguage } from "@/lib/i18n";
import { formatIsoDate } from "@/lib/pdf/detectFields";
import { TODAY_DATA_KEY } from "@/lib/docLibrary/dataKeys";
import { tagLabel, tagOf } from "@/lib/fieldTags";
import { customTagNames, rankedSuggestions, recordValue, useValueHistoryVersion } from "@/lib/valueHistory";
import { useClientProfiles } from "@/lib/clientProfile/store";
import type { AutoMark } from "@/lib/fieldPropagation";
import type { DocumentCanvasApi } from "@/app/sign-pdf/DocumentCanvas";
import { FieldTagPicker, keepInputFocus } from "@/app/sign-pdf/FieldTagPicker";
import { CustomTagSheet } from "@/app/sign-pdf/CustomTagSheet";
import { impliedTagOf } from "@/app/sign-pdf/fieldMemory";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";
import { useDockHeight, useKeyboardInset } from "@/app/sign-pdf/fillMode/useDock";
import { MAX_FILL_UNDO, type FillControl, type FillCursor } from "@/app/sign-pdf/fillMode/fillControl";
import { FillListSheet } from "@/app/sign-pdf/fillMode/FillListSheet";
import { useFillStrings } from "@/app/sign-pdf/fillMode/fillStrings";
import {
  buildChips,
  buildFillSteps,
  firstStep,
  indexOfStep,
  inputKindOf,
  memoryKeyOfStep,
  nextAttention,
  stepKey,
  summarize,
  todayIso,
  visibleSteps,
  type FillChip,
  type FillDocInput,
  type FillStep,
} from "@/app/sign-pdf/fillMode/fillSteps";

/*
 * El asistente «Rellenar» (W3-B2): un panel acoplado abajo que lleva a la persona de campo en campo por TODOS los documentos de la
 * ronda, en orden de lectura. La hoja resalta y centra el campo de ahora (`fillFocusId` del lienzo + `scrollIntoViewRect`); el
 * panel trae la entrada grande con el teclado correcto, las sugerencias a un toque, Siguiente / Anterior / Saltar y el progreso.
 *
 * Lo que escribe va por la MISMA via que el editor de la hoja (`onValue` = `onTextValueChange` de la sesion): borradores,
 * deshacer, memoria por etiqueta y propagacion («Rellenado en N campos · Deshacer») funcionan igual. El estado del asistente
 * (cursor, abierto) vive fuera del flujo (`FillControl`) para sobrevivir al cambio de documento.
 */

export type FillPatch = { textValues?: Record<string, string>; autoFilled?: Record<string, AutoMark> };

export type FillAssistantProps = {
  control: FillControl;
  /** TODOS los documentos de la ronda, en su orden. */
  docs: readonly FillDocInput[];
  /** Documento que tiene el lienzo ahora. */
  activeDocId: string;
  /** API del lienzo del documento activo (centrar el campo). */
  api: DocumentCanvasApi | null;
  /** El lienzo tiene un campo abierto en edicion: el panel se aparta hasta que termine. */
  hidden: boolean;
  /** Campo de texto seleccionado en la hoja (tocar un campo en la pagina lleva el cursor a el). */
  selectedFieldId: string | null;
  /** Escribe en un campo del documento ACTIVO. */
  onValue: (fieldId: string, value: string) => void;
  /** La persona da por bueno el valor de un campo del documento activo (propagacion por etiqueta). Ausente = sin etiquetas. */
  onCommit?: (fieldId: string, value: string) => void;
  /** Pone, cambia o quita la etiqueta de un campo del documento activo. Ausente = sin etiquetas. */
  onTag?: (fieldId: string, tag: string | null) => void;
  /** Cambia el documento activo y lleva su lienzo a esa pagina. */
  onGoToDoc: (docId: string, pageIndex: number) => void;
  /** Escribe valores y marcas en un documento cualquiera (lo usa «Deshacer»). */
  onPatchDoc: (docId: string, patch: FillPatch) => void;
  /** «Continuar a firmar»: pasa al paso siguiente del flujo. Ausente = el asistente solo se cierra. */
  onContinue?: () => void;
  /** No hay nada que firmar todavia (ni huecos ni texto): «Continuar» se explica en vez de funcionar. */
  continueBlocked?: boolean;
  /** Boton que devolvio el foco al cerrar (la entrada del paso). */
  returnFocusSelector?: string;
};

const NAME_FALLBACK_MAX = 60;

/** Defer a un microtask: el lint del proyecto no admite `setState` sincrono en el cuerpo de un efecto. */
function defer(callback: () => void): void {
  queueMicrotask(callback);
}

/** Nombre a mostrar de un campo: su rotulo del documento, su etiqueta o, sin ninguno, «Campo sin nombre». */
function useStepName() {
  const language = useOptionalLanguage();
  const strings = useFillStrings();
  return (step: FillStep): string => {
    const label = step.field.label?.trim();
    if (label) return label.length > NAME_FALLBACK_MAX ? `${label.slice(0, NAME_FALLBACK_MAX - 1)}…` : label;
    const tag = tagOf(step.field);
    if (tag) return tagLabel(tag, language, customTagNames());
    return strings.unnamedField(step.field.pageIndex + 1);
  };
}

const CHIP_BASE =
  "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-subheadline font-medium whitespace-nowrap " +
  "bg-white/10 text-foreground transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] " +
  "hover:bg-white/16 active:scale-[0.97] motion-reduce:active:scale-100 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal forced-colors:border forced-colors:border-[ButtonText]";

const ICON_BUTTON =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-full text-foreground transition-[background-color,scale] " +
  "duration-[var(--duration-fast)] ease-[var(--ease-spring)] hover:bg-white/10 active:scale-[0.97] motion-reduce:active:scale-100 " +
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-40";

function SourceIcon({ source }: { source: FillChip["source"] }) {
  const common = "size-4 shrink-0 text-muted-foreground";
  if (source === "profile") return <User aria-hidden="true" className={common} />;
  if (source === "document") return <FileText aria-hidden="true" className={common} />;
  return <Clock aria-hidden="true" className={common} />;
}

function Highlighted({ chip }: { chip: FillChip }) {
  if (chip.matchAt < 0 || chip.matchLength === 0) return <>{chip.text}</>;
  const end = chip.matchAt + chip.matchLength;
  return (
    <>
      {chip.text.slice(0, chip.matchAt)}
      <strong className="font-semibold text-signal-text">{chip.text.slice(chip.matchAt, end)}</strong>
      {chip.text.slice(end)}
    </>
  );
}

export function FillAssistant({
  control,
  docs,
  activeDocId,
  api,
  hidden,
  selectedFieldId,
  onValue,
  onCommit,
  onTag,
  onGoToDoc,
  onPatchDoc,
  onContinue,
  continueBlocked = false,
  returnFocusSelector,
}: FillAssistantProps) {
  const { state, setState, undoStack } = control;
  const strings = useFillStrings();
  const tagStrings = useTagStrings();
  const language = useOptionalLanguage();
  const stepName = useStepName();
  const profiles = useClientProfiles();
  useValueHistoryVersion();

  const open = state.open;
  const all = buildFillSteps(docs);
  const cursorKey = state.cursor ? stepKey(state.cursor.docId, state.cursor.fieldId) : null;
  const list = visibleSteps(all, state.reviewAuto, cursorKey);
  const index = indexOfStep(list, cursorKey);
  const step = index >= 0 ? list[index] : null;
  const isLast = index >= 0 && index === list.length - 1;
  const working = step !== null && step.docId === activeDocId;

  const dockRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneHeadingRef = useRef<HTMLHeadingElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  const listButtonRef = useRef<HTMLButtonElement>(null);
  const inset = useKeyboardInset();
  const dockHeight = useDockHeight(dockRef, open && !hidden);
  const headingId = useId();
  const [announcement, setAnnouncement] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [customTagFor, setCustomTagFor] = useState<string | null>(null);

  /** Lo que tenia el campo al llegar a el: «Deshacer» devuelve a esto y deja la pila sin ruido si no cambio nada. */
  const [baseline, setBaseline] = useState<{ key: string; value: string; mark: AutoMark | undefined } | null>(null);
  const markOf = (target: FillStep): AutoMark | undefined => docs.find((doc) => doc.id === target.docId)?.autoFilled?.[target.field.id];

  /* ---- El cursor: primer campo al abrir; uno valido siempre ---- */
  useEffect(() => {
    if (!open) return;
    if (step) return;
    defer(() => {
      const first = firstStep(visibleSteps(all, state.reviewAuto, null), state.reviewAuto);
      if (!first) {
        // Nada que rellenar (se borraron los campos): se cierra solo en vez de dejar un panel vacio.
        setState({ open: false, cursor: null, finished: false });
        return;
      }
      setState({ cursor: { docId: first.docId, fieldId: first.field.id }, finished: false });
      if (first.docId !== activeDocId) onGoToDoc(first.docId, first.field.pageIndex);
    });
    // `all` cambia en cada render (se reconstruye); solo importa que haya o no cursor valido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step === null, cursorKey]);

  /* ---- Tocar un campo de la pagina lleva el cursor a el ---- */
  const lastSelectedRef = useRef<string | null>(selectedFieldId);
  useEffect(() => {
    if (lastSelectedRef.current === selectedFieldId) return;
    lastSelectedRef.current = selectedFieldId;
    if (!open || !selectedFieldId) return;
    const target = all.find((candidate) => candidate.docId === activeDocId && candidate.field.id === selectedFieldId);
    if (!target || target.key === cursorKey) return;
    defer(() => setState({ cursor: { docId: target.docId, fieldId: target.field.id }, finished: false }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFieldId]);

  /* ---- Linea base del campo (para «Deshacer»): lo que tenia al llegar a el ---- */
  useEffect(() => {
    if (!open || !step) {
      defer(() => setBaseline(null));
      return;
    }
    const arrival = { key: step.key, value: step.value, mark: markOf(step) };
    defer(() => setBaseline((previous) => (previous?.key === arrival.key ? previous : arrival)));
    // Solo al llegar a un campo nuevo: `step`/`docs` cambian con cada tecla y no deben mover la linea base.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cursorKey]);

  /* ---- Centrar el campo en la hoja (y destacar con un destello al LLEGAR, no en cada ajuste de altura) ---- */
  const revealedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!open || hidden || state.finished || !step || step.docId !== activeDocId || !api) {
      if (!open) revealedKeyRef.current = null;
      return;
    }
    const arrived = revealedKeyRef.current !== step.key;
    revealedKeyRef.current = step.key;
    api.scrollIntoViewRect(step.field.rect, {
      pageIndex: step.field.pageIndex,
      block: "center",
      margin: 16,
      behavior: arrived ? "smooth" : "auto",
      ...(arrived ? { highlightId: step.field.id } : {}),
    });
    // El panel y el teclado cambian la franja libre: se vuelve a centrar cuando cambian sus medidas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hidden, state.finished, cursorKey, activeDocId, api, dockHeight, inset]);

  /* ---- Foco en la entrada al llegar a un campo de texto (el teclado sube solo desde un toque de la persona) ---- */
  useLayoutEffect(() => {
    if (!open || hidden || state.finished || !step || !working) return;
    if (step.type === "checkbox") {
      switchRef.current?.focus({ preventScroll: true });
      return;
    }
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    // Un campo con texto se deja con el cursor al final: seguir escribiendo o borrar con un toque.
    if (step.type !== "date") {
      const end = input.value.length;
      try {
        input.setSelectionRange(end, end);
      } catch {
        // Algunos tipos de entrada (correo, telefono) no admiten seleccion: no pasa nada.
      }
    }
    // Solo al llegar a un campo nuevo o al volver a verse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hidden, state.finished, cursorKey, working]);

  /* ---- Pegado a la pagina: nada de la hoja queda tapado al final ---- */
  const typed = step?.value ?? "";
  const memoryKey = step ? memoryKeyOfStep(step) : null;
  const memory = useMemo(
    () => (open && step && memoryKey && step.type !== "checkbox" ? rankedSuggestions(memoryKey, typed, 8) : []),
    // La memoria cambia con lo escrito y con el almacen (useValueHistoryVersion fuerza el render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, cursorKey, memoryKey, typed],
  );
  const chips: FillChip[] = step
    ? buildChips({
        step,
        typed,
        memory,
        profiles,
        formatDate: (iso) => formatIsoDate(iso, language),
      })
    : [];

  /* ---- Acciones ---- */

  /** Registra en la pila de «Deshacer» lo que cambio el campo desde que se llego a el. */
  const rememberChange = (target: FillStep) => {
    const base = baseline;
    if (!base || base.key !== target.key) return;
    const mark = markOf(target);
    if (base.value === target.value && base.mark === mark) return;
    undoStack.current.push({
      docId: target.docId,
      fieldId: target.field.id,
      value: base.value === "" ? undefined : base.value,
      mark: base.mark,
      name: stepName(target),
    });
    if (undoStack.current.length > MAX_FILL_UNDO) undoStack.current.shift();
    setState({ undoCount: undoStack.current.length });
    setBaseline({ key: target.key, value: target.value, mark });
  };

  /** La persona da por bueno el campo: memoria, propagacion por etiqueta y, si era un autorrelleno, pasa a ser suyo. */
  const confirm = (target: FillStep) => {
    if (target.docId !== activeDocId) return;
    const text = target.value;
    if (target.auto) {
      // Confirmar un autorrelleno lo suelta de la cola (valor de la persona): se reescribe el mismo texto.
      onValue(target.field.id, text);
      return;
    }
    if (target.type === "checkbox" || text.trim() === "") return;
    const key = memoryKeyOfStep(target);
    if (key && target.type !== "date") recordValue(key, text.trim());
    onCommit?.(target.field.id, text);
  };

  const moveTo = (target: FillStep | null, spoken = true) => {
    if (!target) {
      setState({ finished: true });
      setAnnouncement(strings.finished);
      return;
    }
    const cursor: FillCursor = { docId: target.docId, fieldId: target.field.id };
    setState({ cursor, finished: false });
    if (target.docId !== activeDocId) onGoToDoc(target.docId, target.field.pageIndex);
    if (spoken) {
      const position = indexOfStep(list, target.key) + 1;
      setAnnouncement(strings.moved(position, list.length, stepName(target)));
    }
  };

  const go = (direction: 1 | -1, { commit }: { commit: boolean }) => {
    if (!step) return;
    rememberChange(step);
    if (commit) confirm(step);
    const target = list[index + direction] ?? null;
    if (direction === -1) {
      if (target) moveTo(target);
      return;
    }
    moveTo(target);
  };

  const next = () => go(1, { commit: true });
  const prev = () => go(-1, { commit: true });
  const skip = () => {
    if (!step) return;
    setAnnouncement(strings.skipped(stepName(step)));
    go(1, { commit: false });
  };

  const gotoEmpty = () => {
    if (!step) return;
    rememberChange(step);
    confirm(step);
    const target = nextAttention(list, index, state.reviewAuto);
    if (!target) {
      setAnnouncement(strings.noEmptyLeft);
      return;
    }
    moveTo(target);
  };

  const undo = () => {
    if (!step) return;
    const base = baseline;
    // Primero lo que se cambio en ESTE campo; si no cambio nada, el ultimo campo que se toco con el asistente.
    if (base && base.key === step.key && (base.value !== step.value || base.mark !== markOf(step))) {
      restore(step.docId, step.field.id, base.value === "" ? undefined : base.value, base.mark);
      setAnnouncement(strings.undone(stepName(step)));
      return;
    }
    const entry = undoStack.current.pop();
    if (!entry) return;
    setState({ undoCount: undoStack.current.length });
    restore(entry.docId, entry.fieldId, entry.value, entry.mark);
    const target = all.find((candidate) => candidate.docId === entry.docId && candidate.field.id === entry.fieldId) ?? null;
    if (target) moveTo(target, false);
    setAnnouncement(strings.undone(entry.name));
  };

  const restore = (docId: string, fieldId: string, value: string | undefined, mark: AutoMark | undefined) => {
    const doc = docs.find((candidate) => candidate.id === docId);
    if (!doc) return;
    const textValues = { ...doc.textValues };
    if (value === undefined) delete textValues[fieldId];
    else textValues[fieldId] = value;
    const autoFilled = { ...(doc.autoFilled ?? {}) };
    if (mark === undefined) delete autoFilled[fieldId];
    else autoFilled[fieldId] = mark;
    onPatchDoc(docId, { textValues, autoFilled });
    if (baseline?.key === stepKey(docId, fieldId)) setBaseline({ key: stepKey(docId, fieldId), value: value ?? "", mark });
  };

  const canUndo =
    step !== null && ((baseline?.key === step.key && (baseline.value !== step.value || baseline.mark !== markOf(step))) || state.undoCount > 0);

  const close = () => {
    if (step) {
      rememberChange(step);
      confirm(step);
    }
    setListOpen(false);
    setState({ open: false, finished: false });
    if (returnFocusSelector) defer(() => document.querySelector<HTMLElement>(returnFocusSelector)?.focus({ preventScroll: true }));
  };

  /**
   * Un toque en una sugerencia (o en «Hoy») completa el campo y sigue. La escritura es asincrona (estado de React): confirmar y
   * avanzar espera a que el campo ya tenga el valor nuevo (efecto de mas abajo), para que la memoria y la propagacion por
   * etiqueta lean el dato de verdad y no el de antes.
   */
  const pendingAdvanceRef = useRef<{ key: string; value: string } | null>(null);
  const pickValue = (value: string, spoken: string) => {
    if (!step || !working) return;
    setAnnouncement(spoken);
    if (value === step.value && !step.auto) {
      next();
      return;
    }
    pendingAdvanceRef.current = { key: step.key, value };
    onValue(step.field.id, value);
  };
  const pickChip = (chip: FillChip) => pickValue(chip.value, strings.suggestionPicked(chip.text));
  const todayChip = () => {
    if (!step) return;
    const iso = todayIso();
    const readable = formatIsoDate(iso, language);
    // Un campo de fecha lleva la fecha ISO (el selector nativo la muestra a su manera); uno de texto, la fecha ya legible.
    pickValue(step.type === "date" ? iso : readable, strings.todayDone(readable));
  };
  useEffect(() => {
    const pending = pendingAdvanceRef.current;
    if (!pending || !step || pending.key !== step.key || step.value !== pending.value) return;
    pendingAdvanceRef.current = null;
    defer(() => next());
    // `next` se reconstruye en cada render: lo que cuenta es que el campo ya tenga el valor elegido.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.key, step?.value]);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      next();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  /* ---- Fin / lista ---- */
  const summary = summarize(all);
  const goToField = (target: FillStep) => {
    setListOpen(false);
    moveTo(target);
  };

  if (!open) return null;

  const paddingBottom = inset > 0 ? "0.5rem" : "max(env(safe-area-inset-bottom, 0px), 0.5rem)";
  const progressValue = list.length > 0 && index >= 0 ? Math.round(((state.finished ? list.length : index) / list.length) * 100) : 0;
  const tag = step ? (tagOf(step.field) ?? null) : null;
  const tagName = tag ? tagLabel(tag, language, customTagNames()) : null;
  const kind = step ? inputKindOf(step) : null;
  const taggable = onTag && step && (step.type === "text" || step.type === "date") ? step.type : null;
  const sourceText = (chip: FillChip): string =>
    chip.source === "memory" ? strings.sourceMemory : chip.source === "document" ? strings.sourceDocument(chip.from ?? "") : strings.sourceProfile(chip.from ?? "");
  /** Hay otro campo vacio mas alla de este: se ofrece «Ir al siguiente vacio» en la cabecera. */
  const hasEmptyElsewhere = step !== null && index >= 0 && nextAttention(list, index, state.reviewAuto) !== null;
  const nextLabel = step?.auto ? strings.confirmNext : isLast ? strings.nextLast : strings.next;
  // «Hoy»: en las fechas y en los campos de texto cuyo rotulo o plantilla dicen que es la fecha de hoy.
  const offersToday = step !== null && (step.type === "date" || step.rule === "today" || step.dataKey === TODAY_DATA_KEY);

  const dock = (
        <div
          ref={dockRef}
          role="region"
          aria-label={strings.regionLabel}
          data-fill-dock=""
          data-fill-phase={state.finished ? "done" : "step"}
          style={{ bottom: inset, paddingBottom }}
          className={cn(
            "fixed inset-x-0 z-[45] mx-auto flex w-full max-w-2xl flex-col gap-2 border-t border-white/14 bg-elevated px-3 pt-2 shadow-elevation-3",
            "md:rounded-t-[1.25rem] md:border-x",
          )}
        >
          {/* Progreso: una barra fina pegada al borde de arriba del panel */}
          {!state.finished && step ? (
            <div
              role="progressbar"
              aria-label={strings.progressLabel(index + 1, list.length)}
              aria-valuemin={0}
              aria-valuemax={list.length}
              aria-valuenow={index + 1}
              className="absolute inset-x-0 top-0 h-1 overflow-hidden bg-white/10"
            >
              <div className="h-full bg-signal transition-[width] duration-[var(--duration-base,200ms)] motion-reduce:transition-none" style={{ width: `${progressValue}%` }} />
            </div>
          ) : null}

          {state.finished ? (
            <FinishedView
              summary={summary}
              stepName={stepName}
              headingRef={doneHeadingRef}
              headingId={headingId}
              continueBlocked={continueBlocked}
              hasContinue={onContinue !== undefined}
              onGoTo={goToField}
              onContinue={() => {
                setState({ open: false, finished: false });
                onContinue?.();
              }}
              onReview={() => {
                const first = firstStep(visibleSteps(all, state.reviewAuto, null), state.reviewAuto);
                moveTo(first);
              }}
              onClose={close}
              onOpenList={() => setListOpen(true)}
            />
          ) : step ? (
            <>
              {/* Cabecera: donde estamos, que campo es y las dos salidas (lista y cerrar) */}
              <div className="flex items-start gap-1">
                <div className="min-w-0 flex-1 pt-1">
                  <p className="truncate text-caption text-muted-foreground tabular-nums" data-fill-progress="">
                    <span className="font-semibold text-foreground">{strings.progress(index + 1, list.length)}</span>
                    {" · "}
                    {strings.where(docs.length > 1 ? step.docName : null, step.field.pageIndex + 1)}
                  </p>
                  <h3 id={headingId} className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-headline text-foreground">
                    <span className="min-w-0 truncate" title={stepName(step)}>
                      {stepName(step)}
                    </span>
                    {step.required ? (
                      <span className="shrink-0 rounded-full bg-destructive/12 px-2 py-0.5 text-caption-2 font-semibold text-destructive-text">{strings.requiredBadge}</span>
                    ) : null}
                    {step.auto ? (
                      <span className="shrink-0 rounded-full bg-signal/15 px-2 py-0.5 text-caption-2 font-semibold text-signal-text">{strings.autoBadge}</span>
                    ) : null}
                  </h3>
                </div>
                {hasEmptyElsewhere ? (
                  <button type="button" className={ICON_BUTTON} onClick={gotoEmpty} disabled={!working} aria-label={strings.gotoEmpty} title={strings.gotoEmpty} data-fill-goto-empty="">
                    <ChevronsRight aria-hidden="true" className="size-5" />
                  </button>
                ) : null}
                {canUndo ? (
                  <button type="button" className={ICON_BUTTON} onClick={undo} aria-label={strings.undo} title={strings.undo} data-fill-undo="">
                    <Undo2 aria-hidden="true" className="size-5" />
                  </button>
                ) : null}
                <button ref={listButtonRef} type="button" className={ICON_BUTTON} onClick={() => setListOpen(true)} aria-label={strings.list} title={strings.list} data-fill-list-open="">
                  <ListChecks aria-hidden="true" className="size-5" />
                </button>
                <button type="button" className={ICON_BUTTON} onClick={close} aria-label={`${strings.close}. ${strings.closeHint}`} title={strings.close} data-fill-close="">
                  <X aria-hidden="true" className="size-5" />
                </button>
              </div>

              {/* Entrada grande segun el tipo */}
              {step.type === "checkbox" ? (
                <button
                  ref={switchRef}
                  type="button"
                  role="switch"
                  aria-checked={step.value !== ""}
                  aria-label={strings.switchLabel(stepName(step))}
                  disabled={!working}
                  data-fill-switch=""
                  onClick={() => onValue(step.field.id, step.value !== "" ? "" : "true")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      next();
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      close();
                    }
                  }}
                  className={cn(
                    "flex h-14 w-full items-center justify-between gap-3 rounded-ios-sm border px-4 text-left text-headline",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                    step.value !== "" ? "border-signal/60 bg-signal/15 text-foreground" : "border-white/14 bg-white/5 text-foreground",
                  )}
                >
                  <span>{step.value !== "" ? strings.switchOn : strings.switchOff}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full border-2",
                      step.value !== "" ? "border-signal bg-signal text-[var(--color-on-signal)]" : "border-hairline-strong",
                    )}
                  >
                    {step.value !== "" ? <Check className="size-5" strokeWidth={3} /> : null}
                  </span>
                </button>
              ) : (
                <input
                  ref={inputRef}
                  value={step.value}
                  disabled={!working}
                  type={kind?.type ?? "text"}
                  inputMode={kind?.inputMode === "none" ? undefined : kind?.inputMode}
                  autoComplete={kind?.autoComplete}
                  autoCapitalize={kind?.autoCapitalize}
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint={isLast ? "done" : "next"}
                  aria-label={strings.inputLabel(stepName(step))}
                  aria-describedby={step.auto ? `${headingId}-auto` : undefined}
                  data-fill-input=""
                  onChange={(event) => onValue(step.field.id, event.target.value)}
                  onKeyDown={onInputKeyDown}
                  // 16 px como minimo: con menos, Safari de iPhone acerca la pagina al enfocar.
                  className="h-12 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-60"
                />
              )}
              {step.auto ? (
                <p id={`${headingId}-auto`} className="sr-only">
                  {strings.autoBadge}
                </p>
              ) : null}

              {/* Sugerencias a un toque (memoria, perfil de cliente, datos leidos de un documento) y etiqueta */}
              {tagsOpen && taggable ? (
                <div className="-mx-3 overflow-x-auto px-3" data-fill-tags="">
                  <div className="flex items-center gap-2 pb-1">
                    <button type="button" className={CHIP_BASE} onClick={() => setTagsOpen(false)} onPointerDown={keepInputFocus}>
                      <X aria-hidden="true" className="size-4" />
                      {strings.tagClose}
                    </button>
                    <FieldTagPicker
                      type={taggable}
                      current={tag}
                      suggested={impliedTagOf(step.field)}
                      keepFocus
                      onPick={(next) => {
                        onTag?.(step.field.id, next);
                        setTagsOpen(false);
                      }}
                      onNone={() => {
                        onTag?.(step.field.id, null);
                        setTagsOpen(false);
                      }}
                      onOther={() => setCustomTagFor(step.field.id)}
                    />
                  </div>
                </div>
              ) : (
                <div
                  role="group"
                  aria-label={strings.suggestionsLabel}
                  className="-mx-3 overflow-x-auto px-3 [scrollbar-width:none]"
                  data-fill-chips=""
                >
                  <div className="flex items-center gap-2 pb-1">
                    {offersToday ? (
                      <button type="button" className={cn(CHIP_BASE, step.rule === "today" && "shadow-[inset_0_0_0_1.5px_var(--color-signal-text)]")} onClick={todayChip} disabled={!working} data-fill-today="">
                        {strings.today}
                      </button>
                    ) : null}
                    {chips.map((chip) => (
                      <button
                        key={`${chip.source}|${chip.from ?? ""}|${chip.value}`}
                        type="button"
                        className={CHIP_BASE}
                        disabled={!working}
                        title={sourceText(chip)}
                        aria-label={`${chip.text}. ${sourceText(chip)}`}
                        data-fill-chip={chip.source}
                        onClick={() => pickChip(chip)}
                        onPointerDown={keepInputFocus}
                      >
                        <SourceIcon source={chip.source} />
                        <span className="max-w-[14rem] truncate">
                          <Highlighted chip={chip} />
                        </span>
                      </button>
                    ))}
                    {taggable ? (
                      <button type="button" className={cn(CHIP_BASE, "bg-transparent shadow-[inset_0_0_0_1px_var(--color-hairline-strong)]")} onClick={() => setTagsOpen(true)} onPointerDown={keepInputFocus} title={memoryKey ? strings.noSuggestions : strings.noTagHint} data-fill-tag-button="">
                        <Tag aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        {strings.tagButton(tagName)}
                      </button>
                    ) : null}
                  </div>
                </div>
              )}

              {/* Siguiente / Anterior / Saltar / Deshacer */}
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="md" className="px-3" onClick={prev} disabled={index <= 0 || !working} aria-label={strings.prev} data-fill-prev="">
                  <ChevronLeft aria-hidden="true" className="size-5" />
                  <span className="max-[520px]:sr-only">{strings.prev}</span>
                </Button>
                <Button variant="ghost" size="md" className="px-3" onClick={skip} disabled={!working || step.auto} data-fill-skip="">
                  <SkipForward aria-hidden="true" className="size-4" />
                  {strings.skip}
                </Button>
                <Button size="md" className="ml-auto min-w-0 flex-1 px-4 sm:max-w-56" onClick={next} disabled={!working} data-fill-next="">
                  <span className="truncate">{nextLabel}</span>
                  <ArrowRight aria-hidden="true" className="size-4 shrink-0" />
                </Button>
              </div>
            </>
          ) : null}
        </div>
  );

  return (
    <>
      <StatusRegion as="p" text={announcement} className="sr-only" data-fill-live="">
        {announcement}
      </StatusRegion>
      {hidden || typeof document === "undefined" ? null : createPortal(dock, document.body)}

      <FillListSheet
        open={listOpen}
        onClose={() => {
          setListOpen(false);
          defer(() => listButtonRef.current?.focus({ preventScroll: true }));
        }}
        steps={all}
        cursorKey={cursorKey}
        reviewAuto={state.reviewAuto}
        onReviewAutoChange={(reviewAuto) => setState({ reviewAuto })}
        onPick={goToField}
        onGotoEmpty={() => {
          setListOpen(false);
          gotoEmpty();
        }}
        stepName={stepName}
        multiDocs={docs.length > 1}
      />
      <CustomTagSheet
        open={customTagFor !== null}
        onClose={() => setCustomTagFor(null)}
        onCreated={(created) => {
          if (customTagFor) onTag?.(customTagFor, created);
          setTagsOpen(false);
        }}
        closeLabel={tagStrings.chipClose}
      />
      {/* Hueco al final de la pagina para poder llegar hasta el ultimo campo por encima del panel */}
      {open && !hidden ? <div aria-hidden="true" data-fill-spacer="" style={{ height: dockHeight + inset }} /> : null}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Pantalla final: «Todo rellenado · Continuar a firmar»
 * ------------------------------------------------------------------ */

function FinishedView({
  summary,
  stepName,
  headingRef,
  headingId,
  continueBlocked,
  hasContinue,
  onGoTo,
  onContinue,
  onReview,
  onClose,
  onOpenList,
}: {
  summary: ReturnType<typeof summarize>;
  stepName: (step: FillStep) => string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  headingId: string;
  continueBlocked: boolean;
  hasContinue: boolean;
  onGoTo: (step: FillStep) => void;
  onContinue: () => void;
  onReview: () => void;
  onClose: () => void;
  onOpenList: () => void;
}) {
  const strings = useFillStrings();
  const requiredCount = summary.requiredMissing.length;
  // Al llegar, el foco va al titulo: el lector de pantalla lee el resultado y la persona no pierde el sitio.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [headingRef]);
  // Con obligatorios sin rellenar, cada uno es un enlace al campo; sin ellos, los opcionales vacios se cuentan con calma.
  const links = summary.requiredMissing.slice(0, 4);
  const hiddenLinks = requiredCount - links.length;
  return (
    <div className="flex flex-col gap-2 pt-1" data-fill-done="">
      <div className="flex items-start gap-3">
        <CheckCircle2 aria-hidden="true" className={cn("mt-0.5 size-6 shrink-0", requiredCount === 0 ? "text-success-text" : "text-destructive-text")} />
        <div className="min-w-0 flex-1">
          <h3
            ref={headingRef}
            id={headingId}
            tabIndex={-1}
            className="rounded-ios-sm text-headline text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-signal"
          >
            {requiredCount === 0 ? strings.doneTitle : strings.doneTitleRequired(requiredCount)}
          </h3>
          <p className="mt-0.5 text-footnote text-muted-foreground">{requiredCount === 0 ? strings.doneBody : strings.doneBodyRequired}</p>
          {summary.optionalMissing.length > 0 ? <p className="mt-1 text-footnote text-muted-foreground">{strings.doneOptionalMissing(summary.optionalMissing.length)}</p> : null}
        </div>
        <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label={strings.doneExit} title={strings.doneExit} data-fill-close="">
          <X aria-hidden="true" className="size-5" />
        </button>
      </div>
      {links.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={strings.doneTitleRequired(requiredCount)}>
          {links.map((step) => (
            <li key={step.key}>
              <button type="button" className={CHIP_BASE} onClick={() => onGoTo(step)} aria-label={strings.doneGoTo(stepName(step))} data-fill-missing={step.required ? "required" : "optional"}>
                <span className="max-w-[12rem] truncate">{stepName(step)}</span>
                <span className="text-caption-2 font-semibold text-destructive-text">*</span>
              </button>
            </li>
          ))}
          {hiddenLinks > 0 ? (
            <li>
              <button type="button" className={CHIP_BASE} onClick={onOpenList}>
                {strings.doneMore(hiddenLinks)}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
      {continueBlocked ? <p className="text-footnote text-muted-foreground">{strings.doneContinueBlocked}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {hasContinue ? (
          <Button size="md" onClick={onContinue} disabled={continueBlocked} data-fill-continue="">
            {strings.doneContinue}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        <Button variant="secondary" size="md" onClick={onReview} data-fill-review="">
          {strings.doneReview}
        </Button>
        {!hasContinue ? (
          <Button variant="ghost" size="md" onClick={onClose}>
            {strings.doneExit}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

