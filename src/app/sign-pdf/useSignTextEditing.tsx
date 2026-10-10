"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import {
  COVER_PADDING_PT,
  MIN_BOX_PT,
  draftEditForBlock,
  geometryFromPdfJsPage,
  makeMetrics,
  nextFocusKey,
  nudgeDelta,
  pageLayoutOf,
  pxRectToUserBox,
  textFrame,
  userBoxToPx,
  userDeltaFromView,
  type NudgeDirection,
  type PageMetrics,
} from "@/app/edit-pdf/editCanvasMath";
import { EditFloatingBar, glyphNotice, type BarTextState } from "@/app/edit-pdf/EditFloatingBar";
import { InlineTextEditor, type InlineExitReason } from "@/app/edit-pdf/InlineTextEditor";
import { TextBlockLayer, type LayerHandlers } from "@/app/edit-pdf/TextBlockLayer";
import {
  createEditSession,
  newEditId,
  textItem,
  type EditSession,
  type EditTextItem,
  type RestylePatch,
} from "@/app/edit-pdf/editSession";
import type { EditInlineStrings } from "@/app/edit-pdf/strings";
import { usePageText } from "@/app/edit-pdf/useEditDocument";
import { useEditSession } from "@/app/edit-pdf/useEditSession";
import { sampleBackgroundFromImage } from "@/app/sign-pdf/textEditSampling";
import { effectiveTextEdits } from "@/app/sign-pdf/textEdits";
import { blockCoverExtent, blockCoverQuad, coverShape } from "@/lib/pdf/editCover";
import type { TextBlock, TextEdit, UserBox } from "@/lib/pdf/editTypes";
import { blocksInReadingOrder } from "@/lib/pdf/textBlocks";

/*
 * Herramienta «Editar texto» dentro de Firmar (W6-A).
 *
 * Decision de integracion: NO se toca el cuerpo de `DocumentCanvas` (3300 lineas,
 * 244 pruebas). La herramienta es un MODO del lienzo: este hook monta la capa de
 * bloques de Editar PDF (`TextBlockLayer`, `InlineTextEditor`, `EditFloatingBar`)
 * SOBRE la misma imagen nitida que ya pinta el lienzo (`usePageImage`), sin un
 * segundo render. Devuelve dos nodos: `layer` (dentro de la hoja) y `bar` (en el
 * escenario, donde van las barras flotantes).
 *
 * El estado vive FUERA del lienzo (en las opciones / el estado del documento) como
 * una lista de `TextEdit`; aqui se mantiene la sesion de edicion con su historial
 * (deshacer / rehacer) y cada cambio se entrega con `onEditsChange`. Mismo modelo
 * de foco que `EditWorkspace`: un bloque SIN tocar no crea nada; la edicion nace con
 * el primer cambio real, en UNA operacion `add` ya con ese cambio.
 *
 * Fuera de la herramienta, las ediciones siguen pintandose (el PDF se ve como
 * quedara) pero la capa es inerte (`inert`): no se enfoca ni recibe punteros.
 */

const EMPTY_BLOCKS: readonly TextBlock[] = [];
const NO_EDITS: readonly TextEdit[] = [];

type Focus = { key: string; mode: "selected" | "editing"; seed?: string };
type CoverInfo = {
  key: string;
  color: string;
  uniform: boolean;
  clip?: UserBox[];
  /** `false`: aun no habia imagen que leer; es un valor provisional que se vuelve a muestrear. */
  sampled: boolean;
};

export type SignTextEditConfig = {
  /** Ediciones del documento (todas las paginas). */
  edits: readonly TextEdit[];
  onEditsChange: (edits: TextEdit[]) => void;
  strings: EditInlineStrings;
};

export type SignTextEditingParams = {
  config: SignTextEditConfig | undefined;
  /** La herramienta «Editar texto» esta activa. */
  active: boolean;
  doc: PDFDocumentProxy | null;
  page: PDFPageProxy | null;
  pageIndex: number;
  /** Ancho (px CSS) de la hoja SIN zoom. */
  layoutWidth: number;
  /** Cambia cuando la imagen mostrada se vuelve a dibujar (zoom, ancho): el fondo se vuelve a leer. */
  renderKey: string | null;
  imageRef: RefObject<HTMLImageElement | null>;
  hostRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  clipRef: RefObject<HTMLDivElement | null>;
  coarse: boolean;
  /** Region viva UNICA del lienzo. */
  announce: (text: string) => void;
};

export type SignTextEditing = {
  enabled: boolean;
  /** Dentro de la hoja (encima de la imagen); `null` si la herramienta no existe. */
  layer: ReactNode;
  /** En el escenario (barras flotantes); `null` si la herramienta no existe. */
  bar: ReactNode;
  /** Ediciones del documento que se aplicaran al firmar (todas las paginas). */
  count: number;
  /** Ediciones en la pagina visible. */
  pageCount: number;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** Estado del analisis de la pagina visible: «analizando», «escaneada»... */
  status: "idle" | "analyzing" | "ready" | "failed" | "scanned";
  /** Bloques de la pagina que no se pueden editar. */
  nonEditable: number;
  /** Suelta el foco/seleccion de texto (al cambiar de herramienta o de pagina). */
  release: () => void;
};

/** Sesion de edicion con los textos dados como items (sin historial). */
function sessionOfEdits(edits: readonly TextEdit[] | undefined): EditSession {
  return { ...createEditSession(), items: (edits ?? NO_EDITS).map((edit) => textItem(edit)) };
}

function sameEdits(a: readonly TextEdit[], b: readonly TextEdit[]): boolean {
  return a.length === b.length && a.every((edit, index) => edit === b[index]);
}

export function useSignTextEditing(params: SignTextEditingParams): SignTextEditing {
  const {
    config,
    active,
    doc,
    page,
    pageIndex,
    layoutWidth,
    renderKey,
    imageRef,
    hostRef,
    stageRef,
    clipRef,
    coarse,
    announce,
  } = params;
  const enabled = config !== undefined;
  const live = enabled && active;

  /* ---------------------------------------------------------------- *
   * Sesion de edicion <-> estado del documento
   * ---------------------------------------------------------------- */

  const edit = useEditSession({
    initial: () => sessionOfEdits(config?.edits),
    shortcuts: { enabled: live },
  });
  const textEdits = useMemo(
    () =>
      edit.items
        .filter((item): item is EditTextItem => item.kind === "text")
        .map((item) => item.edit),
    [edit.items],
  );
  const emitted = useRef<readonly TextEdit[]>(config?.edits ?? NO_EDITS);
  /**
   * Todas las listas que esta sesion ya entrego al documento. El documento las devuelve
   * (como `config.edits`) con retraso: si se teclea rapido, cuando llega el eco de la
   * lista N la sesion ya va por la N+1. Un eco de algo que YA entregamos nunca es un
   * cambio externo; tratarlo como tal recargaba la sesion con el texto viejo y se
   * perdia la letra tecleada entre medias (la 2.a tecla tras abrir el editor).
   */
  const delivered = useRef<WeakSet<readonly TextEdit[]>>(new WeakSet());
  const onEditsChangeRef = useRef(config?.onEditsChange);
  useEffect(() => {
    onEditsChangeRef.current = config?.onEditsChange;
  });
  /* Lo que cambia la sesion se entrega al documento... */
  useEffect(() => {
    if (!enabled || sameEdits(textEdits, emitted.current)) return;
    emitted.current = textEdits;
    delivered.current.add(textEdits);
    onEditsChangeRef.current?.(textEdits);
  }, [enabled, textEdits]);
  /* ...y un cambio que viene de fuera (borrador, quitar el documento) recarga la sesion. */
  const external = config?.edits;
  const loadSession = edit.load;
  useEffect(() => {
    if (!external || external === emitted.current) return;
    // Eco tardio de una lista que ya entregamos: la sesion va por delante, no se toca.
    if (delivered.current.has(external)) return;
    emitted.current = external;
    if (sameEdits(external, textEdits)) return;
    loadSession(sessionOfEdits(external));
    // Solo cuando llega una lista nueva de fuera; `textEdits` se compara dentro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external, loadSession]);

  /* ---------------------------------------------------------------- *
   * Pagina, bloques y geometria
   * ---------------------------------------------------------------- */

  const pageText = usePageText(live ? doc : null, pageIndex);
  const blocks = live ? (pageText.analysis?.blocks ?? EMPTY_BLOCKS) : EMPTY_BLOCKS;

  const metrics: PageMetrics | null = useMemo(() => {
    if (!enabled || !page || layoutWidth <= 0) return null;
    try {
      if (!Array.isArray((page as { view?: unknown }).view)) return null;
      return makeMetrics(geometryFromPdfJsPage(page), layoutWidth);
    } catch {
      return null;
    }
  }, [enabled, page, layoutWidth]);

  const pageEdits = useMemo(
    () => textEdits.filter((candidate) => candidate.pageIndex === pageIndex),
    [textEdits, pageIndex],
  );

  /* ---------------------------------------------------------------- *
   * Foco, cobertura, avisos
   * ---------------------------------------------------------------- */

  const [focus, setFocus] = useState<Focus | null>(null);
  const [coverInfo, setCoverInfo] = useState<CoverInfo | null>(null);
  const [gesturing, setGesturing] = useState(false);
  const [renderTick, setRenderTick] = useState(0);
  const exitingRef = useRef(false);

  const latest = useRef({ edit, metrics, blocks, pageEdits, focus, coverInfo, pageIndex, strings: config?.strings });
  useEffect(() => {
    latest.current = { edit, metrics, blocks, pageEdits, focus, coverInfo, pageIndex, strings: config?.strings };
  });

  const message = useCallback((text: string) => announce(text), [announce]);

  const focusKey = focus?.key ?? null;
  const focusBlock = useMemo(
    () => (focusKey ? blocks.find((block) => block.id === focusKey) : undefined),
    [blocks, focusKey],
  );
  const focusEdit = useMemo(
    () => (focusKey ? pageEdits.find((candidate) => (candidate.blockId ?? candidate.id) === focusKey) : undefined),
    [pageEdits, focusKey],
  );
  const focusCover = coverInfo && coverInfo.key === focusKey ? coverInfo : null;
  const layout = useMemo(() => pageLayoutOf(metrics, blocks), [metrics, blocks]);
  const effective: TextEdit | null = useMemo(() => {
    if (focusEdit) return focusEdit;
    if (focusBlock) {
      return draftEditForBlock(focusBlock, {
        coverColor: focusCover?.color ?? "#ffffff",
        coverClip: focusCover?.clip,
        layout,
      });
    }
    return null;
  }, [focusEdit, focusBlock, focusCover, layout]);

  const coverCrossesNeighbor = useMemo(() => {
    if (!effective || !effective.cover.color) return false;
    const shape = coverShape(effective);
    return shape?.kind === "oriented" && shape.holes.length > 0;
  }, [effective]);

  const regionOf = useCallback(
    (key: string): HTMLElement | null => {
      const regions = hostRef.current?.querySelectorAll<HTMLElement>(
        '[data-block-layer] [data-element-id][data-drag-mode="move"]',
      );
      for (const region of Array.from(regions ?? [])) if (region.dataset.elementId === key) return region;
      return null;
    },
    [hostRef],
  );

  const focusRegion = useCallback(
    (key: string | null) => {
      let framesLeft = 20;
      const attempt = () => {
        const target = key ? regionOf(key) : null;
        if (key && !target && framesLeft > 0) {
          framesLeft -= 1;
          window.requestAnimationFrame(attempt);
          return;
        }
        (target ?? hostRef.current)?.focus({ preventScroll: true });
      };
      window.requestAnimationFrame(attempt);
    },
    [regionOf, hostRef],
  );

  const sampleCover = useCallback(
    (block: TextBlock): CoverInfo => {
      const { blocks: all, metrics: m } = latest.current;
      // Las cajas de los demas bloques: ni recortan la cobertura ni cuentan como fondo.
      const neighbors = all
        .filter((other) => other.id !== block.id)
        .map((other) => ({ id: other.id, box: other.box }));
      const sample = sampleBackgroundFromImage(
        imageRef.current,
        m,
        blockCoverExtent(block, COVER_PADDING_PT, neighbors),
        blockCoverQuad(block, COVER_PADDING_PT) ?? undefined,
        neighbors.map((other) => other.box),
        block.box,
      );
      if (!sample) return { key: block.id, color: "#ffffff", uniform: true, sampled: false };
      return {
        key: block.id,
        color: sample.color,
        uniform: sample.uniform,
        sampled: true,
        ...(sample.clip && sample.clip.length > 0 ? { clip: sample.clip } : {}),
      };
    },
    [imageRef],
  );

  const resolve = useCallback((key: string) => {
    const { blocks: list, pageEdits: edits } = latest.current;
    return {
      edit: edits.find((candidate) => (candidate.blockId ?? candidate.id) === key),
      block: list.find((block) => block.id === key),
    };
  }, []);

  const coverFor = useCallback(
    (block: TextBlock): CoverInfo => {
      const info = latest.current.coverInfo;
      return info && info.key === block.id && info.sampled ? info : sampleCover(block);
    },
    [sampleCover],
  );

  const blockDraft = useCallback(
    (block: TextBlock, overrides?: Partial<TextEdit>): TextEdit => {
      const cover = coverFor(block);
      const { metrics: m, blocks: all } = latest.current;
      return draftEditForBlock(block, {
        coverColor: cover.color,
        coverUniform: cover.uniform,
        coverClip: cover.clip,
        layout: pageLayoutOf(m, all),
        overrides,
      });
    },
    [coverFor],
  );

  /* ---------------------------------------------------------------- *
   * Operaciones sobre una entrada (bloque o texto copiado)
   * ---------------------------------------------------------------- */

  const updateText = useCallback(
    (key: string, text: string) => {
      const { edit: session } = latest.current;
      const { edit: existing, block } = resolve(key);
      if (existing) {
        if (text === existing.text) return;
        session.dispatch({ type: "update", id: existing.id, patch: { text } });
      } else if (block) {
        // Un bloque con su mismo texto sigue siendo el original: no se crea edicion.
        if (text === block.text) return;
        session.dispatch({ type: "add", item: textItem(blockDraft(block, { text })) });
      }
    },
    [resolve, blockDraft],
  );

  const restyleEntry = useCallback(
    (key: string, patch: RestylePatch) => {
      const { edit: session } = latest.current;
      const { edit: existing, block } = resolve(key);
      if (existing) {
        session.dispatch({ type: "restyle", id: existing.id, patch });
      } else if (block) {
        session.dispatch({
          type: "add",
          item: textItem(blockDraft(block, patch as Partial<TextEdit>)),
        });
      }
    },
    [resolve, blockDraft],
  );

  const moveEntry = useCallback(
    (key: string, dx: number, dy: number) => {
      const { edit: session } = latest.current;
      const { edit: existing, block } = resolve(key);
      if (existing) {
        session.dispatch({ type: "move", id: existing.id, dx, dy });
      } else if (block) {
        const base = blockDraft(block);
        session.dispatch({
          type: "add",
          item: textItem({ ...base, box: { ...base.box, x: base.box.x + dx, y: base.box.y + dy } }),
        });
      }
    },
    [resolve, blockDraft],
  );

  const resizeEntry = useCallback(
    (key: string, box: UserBox) => {
      const { edit: session } = latest.current;
      const { edit: existing, block } = resolve(key);
      if (existing) {
        session.dispatch({ type: "resize", id: existing.id, box });
      } else if (block) {
        session.dispatch({ type: "add", item: textItem({ ...blockDraft(block), box }) });
      }
    },
    [resolve, blockDraft],
  );

  const orderedKeys = useCallback((): string[] => {
    const { blocks: list, pageEdits: edits } = latest.current;
    const keys = blocksInReadingOrder(list).map((block) => block.id);
    for (const candidate of edits) {
      const key = candidate.blockId ?? candidate.id;
      if (!keys.includes(key)) keys.push(key);
    }
    return keys;
  }, []);

  const enter = useCallback(
    (key: string | null, mode: "selected" | "editing", seed?: string) => {
      const { edit: session } = latest.current;
      if (key === null) {
        setFocus(null);
        setCoverInfo(null);
        session.select(null);
        return;
      }
      const { block, edit: existing } = resolve(key);
      if (block) setCoverInfo(sampleCover(block));
      setFocus({ key, mode, seed });
      session.select(existing?.id ?? null);
    },
    [resolve, sampleCover],
  );

  /* Tras repintar la imagen (zoom, ancho) el muestreo anterior pudo leer la vieja: se repite. */
  useEffect(() => {
    // `queueMicrotask`: sin `setState` sincrono en el cuerpo del efecto.
    queueMicrotask(() => setRenderTick((tick) => tick + 1));
  }, [renderKey]);
  useEffect(() => {
    if (renderTick === 0) return;
    const { focus: current, blocks: all } = latest.current;
    const block = current ? all.find((candidate) => candidate.id === current.key) : undefined;
    if (!block) return;
    const next = sampleCover(block);
    setCoverInfo((previous) =>
      previous &&
      previous.key === next.key &&
      previous.sampled === next.sampled &&
      previous.color === next.color &&
      previous.uniform === next.uniform &&
      (previous.clip?.length ?? 0) === (next.clip?.length ?? 0)
        ? previous
        : next,
    );
  }, [renderTick, sampleCover]);

  const finishEditing = useCallback(
    (key: string, restoreFocus: boolean) => {
      setFocus((current) =>
        current && current.key === key && current.mode === "editing"
          ? { key, mode: "selected" }
          : current,
      );
      if (!restoreFocus) return;
      // El foco pasa AL INSTANTE al bloque (el editor se desmonta en este mismo ciclo).
      const region = regionOf(key);
      if (region) {
        exitingRef.current = true;
        region.focus({ preventScroll: true });
        window.requestAnimationFrame(() => {
          exitingRef.current = false;
        });
      } else {
        focusRegion(key);
      }
    },
    [regionOf, focusRegion],
  );

  const removeEntry = useCallback(
    (key: string) => {
      const { edit: session, strings: text } = latest.current;
      const { edit: existing, block } = resolve(key);
      if (existing && existing.blockId === undefined) {
        // Un texto copiado: se quita del todo y el foco pasa al siguiente.
        session.dispatch({ type: "remove", id: existing.id });
        const next = nextFocusKey(orderedKeys(), key);
        setFocus(null);
        session.select(null);
        if (text) message(text.deleted);
        focusRegion(next);
        return;
      }
      // Borrar el texto de un bloque original = dejarlo vacio (cubierto y sin redibujar).
      if (existing) {
        if (existing.text === "") return;
        session.dispatch({ type: "update", id: existing.id, patch: { text: "" } });
      } else if (block) {
        session.dispatch({ type: "add", item: textItem(blockDraft(block, { text: "" })) });
      }
      if (text) message(text.deleted);
    },
    [resolve, blockDraft, orderedKeys, focusRegion, message],
  );

  const duplicateEntry = useCallback(
    (key: string) => {
      const { edit: session, metrics: m, pageIndex: current, strings: text } = latest.current;
      const { edit: existing, block } = resolve(key);
      const source: TextEdit | null =
        existing ?? (block ? draftEditForBlock(block, { coverColor: null }) : null);
      if (!source || !m) return;
      const rect = userBoxToPx(m, source.box);
      const shift = userDeltaFromView(m, 0, rect.height + 8 * m.scale);
      const copy: TextEdit = {
        ...source,
        id: newEditId("tx"),
        pageIndex: current,
        box: { ...source.box, x: source.box.x + shift.dx, y: source.box.y + shift.dy },
        cover: { color: null, padding: 0 },
      };
      delete copy.blockId;
      delete copy.coverBox;
      delete copy.sourceFont;
      session.dispatch({ type: "add", item: textItem(copy) });
      setFocus({ key: copy.id, mode: "selected" });
      if (text) message(text.duplicated);
      focusRegion(copy.id);
    },
    [resolve, focusRegion, message],
  );

  /* ---------------------------------------------------------------- *
   * Manejadores de la capa
   * ---------------------------------------------------------------- */

  const handlers = useMemo<LayerHandlers>(
    () => ({
      onSelect: (key) => enter(key, "selected"),
      onBeginEdit: (key, seed) => enter(key, "editing", seed),
      onDelete: removeEntry,
      onNudge: (key, direction: NudgeDirection, big, resize) => {
        const { metrics: m, strings: text } = latest.current;
        if (!m) return;
        const { edit: existing, block } = resolve(key);
        if (!existing && !block) return;
        if (!resize) {
          const delta = nudgeDelta(m, direction, big);
          moveEntry(key, delta.dx, delta.dy);
          return;
        }
        const source = existing ?? (block ? draftEditForBlock(block, { coverColor: null }) : null);
        if (!source) return;
        const rect = userBoxToPx(m, source.box);
        const step = (big ? 10 : 1) * m.scale;
        const next = { ...rect };
        if (direction === "left") next.width = Math.max(MIN_BOX_PT * m.scale, rect.width - step);
        if (direction === "right") next.width = rect.width + step;
        if (direction === "up") next.height = Math.max(MIN_BOX_PT * m.scale, rect.height - step);
        if (direction === "down") next.height = rect.height + step;
        const resized = pxRectToUserBox(m, next);
        resizeEntry(key, resized);
        if (text) message(text.sizeAnnounce(Math.round(resized.width), Math.round(resized.height)));
      },
      onMove: (key, dxPx, dyPx) => {
        const { metrics: m } = latest.current;
        if (!m) return;
        const delta = userDeltaFromView(m, dxPx, dyPx);
        moveEntry(key, delta.dx, delta.dy);
      },
      onResize: (key, rect) => {
        const { metrics: m } = latest.current;
        if (!m) return;
        resizeEntry(key, pxRectToUserBox(m, rect));
      },
      onGesture: setGesturing,
      onTabIntoBar: () => {
        const bar = stageRef.current?.querySelector<HTMLElement>("[data-edit-text-bar] [data-floating-bar]");
        const first = bar?.querySelector<HTMLElement>("button:not([disabled]), select:not([disabled])");
        if (!first) return false;
        first.focus();
        return true;
      },
    }),
    [enter, removeEntry, resolve, moveEntry, resizeEntry, message, stageRef],
  );

  const onEditorExit = useCallback(
    (reason: InlineExitReason, related: Element | null) => {
      const current = latest.current.focus;
      if (!current || current.mode !== "editing") return;
      if (exitingRef.current) return;
      if (reason === "blur") {
        // Pasar a la barra flotante no termina la edicion.
        if (related?.closest("[data-floating-bar]")) return;
        finishEditing(current.key, related === null);
        return;
      }
      finishEditing(current.key, true);
    },
    [finishEditing],
  );

  const onHistory = useCallback((action: "undo" | "redo") => {
    const { edit: session } = latest.current;
    if (action === "undo") session.undo();
    else session.redo();
  }, []);

  /* El foco apunta a algo que ya no existe (deshacer lo quito): se suelta sin caer a <body>. */
  const entryExists = focusBlock !== undefined || focusEdit !== undefined;
  const orphan = focus !== null && !entryExists && (!live || pageText.status === "ready");
  useEffect(() => {
    if (!orphan) return;
    const frame = window.requestAnimationFrame(() => {
      setFocus(null);
      setCoverInfo(null);
      hostRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [orphan, hostRef]);

  /* Al salir de la herramienta o cambiar de pagina se suelta el foco de texto. */
  const release = useCallback(() => {
    setFocus(null);
    setCoverInfo(null);
    setGesturing(false);
    latest.current.edit.select(null);
  }, []);
  const releaseRef = useRef(release);
  useEffect(() => {
    releaseRef.current = release;
  });
  useEffect(() => {
    // `queueMicrotask`: sin `setState` sincrono en el cuerpo del efecto.
    if (!live) queueMicrotask(() => releaseRef.current());
  }, [live]);
  const lastPage = useRef(pageIndex);
  useEffect(() => {
    if (lastPage.current === pageIndex) return;
    lastPage.current = pageIndex;
    queueMicrotask(() => releaseRef.current());
  }, [pageIndex]);

  /* ---------------------------------------------------------------- *
   * Barra y capa
   * ---------------------------------------------------------------- */

  const s = config?.strings;
  const barState: BarTextState | null =
    live && effective && focus
      ? {
          fontKey: effective.fontKey,
          fontSize: effective.fontSize,
          bold: effective.bold,
          italic: effective.italic,
          color: effective.color,
          align: effective.align,
          coverColor: effective.cover.color,
          sourceFont: effective.sourceFont ?? focusBlock?.font,
          text: effective.text,
          mixedStyle: focusBlock?.mixedStyle === true,
          overlap: false,
          coverCrossesNeighbor,
        }
      : null;
  const replacesBlock = focusBlock !== undefined || focusEdit?.blockId !== undefined;
  const layoutKey = [
    pageIndex,
    metrics?.cssWidth ?? 0,
    focus?.key ?? "",
    focus?.mode ?? "",
    effective ? `${effective.box.x},${effective.box.y},${effective.box.width},${effective.box.height}` : "",
  ].join("|");

  const glyphText = barState && s ? glyphNotice(barState, s) : "";
  useEffect(() => {
    if (!glyphText) return;
    const frame = window.requestAnimationFrame(() => announce(glyphText));
    return () => window.cancelAnimationFrame(frame);
  }, [glyphText, announce]);

  const analysis = pageText.analysis;
  const status: SignTextEditing["status"] = !live
    ? "idle"
    : pageText.status === "analyzing"
      ? "analyzing"
      : analysis?.failed
        ? "failed"
        : analysis && !analysis.hasTextLayer
          ? "scanned"
          : "ready";
  const nonEditable = blocks.filter((block) => !block.editable).length;

  const layer: ReactNode =
    enabled && s && metrics ? (
      <div
        className="absolute inset-0"
        data-edit-text-layer=""
        data-active={live ? "" : undefined}
        // Fuera de la herramienta la capa solo MUESTRA las ediciones: ni foco ni punteros.
        inert={!live}
        aria-hidden={live ? undefined : true}
      >
        <TextBlockLayer
          metrics={metrics}
          blocks={blocks}
          edits={pageEdits}
          pending={null}
          selectedKey={focus?.mode === "selected" ? focus.key : null}
          editingKey={focus?.mode === "editing" ? focus.key : null}
          editingCover={focusCover?.color ?? null}
          coarse={coarse}
          strings={s}
          handlers={handlers}
          onAnnounce={announce}
        >
          {live && focus?.mode === "editing" && effective ? (
            <InlineTextEditor
              key={focus.key}
              frame={textFrame(metrics, effective.box, effective.rotation)}
              text={effective.text}
              css={effective}
              scale={metrics.scale}
              label={s.editorLabel}
              hint={s.editorHint}
              seed={focus.seed}
              onTextChange={(text) => updateText(focus.key, text)}
              onExit={onEditorExit}
              onHistory={onHistory}
            />
          ) : null}
        </TextBlockLayer>
      </div>
    ) : null;

  const bar: ReactNode =
    enabled && s ? (
      <div data-edit-text-bar="">
        <EditFloatingBar
          stageRef={stageRef}
          clipRef={clipRef}
          hostRef={hostRef}
          selectionId={gesturing || !live ? null : focusKey}
          layoutKey={layoutKey}
          state={barState}
          replacesBlock={replacesBlock}
          backgroundNotUniform={focusCover?.uniform === false || focusEdit?.cover.uniform === false}
          strings={s}
          onRestyle={(patch) => focusKey && restyleEntry(focusKey, patch)}
          onDuplicate={() => focusKey && duplicateEntry(focusKey)}
          onDelete={() => focusKey && removeEntry(focusKey)}
          onEscape={() => {
            if (!focus) return;
            if (focus.mode === "editing") {
              hostRef.current?.querySelector<HTMLElement>("[data-inline-editor]")?.focus();
            } else {
              focusRegion(focus.key);
            }
          }}
          onTabBackward={() => {
            if (!focus) return;
            if (focus.mode === "editing") {
              hostRef.current?.querySelector<HTMLElement>("[data-inline-editor]")?.focus();
            } else {
              focusRegion(focus.key);
            }
          }}
          onTabForward={() => {
            if (!focusKey) return false;
            const keys = orderedKeys();
            const next = keys[keys.indexOf(focusKey) + 1];
            const region = next ? regionOf(next) : null;
            if (!region) return false;
            region.focus();
            return true;
          }}
        />
      </div>
    ) : null;

  return {
    enabled,
    layer,
    bar,
    count: effectiveTextEdits(textEdits).length,
    pageCount: effectiveTextEdits(pageEdits).length,
    canUndo: edit.canUndo,
    canRedo: edit.canRedo,
    undo: edit.undo,
    redo: edit.redo,
    status,
    nonEditable,
    release,
  };
}
