"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsRight,
  CircleHelp,
  List,
  MousePointer2,
  MoveHorizontal,
  MoveVertical,
  PenLine,
  Redo2,
  Signature,
  SlidersHorizontal,
  SquareCheck,
  Type,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { createVelocityTracker, nearestSnapPoint, project, rubberband } from "@/lib/motion";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { PlacementTool } from "@/app/sign-pdf/canvasTools";
import type { EditModeStrings } from "@/app/sign-pdf/editMode/editModeStrings";
import { IconButton, PillButton } from "@/app/sign-pdf/editMode/editUi";
import type { FitMode, Insets } from "@/app/sign-pdf/editMode/viewMath";

/*
 * El «marco» del modo «Editar campos» (W3-B1): barras, herramientas y panel de edicion alrededor de la hoja fija. Es solo
 * maquetacion y presentacion; el lienzo (`DocumentCanvas`) le da la hoja y sabe que hacer con cada boton.
 *
 * Disposicion (se decide por el ANCHO UTIL de la pantalla, no por el modelo: Split View y ventanas estrechas cuentan):
 *  - estrecho (< 600 px): barra superior · escenario · barra de paginas y zoom · herramientas ABAJO (al alcance del pulgar);
 *    el panel de edicion sube desde abajo con tres detentes (minimo, medio, completo) que se arrastran por el asa.
 *  - ancho (>= 600 px): barra superior · riel de herramientas a la IZQUIERDA · escenario · barra de paginas y zoom abajo; el
 *    panel es LATERAL, a la derecha, desde 900 px o con poco alto (iPhone apaisado).
 * El panel cubre parte del escenario SIN encogerlo: el lienzo recibe cuanto tapa (`onChromeInsets`) y reencuadra la hoja.
 */

export type DockTab = "element" | "elements" | "pages" | "help";

export type EditLayout = {
  width: number;
  height: number;
  /** Riel de herramientas a la izquierda (si no, barra de herramientas abajo). */
  rail: boolean;
  dockSide: "bottom" | "right";
  /** Poco alto (movil apaisado): barras mas bajas. */
  short: boolean;
};

const RAIL_MIN_WIDTH = 600;
const SIDE_DOCK_MIN_WIDTH = 900;
const SHORT_HEIGHT = 520;
const SIDE_DOCK_WIDTH = 360;

export function layoutFor(width: number, height: number): EditLayout {
  const rail = width >= RAIL_MIN_WIDTH;
  const short = height > 0 && height < SHORT_HEIGHT;
  const dockSide = rail && (width >= SIDE_DOCK_MIN_WIDTH || short) ? "right" : "bottom";
  return { width, height, rail, dockSide, short };
}

const TOOL_ICONS: Record<PlacementTool, typeof Type> = {
  select: MousePointer2,
  signature: PenLine,
  initials: Signature,
  text: Type,
  checkbox: SquareCheck,
  date: CalendarDays,
  editText: Type,
};

const BAR_SURFACE = "material-thick";

type SignerChip = { id: string; name: string; color: string };

export type EditModeFrameProps = {
  strings: SignStrings;
  edit: EditModeStrings;
  title: string;
  onDone: () => void;
  history: { canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void };
  tools: readonly PlacementTool[];
  tool: PlacementTool;
  toolLabel: (tool: PlacementTool) => string;
  onTool: (tool: PlacementTool) => void;
  /** Mas de un firmante: a quien se asignan los huecos nuevos. */
  signers: readonly SignerChip[];
  activeSignerId: string | null;
  onActiveSigner: (id: string) => void;
  pages: {
    index: number;
    count: number;
    onPrev: () => void;
    onNext: () => void;
    onStepWithFields: (direction: 1 | -1) => void;
  };
  zoom: {
    value: number;
    canIn: boolean;
    canOut: boolean;
    onIn: () => void;
    onOut: () => void;
    onFit: () => void;
    fitMode: FitMode;
    onToggleFit: () => void;
  };
  dock: {
    open: boolean;
    tab: DockTab;
    /** Pestanas disponibles, en orden («Elemento» solo hay con algo seleccionado). */
    tabs: readonly DockTab[];
    onTab: (tab: DockTab) => void;
    onClose: () => void;
    /** El contenido de la pestana; recibe la disposicion para elegir (tira de paginas abajo, rejilla en el panel lateral). */
    body: (layout: EditLayout) => ReactNode;
  };
  /** «Propiedades»: abre el panel del elemento seleccionado cuando esta cerrado (un campo de texto no lo abre solo: tocarlo lo escribe). */
  properties: { visible: boolean; onClick: () => void };
  /** Boton de la barra superior o de paginas: abre el panel en esa pestana (o lo cierra si ya estaba). */
  onOpenTab: (tab: DockTab) => void;
  /** El escenario (la hoja y sus gestos), que el lienzo pinta y gobierna. */
  stage: ReactNode;
  /** Cuanto tapa el panel del escenario (px), para reencuadrar la hoja. */
  onChromeInsets: (insets: Insets) => void;
};

export function EditModeFrame(props: EditModeFrameProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const layout = layoutFor(size.width, size.height);
  const { onChromeInsets } = props;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => setSize({ width: root.clientWidth, height: root.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  /* Cuanto tapa el panel del escenario: se mide el solape real de sus cajas (sigue al panel mientras se arrastra). */
  const dockOpen = props.dock.open;
  useEffect(() => {
    const cell = cellRef.current;
    if (!cell) return;
    const report = () => {
      const dock = dockOpen ? dockRef.current : null;
      if (!dock) {
        onChromeInsets({ top: 0, right: 0, bottom: 0, left: 0 });
        return;
      }
      const a = cell.getBoundingClientRect();
      const b = dock.getBoundingClientRect();
      onChromeInsets({
        top: 0,
        left: 0,
        right: layout.dockSide === "right" ? Math.max(0, Math.min(a.width, a.right - b.left)) : 0,
        bottom: layout.dockSide === "bottom" ? Math.max(0, Math.min(a.height, a.bottom - b.top)) : 0,
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(cell);
    if (dockRef.current) observer.observe(dockRef.current);
    return () => observer.disconnect();
  }, [dockOpen, layout.dockSide, onChromeInsets]);

  const compactBar = !layout.rail;

  return (
    <div ref={rootRef} data-edit-frame="" className="flex h-full w-full flex-col bg-background">
      <TopBar {...props} layout={layout} />

      <div className="flex min-h-0 flex-1">
        {layout.rail ? <ToolRail {...props} layout={layout} /> : null}
        <div ref={cellRef} className="relative min-w-0 flex-1 bg-[color-mix(in_oklab,var(--color-foreground)_7%,var(--color-background))]">
          {props.stage}
          {props.dock.open ? (
            <Dock key={layout.dockSide} {...props} layout={layout} dockRef={dockRef} cellRef={cellRef} />
          ) : null}
        </div>
      </div>

      <PageBar {...props} layout={layout} lowest={!compactBar} />
      {compactBar ? <BottomTools {...props} layout={layout} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Barra superior
 * ------------------------------------------------------------------ */

type BarProps = EditModeFrameProps & { layout: EditLayout };

function TopBar({ edit, title, onDone, history, dock, onOpenTab, properties, layout }: BarProps) {
  return (
    <header
      className={cn(
        BAR_SURFACE,
        "relative z-20 flex shrink-0 items-center gap-1 rounded-none border-x-0 border-t-0 px-2",
        "pt-[max(0.25rem,env(safe-area-inset-top,0px))] pb-1",
        "pl-[max(0.5rem,env(safe-area-inset-left,0px))] pr-[max(0.5rem,env(safe-area-inset-right,0px))]",
      )}
    >
      <IconButton label={edit.undo} inactive={!history.canUndo} onClick={history.onUndo} data-edit-undo="">
        <Undo2 aria-hidden="true" className="size-5" />
      </IconButton>
      <IconButton label={edit.redo} inactive={!history.canRedo} onClick={history.onRedo} data-edit-redo="">
        <Redo2 aria-hidden="true" className="size-5" />
      </IconButton>
      <h2
        className={cn(
          "min-w-0 flex-1 truncate px-2 text-center text-headline text-foreground",
          layout.width < 420 && "sr-only",
        )}
      >
        {title}
      </h2>
      {layout.width < 420 ? <span className="flex-1" /> : null}
      {properties.visible ? (
        <IconButton label={edit.inspectorOpen} onClick={properties.onClick} data-edit-properties-button="">
          <SlidersHorizontal aria-hidden="true" className="size-5" />
        </IconButton>
      ) : null}
      <IconButton
        label={edit.elementsButton}
        pressed={dock.open && dock.tab === "elements"}
        onClick={() => onOpenTab("elements")}
        data-edit-elements-button=""
      >
        <List aria-hidden="true" className="size-5" />
      </IconButton>
      <IconButton
        label={edit.helpButton}
        pressed={dock.open && dock.tab === "help"}
        onClick={() => onOpenTab("help")}
        data-edit-help-button=""
      >
        <CircleHelp aria-hidden="true" className="size-5" />
      </IconButton>
      <PillButton tone="primary" aria-label={edit.doneLabel} onClick={onDone} data-edit-done="" className="ml-1 px-4">
        <Check aria-hidden="true" className="size-4" />
        {edit.done}
      </PillButton>
    </header>
  );
}

/* ------------------------------------------------------------------ *
 * Herramientas: riel (izquierda) o barra (abajo)
 * ------------------------------------------------------------------ */

function ToolButtons({
  tools,
  tool,
  toolLabel,
  onTool,
  variant,
  ownerColor,
}: Pick<EditModeFrameProps, "tools" | "tool" | "toolLabel" | "onTool"> & {
  variant: "rail" | "bar";
  ownerColor: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const items = tools.filter((id) => id !== "editText");

  // Flechas, Inicio y Fin mueven el foco entre herramientas (patron APG de barra de herramientas).
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = variant === "rail" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    if (![...keys, "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>("button[data-tool-id]") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === keys[1] ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      ref={containerRef}
      onKeyDown={onKeyDown}
      className={cn(variant === "rail" ? "flex flex-col items-center gap-1" : "flex flex-1 items-stretch gap-1")}
    >
      {items.map((id) => {
        const Icon = TOOL_ICONS[id];
        const active = id === tool;
        const label = toolLabel(id);
        return (
          <button
            key={id}
            type="button"
            data-tool-id={id}
            aria-pressed={active}
            onClick={() => onTool(id)}
            className={cn(
              "relative flex flex-col items-center justify-center gap-0.5 rounded-ios-sm",
              variant === "rail" ? "h-14 w-[4.5rem] shrink-0" : "min-h-14 min-w-11 flex-1 px-0.5",
              active
                ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                : "text-muted-foreground hover:bg-white/8 hover:text-foreground",
              "transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.94] motion-reduce:active:scale-100",
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal forced-colors:border forced-colors:border-[ButtonText]",
            )}
          >
            <Icon aria-hidden="true" className="size-5" />
            <span className="max-w-full truncate text-[0.6875rem] leading-tight font-semibold">{label}</span>
            {ownerColor && (id === "signature" || id === "initials") ? (
              <span
                aria-hidden="true"
                className="absolute top-1 right-1.5 size-2 rounded-full ring-2 ring-background"
                /* Color del firmante activo: dato del documento, no un token del tema. */
                style={{ backgroundColor: ownerColor }}
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function SignerPicker({
  signers,
  activeSignerId,
  onActiveSigner,
  edit,
  vertical,
}: Pick<EditModeFrameProps, "signers" | "activeSignerId" | "onActiveSigner" | "edit"> & { vertical: boolean }) {
  if (signers.length < 2) return null;
  return (
    <div
      role="radiogroup"
      aria-label={edit.signerLabel}
      className={cn(vertical ? "flex flex-col items-center gap-1" : "flex items-center gap-1 overflow-x-auto px-1")}
    >
      {signers.map((signer, index) => {
        const active = signer.id === activeSignerId;
        return (
          <button
            key={signer.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={signer.name}
            title={signer.name}
            onClick={() => onActiveSigner(signer.id)}
            className={cn(
              "flex min-h-11 shrink-0 items-center gap-2 rounded-ios-sm text-footnote font-semibold",
              vertical ? "size-11 justify-center" : "px-3",
              active ? "bg-signal/20 shadow-[inset_0_0_0_1.5px_var(--color-signal)]" : "bg-white/6 hover:bg-white/12",
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
            )}
          >
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-bold text-white"
              /* Color del firmante: dato del documento, no un token del tema. */
              style={{ backgroundColor: signer.color }}
            >
              {index + 1}
            </span>
            {vertical ? null : <span className="max-w-28 truncate">{signer.name}</span>}
          </button>
        );
      })}
    </div>
  );
}

function ownerColorOf(props: Pick<EditModeFrameProps, "signers" | "activeSignerId">): string | null {
  if (props.signers.length < 2) return null;
  return props.signers.find((signer) => signer.id === props.activeSignerId)?.color ?? null;
}

function ToolRail(props: BarProps) {
  return (
    <nav
      aria-label={props.edit.toolsLabel}
      className={cn(
        BAR_SURFACE,
        "z-10 flex w-[5rem] shrink-0 flex-col items-center gap-2 overflow-y-auto overscroll-contain rounded-none border-y-0 border-l-0 py-2 [scrollbar-width:none]",
        "pl-[max(0.25rem,env(safe-area-inset-left,0px))] pr-1",
      )}
    >
      <div role="toolbar" aria-label={props.edit.toolsLabel} aria-orientation="vertical">
        <ToolButtons {...props} variant="rail" ownerColor={ownerColorOf(props)} />
      </div>
      <SignerPicker {...props} vertical />
    </nav>
  );
}

function BottomTools(props: BarProps) {
  return (
    <nav
      aria-label={props.edit.toolsLabel}
      className={cn(
        BAR_SURFACE,
        "z-10 shrink-0 rounded-none border-x-0 border-b-0 px-1 pt-1",
        "pb-[max(0.25rem,env(safe-area-inset-bottom,0px))]",
        "pl-[max(0.25rem,env(safe-area-inset-left,0px))] pr-[max(0.25rem,env(safe-area-inset-right,0px))]",
      )}
    >
      <SignerPicker {...props} vertical={false} />
      <div role="toolbar" aria-label={props.edit.toolsLabel} className="flex">
        <ToolButtons {...props} variant="bar" ownerColor={ownerColorOf(props)} />
      </div>
    </nav>
  );
}

/* ------------------------------------------------------------------ *
 * Paginas y zoom
 * ------------------------------------------------------------------ */

function PageBar({ strings, edit, pages, zoom, onOpenTab, dock, layout, lowest }: BarProps & { lowest: boolean }) {
  const compactLabel = layout.width < 440;
  const percent = Math.round(zoom.value * 100);
  const multiPage = pages.count > 1;
  return (
    <div
      role="group"
      aria-label={edit.pageBar}
      className={cn(
        BAR_SURFACE,
        "relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-x-2 rounded-none border-x-0 px-1",
        lowest
          ? "border-b-0 pb-[max(0.125rem,env(safe-area-inset-bottom,0px))]"
          : "border-b-0",
        "pl-[max(0.25rem,env(safe-area-inset-left,0px))] pr-[max(0.25rem,env(safe-area-inset-right,0px))]",
      )}
    >
      <div className="flex items-center">
        <IconButton
          label={strings.previousPage}
          inactive={pages.index <= 0}
          onClick={pages.onPrev}
          data-edit-prev-page=""
        >
          <ChevronLeft aria-hidden="true" className="size-5" />
        </IconButton>
        <button
          type="button"
          aria-label={edit.pagesToggle(pages.index + 1, Math.max(1, pages.count))}
          aria-expanded={dock.open && dock.tab === "pages"}
          disabled={!multiPage}
          onClick={() => onOpenTab("pages")}
          data-edit-pages-button=""
          className={cn(
            "inline-flex min-h-11 min-w-14 items-center justify-center gap-1 rounded-ios-sm px-2 text-footnote font-semibold text-foreground tabular-nums",
            "hover:bg-white/10 disabled:hover:bg-transparent",
            "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal active:scale-[0.97] motion-reduce:active:scale-100",
          )}
        >
          {compactLabel
            ? `${pages.index + 1} / ${Math.max(1, pages.count)}`
            : strings.pageOf(pages.index + 1, Math.max(1, pages.count))}
          {multiPage ? <ChevronUp aria-hidden="true" className="size-3.5 text-muted-foreground" /> : null}
        </button>
        <IconButton
          label={strings.nextPage}
          inactive={pages.index >= pages.count - 1}
          onClick={pages.onNext}
          data-edit-next-page=""
        >
          <ChevronRight aria-hidden="true" className="size-5" />
        </IconButton>
        {layout.rail && multiPage ? (
          <IconButton label={edit.nextWithFields} onClick={() => pages.onStepWithFields(1)}>
            <ChevronsRight aria-hidden="true" className="size-5" />
          </IconButton>
        ) : null}
      </div>

      <div role="group" aria-label={strings.zoomGroupLabel} className="flex items-center">
        <IconButton label={strings.zoomOut} inactive={!zoom.canOut} onClick={zoom.onOut} data-edit-zoom-out="">
          <ZoomOut aria-hidden="true" className="size-5" />
        </IconButton>
        <button
          type="button"
          aria-label={`${strings.resetZoomButton}: ${edit.zoomValue(percent)}`}
          title={strings.resetZoomButton}
          onClick={zoom.onFit}
          data-edit-zoom-fit=""
          className="inline-flex min-h-11 min-w-14 items-center justify-center rounded-ios-sm px-1.5 text-footnote font-semibold text-foreground tabular-nums hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal active:scale-[0.97] motion-reduce:active:scale-100"
        >
          {edit.zoomValue(percent)}
        </button>
        <IconButton label={strings.zoomIn} inactive={!zoom.canIn} onClick={zoom.onIn} data-edit-zoom-in="">
          <ZoomIn aria-hidden="true" className="size-5" />
        </IconButton>
        <IconButton
          label={edit.fitSwitchTo(zoom.fitMode === "height" ? "width" : "height")}
          onClick={zoom.onToggleFit}
          data-edit-fit-toggle=""
        >
          {zoom.fitMode === "height" ? (
            <MoveHorizontal aria-hidden="true" className="size-5" />
          ) : (
            <MoveVertical aria-hidden="true" className="size-5" />
          )}
        </IconButton>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Panel de edicion (inspector, elementos, paginas, ayuda)
 * ------------------------------------------------------------------ */

type Detent = "mini" | "peek" | "full";
const MINI_HEIGHT = 92;

function tabLabel(tab: DockTab, edit: EditModeStrings): string {
  return tab === "element"
    ? edit.tabElement
    : tab === "elements"
      ? edit.tabElements
      : tab === "pages"
        ? edit.tabPages
        : edit.tabHelp;
}

function Dock(
  props: BarProps & {
    dockRef: RefObject<HTMLElement | null>;
    cellRef: RefObject<HTMLDivElement | null>;
  },
) {
  const { edit, dock, layout, dockRef, cellRef } = props;
  const side = layout.dockSide === "right";
  const [detent, setDetent] = useState<Detent>("peek");
  const [cellHeight, setCellHeight] = useState(0);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    tracker: ReturnType<typeof createVelocityTracker>;
  } | null>(null);

  useLayoutEffect(() => {
    const cell = cellRef.current;
    if (!cell) return;
    const measure = () => setCellHeight(cell.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [cellRef]);

  const full = Math.max(MINI_HEIGHT + 80, Math.round(cellHeight * 0.88));
  const peek = Math.min(full - 60, Math.max(MINI_HEIGHT + 120, Math.min(380, Math.round(cellHeight * 0.44))));
  const heights: Record<Detent, number> = { mini: MINI_HEIGHT, peek, full };
  const currentHeight = dragHeight ?? heights[detent];

  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (side) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const tracker = createVelocityTracker();
    tracker.push(event.clientY, event.timeStamp);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: heights[detent], tracker };
    setDragHeight(heights[detent]);
  };
  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.tracker.push(event.clientY, event.timeStamp);
    const wanted = drag.startHeight + (drag.startY - event.clientY);
    // Mas alla de los topes la resistencia crece (rubber-band): nunca un tope duro.
    const over = wanted > full ? wanted - full : wanted < MINI_HEIGHT ? wanted - MINI_HEIGHT : 0;
    const resisted = over === 0 ? wanted : (wanted > full ? full : MINI_HEIGHT) + rubberband(over, 120);
    setDragHeight(resisted);
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // Hacia donde IBA el dedo (proyeccion del momentum), no donde lo soltaron.
    const velocityUp = -drag.tracker.velocity(event.timeStamp);
    const projected = (dragHeight ?? drag.startHeight) + project(velocityUp);
    const target = nearestSnapPoint(projected, [MINI_HEIGHT, peek, full]);
    setDetent(target === MINI_HEIGHT ? "mini" : target === full ? "full" : "peek");
    setDragHeight(null);
  };
  const cycleDetent = () => setDetent((current) => (current === "full" ? "peek" : "full"));

  return (
    <aside
      ref={dockRef}
      aria-label={edit.dockLabel}
      data-edit-dock=""
      data-detent={side ? undefined : detent}
      className={cn(
        // Fondo OPACO (como la barra de sugerencias): es un panel de trabajo con texto y deslizadores; lo que hay detras
        // (la hoja) no debe asomar bajo ellos.
        "absolute z-20 flex flex-col overflow-hidden border border-hairline bg-elevated shadow-elevation-3",
        side
          ? "inset-y-0 right-0 animate-[fade-in_200ms_ease-out] rounded-none border-y-0 border-r-0 pr-[env(safe-area-inset-right,0px)] motion-reduce:animate-none"
          : "inset-x-0 bottom-0 animate-sheet-in rounded-t-ios-lg border-b-0 motion-reduce:animate-none",
        !side && dragHeight === null && "transition-[height] duration-300 ease-[var(--ease-spring)] motion-reduce:transition-none",
      )}
      style={
        side
          ? { width: `min(${SIDE_DOCK_WIDTH}px, 45%)` }
          : { height: Math.min(currentHeight, Math.max(MINI_HEIGHT, cellHeight - 8)) }
      }
    >
      {side ? null : (
        <div
          data-edit-dock-handle=""
          aria-hidden="true"
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          onDoubleClick={cycleDetent}
          title={edit.dockHandle}
          className="flex h-5 shrink-0 cursor-grab touch-none items-center justify-center active:cursor-grabbing"
        >
          <span className="h-1 w-10 rounded-full bg-muted-foreground/50" />
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 px-2">
        <div
          role="tablist"
          aria-label={edit.dockLabel}
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {dock.tabs.map((tab) => {
            const selected = tab === dock.tab;
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                id={`edit-tab-${tab}`}
                aria-selected={selected}
                aria-controls="edit-dock-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => dock.onTab(tab)}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  const index = dock.tabs.indexOf(tab);
                  const next = dock.tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + dock.tabs.length) % dock.tabs.length];
                  dock.onTab(next);
                  window.requestAnimationFrame(() =>
                    document.getElementById(`edit-tab-${next}`)?.focus({ preventScroll: true }),
                  );
                }}
                className={cn(
                  "inline-flex min-h-11 shrink-0 items-center rounded-ios-sm px-1.5 text-footnote font-semibold whitespace-nowrap min-[600px]:px-2",
                  selected
                    ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                    : "text-muted-foreground hover:bg-white/8 hover:text-foreground",
                  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                )}
              >
                {tabLabel(tab, edit)}
              </button>
            );
          })}
        </div>
        {side ? null : (
          <IconButton
            label={detent === "full" ? edit.dockCollapse : edit.dockExpand}
            onClick={cycleDetent}
            data-edit-dock-toggle=""
          >
            {detent === "full" ? (
              <ChevronDown aria-hidden="true" className="size-5" />
            ) : (
              <ChevronUp aria-hidden="true" className="size-5" />
            )}
          </IconButton>
        )}
        <IconButton label={edit.dockClose} onClick={dock.onClose} data-edit-dock-close="">
          <X aria-hidden="true" className="size-5" />
        </IconButton>
      </div>

      <div
        id="edit-dock-panel"
        role="tabpanel"
        aria-labelledby={`edit-tab-${dock.tab}`}
        data-edit-scroll=""
        className="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))]"
      >
        {dock.body(layout)}
      </div>
    </aside>
  );
}
