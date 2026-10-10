"use client";

import { useState, type ReactNode, type RefObject } from "react";
import { CopyPlus, Minus, PaintBucket, Plus, Trash2, Check, X } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  BAR_BUTTON_CLASS,
  BarButton,
  BarGroup,
  FloatingFieldBar,
} from "@/app/sign-pdf/FloatingFieldBar";
import { ColorRow } from "@/app/edit-pdf/EditFloatingBar";
import type { EditImageItem, EditShapeItem, RestylePatch } from "@/app/edit-pdf/editSession";
import type { EditInlineStrings } from "@/app/edit-pdf/strings";
import {
  FILL_OPACITIES,
  HIGHLIGHT_COLORS,
  MAX_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  type CheckMark,
} from "@/lib/pdf/editPdf";

/*
 * Barra flotante del elemento seleccionado (imagen, rectangulo, elipse, linea,
 * resaltado o marca; W5-U4b), sobre `FloatingFieldBar` como la del texto. Las
 * opciones son las del editor anterior: color y grosor del trazo, relleno (con
 * su color y su opacidad), color e intensidad del resaltado y simbolo de la
 * marca; ademas, duplicar y borrar. Una imagen solo se duplica o se borra (el
 * motor no tiene estilo para ella).
 */

export type ElementBarState =
  | {
      type: "rect" | "ellipse";
      strokeColor: string;
      strokeWidth: number;
      fill: boolean;
      fillColor: string;
      fillOpacity: number;
    }
  | { type: "line"; strokeColor: string; strokeWidth: number }
  | { type: "highlight"; color: string; opacity: number }
  | { type: "check"; mark: CheckMark; strokeColor: string; strokeWidth: number }
  | { type: "image" };

/** Lo que muestra la barra para un elemento (los campos de estilo que entiende su tipo). */
export function barStateOf(item: EditShapeItem | EditImageItem): ElementBarState {
  if (item.kind === "image") return { type: "image" };
  const el = item.element;
  switch (el.type) {
    case "rect":
    case "ellipse":
      return {
        type: el.type,
        strokeColor: el.strokeColor,
        strokeWidth: el.strokeWidth,
        fill: el.fill,
        fillColor: el.fillColor,
        fillOpacity: el.fillOpacity,
      };
    case "line":
      return { type: "line", strokeColor: el.strokeColor, strokeWidth: el.strokeWidth };
    case "highlight":
      return { type: "highlight", color: el.color, opacity: el.opacity };
    case "check":
      return { type: "check", mark: el.mark, strokeColor: el.strokeColor, strokeWidth: el.strokeWidth };
  }
}

export type ElementFloatingBarProps = {
  stageRef: RefObject<HTMLElement | null>;
  clipRef: RefObject<HTMLElement | null>;
  hostRef: RefObject<HTMLElement | null>;
  /** Elemento seleccionado, o `null` (la barra sale). */
  selectionId: string | null;
  layoutKey: string;
  state: ElementBarState | null;
  strings: EditInlineStrings;
  onRestyle: (patch: RestylePatch) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEscape: () => void;
  onTabBackward: () => void;
  onTabForward: () => boolean;
};

const ROW = "basis-full";
const WIDTH_STEP = 0.5;

export function formatWidth(width: number): string {
  return String(Math.round(width * 10) / 10);
}

type Picker = "stroke" | "fill" | "highlight";

export function ElementFloatingBar({
  stageRef,
  clipRef,
  hostRef,
  selectionId,
  layoutKey,
  state,
  strings,
  onRestyle,
  onDuplicate,
  onDelete,
  onEscape,
  onTabBackward,
  onTabForward,
}: ElementFloatingBarProps) {
  // El selector de color se abre para UN elemento: al cambiar de seleccion se cierra solo.
  const [open, setOpen] = useState<{ id: string; which: Picker } | null>(null);
  const [widthDraft, setWidthDraft] = useState<string | null>(null);
  const idBase = selectionId ?? "none";
  const picker = open && open.id === selectionId ? open.which : null;
  const toggle = (which: Picker) =>
    setOpen(picker === which || selectionId === null ? null : { id: selectionId, which });

  const swatch = (color: string) => (
    <span
      className="size-5 rounded-full border border-black/30 shadow-[0_0_0_1px_rgb(255_255_255/0.4)] forced-color-adjust-none forced-colors:border-[CanvasText]"
      // Color del documento elegido por quien edita: dato, no un token del tema.
      style={{ backgroundColor: color }}
    />
  );

  const opacityGroup = (
    label: string,
    value: number,
    key: "fillOpacity" | "opacity",
    action: string,
  ) => (
    <BarGroup label={label} className={cn(ROW, "flex-wrap justify-center")}>
      {FILL_OPACITIES.map((opacity) => (
        <button
          key={opacity}
          type="button"
          aria-label={strings.opacityOption(Math.round(opacity * 100))}
          title={strings.opacityOption(Math.round(opacity * 100))}
          aria-pressed={Math.abs(value - opacity) < 0.001}
          data-bar-action={`${action}-${Math.round(opacity * 100)}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onRestyle(key === "fillOpacity" ? { fillOpacity: opacity } : { opacity })}
          className={cn(
            BAR_BUTTON_CLASS,
            "w-auto min-w-9 px-2 text-xs font-medium tabular-nums pointer-coarse:min-w-11",
            Math.abs(value - opacity) < 0.001
              ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)]"
              : "text-muted-foreground hover:bg-white/10 hover:text-foreground",
          )}
        >
          {Math.round(opacity * 100)} %
        </button>
      ))}
    </BarGroup>
  );

  const content = (): ReactNode => {
    if (!state) return null;

    const widthControls = (
      current: number,
      min: number,
    ): ReactNode => {
      const commit = () => {
        if (widthDraft === null) return;
        const parsed = Number.parseFloat(widthDraft.replace(",", "."));
        setWidthDraft(null);
        if (Number.isFinite(parsed)) {
          onRestyle({ strokeWidth: Math.min(MAX_STROKE_WIDTH, Math.max(min, parsed)) });
        }
      };
      return (
        <BarGroup label={strings.strokeWidthLabel}>
          <BarButton
            label={strings.widthDecrease}
            dataAction="width-down"
            onClick={() => onRestyle({ strokeWidth: Math.max(min, current - WIDTH_STEP) })}
          >
            <Minus aria-hidden="true" className="size-4" />
          </BarButton>
          <input
            type="text"
            inputMode="decimal"
            aria-label={strings.strokeWidthLabel}
            data-bar-action="width"
            value={widthDraft ?? formatWidth(current)}
            onChange={(event) => setWidthDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                setWidthDraft(null);
              }
            }}
            className={cn(
              "h-9 w-11 rounded-ios-sm bg-transparent text-center text-sm text-foreground tabular-nums pointer-coarse:h-11",
              "focus-visible:outline-2 focus-visible:outline-offset-[-2px] outline-signal",
            )}
          />
          <BarButton
            label={strings.widthIncrease}
            dataAction="width-up"
            onClick={() => onRestyle({ strokeWidth: Math.min(MAX_STROKE_WIDTH, current + WIDTH_STEP) })}
          >
            <Plus aria-hidden="true" className="size-4" />
          </BarButton>
        </BarGroup>
      );
    };

    const strokeColorButton = (color: string) => (
      <BarGroup label={strings.strokeColorLabel}>
        <BarButton
          label={strings.strokeColorOpen}
          dataAction="stroke-color"
          ariaExpanded={picker === "stroke"}
          onClick={() => toggle("stroke")}
        >
          {swatch(color)}
        </BarButton>
      </BarGroup>
    );

    const actions = (
      <BarGroup>
        <BarButton label={strings.duplicate} dataAction="duplicate" onClick={onDuplicate}>
          <CopyPlus aria-hidden="true" className="size-4" />
        </BarButton>
        <BarButton label={strings.remove} dataAction="delete" destructive onClick={onDelete}>
          <Trash2 aria-hidden="true" className="size-4" />
        </BarButton>
      </BarGroup>
    );

    let controls: ReactNode = null;
    let extra: ReactNode = null;

    if (state.type === "rect" || state.type === "ellipse") {
      controls = (
        <>
          {strokeColorButton(state.strokeColor)}
          {widthControls(state.strokeWidth, 0)}
          <BarGroup label={strings.fillLabel}>
            <BarButton
              label={strings.fillLabel}
              dataAction="fill"
              pressed={state.fill}
              onClick={() => onRestyle({ fill: !state.fill })}
            >
              <PaintBucket aria-hidden="true" className="size-4" />
            </BarButton>
            {state.fill ? (
              <BarButton
                label={strings.fillColorOpen}
                dataAction="fill-color"
                ariaExpanded={picker === "fill"}
                onClick={() => toggle("fill")}
              >
                {swatch(state.fillColor)}
              </BarButton>
            ) : null}
          </BarGroup>
        </>
      );
      extra = (
        <>
          {picker === "stroke" ? (
            <ColorRow
              id={`edit-el-stroke-${idBase}`}
              label={strings.strokeColorLabel}
              value={state.strokeColor}
              strings={strings}
              onPick={(hex) => onRestyle({ strokeColor: hex })}
            />
          ) : null}
          {state.fill && picker === "fill" ? (
            <ColorRow
              id={`edit-el-fill-${idBase}`}
              label={strings.fillColorLabel}
              value={state.fillColor}
              strings={strings}
              onPick={(hex) => onRestyle({ fillColor: hex })}
            />
          ) : null}
          {state.fill ? opacityGroup(strings.fillOpacityLabel, state.fillOpacity, "fillOpacity", "fill-opacity") : null}
        </>
      );
    } else if (state.type === "line") {
      controls = (
        <>
          {strokeColorButton(state.strokeColor)}
          {widthControls(state.strokeWidth, MIN_STROKE_WIDTH)}
        </>
      );
      extra =
        picker === "stroke" ? (
          <ColorRow
            id={`edit-el-stroke-${idBase}`}
            label={strings.strokeColorLabel}
            value={state.strokeColor}
            strings={strings}
            onPick={(hex) => onRestyle({ strokeColor: hex })}
          />
        ) : null;
    } else if (state.type === "check") {
      controls = (
        <>
          <BarGroup label={strings.markLabel}>
            <BarButton
              label={strings.markCheck}
              dataAction="mark-check"
              pressed={state.mark === "check"}
              onClick={() => onRestyle({ mark: "check" })}
            >
              <Check aria-hidden="true" className="size-4" />
            </BarButton>
            <BarButton
              label={strings.markCross}
              dataAction="mark-cross"
              pressed={state.mark === "cross"}
              onClick={() => onRestyle({ mark: "cross" })}
            >
              <X aria-hidden="true" className="size-4" />
            </BarButton>
          </BarGroup>
          {strokeColorButton(state.strokeColor)}
          {widthControls(state.strokeWidth, MIN_STROKE_WIDTH)}
        </>
      );
      extra =
        picker === "stroke" ? (
          <ColorRow
            id={`edit-el-stroke-${idBase}`}
            label={strings.strokeColorLabel}
            value={state.strokeColor}
            strings={strings}
            onPick={(hex) => onRestyle({ strokeColor: hex })}
          />
        ) : null;
    } else if (state.type === "highlight") {
      controls = (
        <BarGroup label={strings.highlightColorLabel}>
          <BarButton
            label={strings.highlightColorOpen}
            dataAction="highlight-color"
            ariaExpanded={picker === "highlight"}
            onClick={() => toggle("highlight")}
          >
            {swatch(state.color)}
          </BarButton>
        </BarGroup>
      );
      extra = (
        <>
          {picker === "highlight" ? (
            <ColorRow
              id={`edit-el-highlight-${idBase}`}
              label={strings.highlightColorLabel}
              value={state.color}
              colors={HIGHLIGHT_COLORS}
              strings={strings}
              onPick={(hex) => onRestyle({ color: hex })}
            />
          ) : null}
          {opacityGroup(strings.highlightOpacityLabel, state.opacity, "opacity", "highlight-opacity")}
        </>
      );
    }

    return (
      // `contents`: los hijos siguen siendo elementos de la barra; el clic en un boton no roba el foco.
      <div
        className="contents"
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) event.preventDefault();
        }}
      >
        {controls}
        {actions}
        {extra}
      </div>
    );
  };

  return (
    <FloatingFieldBar
      stageRef={stageRef}
      clipRef={clipRef}
      hostRef={hostRef}
      selection={selectionId !== null && state ? { kind: state.type === "image" ? "image" : "shape", id: selectionId } : null}
      layoutKey={layoutKey}
      label={strings.elementBarLabel}
      description={strings.barShortcuts}
      aboveSticky
      onEscape={onEscape}
      onTabBackward={onTabBackward}
      onTabForward={onTabForward}
      onFocusLeave={() => setOpen(null)}
    >
      {content()}
    </FloatingFieldBar>
  );
}
