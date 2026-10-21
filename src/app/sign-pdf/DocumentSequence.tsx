"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, CircleDashed, FileText } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { CanvasHandle, CanvasSequence } from "@/app/sign-pdf/DocumentCanvas";
import { docStateOf, liveFields, type DocId, type DocState } from "@/app/sign-pdf/docSet";
import { pageInfoOf } from "@/app/sign-pdf/pageAspect";
import {
  findPendingInOtherDocs,
  hasPendingInOtherDocs,
  planSoloPlacements,
  sequencePosition,
  soloPlacedCount,
  soloPlacement,
  stepPage,
  type PageTarget,
  type SoloPlacementInput,
} from "@/app/sign-pdf/sequenceMath";
import type { SignSession } from "@/app/sign-pdf/signSession";
import { useBackgroundDetection } from "@/app/sign-pdf/useBackgroundDetection";
import { isSuggestionOnly, type DetectedField } from "@/lib/pdf/detectFields";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { thumbKey, useSequenceMeta } from "@/app/sign-pdf/useSequenceMeta";
import { UNPLACED_RECT } from "@/app/sign-pdf/soloSignature";
import type { NormalizedRect } from "@/lib/pdf/watermark";

/*
 * Vista continua (W4-U4): varios PDF individuales que se ven como UN solo PDF.
 *
 * Hay UN solo `DocumentCanvas` (el del documento activo, con SU estado) y este
 * envoltorio, que vive FUERA del `key` con el que se remontan los flujos y el
 * lienzo al cambiar de documento. Aqui estan:
 *  - el paginador global («Pagina 7 de 12» y la etiqueta «Contrato B · p. 2/3»),
 *    en una barra pegajosa que tambien aloja el zoom del lienzo (por portal): al
 *    cruzar de documento sus botones siguen siendo los mismos nodos y el foco no
 *    cae a `<body>`;
 *  - la tira de miniaturas de todos los documentos, con un grupo por documento
 *    (se pinta por portal en un hueco del lienzo, para quedar donde estaba; si
 *    el foco estaba en una miniatura al cruzar, se devuelve a la de destino);
 *  - la region viva «Documento 2 de 3: Contrato B, pagina 2 de 3»;
 *  - en «Solo yo», el resumen de documentos con la firma colocada y «Aplicar a
 *    todos los documentos».
 *
 * Con un solo documento (`enabled` falso) no pinta nada y el lienzo recibe
 * `sequence` indefinido: la interfaz de siempre.
 */

export type SequenceDoc = { id: DocId; name: string; file: File };

/** Donde ir: documento, pagina (0-based) y, opcionalmente, un campo de texto que seleccionar y editar. */
export type SequenceTarget = {
  docId: DocId;
  pageIndex: number;
  textFieldId?: string;
};

export type SoloPlacementPlan = Record<
  DocId,
  { rect: NormalizedRect; pageIndex: number }
>;

export type DocumentSequenceProps = {
  /** Hay mas de un documento y el flag lo permite. */
  enabled: boolean;
  docs: readonly SequenceDoc[];
  activeId: DocId;
  /** Sesion ya puesta al dia con los archivos. */
  session: SignSession;
  go: (target: SequenceTarget) => void;
  /** Escribe la colocacion de la firma de «Solo yo» por documento. */
  placeSolo: (plan: SoloPlacementPlan) => void;
  /** Guarda los campos detectados en segundo plano en un documento aun sin abrir. */
  onDetected: (docId: DocId, file: File, fields: DetectedField[]) => void;
  strings: SignStrings;
  children: ReactNode;
};

const SequenceContext = createContext<CanvasSequence | null>(null);

/** Lo que el lienzo recibe como `sequence`: `undefined` fuera de una vista continua. */
export function useCanvasSequence(): CanvasSequence | undefined {
  return useContext(SequenceContext) ?? undefined;
}

const NO_DOCS: readonly SequenceDoc[] = [];
const UNDO_MS = 6000;

/** Elementos del documento por pagina (huecos + campos), para el contador de la miniatura. */
function elementCounts(
  doc: DocState,
  signers: SignSession["signers"],
  solo: boolean,
): Map<number, number> {
  const counts = new Map<number, number>();
  const add = (page: number) => counts.set(page, (counts.get(page) ?? 0) + 1);
  if (solo) {
    if (doc.rect.width > 0) add(doc.pageIndex);
  } else {
    for (const field of liveFields(doc, signers)) add(field.pageIndex);
  }
  for (const field of doc.textFields) {
    // Una sugerencia sin tocar no es un elemento del documento (el lienzo la oculta o la ofrece aparte).
    if (!isSuggestionOnly(field, doc.textValues[field.id])) add(field.pageIndex);
  }
  return counts;
}

export function DocumentSequence({
  enabled,
  docs: allDocs,
  activeId,
  session,
  go,
  placeSolo,
  onDetected,
  strings,
  children,
}: DocumentSequenceProps) {
  const docs = enabled ? allDocs : NO_DOCS;
  const order = useMemo(() => docs.map((doc) => doc.id), [docs]);
  // Miniaturas perezosas: solo las que la tira tiene a la vista (sin IntersectionObserver, el activo y sus vecinos).
  const lazyThumbs = typeof IntersectionObserver !== "undefined";
  const meta = useSequenceMeta(docs, activeId, lazyThumbs);
  const setVisibleThumbs = meta.setVisible;
  const { counts } = meta;
  const reportCount = meta.reportCount;

  const activeDoc = docs.find((doc) => doc.id === activeId) ?? docs[0];
  const activeState = docStateOf(session.docs, activeId);
  const solo = session.mode === "single";

  /* --- Lienzo montado: alta/baja, huecos del lienzo y su accion de pagina --- */
  const handleRef = useRef<CanvasHandle | null>(null);
  const [mounted, setMounted] = useState(0);
  const [zoomSlot, setZoomSlot] = useState<HTMLElement | null>(null);
  const [thumbsSlot, setThumbsSlot] = useState<HTMLElement | null>(null);
  const register = useCallback((handle: CanvasHandle) => {
    handleRef.current = handle;
    setMounted((count) => count + 1);
    return () => {
      if (handleRef.current === handle) handleRef.current = null;
      setMounted((count) => count - 1);
    };
  }, []);
  const canvasPresent = mounted > 0;

  // Los campos de los documentos aun sin abrir se detectan en segundo plano (solo con el lienzo a la vista).
  useBackgroundDetection({
    enabled: enabled && canvasPresent,
    docs,
    activeId,
    docStates: session.docs,
    onDetected,
  });

  /* --- Posicion --- */
  const knownCount = counts[activeId];
  const pageIndex =
    knownCount === undefined
      ? activeState.fieldPageIndex
      : Math.min(activeState.fieldPageIndex, Math.max(0, knownCount - 1));
  const position = sequencePosition(order, counts, activeId, pageIndex);
  const activeName = activeDoc?.name ?? "";

  const prevTarget = stepPage(order, counts, { docId: activeId, pageIndex }, -1);
  const nextTarget = stepPage(order, counts, { docId: activeId, pageIndex }, 1);

  const navigateTo = (target: PageTarget) => {
    if (target.docId === activeId && handleRef.current) {
      handleRef.current.goToPage(target.pageIndex);
      return;
    }
    go({ docId: target.docId, pageIndex: target.pageIndex });
  };

  /* --- Siguiente/anterior campo pendiente: salta al documento vecino que lo tenga --- */
  const othersPending = hasPendingInOtherDocs(order, session.docs, activeId);
  const sessionRef = useRef(session);
  const goRef = useRef(go);
  useEffect(() => {
    sessionRef.current = session;
    goRef.current = go;
  });
  const onNoPendingHere = useCallback(
    (direction: 1 | -1): boolean => {
      const target = findPendingInOtherDocs(order, sessionRef.current.docs, activeId, direction);
      if (!target) return false;
      goRef.current({
        docId: target.docId,
        pageIndex: target.pageIndex,
        textFieldId: target.fieldId,
      });
      return true;
    },
    [order, activeId],
  );

  const activeFile = activeDoc?.file;
  const canvasSequence: CanvasSequence = {
    hidePager: true,
    hideThumbs: true,
    zoomSlot,
    setThumbsSlot,
    register,
    onPageCount: (count) => {
      if (activeFile) reportCount(activeId, activeFile, count);
    },
    onNoPendingHere,
    othersPending,
  };

  /* --- Anuncios: UNA sola region viva para documento y pagina --- */
  const key = `${activeId}:${pageIndex}`;
  const [announced, setAnnounced] = useState({ key, docId: activeId, text: "" });
  if (enabled && announced.key !== key) {
    const docChanged = announced.docId !== activeId;
    setAnnounced({
      key,
      docId: activeId,
      text: docChanged
        ? strings.sequenceLive(
            position.docNumber,
            position.docCount,
            activeName,
            position.local,
            position.localTotal,
          )
        : position.global !== null && position.total !== null
          ? strings.pageOf(position.global, position.total)
          : strings.pageOf(position.local, position.localTotal ?? position.local),
    });
  }

  /*
   * Un boton que se desactiva con el foco puesto lo pierde (Chrome lo desenfoca
   * en el acto y cae a <body>): al llegar a la ultima pagina «siguiente» se
   * desactiva, y a la primera, «anterior». Por eso, ANTES de moverse, si el
   * destino es el extremo, el foco pasa ya al otro sentido (que sigue activo).
   */
  const previousRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const pageStep = (dir: 1 | -1) => {
    const target = dir === 1 ? nextTarget : prevTarget;
    if (!target) return;
    const beyond = stepPage(order, counts, target, dir);
    const own = dir === 1 ? nextRef.current : previousRef.current;
    if (!beyond && document.activeElement === own) {
      (dir === 1 ? previousRef.current : nextRef.current)?.focus();
    }
    navigateTo(target);
  };

  /* --- Foco de la tira de miniaturas tras cruzar de documento --- */
  /** Forma de la tira (documentos y paginas): cambia solo si cambia de verdad, no con cada miniatura. */
  const stripShape = docs.map((doc) => `${doc.id}=${counts[doc.id] ?? "?"}`).join("|");
  const pendingFocusRef = useRef<string | null>(null);
  const [roving, setRoving] = useState<string | null>(null);
  const activeKey = thumbKey(activeId, pageIndex);
  useLayoutEffect(() => {
    // Un hueco desmontado (el del lienzo anterior) no vale: su tira se repinta en el nuevo.
    if (!thumbsSlot || !thumbsSlot.isConnected) return;
    const wanted = pendingFocusRef.current;
    if (wanted) {
      const target = thumbsSlot.querySelector<HTMLElement>(`[data-thumb="${wanted}"]`);
      if (target) {
        pendingFocusRef.current = null;
        target.focus({ preventScroll: true });
      }
    }
    // La miniatura activa a la vista (solo en horizontal: no mueve la pagina).
    const current = thumbsSlot.querySelector<HTMLElement>('[aria-current="true"]');
    const scroller = thumbsSlot.querySelector<HTMLElement>("[data-thumb-scroller]");
    if (current && scroller) {
      scroller.scrollLeft =
        current.offsetLeft - scroller.clientWidth / 2 + current.offsetWidth / 2;
    }
  }, [thumbsSlot, activeKey, stripShape]);

  /*
   * Que miniaturas se ven en la tira: un IntersectionObserver sobre la propia
   * tira (con un margen a los lados para ir un poco por delante) alimenta la
   * cola de `useSequenceMeta`. Lo que sale de la vista deja de pedirse.
   */
  useEffect(() => {
    if (!lazyThumbs || !thumbsSlot || !thumbsSlot.isConnected) return;
    const scroller = thumbsSlot.querySelector<HTMLElement>("[data-thumb-scroller]");
    if (!scroller) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const key = (entry.target as HTMLElement).dataset.thumb;
          if (!key) continue;
          if (entry.isIntersecting) visible.add(key);
          else visible.delete(key);
        }
        setVisibleThumbs(new Set(visible));
      },
      { root: scroller, rootMargin: "0px 240px" },
    );
    for (const button of scroller.querySelectorAll("[data-thumb]")) observer.observe(button);
    return () => {
      observer.disconnect();
      setVisibleThumbs(null);
    };
  }, [lazyThumbs, thumbsSlot, stripShape, setVisibleThumbs]);

  // Unica miniatura que entra en el orden de Tab (roving): la ultima enfocada si sigue existiendo; si no, la activa.
  const rovingValid = (() => {
    if (!roving) return false;
    const at = roving.lastIndexOf(":");
    const total = counts[roving.slice(0, at)];
    return total !== undefined && Number(roving.slice(at + 1)) < total;
  })();
  const tabStop = rovingValid && roving ? roving : activeKey;

  const activateThumb = (docId: DocId, page: number) => {
    if (docId !== activeId) pendingFocusRef.current = thumbKey(docId, page);
    setRoving(thumbKey(docId, page));
    navigateTo({ docId, pageIndex: page });
  };

  const onThumbKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const keyName = event.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(keyName)) return;
    const buttons = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-thumb]"),
    );
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const nextIndex =
      keyName === "Home"
        ? 0
        : keyName === "End"
          ? buttons.length - 1
          : Math.min(buttons.length - 1, Math.max(0, index + (keyName === "ArrowRight" ? 1 : -1)));
    buttons[nextIndex]?.focus();
  };

  /* --- «Solo yo»: firma por documento --- */
  const soloVisible = enabled && solo && session.signaturePng !== "";
  const placedCount = soloPlacedCount(order, session.docs);

  return (
    <SequenceContext.Provider value={enabled ? canvasSequence : null}>
      {enabled ? (
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-sequence-live="">
          {announced.text}
        </div>
      ) : null}

      {soloVisible ? (
        <SoloApplyAll
          docs={docs}
          activeId={activeId}
          session={session}
          placed={placedCount}
          placeSolo={placeSolo}
          strings={strings}
        />
      ) : null}

      {enabled && canvasPresent ? (
        <div
          data-canvas-sticky=""
          data-sequence-bar=""
          className="material-thick shadow-elevation-2 rounded-ios sticky top-[calc(3.5rem+env(safe-area-inset-top,0px)+0.5rem)] z-30 flex items-center justify-between gap-x-1 p-1 md:top-[calc(4rem+env(safe-area-inset-top,0px)+0.5rem)] lg:top-3 pointer-coarse:gap-x-2"
        >
          <div ref={setZoomSlot} className="flex shrink-0 items-center pointer-coarse:[&_[role=group]]:gap-2" />
          {/* Una sola fila a 375 px: lo que sobra se lo lleva el nombre del documento (se recorta). */}
          <div
            role="group"
            aria-label={strings.sequenceBarLabel}
            className="flex min-w-0 items-center gap-1 pointer-coarse:gap-2"
          >
            <Button
              ref={previousRef}
              variant="ghost"
              size="sm"
              className="shrink-0 pointer-coarse:h-11 pointer-coarse:before:hidden"
              aria-label={strings.previousPage}
              data-sequence-action="previous"
              disabled={!prevTarget}
              onClick={() => pageStep(-1)}
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>
            <span className="flex min-w-0 flex-col items-center text-center leading-tight tabular-nums">
              <span className="text-footnote font-medium text-foreground">
                {position.global !== null && position.total !== null ? (
                  <>
                    <span aria-hidden="true" className="hidden max-[420px]:inline">
                      {position.global} / {position.total}
                    </span>
                    <span className="max-[420px]:sr-only">
                      {strings.pageOf(position.global, position.total)}
                    </span>
                  </>
                ) : (
                  <>
                    <span aria-hidden="true" className="hidden max-[420px]:inline">
                      {position.local}
                      {position.localTotal !== null ? ` / ${position.localTotal}` : ""}
                    </span>
                    <span className="max-[420px]:sr-only">
                      {strings.pageOf(position.local, position.localTotal ?? position.local)}
                    </span>
                  </>
                )}
              </span>
              <span
                data-sequence-doc-label=""
                className="flex max-w-[9.5rem] min-w-0 items-baseline md:max-w-[16rem] justify-center self-stretch text-caption-2 text-muted-foreground"
              >
                <DocLabel
                  name={activeName}
                  local={position.local}
                  total={position.localTotal}
                  strings={strings}
                />
              </span>
            </span>
            <Button
              ref={nextRef}
              variant="ghost"
              size="sm"
              className="shrink-0 pointer-coarse:h-11 pointer-coarse:before:hidden"
              aria-label={strings.nextPage}
              data-sequence-action="next"
              disabled={!nextTarget}
              onClick={() => pageStep(1)}
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {children}

      {enabled && canvasPresent && thumbsSlot
        ? createPortal(
            <div className="mt-5" onKeyDown={onThumbKeyDown}>
              <h4 className="ui-label mb-1 text-muted-foreground">
                {strings.sequenceThumbsTitle}
              </h4>
              <p className="mb-2 hidden text-caption text-muted-foreground md:block">
                {strings.sequenceThumbsHint}
              </p>
              <div
                data-thumb-scroller=""
                className="flex items-start gap-3 overflow-x-auto pb-2"
              >
                {docs.map((doc, docIndex) => {
                  const count = counts[doc.id];
                  const state = docStateOf(session.docs, doc.id);
                  const badge =
                    soloVisible
                      ? soloPlacement(state) === "placed"
                        ? { done: true, label: strings.docBadgePlaced }
                        : { done: false, label: strings.docBadgePending }
                      : null;
                  const pages = count ?? 0;
                  const perPage = elementCounts(state, session.signers, solo);
                  return (
                    <div
                      key={doc.id}
                      role="group"
                      aria-label={strings.sequenceDocGroup(docIndex + 1, doc.name, count ?? null)}
                      data-sequence-group={doc.id}
                      className={cn(
                        "shrink-0",
                        docIndex > 0 && "border-l border-white/15 pl-3",
                      )}
                    >
                      <p
                        className={cn(
                          "mb-1.5 flex max-w-[16rem] items-center gap-1.5 text-caption-2",
                          doc.id === activeId
                            ? "font-semibold text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        <span className="min-w-0 truncate">
                          {strings.documentTab(docIndex + 1, doc.name)}
                        </span>
                        {badge ? (
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-0.5",
                              badge.done ? "text-success-text" : "text-muted-foreground",
                            )}
                          >
                            {badge.done ? (
                              <Check aria-hidden="true" className="size-3" />
                            ) : (
                              <CircleDashed aria-hidden="true" className="size-3" />
                            )}
                            {badge.label}
                          </span>
                        ) : null}
                      </p>
                      <ul className="flex gap-2">
                        {Array.from({ length: pages }, (_, page) => {
                          const k = thumbKey(doc.id, page);
                          const current = doc.id === activeId && page === pageIndex;
                          const url = meta.thumbs[k];
                          const elements = perPage.get(page) ?? 0;
                          return (
                            <li key={page} className="shrink-0">
                              <button
                                type="button"
                                data-thumb={k}
                                aria-label={strings.sequenceGoToPage(page + 1, doc.name)}
                                aria-current={current ? "true" : undefined}
                                tabIndex={tabStop === k ? 0 : -1}
                                onFocus={() => setRoving(k)}
                                onClick={() => activateThumb(doc.id, page)}
                                className={cn(
                                  "relative flex min-h-11 items-center justify-center overflow-hidden rounded-ios-sm border p-0.5 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
                                  current
                                    ? "border-signal"
                                    : "border-white/10 hover:border-white/25",
                                )}
                              >
                                {url ? (
                                  /* eslint-disable-next-line @next/next/no-img-element */
                                  <img
                                    src={url}
                                    alt=""
                                    draggable={false}
                                    className="block w-16 rounded-ios-sm"
                                  />
                                ) : (
                                  /* Marcador mientras llega la miniatura (o si se solto de memoria): hoja neutra con su icono, no un hueco roto. */
                                  <span
                                    aria-hidden="true"
                                    data-thumb-placeholder=""
                                    className="flex aspect-[3/4] w-16 items-center justify-center rounded-ios-sm bg-white/5 text-muted-foreground"
                                  >
                                    <FileText className="size-5" />
                                  </span>
                                )}
                                <span className="absolute right-1 bottom-1 rounded-full bg-background/85 px-1.5 py-0.5 text-caption-2 leading-tight font-semibold text-foreground tabular-nums">
                                  {elements > 0 ? `${page + 1} · ${elements}` : page + 1}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </div>
            </div>,
            thumbsSlot,
          )
        : null}
    </SequenceContext.Provider>
  );
}

/** «Contrato B · p. 2/3»: el nombre se recorta, la pagina no. */
function DocLabel({
  name,
  local,
  total,
  strings,
}: {
  name: string;
  local: number;
  total: number | null;
  strings: SignStrings;
}) {
  const full = strings.sequenceDocPage(name, local, total);
  const suffix = full.slice(name.length);
  // (M5 · N9) El nombre se recorta por el FINAL con puntos suspensivos («contrato…»), con el texto completo en `title`: el
  // recorte por el medio («c.A.pdf») dejaba 8 px al nombre en un iPhone con dos documentos y no se leia nada.
  return (
    <>
      <span className="flex min-w-0" title={full}>
        {/* `whitespace-nowrap` (con `truncate` seria lo mismo): el espacio final del nombre no debe colapsarse. */}
        <span
          data-doc-label-name=""
          className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap"
        >
          {name}
        </span>
      </span>
      <span className="shrink-0 whitespace-pre">{suffix}</span>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * «Solo yo»: la firma creada una vez se coloca en cada documento
 * ------------------------------------------------------------------ */

type ApplyUndo = { previous: SoloPlacementPlan; count: number };

function SoloApplyAll({
  docs,
  activeId,
  session,
  placed,
  placeSolo,
  strings,
}: {
  docs: readonly SequenceDoc[];
  activeId: DocId;
  session: SignSession;
  placed: number;
  placeSolo: (plan: SoloPlacementPlan) => void;
  strings: SignStrings;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [undo, setUndo] = useState<ApplyUndo | null>(null);
  const applyRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const aliveRef = useRef(true);
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  });
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // El aviso con «Deshacer» dura 6 s; si el foco estaba en el, vuelve al boton de aplicar (nunca a <body>).
  useEffect(() => {
    if (!undo) return;
    const timer = window.setTimeout(() => {
      if (document.activeElement === undoRef.current) applyRef.current?.focus();
      setUndo(null);
    }, UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    setUndo(null);
    setMessage(strings.soloApplyAllBusy);
    const snapshot = sessionRef.current;
    const active = docStateOf(snapshot.docs, activeId);
    const reference =
      active.rect.width > 0 ? { rect: active.rect, pageIndex: active.pageIndex } : null;

    // Un documento cada vez: nunca hay mas de un PDF abierto en pdf.js.
    const inputs: SoloPlacementInput[] = [];
    let unread = false;
    for (const doc of docs) {
      if (reference && doc.id === activeId) continue;
      const visiblePage = docStateOf(snapshot.docs, doc.id).fieldPageIndex;
      const info = await pageInfoOf(doc.file, reference ? reference.pageIndex : visiblePage);
      if (!aliveRef.current) return;
      if (!info) unread = true;
      inputs.push({
        docId: doc.id,
        visiblePage,
        info: info ? { count: info.count, aspect: info.aspect } : null,
      });
    }
    const plan = planSoloPlacements(snapshot.ratio, reference, inputs);

    // Para deshacer: lo que habia en cada documento que se toca (ahora mismo, no al empezar).
    const latest = sessionRef.current;
    const previous: SoloPlacementPlan = {};
    for (const id of Object.keys(plan)) {
      const before = docStateOf(latest.docs, id);
      previous[id] = {
        rect: before.rect.width > 0 ? before.rect : UNPLACED_RECT,
        pageIndex: before.pageIndex,
      };
    }
    placeSolo(plan);
    const count = Object.keys(plan).length + (reference ? 1 : 0);
    setBusy(false);
    setUndo({ previous, count });
    setMessage(
      unread
        ? `${strings.soloApplyAllDone(count)} ${strings.soloApplyAllFailed}`
        : strings.soloApplyAllDone(count),
    );
  };

  const undoApply = () => {
    if (!undo) return;
    placeSolo(undo.previous);
    setUndo(null);
    setMessage(strings.soloApplyAllUndone);
    applyRef.current?.focus();
  };

  return (
    <section
      aria-label={strings.soloAllTitle}
      data-sequence-solo=""
      className="surface-card rounded-ios flex flex-col gap-2 p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="ui-label text-muted-foreground">{strings.soloAllTitle}</h4>
          <p className="text-footnote text-foreground">
            {strings.soloAllSummary(placed, docs.length)}
          </p>
        </div>
        <Button
          ref={applyRef}
          variant="secondary"
          size="sm"
          wrap
          className="pointer-coarse:h-11 pointer-coarse:min-h-11 pointer-coarse:before:hidden aria-disabled:opacity-50"
          aria-busy={busy}
          // `aria-disabled` y no `disabled`: un boton que se desactiva con el foco lo pierde (cae a <body>).
          aria-disabled={busy}
          onClick={() => void apply()}
        >
          {strings.soloApplyAll}
        </Button>
      </div>
      <p className="text-caption text-muted-foreground">{strings.soloApplyAllHint}</p>
      {/* Region de estado SIEMPRE montada: solo cambia su contenido. */}
      <div role="status" aria-live="polite" className="flex flex-wrap items-center gap-2 empty:-mt-2">
        {message ? (
          <span className="text-footnote text-muted-foreground">{message}</span>
        ) : null}
        {undo ? (
          <Button
            ref={undoRef}
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11 pointer-coarse:before:hidden"
            onClick={undoApply}
          >
            {strings.soloApplyAllUndo}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
