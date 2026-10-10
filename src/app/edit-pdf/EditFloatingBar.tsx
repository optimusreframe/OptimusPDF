"use client";

import { useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CopyPlus,
  Ellipsis,
  Italic,
  Minus,
  Palette,
  Plus,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import {
  BAR_BUTTON_CLASS,
  BarButton,
  BarGroup,
  FloatingFieldBar,
} from "@/app/sign-pdf/FloatingFieldBar";
import type { RestylePatch } from "@/app/edit-pdf/editSession";
import type { EditInlineStrings } from "@/app/edit-pdf/strings";
import { INK_COLORS } from "@/lib/pdf/core";
import {
  CATALOG,
  CATALOG_FONT_KEYS,
  effectiveFontKey,
  isCatalogFontNative,
  mapSourceFont,
  pickFontForText,
} from "@/lib/pdf/editFonts";
import type { CatalogFontKey, SourceFontInfo, TextAlign } from "@/lib/pdf/editTypes";

/*
 * Barra flotante del texto seleccionado (W5-U4a), sobre `FloatingFieldBar`:
 * fuente del catalogo, tamano, color, negrita/cursiva, alineacion, duplicar y
 * borrar, mas los avisos que dependen del bloque (fuente parecida, fondo no
 * uniforme y «el texto original puede seguir existiendo»).
 */

export type BarTextState = {
  fontKey: CatalogFontKey;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: TextAlign;
  /** Color con el que se cubre el texto original, o `null` si no se cubre nada. */
  coverColor: string | null;
  /** Fuente del bloque original (solo bloques existentes). */
  sourceFont?: SourceFontInfo;
  /** Texto actual: se avisa de los caracteres que la fuente no puede dibujar. */
  text?: string;
  /** (W5-U5) El bloque original mezcla estilos: redibujarlo los unifica. */
  mixedStyle?: boolean;
  /** (W5-U5) El texto que se escribe invade a otro bloque (aviso en vivo). */
  overlap?: boolean;
  /** (W5-U5) El texto original esta girado y un vecino lo cruza: parte puede quedar visible. */
  coverCrossesNeighbor?: boolean;
};

/** Pantallas estrechas o con puntero grueso: barra COMPACTA (dos filas) y avisos en una hoja. */
export const COMPACT_BAR_QUERY = "(max-width: 767px), (pointer: coarse)";

export type EditFloatingBarProps = {
  stageRef: RefObject<HTMLElement | null>;
  clipRef: RefObject<HTMLElement | null>;
  hostRef: RefObject<HTMLElement | null>;
  /** Elemento seleccionado, o `null` (la barra sale). */
  selectionId: string | null;
  layoutKey: string;
  state: BarTextState | null;
  /** El texto reemplaza a un bloque del PDF (se muestran los avisos del original). */
  replacesBlock: boolean;
  /** La pagina esta aplanada: el original ya no queda bajo la edicion (igual que la lista de descarga). */
  originalRemoved?: boolean;
  /** El fondo del bloque no es de un solo color: se ofrece elegir el de la cobertura. */
  backgroundNotUniform: boolean;
  strings: EditInlineStrings;
  /** Hay variante negrita/cursiva de la fuente? Por defecto, segun el catalogo. */
  variantAvailable?: (key: CatalogFontKey, bold: boolean, italic: boolean) => boolean;
  onRestyle: (patch: RestylePatch) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onEscape: () => void;
  onTabBackward: () => void;
  onTabForward: () => boolean;
  /** «Aplanar pagina»: la accion real la cablea la integracion (U5). */
  onFlattenRequested?: () => void;
};

/** Todas las fuentes del catalogo tienen los 4 estilos (regular, negrita, cursiva, ambas). */
export function fontVariantAvailable(key: CatalogFontKey): boolean {
  const entry = CATALOG[effectiveFontKey(key)];
  return entry.standard !== null || entry.files !== null;
}

const MIN_SIZE = 1;
const MAX_SIZE = 400;

export function formatSize(size: number): string {
  return String(Math.round(size * 10) / 10);
}

function clampSize(size: number): number {
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));
}

/** Fuente que se dibujara y si es una sustituta aproximada de la original. */
export function fontNotice(state: BarTextState): { label: string; similar: boolean } {
  const used = effectiveFontKey(state.fontKey);
  const mapped = state.sourceFont ? mapSourceFont(state.sourceFont) : null;
  // Mismo criterio que el exportador: aproximada y todavia la elegida por el mapeo.
  const similar = mapped !== null && !mapped.exact && mapped.key === state.fontKey;
  return { label: CATALOG[used].label, similar };
}

/**
 * Aviso de glifos que la fuente elegida no dibuja (el exportador usara otra
 * fuente del catalogo o un «?»): lo que se ve al teclear no siempre es lo que
 * saldra, y nunca debe cambiar en silencio.
 */
export function glyphNotice(state: BarTextState, strings: EditInlineStrings): string {
  if (!state.text) return "";
  const pick = pickFontForText(state.fontKey, state.text);
  const used = effectiveFontKey(state.fontKey);
  const parts: string[] = [];
  if (pick.changed && pick.key !== used) {
    parts.push(strings.glyphFallback(CATALOG[used].label, CATALOG[pick.key].label));
  }
  if (pick.unsupported.length > 0) {
    parts.push(strings.glyphUnsupported(pick.unsupported.slice(0, 12).join(" ")));
  }
  return parts.join(" ");
}

const ROW = "basis-full";

export function ColorRow({
  label,
  value,
  strings,
  onPick,
  id,
  colors = INK_COLORS,
}: {
  label: string;
  value: string;
  strings: EditInlineStrings;
  onPick: (hex: string) => void;
  id: string;
  /** Colores ofrecidos (por defecto, las tintas del documento). */
  colors?: readonly string[];
}) {
  return (
    <BarGroup label={label} className={cn(ROW, "flex-wrap justify-center")}>
      {colors.map((hex) => (
        <button
          key={hex}
          type="button"
          aria-label={strings.colorOption(strings.colorNames[hex] ?? hex)}
          title={strings.colorNames[hex] ?? hex}
          aria-pressed={value.toLowerCase() === hex}
          data-color-swatch={hex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(hex)}
          className={cn(
            BAR_BUTTON_CLASS,
            value.toLowerCase() === hex && "shadow-[inset_0_0_0_2px_var(--color-signal)]",
          )}
        >
          <span
            className="size-5 rounded-full border border-black/30 shadow-[0_0_0_1px_rgb(255_255_255/0.4)] forced-color-adjust-none forced-colors:border-[CanvasText]"
            // Color del documento elegido por quien edita: dato, no un token del tema.
            style={{ backgroundColor: hex }}
          />
        </button>
      ))}
      <label
        className={cn(BAR_BUTTON_CLASS, "cursor-pointer text-muted-foreground hover:text-foreground")}
        title={strings.colorCustom}
      >
        <span className="sr-only">{`${label}: ${strings.colorCustom}`}</span>
        <Palette aria-hidden="true" className="size-4" />
        <input
          id={id}
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#000000"}
          onChange={(event) => onPick(event.target.value.toLowerCase())}
          className="sr-only"
        />
      </label>
    </BarGroup>
  );
}

export function EditFloatingBar({
  stageRef,
  clipRef,
  hostRef,
  selectionId,
  layoutKey,
  state,
  replacesBlock,
  originalRemoved = false,
  backgroundNotUniform,
  strings,
  variantAvailable,
  onRestyle,
  onDuplicate,
  onDelete,
  onEscape,
  onTabBackward,
  onTabForward,
  onFlattenRequested,
}: EditFloatingBarProps) {
  // El selector de color se abre para UN elemento: al cambiar de seleccion se cierra solo.
  const [colorOpenFor, setColorOpenFor] = useState<string | null>(null);
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const [moreOpenFor, setMoreOpenFor] = useState<string | null>(null);
  const compact = useMediaQuery(COMPACT_BAR_QUERY);
  const moreOpen = moreOpenFor !== null && moreOpenFor === selectionId;
  /** Duplicar/aplanar desde «Más» ya mueven el foco: la hoja no debe devolverlo al disparador al irse. */
  const skipFocusRestore = useRef(false);
  const idBase = selectionId ?? "none";
  const colorOpen = colorOpenFor !== null && colorOpenFor === selectionId;

  /** Todos los avisos de este texto, en una lista (la barra compacta los lleva a una hoja). */
  const noticesOf = (): { id: string; text: string }[] => {
    if (!state) return [];
    const notice = fontNotice(state);
    const glyphText = glyphNotice(state, strings);
    const items: { id: string; text: string }[] = [];
    if (notice.similar) items.push({ id: "font", text: strings.fontSubstituted(notice.label) });
    if (glyphText) items.push({ id: "glyph", text: glyphText });
    if (replacesBlock && backgroundNotUniform && state.coverColor) {
      items.push({ id: "background", text: strings.backgroundNotUniform });
    }
    if (replacesBlock && state.mixedStyle) items.push({ id: "mixed", text: strings.mixedStyleNotice });
    if (state.overlap) items.push({ id: "overlap", text: strings.overlapNotice });
    if (state.coverCrossesNeighbor) items.push({ id: "cover", text: strings.coverCrossesNotice });
    if (replacesBlock && !originalRemoved) items.push({ id: "original", text: strings.originalRemains });
    return items;
  };

  /** Hoja «Más opciones» de la barra compacta: lo que no cabe en las dos filas, mas todos los avisos. */
  const moreSheet = () => {
    if (!state) return null;
    const items = noticesOf();
    const close = () => setMoreOpenFor(null);
    return (
      <Sheet
        open={moreOpen}
        onClose={close}
        title={strings.moreTitle}
        closeLabel={strings.moreClose}
        restoreFocusOnClose={() => !skipFocusRestore.current}
      >
        <div data-bar-more="" className="space-y-4 pb-2">
          <div className="grid gap-2">
            <Button
              variant="secondary"
              size="md"
              fullWidth
              data-more-action="duplicate"
              onClick={() => {
                skipFocusRestore.current = true;
                close();
                onDuplicate();
              }}
            >
              <CopyPlus aria-hidden="true" className="size-4" />
              {strings.duplicate}
            </Button>
            <div role="group" aria-label={strings.alignLabel} className="grid grid-cols-3 gap-2">
              {(
                [
                  ["left", strings.alignLeft, AlignLeft],
                  ["center", strings.alignCenter, AlignCenter],
                  ["right", strings.alignRight, AlignRight],
                ] as const
              ).map(([value, label, Icon]) => (
                <Button
                  key={value}
                  variant={state.align === value ? "primary" : "secondary"}
                  size="md"
                  aria-label={label}
                  aria-pressed={state.align === value}
                  data-more-action={`align-${value}`}
                  onClick={() => onRestyle({ align: value })}
                >
                  <Icon aria-hidden="true" className="size-4" />
                </Button>
              ))}
            </div>
          </div>
          {replacesBlock && backgroundNotUniform && state.coverColor ? (
            <ColorRow
              id={`edit-more-cover-${idBase}`}
              label={strings.coverColorLabel}
              value={state.coverColor}
              strings={strings}
              onPick={(hex) => onRestyle({ cover: { color: hex, padding: 1 } })}
            />
          ) : null}
          {replacesBlock && onFlattenRequested ? (
            <Button
              variant="secondary"
              size="md"
              fullWidth
              data-more-action="flatten"
              onClick={() => {
                skipFocusRestore.current = true;
                close();
                onFlattenRequested();
              }}
            >
              {strings.flatten}
            </Button>
          ) : null}
          {items.length > 0 ? (
            <section aria-labelledby={`edit-more-notices-${idBase}`}>
              <h3 id={`edit-more-notices-${idBase}`} className="ui-label mb-2 text-muted-foreground">
                {strings.noticesTitle}
              </h3>
              <ul className="space-y-2 text-footnote text-foreground">
                {items.map((item) => (
                  <li key={item.id} data-more-notice={item.id}>
                    {item.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </Sheet>
    );
  };

  const content = (): ReactNode => {
    if (!state) return null;
    const canBold = (variantAvailable ?? fontVariantAvailable)(state.fontKey, true, state.italic);
    const canItalic = (variantAvailable ?? fontVariantAvailable)(state.fontKey, state.bold, true);
    const fontValue = effectiveFontKey(state.fontKey);

    const commitSize = () => {
      if (sizeDraft === null) return;
      const parsed = Number.parseFloat(sizeDraft.replace(",", "."));
      setSizeDraft(null);
      if (Number.isFinite(parsed) && parsed > 0) onRestyle({ fontSize: clampSize(parsed) });
    };

    const fontKeys = CATALOG_FONT_KEYS.filter(
      (key) => isCatalogFontNative(key) || key === fontValue,
    );

    const noticeItems = noticesOf();

    // (W5-U5 · D2) UN solo diseno compacto en movil Y en escritorio: fuente, tamano, color, B/I, alinear, borrar y «Más»
    // (con el contador de avisos). Movil: dos filas (cabe en 360 px); escritorio: UNA fila de ~520 px. Los avisos no van
    // dentro de la barra: los lleva la hoja «Más opciones» (la region viva unica los anuncia).
    const alignOrder = ["left", "center", "right"] as const;
    const nextAlign = alignOrder[(alignOrder.indexOf(state.align) + 1) % 3];
    const AlignIcon = state.align === "center" ? AlignCenter : state.align === "right" ? AlignRight : AlignLeft;
    const fontGroup = (
      <BarGroup label={strings.fontLabel} className={compact ? "min-w-0 flex-1" : undefined}>
        <select
          aria-label={strings.fontLabel}
          data-bar-action="font"
          value={fontValue}
          onChange={(event) => onRestyle({ fontKey: event.target.value as CatalogFontKey })}
          className={cn(
            "rounded-ios-sm bg-transparent px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] outline-signal",
            compact ? "h-11 w-full min-w-0" : "h-9 w-36 pointer-coarse:h-11",
          )}
        >
          {fontKeys.map((key) => (
            <option key={key} value={key} className="bg-elevated text-foreground">
              {CATALOG[key].label}
            </option>
          ))}
        </select>
      </BarGroup>
    );
    const sizeGroup = (
      <BarGroup label={strings.sizeLabel}>
        <BarButton
          label={strings.sizeDecrease}
          dataAction="size-down"
          onClick={() => onRestyle({ fontSize: clampSize(state.fontSize - 1) })}
        >
          <Minus aria-hidden="true" className="size-4" />
        </BarButton>
        <input
          type="text"
          inputMode="decimal"
          aria-label={strings.sizeLabel}
          data-bar-action="size"
          value={sizeDraft ?? formatSize(state.fontSize)}
          onChange={(event) => setSizeDraft(event.target.value)}
          onBlur={commitSize}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitSize();
            } else if (event.key === "Escape") {
              setSizeDraft(null);
            }
          }}
          className={cn(
            "rounded-ios-sm bg-transparent text-center text-sm text-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-offset-[-2px] outline-signal",
            compact ? "h-11 w-11" : "h-9 w-11 pointer-coarse:h-11",
          )}
        />
        <BarButton
          label={strings.sizeIncrease}
          dataAction="size-up"
          onClick={() => onRestyle({ fontSize: clampSize(state.fontSize + 1) })}
        >
          <Plus aria-hidden="true" className="size-4" />
        </BarButton>
      </BarGroup>
    );
    const actionButtons = (
      <>
        <BarButton
          label={strings.colorOpen}
          dataAction="color"
          ariaExpanded={colorOpen}
          onClick={() => setColorOpenFor(colorOpen ? null : selectionId)}
        >
          <span
            className="size-5 rounded-full border border-black/30 shadow-[0_0_0_1px_rgb(255_255_255/0.4)] forced-color-adjust-none forced-colors:border-[CanvasText]"
            style={{ backgroundColor: state.color }}
          />
        </BarButton>
        <BarButton
          label={canBold ? strings.bold : strings.variantUnavailable(strings.bold.toLowerCase())}
          dataAction="bold"
          pressed={state.bold}
          disabled={!canBold && !state.bold}
          onClick={() => onRestyle({ bold: !state.bold })}
        >
          <Bold aria-hidden="true" className="size-4" />
        </BarButton>
        <BarButton
          label={canItalic ? strings.italic : strings.variantUnavailable(strings.italic.toLowerCase())}
          dataAction="italic"
          pressed={state.italic}
          disabled={!canItalic && !state.italic}
          onClick={() => onRestyle({ italic: !state.italic })}
        >
          <Italic aria-hidden="true" className="size-4" />
        </BarButton>
        <BarButton
          label={strings.alignCycle(strings.alignNames[state.align])}
          dataAction="align"
          onClick={() => onRestyle({ align: nextAlign })}
        >
          <AlignIcon aria-hidden="true" className="size-4" />
        </BarButton>
        <BarButton label={strings.remove} dataAction="delete" destructive onClick={onDelete}>
          <Trash2 aria-hidden="true" className="size-4" />
        </BarButton>
        <button
          type="button"
          aria-label={strings.moreOptions(noticeItems.length)}
          title={strings.moreOptions(noticeItems.length)}
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          data-bar-action="more"
          data-notice-count={noticeItems.length}
          onClick={() => {
            skipFocusRestore.current = false;
            setMoreOpenFor(selectionId);
          }}
          className={cn(BAR_BUTTON_CLASS, "relative text-muted-foreground hover:bg-white/10 hover:text-foreground")}
        >
          <Ellipsis aria-hidden="true" className="size-4" />
          {noticeItems.length > 0 ? (
            <span
              aria-hidden="true"
              data-more-badge=""
              className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-signal px-1 text-caption-2 leading-4 font-semibold text-[var(--color-on-signal)] ring-1 ring-background forced-color-adjust-none forced-colors:border forced-colors:border-[HighlightText] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText] forced-colors:ring-0"
            >
              {noticeItems.length}
            </span>
          ) : null}
        </button>
      </>
    );
    return (
      <div
        data-bar-compact=""
        data-bar-layout={compact ? "stacked" : "row"}
        className={cn("flex flex-col gap-1", compact ? "w-[min(20.5rem,calc(100vw-3rem))]" : "w-max max-w-full")}
        onMouseDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) event.preventDefault();
        }}
      >
        {compact ? (
          <>
            <div className="flex items-center gap-1">
              {fontGroup}
              {sizeGroup}
            </div>
            <div className="flex items-center justify-between gap-1">{actionButtons}</div>
          </>
        ) : (
          <div className="flex items-center gap-1">
            {fontGroup}
            {sizeGroup}
            {actionButtons}
          </div>
        )}

        {colorOpen ? (
          <ColorRow
            id={`edit-bar-color-${idBase}`}
            label={strings.colorLabel}
            value={state.color}
            strings={strings}
            onPick={(hex) => onRestyle({ color: hex })}
          />
        ) : null}
      </div>
    );
  };

  return (
    <>
    <FloatingFieldBar
      stageRef={stageRef}
      clipRef={clipRef}
      hostRef={hostRef}
      selection={selectionId !== null && state ? { kind: "text", id: selectionId } : null}
      layoutKey={layoutKey}
      label={strings.barLabel}
      description={strings.barShortcuts}
      aboveSticky
      onEscape={onEscape}
      onTabBackward={onTabBackward}
      onTabForward={onTabForward}
      onFocusLeave={() => setColorOpenFor(null)}
    >
      {content()}
    </FloatingFieldBar>
    {state ? moreSheet() : null}
    </>
  );
}
