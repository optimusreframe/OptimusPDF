"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Camera, CircleAlert, Copy, Crop, Images, ListChecks, Maximize, Move, Redo2, RotateCw, ScanSearch, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useFocusTarget } from "@/components/tool/useFocusTarget";
import { cn } from "@/lib/cn";
import { blankPageIds, orientationCounts, type QualityChipKind } from "@/app/scan-to-pdf/scanState";
import { FILTER_ORDER } from "@/app/scan-to-pdf/PageEditor";
import { PageGrid } from "@/app/scan-to-pdf/PageGrid";
import { ScreenShell } from "@/app/scan-to-pdf/ScreenShell";
import { ImportProblemsBanner } from "@/app/scan-to-pdf/ImportProblemsBanner";
import { useAnnounce } from "@/app/scan-to-pdf/ScanLive";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";
import type { ScanSessionApi, SaveStatus } from "@/app/scan-to-pdf/useScanSession";
import type { ScanFilterMode } from "@/lib/scan/types";

export type AddTarget = { kind: "append" } | { kind: "insert"; at: number } | { kind: "retake"; id: string };

export type ReviewScreenProps = {
  s: ScanToPdfStrings;
  api: ScanSessionApi;
  closeLabel: string;
  onCamera: (target: AddTarget) => void;
  onPhotos: (target: AddTarget) => void;
  onEdit: (id: string) => void;
  /** Abre el editor de esquinas de una pagina (el chip «Sin documento detectado»). */
  onCorners: (id: string) => void;
  onViewSheet: (id: string) => void;
  onSave: () => void;
};

function statusText(s: ScanToPdfStrings, status: SaveStatus): string {
  switch (status) {
    case "saving":
    // Cambio en espera de guardarse (silencio de unos 500 ms): se dice igual que mientras guarda, no como un fallo.
    case "unsaved":
      return s.statusSaving;
    case "saved":
    case "idle":
      return s.statusSaved;
    case "quota":
      return s.statusQuota;
    case "unavailable":
      return s.statusUnavailable;
    case "tooBig":
      return s.statusTooBig;
  }
}

/**
 * Revisar y organizar: cuadricula de miniaturas con numero, chips de calidad con accion de un toque, reordenar, girar, borrar,
 * duplicar, repetir captura, insertar, seleccion multiple (barra inferior contextual), deshacer / rehacer. La accion primaria
 * («Guardar PDF») vive abajo, al alcance del pulgar.
 */
export function ReviewScreen({ s, api, closeLabel, onCamera, onPhotos, onEdit, onCorners, onViewSheet, onSave }: ReviewScreenProps) {
  const announce = useAnnounce();
  const pages = api.pages;
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [movingIds, setMovingIds] = useState<string[] | null>(null);
  const [moreId, setMoreId] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const focusArg = useRef<{ index: number; id: string; part: "remove" | "handle" | "main" }>({ index: 0, id: "", part: "main" });

  const { request: askFocus } = useFocusTarget<"tile" | "fallback">((target) => {
    const tiles = Array.from(document.querySelectorAll<HTMLElement>("[data-page-grid] [data-page-id]"));
    const fallback = [document.querySelector<HTMLElement>('[data-review-action="camera"]'), document.querySelector<HTMLElement>('[data-review-action="photos"]')];
    if (target === "fallback") return { candidates: fallback };
    const { id, index, part } = focusArg.current;
    const byId = tiles.find((tile) => tile.getAttribute("data-page-id") === id);
    const near = tiles[Math.min(index, tiles.length - 1)];
    const pick = (tile: HTMLElement | undefined) => (tile ? (tile.querySelector<HTMLElement>(part === "handle" ? "[data-drag-handle]" : part === "remove" ? '[data-tile-action="remove"]' : "[data-page-main]") ?? tile.querySelector<HTMLElement>("[data-page-main]")) : null);
    return { candidates: [pick(byId), pick(near), ...fallback] };
  });

  const blanks = useMemo(() => blankPageIds(pages), [pages]);
  const indexOf = useCallback((id: string) => pages.findIndex((page) => page.id === id), [pages]);
  const chosen = useMemo(() => pages.filter((page) => selection.has(page.id)).map((page) => page.id), [pages, selection]);

  /* ---------------- acciones por pagina ---------------- */
  const remove = useCallback(
    (ids: string[]) => {
      const indexes = ids.map((id) => indexOf(id)).filter((i) => i >= 0);
      // El foco va a la tarjeta que ocupa el sitio de la primera borrada (la anterior si era la ultima).
      focusArg.current = { index: indexes.length > 0 ? Math.min(...indexes) : 0, id: "", part: "main" };
      api.removeIds(ids);
      setSelection((current) => new Set(Array.from(current).filter((id) => !ids.includes(id))));
      askFocus(pages.length - ids.length > 0 ? "tile" : "fallback");
    },
    [api, askFocus, indexOf, pages.length],
  );

  const onChip = useCallback(
    (id: string, kind: QualityChipKind) => {
      if (kind === "blank" || kind === "duplicate") remove([id]);
      // Sin documento detectado: la pagina esta ENTERA; se abre el ajuste de esquinas («Toda la foto» la deja completa).
      else if (kind === "noDocument") onCorners(id);
      else onCamera({ kind: "retake", id });
    },
    [remove, onCorners, onCamera],
  );

  const onDrop = useCallback(
    (ids: string[], insertBefore: number) => {
      const pos = api.moveIds(ids, insertBefore);
      if (pos > 0) {
        announce(s.moveDone(pos));
        focusArg.current = { index: pos - 1, id: ids[0], part: "handle" };
        askFocus("tile");
      }
    },
    [api, announce, s, askFocus],
  );

  const onShift = useCallback(
    (id: string, delta: number) => {
      const index = indexOf(id);
      const pos = Number.isFinite(delta) ? api.shiftIds([id], delta, `move:${id}`) : api.moveIds([id], delta < 0 ? 0 : pages.length, `move:${id}`);
      if (pos > 0) {
        announce(s.dragMoved(index + 1, pos));
        focusArg.current = { index: pos - 1, id, part: "handle" };
        askFocus("tile");
      }
    },
    [api, announce, askFocus, indexOf, pages.length, s],
  );

  const onMoveHere = useCallback(
    (insertBefore: number) => {
      if (!movingIds) return;
      const pos = api.moveIds(movingIds, insertBefore);
      setMovingIds(null);
      if (pos > 0) {
        announce(s.moveDone(pos));
        focusArg.current = { index: pos - 1, id: movingIds[0], part: "main" };
        askFocus("tile");
      }
    },
    [api, announce, askFocus, movingIds, s],
  );

  const startMove = (ids: string[]) => {
    setMovingIds(ids);
    setSelecting(false);
    setSelection(new Set());
    announce(s.moveModeTitle(ids.length));
  };

  const toggleSelect = useCallback((id: string) => {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const endSelecting = () => {
    setSelecting(false);
    setSelection(new Set());
  };

  const more = moreId ? pages.find((page) => page.id === moreId) : null;
  const moreNumber = more ? indexOf(more.id) + 1 : 0;
  const empty = pages.length === 0;
  const notice = api.orientationNotice;

  const filterChoices = (
    <div className="flex flex-col gap-2 pb-2" data-bulk-filter="">
      {FILTER_ORDER.map((filter: ScanFilterMode) => (
        <Button
          key={filter}
          variant="secondary"
          size="md"
          fullWidth
          data-filter={filter}
          onClick={() => {
            api.applyFilter(chosen, filter);
            setFilterOpen(false);
          }}
        >
          {s.filters[filter]}
        </Button>
      ))}
    </div>
  );

  return (
    <>
      <ScreenShell
        className="max-w-[1200px]"
        scrollerRef={scrollerRef}
        rootProps={{ "data-review": "" }}
        barProps={{ "data-review-bar": "" }}
        top={
          <>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 data-view-heading="" tabIndex={-1} className="text-title-3 text-foreground outline-none">
            {s.reviewTitle}
          </h2>
          <p
            data-save-status={api.saveStatus}
            className={cn("mt-0.5 text-footnote font-medium", api.saveStatus === "saved" || api.saveStatus === "idle" ? "text-success-text" : api.saveStatus === "saving" || api.saveStatus === "unsaved" ? "text-muted-foreground" : "text-destructive-text")}
          >
            {statusText(s, api.saveStatus)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <IconButton label={s.undo} action="undo" disabled={!api.canUndo} onClick={api.undo}>
            <Undo2 aria-hidden="true" className="size-5" />
          </IconButton>
          <IconButton label={s.redo} action="redo" disabled={!api.canRedo} onClick={api.redo}>
            <Redo2 aria-hidden="true" className="size-5" />
          </IconButton>
          <Button
            variant={selecting ? "primary" : "secondary"}
            size="md"
            data-review-action="select"
            aria-pressed={selecting}
            disabled={empty}
            onClick={() => (selecting ? endSelecting() : (setSelecting(true), setMovingIds(null)))}
          >
            <ListChecks aria-hidden="true" className="size-4" />
            {selecting ? s.selectDone : s.select}
          </Button>
        </div>
      </div>
          </>
        }
        bar={
          <>
        {movingIds ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-subheadline text-foreground">{s.moveModeTitle(movingIds.length)}</p>
            <Button variant="secondary" size="md" data-move-cancel="" onClick={() => setMovingIds(null)}>
              {s.moveCancel}
            </Button>
          </div>
        ) : selecting ? (
          <div role="group" aria-label={s.actionsLabel} className="flex flex-col gap-2" data-selection-bar="">
            <div className="flex items-center justify-between gap-2">
              <p className="text-subheadline font-semibold text-foreground" data-selected-count="">
                {s.selectedCount(chosen.length)}
              </p>
              <Button variant="ghost" size="md" data-review-action="select-all" onClick={() => setSelection(new Set(pages.map((page) => page.id)))}>
                {s.selectAll}
              </Button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              <BarButton label={s.bulkFilter} action="bulk-filter" disabled={chosen.length === 0} onClick={() => setFilterOpen(true)}>
                <ScanSearch aria-hidden="true" className="size-5" />
              </BarButton>
              <BarButton label={s.bulkRotate} action="bulk-rotate" disabled={chosen.length === 0} onClick={() => api.rotateIds(chosen, 90, `rotate:bulk`)}>
                <RotateCw aria-hidden="true" className="size-5" />
              </BarButton>
              <BarButton label={s.bulkDelete} action="bulk-delete" disabled={chosen.length === 0} onClick={() => { const ids = chosen; endSelecting(); remove(ids); }}>
                <Trash2 aria-hidden="true" className="size-5" />
              </BarButton>
              <BarButton label={s.bulkMove} action="bulk-move" disabled={chosen.length === 0} onClick={() => startMove(chosen)}>
                <Move aria-hidden="true" className="size-5" />
              </BarButton>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label={s.addCamera} action="camera" large onClick={() => onCamera({ kind: "append" })} review>
              <Camera aria-hidden="true" className="size-6" />
            </IconButton>
            <IconButton label={s.addPhotos} action="photos" large onClick={() => onPhotos({ kind: "append" })} review>
              <Images aria-hidden="true" className="size-6" />
            </IconButton>
            <Button
              size="lg"
              wrap
              data-review-action="save"
              disabled={empty}
              aria-disabled={!empty && api.pendingCount > 0 ? true : undefined}
              onClick={() => (api.pendingCount > 0 ? announce(s.saveBlocked) : onSave())}
              className="min-h-[56px] min-w-0 flex-[1_1_9rem] px-4"
            >
              {s.save(pages.length)}
            </Button>
          </div>
        )}
        {api.pendingCount > 0 && !selecting && !movingIds ? <p className="mt-1.5 text-center text-caption text-muted-foreground">{s.saveBlocked}</p> : null}
          </>
        }
      >
      <p className="text-footnote text-muted-foreground">{s.reviewHelp}</p>

      <ImportProblemsBanner s={s} problems={api.importProblems} onDismiss={api.dismissImportProblems} />

      {blanks.length > 0 ? (
        <div data-banner="blanks" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-ios border border-hairline bg-white/5 px-3 py-2">
          <p className="min-w-0 text-footnote text-foreground">{s.blanksBanner(blanks.length)}</p>
          <Button size="sm" data-review-action="remove-blanks" onClick={() => { focusArg.current = { index: 0, id: "", part: "main" }; api.removeBlanks(); askFocus(pages.length - blanks.length > 0 ? "tile" : "fallback"); }}>
            <Trash2 aria-hidden="true" className="size-4" />
            {s.removeBlanks(blanks.length)}
          </Button>
        </div>
      ) : null}

      {notice ? (
        <div data-banner="orientation" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-ios border border-hairline bg-white/5 px-3 py-2">
          <p className="min-w-0 text-footnote text-foreground">{s.orientationNotice(orientationCounts(notice))}</p>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="secondary" data-review-action="undo-orientation" onClick={api.undoOrientation}>
              <Undo2 aria-hidden="true" className="size-4" />
              {s.orientationUndo}
            </Button>
            <IconButton label={s.close} action="dismiss-orientation" onClick={api.dismissOrientationNotice}>
              <X aria-hidden="true" className="size-5" />
            </IconButton>
          </div>
        </div>
      ) : null}

      {api.lostPages > 0 ? (
        <div data-banner="lost" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-ios border border-destructive/40 bg-destructive/10 px-3 py-2">
          <p className="min-w-0 text-footnote text-foreground">{s.lostPages(api.lostPages)}</p>
          <IconButton label={s.close} action="dismiss-lost" onClick={api.dismissLostPages}>
            <X aria-hidden="true" className="size-5" />
          </IconButton>
        </div>
      ) : null}

      {api.saveStatus === "unavailable" || api.saveStatus === "quota" || api.saveStatus === "tooBig" ? (
        <div data-banner="storage" className="mt-3 flex items-start gap-2 rounded-ios border border-destructive/40 bg-destructive/10 p-3">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive-text" />
          <p className="text-subheadline text-foreground">{api.saveStatus === "unavailable" ? s.storageUnavailableHint : api.saveStatus === "quota" ? s.statusQuota : s.statusTooBig}. {s.storageUnavailableHint}</p>
        </div>
      ) : null}

      {movingIds ? (
        <div data-banner="moving" className="mt-3 rounded-ios border border-signal bg-signal/10 p-3 text-subheadline text-foreground">
          {s.moveModeTitle(movingIds.length)}
        </div>
      ) : null}

      <div className="mt-4 pb-6">
        {empty ? (
          <div className="surface-card rounded-ios-lg px-6 py-12 text-center">
            <h3 className="text-headline text-foreground">{s.emptyTitle}</h3>
            <p className="mt-1 text-callout text-muted-foreground">{s.emptyBody}</p>
          </div>
        ) : (
          <PageGrid
            s={s}
            pages={pages}
            pendingIds={api.state.pendingIds}
            selection={selection}
            selecting={selecting}
            movingIds={movingIds}
            onOpen={onEdit}
            onToggleSelect={toggleSelect}
            onRotate={(id) => api.rotateIds([id], 90, `rotate:${id}`)}
            onRemove={(id) => remove([id])}
            onMore={setMoreId}
            onChip={onChip}
            onDrop={onDrop}
            onShift={onShift}
            onMoveHere={onMoveHere}
            announce={announce}
            scrollerRef={scrollerRef}
          />
        )}
        {movingIds && !empty ? (
          <div className="mt-3">
            <Button variant="secondary" size="md" fullWidth data-move-end="" onClick={() => onMoveHere(pages.length)}>
              {s.moveToEnd}
            </Button>
          </div>
        ) : null}
      </div>
      </ScreenShell>

      {/* Mas acciones de una pagina */}
      <Sheet open={moreId !== null && more !== undefined && more !== null} onClose={() => setMoreId(null)} title={s.moreTitle(moreNumber)} closeLabel={closeLabel} inertBackground>
        <div className="flex flex-col gap-2 pb-2" data-more-sheet="">
          <MoreAction icon={<Crop className="size-5" />} label={s.edit} action="edit" onClick={() => { const id = moreId!; setMoreId(null); onEdit(id); }} />
          <MoreAction icon={<ScanSearch className="size-5" />} label={s.retake} action="retake" onClick={() => { const id = moreId!; setMoreId(null); onCamera({ kind: "retake", id }); }} />
          <MoreAction icon={<Copy className="size-5" />} label={s.duplicate} action="duplicate" onClick={() => { const id = moreId!; setMoreId(null); api.duplicateIds([id]); }} />
          <MoreAction icon={<Images className="size-5" />} label={s.insertBefore} action="insert-before" onClick={() => { const at = indexOf(moreId!); setMoreId(null); setInsertAt(at); }} />
          <MoreAction icon={<Images className="size-5" />} label={s.insertAfter} action="insert-after" onClick={() => { const at = indexOf(moreId!) + 1; setMoreId(null); setInsertAt(at); }} />
          <MoreAction icon={<Move className="size-5" />} label={s.moveTo} action="move" onClick={() => { const id = moreId!; setMoreId(null); startMove([id]); }} />
          <MoreAction icon={<Maximize className="size-5" />} label={s.viewSheet} action="sheet" onClick={() => { const id = moreId!; setMoreId(null); onViewSheet(id); }} />
          <MoreAction icon={<ListChecks className="size-5" />} label={s.select} action="select" onClick={() => { const id = moreId!; setMoreId(null); setSelecting(true); setSelection(new Set([id])); }} />
        </div>
      </Sheet>

      {/* Insertar: camara o fototeca */}
      <Sheet open={insertAt !== null} onClose={() => setInsertAt(null)} title={s.insertSourceTitle} closeLabel={closeLabel} inertBackground>
        <div className="flex flex-col gap-2 pb-2" data-insert-sheet="">
          <Button size="md" fullWidth data-insert="camera" onClick={() => { const at = insertAt!; setInsertAt(null); onCamera({ kind: "insert", at }); }}>
            <Camera aria-hidden="true" className="size-4" />
            {s.insertCamera}
          </Button>
          <Button variant="secondary" size="md" fullWidth data-insert="library" onClick={() => { const at = insertAt!; setInsertAt(null); onPhotos({ kind: "insert", at }); }}>
            <Images aria-hidden="true" className="size-4" />
            {s.insertLibrary}
          </Button>
        </div>
      </Sheet>

      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title={s.bulkFilterTitle} closeLabel={closeLabel} inertBackground>
        {filterChoices}
      </Sheet>
    </>
  );
}

function IconButton({ label, action, disabled, onClick, children, large, review }: { label: string; action: string; disabled?: boolean; onClick: () => void; children: React.ReactNode; large?: boolean; review?: boolean }) {
  return (
    <button
      type="button"
      {...(review ? { "data-review-action": action } : { "data-icon-action": action })}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full text-foreground outline-none hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-35",
        large ? "size-[56px] border border-hairline bg-white/5" : "size-[44px]",
      )}
    >
      {children}
    </button>
  );
}

function BarButton({ label, action, disabled, onClick, children }: { label: string; action: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-review-action={action}
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-ios-sm border border-hairline bg-white/5 px-1 py-1 text-caption font-semibold text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-40"
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

function MoreAction({ icon, label, action, onClick }: { icon: React.ReactNode; label: string; action: string; onClick: () => void }) {
  return (
    <Button variant="secondary" size="md" fullWidth data-more-action={action} className="justify-start" onClick={onClick}>
      {icon}
      {label}
    </Button>
  );
}
