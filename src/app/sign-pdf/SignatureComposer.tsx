"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Eraser, ImageUp } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { Slider } from "@/components/ui/Slider";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import type { SignStrings } from "@/app/sign-pdf/strings";

/**
 * Compositor de firma: dibujar, escribir o subir una imagen. Sea cual
 * sea el modo, la salida siempre es el mismo contrato — un PNG en data
 * URL generado en el canvas del navegador.
 */

export type SignatureDraft = {
  dataUrl: string;
  /** alto / ancho del PNG resultante. */
  ratio: number;
};

export type SignatureComposerProps = {
  open: boolean;
  onClose: () => void;
  onSave: (draft: SignatureDraft) => void;
  strings: SignStrings;
};

type ComposerMode = "draw" | "type" | "upload";

/** Tintas admitidas para una firma: siempre oscuras y legibles. */
const SIGNATURE_INKS = ["#0b0b0c", "#12327d", "#3d3d42"] as const;

/**
 * Familias tipográficas para la firma escrita.
 *
 * La primera es Caveat, una fuente real servida con el propio sitio a
 * través de la variable CSS `--font-caveat`: se ve igual en cualquier
 * equipo. Las demás son pilas del sistema con respaldo genérico
 * `cursive`/`serif`, así que si el equipo no tiene la primera cae en la
 * siguiente sin romper nada.
 */
const SIGNATURE_FONTS = [
  "var(--font-caveat), cursive",
  '"Segoe Script", "Bradley Hand", "Snell Roundhand", "Apple Chancery", cursive',
  'italic "Brush Script MT", "Lucida Handwriting", "Zapfino", cursive',
  'italic "Times New Roman", Georgia, serif',
  '500 system-ui, "Segoe UI", sans-serif',
] as const;

/**
 * Nombre visible de la opción de Caveat. Es el nombre propio de la
 * fuente, así que no se traduce ni necesita entrada en `strings.ts`
 * (cuyo `styleNames` sigue describiendo las cuatro pilas del sistema,
 * en su mismo orden, a partir del índice 1).
 */
const CAVEAT_STYLE_NAME = "Caveat";

const DRAW_WIDTH = 640;
const DRAW_HEIGHT = 220;
const EXPORT_SCALE = 3;
const TYPE_FONT_SIZE = 96;

/**
 * El contexto 2D del canvas no entiende `var(...)`: si se le pasa sin
 * resolver, descarta la cadena entera y dibuja con la fuente por
 * defecto. Se sustituye por el valor real leído de la raíz del
 * documento, y si la variable no estuviera definida se elimina el hueco
 * para que quede el respaldo genérico (`cursive`) en vez de una familia
 * inválida.
 */
function resolveFontFamily(family: string): string {
  if (!family.includes("var(")) return family;
  const root = getComputedStyle(document.documentElement);
  return family
    .replace(/var\((--[\w-]+)\)/g, (_match, name: string) =>
      root.getPropertyValue(name).trim(),
    )
    .replace(/^\s*,\s*/, "")
    .replace(/,\s*,/g, ",")
    .trim();
}

function trimTransparent(source: HTMLCanvasElement): HTMLCanvasElement {
  const context = source.getContext("2d");
  if (!context) return source;
  const { width, height } = source;
  if (width === 0 || height === 0) return source;

  const data = context.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return source;

  const pad = Math.round(Math.min(width, height) * 0.02);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);

  const output = document.createElement("canvas");
  output.width = right - left + 1;
  output.height = bottom - top + 1;
  const target = output.getContext("2d");
  if (!target) return source;
  target.drawImage(
    source,
    left,
    top,
    output.width,
    output.height,
    0,
    0,
    output.width,
    output.height,
  );
  return output;
}

function toDraft(canvas: HTMLCanvasElement): SignatureDraft | null {
  if (canvas.width === 0 || canvas.height === 0) return null;
  return {
    dataUrl: canvas.toDataURL("image/png"),
    ratio: canvas.height / canvas.width,
  };
}

export function SignatureComposer({
  open,
  onClose,
  onSave,
  strings,
}: SignatureComposerProps) {
  const t = useT();
  const [mode, setMode] = useState<ComposerMode>("draw");
  const [ink, setInk] = useState<string>(SIGNATURE_INKS[0]);
  const [stroke, setStroke] = useState(4);
  const [typed, setTyped] = useState("");
  const [fontIndex, setFontIndex] = useState(0);
  const [uploaded, setUploaded] = useState<HTMLCanvasElement | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [warning, setWarning] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const resetCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }, []);

  useEffect(() => {
    if (!open || mode !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = DRAW_WIDTH * 2;
    canvas.height = DRAW_HEIGHT * 2;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  }, [open, mode]);

  const pointFromEvent = (
    event: ReactPointerEvent<HTMLCanvasElement>,
  ): { x: number; y: number } => {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - bounds.left) / (bounds.width || 1)) * canvas.width,
      y: ((event.clientY - bounds.top) / (bounds.height || 1)) * canvas.height,
    };
  };

  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    lastPointRef.current = pointFromEvent(event);
  };

  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const previous = lastPointRef.current;
    if (!previous) return;
    event.preventDefault();
    const canvas = event.currentTarget;
    const context = canvas.getContext("2d");
    if (!context) return;

    const point = pointFromEvent(event);
    context.strokeStyle = ink;
    context.lineWidth = stroke * 2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    // Curva suave: el punto medio actúa como final del segmento y el
    // punto anterior como control, así no se ven esquinas.
    context.quadraticCurveTo(
      previous.x,
      previous.y,
      (previous.x + point.x) / 2,
      (previous.y + point.y) / 2,
    );
    context.stroke();

    lastPointRef.current = point;
    if (!hasInk) setHasInk(true);
  };

  const endStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    lastPointRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const readUpload = async (file: File): Promise<void> => {
    const url = URL.createObjectURL(file);
    try {
      const image = new window.Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("image"));
        image.src = url;
      });
      const maxWidth = 1600;
      const scale = Math.min(1, maxWidth / (image.naturalWidth || 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      setUploaded(trimTransparent(canvas));
      setUploadName(file.name);
      setWarning(false);
    } catch {
      setUploaded(null);
      setUploadName(null);
      setWarning(true);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const buildTyped = (): HTMLCanvasElement | null => {
    const text = typed.trim();
    if (text.length === 0) return null;
    const measure = document.createElement("canvas");
    const measureContext = measure.getContext("2d");
    if (!measureContext) return null;
    const font = `${TYPE_FONT_SIZE}px ${resolveFontFamily(
      SIGNATURE_FONTS[fontIndex],
    )}`;
    measureContext.font = font;
    const width = Math.ceil(measureContext.measureText(text).width);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, (width + TYPE_FONT_SIZE) * EXPORT_SCALE);
    canvas.height = Math.round(TYPE_FONT_SIZE * 1.8 * EXPORT_SCALE);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.scale(EXPORT_SCALE, EXPORT_SCALE);
    context.font = font;
    context.fillStyle = ink;
    context.textBaseline = "middle";
    context.fillText(text, TYPE_FONT_SIZE / 2, (TYPE_FONT_SIZE * 1.8) / 2);
    return trimTransparent(canvas);
  };

  const save = () => {
    let canvas: HTMLCanvasElement | null = null;
    if (mode === "draw") {
      const source = canvasRef.current;
      canvas = source && hasInk ? trimTransparent(source) : null;
    } else if (mode === "type") {
      canvas = buildTyped();
    } else {
      canvas = uploaded;
    }

    const draft = canvas ? toDraft(canvas) : null;
    if (!draft) {
      setWarning(true);
      return;
    }
    setWarning(false);
    onSave(draft);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={strings.createTitle}
      closeLabel={t.common.close}
    >
      <div className="space-y-5 pb-2">
        <SegmentedControl<ComposerMode>
          value={mode}
          onChange={(next) => {
            setMode(next);
            setWarning(false);
          }}
          options={[
            { value: "draw", label: strings.modeDraw },
            { value: "type", label: strings.modeType },
            { value: "upload", label: strings.modeUpload },
          ]}
        />

        {mode === "draw" ? (
          <div className="space-y-3">
            <canvas
              ref={canvasRef}
              onPointerDown={startStroke}
              onPointerMove={continueStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              aria-label={strings.drawHint}
              className="block h-auto w-full touch-none rounded-ios-sm border border-white/14 bg-white"
              style={{ aspectRatio: `${DRAW_WIDTH} / ${DRAW_HEIGHT}` }}
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {strings.drawHint}
              </p>
              <Button variant="ghost" size="sm" onClick={resetCanvas}>
                <Eraser aria-hidden="true" className="size-3.5" />
                {strings.clear}
              </Button>
            </div>
            <Slider
              label={strings.strokeLabel}
              value={stroke}
              min={2}
              max={10}
              onChange={setStroke}
            />
          </div>
        ) : null}

        {mode === "type" ? (
          <div className="space-y-4">
            <div>
              <label
                htmlFor="signature-typed"
                className="hud-label mb-1.5 block text-[10px] text-muted-foreground"
              >
                {strings.typeLabel}
              </label>
              <input
                id="signature-typed"
                type="text"
                value={typed}
                maxLength={48}
                placeholder={strings.typePlaceholder}
                onChange={(event) => setTyped(event.target.value)}
                className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60"
              />
            </div>
            <div>
              <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
                {strings.styleLabel}
              </span>
              <div role="radiogroup" className="grid gap-2">
                {SIGNATURE_FONTS.map((font, index) => {
                  const active = index === fontIndex;
                  const styleName =
                    index === 0
                      ? CAVEAT_STYLE_NAME
                      : strings.styleNames[index - 1];
                  return (
                    <button
                      key={font}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={styleName}
                      onClick={() => setFontIndex(index)}
                      className={cn(
                        "flex min-h-14 items-center justify-center rounded-ios-sm border px-3 py-2 transition-all duration-200 ease-spring",
                        active
                          ? "border-signal/60 bg-signal/15"
                          : "border-white/10 bg-white/5 hover:border-white/25",
                      )}
                    >
                      <span
                        className="truncate text-2xl text-foreground"
                        style={{ fontFamily: font }}
                      >
                        {typed.trim() || styleName}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : null}

        {mode === "upload" ? (
          <div className="space-y-3">
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/png,image/jpeg,.png,.jpg,.jpeg"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void readUpload(file);
                event.target.value = "";
              }}
            />
            <Button
              variant="secondary"
              size="md"
              fullWidth
              onClick={() => uploadInputRef.current?.click()}
            >
              <ImageUp aria-hidden="true" className="size-4" />
              {strings.uploadPick}
            </Button>
            {uploadName ? (
              <p className="truncate text-sm text-foreground">{uploadName}</p>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {strings.uploadHint}
              </p>
            )}
          </div>
        ) : null}

        {mode !== "upload" ? (
          <div>
            <span className="hud-label mb-2 block text-[10px] text-muted-foreground">
              {strings.inkLabel}
            </span>
            <div role="radiogroup" className="flex gap-2">
              {SIGNATURE_INKS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={color === ink}
                  aria-label={color}
                  onClick={() => setInk(color)}
                  className={cn(
                    "size-9 rounded-full border-2 transition-all duration-200 ease-spring",
                    color === ink
                      ? "border-signal scale-110"
                      : "border-white/20 hover:border-white/40",
                  )}
                  /* Tinta del documento: es dato del usuario, no un token del tema. */
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>
        ) : null}

        {warning ? (
          <p role="alert" className="text-sm text-destructive">
            {strings.emptyWarning}
          </p>
        ) : null}

        <Button size="lg" fullWidth onClick={save}>
          {strings.save}
        </Button>
      </div>
    </Sheet>
  );
}
