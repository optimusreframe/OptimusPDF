"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Eraser, ImageUp, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { Slider } from "@/components/ui/Slider";
import { useMediaQuery } from "@/hooks/useMediaQuery";
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

/**
 * "initials" no cambia el mecanismo (dibujar, escribir o subir): solo
 * ajusta el lienzo y el limite de caracteres a un trazo corto y casi
 * cuadrado, que es lo que acaba dentro de un hueco de iniciales.
 */
export type SignatureComposerVariant = "signature" | "initials";

export type SignatureComposerProps = {
  open: boolean;
  onClose: () => void;
  onSave: (draft: SignatureDraft) => void;
  strings: SignStrings;
  /** Titulo del panel. Por defecto, el generico "Tu firma". */
  title?: string;
  variant?: SignatureComposerVariant;
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

/**
 * Lienzo de dibujo. Girar el telefono es la unica forma de ganar ancho en
 * Safari (no se puede forzar la rotacion desde una pestaña normal), asi
 * que en apaisado el lienzo se ensancha y se acorta para aprovechar el
 * hueco real que queda entre la cabecera y los controles.
 */
const DRAW_SIZES: Record<
  SignatureComposerVariant,
  Record<"portrait" | "landscape", { width: number; height: number }>
> = {
  signature: {
    portrait: { width: 640, height: 220 },
    landscape: { width: 760, height: 160 },
  },
  initials: {
    portrait: { width: 320, height: 220 },
    landscape: { width: 420, height: 160 },
  },
};

/** Pixeles reales por pixel CSS del lienzo de dibujo. */
const CANVAS_DENSITY = 2;

const LANDSCAPE_QUERY = "(orientation: landscape)";
const COARSE_POINTER_QUERY = "(pointer: coarse)";

const MAX_TYPED_LENGTH = 48;
const MAX_TYPED_INITIALS_LENGTH = 8;
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

export type StrokePoint = { x: number; y: number };

/**
 * Recorta un valor al intervalo [0, max]. Con `max` no positivo (un
 * lienzo que aun no tiene tamaño) se devuelve el valor tal cual: es
 * preferible un punto sin recortar que colapsar todo el trazo en cero.
 */
function clampToRange(value: number, max: number): number {
  if (!(max > 0)) return value;
  if (value < 0) return 0;
  if (value > max) return max;
  return value;
}

export function midpoint(a: StrokePoint, b: StrokePoint): StrokePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Suavizado por punto medio, la tecnica estandar del trazo a mano alzada:
 * cada segmento va del punto medio anterior al nuevo punto medio, con el
 * punto capturado como control. Encadenados asi los segmentos comparten
 * extremo, de modo que la tinta sale continua y sin esquinas; dibujar
 * directamente entre puntos capturados deja huecos a mitad de camino.
 */
export function drawStrokeSegment(
  context: CanvasRenderingContext2D,
  from: StrokePoint,
  control: StrokePoint,
  to: StrokePoint,
  style: { ink: string; width: number },
): void {
  context.strokeStyle = style.ink;
  context.lineWidth = style.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  // Tinta continua: nada de guiones heredados de otro dibujo en el mismo
  // contexto.
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.quadraticCurveTo(control.x, control.y, to.x, to.y);
  context.stroke();
}

/**
 * Trazo ya terminado, guardado como vector en un espacio de referencia
 * estable (el lienzo tal como estaba cuando se empezo a dibujar). Girar
 * el telefono no toca estos puntos: solo cambia la escala con la que se
 * repintan, asi que la tinta nunca se degrada por reescalados en cadena.
 */
type CompletedStroke = { ink: string; width: number; points: StrokePoint[] };

type InkBounds = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * Caja real de la tinta en el espacio de referencia. La linea se pinta
 * centrada en sus puntos, asi que se suma el radio de cada trazo
 * (`width / 2`, distinto en cada uno): mirando solo los puntos, un trazo
 * grueso pegado al borde perderia la mitad de su grosor al recortar.
 */
function inkBounds(strokes: CompletedStroke[]): InkBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const item of strokes) {
    if (item.points.length < 2) continue;
    const radius = item.width / 2;
    for (const point of item.points) {
      if (point.x - radius < minX) minX = point.x - radius;
      if (point.y - radius < minY) minY = point.y - radius;
      if (point.x + radius > maxX) maxX = point.x + radius;
      if (point.y + radius > maxY) maxY = point.y + radius;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Escala unica desde el espacio de referencia al lienzo actual. Se
 * calcula siempre desde los puntos originales —nunca desde el resultado
 * del giro anterior—, de modo que girar ida y vuelta devuelve la tinta a
 * su tamaño exacto. Solo se encoge si la tinta no cabe; nunca se agranda.
 */
function fitScale(
  strokes: CompletedStroke[],
  width: number,
  height: number,
): number {
  const bounds = inkBounds(strokes);
  if (!bounds) return 1;
  const scaleX = bounds.maxX > 0 ? width / bounds.maxX : 1;
  const scaleY = bounds.maxY > 0 ? height / bounds.maxY : 1;
  return Math.min(1, scaleX, scaleY);
}

/**
 * Repinta los trazos guardados sobre el lienzo actual. `origin` desplaza
 * la tinta en el espacio ya escalado, que es lo que permite exportar
 * pegado a la caja del dibujo sin pasar por el bitmap visible.
 */
function renderStrokes(
  context: CanvasRenderingContext2D,
  strokes: CompletedStroke[],
  scale: number,
  origin: StrokePoint = { x: 0, y: 0 },
): void {
  for (const item of strokes) {
    if (item.points.length < 2) continue;
    const style = { ink: item.ink, width: item.width * scale };
    const at = (point: StrokePoint): StrokePoint => ({
      x: point.x * scale - origin.x,
      y: point.y * scale - origin.y,
    });
    let previous = at(item.points[0]);
    let from = previous;
    for (let index = 1; index < item.points.length; index += 1) {
      const point = at(item.points[index]);
      const mid = midpoint(previous, point);
      drawStrokeSegment(context, from, previous, mid, style);
      previous = point;
      from = mid;
    }
    if (from.x !== previous.x || from.y !== previous.y) {
      drawStrokeSegment(context, from, previous, previous, style);
    }
  }
}

/** Reajusta un punto vivo del lienzo cuando cambia la escala. */
function scalePoint(
  point: StrokePoint | null,
  ratio: number,
): StrokePoint | null {
  return point ? { x: point.x * ratio, y: point.y * ratio } : null;
}

/**
 * Imagen final reconstruida desde los puntos guardados sobre un lienzo
 * aparte, no recortada del lienzo visible. La fuente de verdad son los
 * trazos, asi que el PNG sale identico este el telefono en vertical o
 * apaisado al pulsar guardar: `target` es el lienzo de referencia con el
 * que se empezo a dibujar, no el de la pantalla actual.
 */
function exportStrokes(
  strokes: CompletedStroke[],
  target: { width: number; height: number },
): HTMLCanvasElement | null {
  const bounds = inkBounds(strokes);
  if (!bounds) return null;
  const inkWidth = Math.max(1, bounds.maxX - bounds.minX);
  const inkHeight = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(1, target.width / inkWidth, target.height / inkHeight);

  const canvas = document.createElement("canvas");
  // `ceil`, no `round`: con limites fraccionarios redondear hacia abajo
  // dejaria el lienzo hasta medio pixel por debajo de la caja real y
  // recortaria el borde de la tinta.
  canvas.width = Math.max(1, Math.ceil(inkWidth * scale));
  canvas.height = Math.max(1, Math.ceil(inkHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return null;
  renderStrokes(context, strokes, scale, {
    x: bounds.minX * scale,
    y: bounds.minY * scale,
  });
  return canvas;
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
  title,
  variant = "signature",
}: SignatureComposerProps) {
  const t = useT();
  const initials = variant === "initials";
  // El aviso y el lienzo apaisado solo tienen sentido con el aparato en
  // la mano: en un escritorio la ventana ya es ancha de serie.
  const touch = useMediaQuery(COARSE_POINTER_QUERY);
  const landscape = useMediaQuery(LANDSCAPE_QUERY);
  const drawSize =
    DRAW_SIZES[variant][touch && landscape ? "landscape" : "portrait"];
  const [mode, setMode] = useState<ComposerMode>("draw");
  const [ink, setInk] = useState<string>(SIGNATURE_INKS[0]);
  const [stroke, setStroke] = useState(4);
  const [typed, setTyped] = useState("");
  const [fontIndex, setFontIndex] = useState(0);
  const [uploaded, setUploaded] = useState<HTMLCanvasElement | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [warning, setWarning] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Ultimo punto capturado: es el control de la curva siguiente. */
  const lastPointRef = useRef<StrokePoint | null>(null);
  /** Punto medio donde acabo el segmento anterior; ahi arranca el proximo. */
  const lastMidRef = useRef<StrokePoint | null>(null);
  /** Trazos terminados, en el espacio de referencia (ver `CompletedStroke`). */
  const strokesRef = useRef<CompletedStroke[]>([]);
  /** Trazo en curso, aun sin cerrar. */
  const activeStrokeRef = useRef<CompletedStroke | null>(null);
  /** Escala vigente del espacio de referencia al lienzo actual. */
  const scaleRef = useRef(1);
  /**
   * Tamaño del lienzo en el que se abrio el espacio de referencia. Es la
   * resolucion a la que se exporta la firma, para que el PNG final no
   * dependa de la orientacion que hubiera al pulsar guardar.
   */
  const referenceSizeRef = useRef({
    width: DRAW_SIZES[variant].portrait.width * CANVAS_DENSITY,
    height: DRAW_SIZES[variant].portrait.height * CANVAS_DENSITY,
  });
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const clearStrokes = useCallback(() => {
    strokesRef.current = [];
    activeStrokeRef.current = null;
    lastPointRef.current = null;
    lastMidRef.current = null;
    scaleRef.current = 1;
    // Sin tinta, el espacio de referencia vuelve a ser el lienzo actual.
    const canvas = canvasRef.current;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      referenceSizeRef.current = { width: canvas.width, height: canvas.height };
    }
  }, []);

  const resetCanvas = useCallback(() => {
    clearStrokes();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  }, [clearStrokes]);

  /* Entrar en el modo de dibujo siempre empieza con el lienzo limpio. */
  useEffect(() => {
    if (!open || mode !== "draw") return;
    clearStrokes();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, [open, mode, clearStrokes]);

  /**
   * Girar el telefono cambia el tamaño del lienzo, y asignar `width` o
   * `height` lo vacia. En vez de reescalar el bitmap —lo que encogeria la
   * tinta un poco mas en cada giro— se repintan los trazos guardados
   * desde sus puntos originales con una sola escala.
   */
  useEffect(() => {
    if (!open || mode !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = drawSize.width * CANVAS_DENSITY;
    const height = drawSize.height * CANVAS_DENSITY;
    if (canvas.width === width && canvas.height === height) return;

    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    // El trazo en curso entra en el repintado como uno mas: girar el
    // telefono con el dedo apoyado no puede borrar lo que ya se lleva
    // dibujado de el.
    const active = activeStrokeRef.current;
    const painted = active
      ? [...strokesRef.current, active]
      : strokesRef.current;
    if (painted.length === 0) {
      scaleRef.current = 1;
      referenceSizeRef.current = { width, height };
      return;
    }
    const previous = scaleRef.current || 1;
    scaleRef.current = fitScale(painted, width, height);
    renderStrokes(context, painted, scaleRef.current);
    // Los punteros vivos estan en coordenadas del lienzo anterior: sin
    // reajustarlos, el trazo continuaria desde un punto que ya no existe.
    const ratio = scaleRef.current / previous;
    if (active && ratio !== 1) {
      lastPointRef.current = scalePoint(lastPointRef.current, ratio);
      lastMidRef.current = scalePoint(lastMidRef.current, ratio);
    }
  }, [open, mode, drawSize.width, drawSize.height]);

  /**
   * Punto del evento en espacio de lienzo, recortado al area de dibujo.
   * Con el puntero capturado los eventos siguen llegando aunque el dedo
   * se salga del lienzo: en pantalla ese tramo no se ve (el elemento lo
   * recorta), pero la exportacion reconstruye desde los puntos guardados
   * y si tuvieran coordenadas de fuera inflaria la caja de la tinta y
   * encogeria la firma visible. Recortando aqui, ni el trazo pintado ni
   * el exportado pueden salirse nunca del area visible.
   */
  const pointFrom = (
    canvas: HTMLCanvasElement,
    clientX: number,
    clientY: number,
  ): StrokePoint => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: clampToRange(
        ((clientX - bounds.left) / (bounds.width || 1)) * canvas.width,
        canvas.width,
      ),
      y: clampToRange(
        ((clientY - bounds.top) / (bounds.height || 1)) * canvas.height,
        canvas.height,
      ),
    };
  };

  /**
   * Puntos reales del evento en espacio de lienzo. Un trazo rapido en el
   * movil llega con varios puntos por evento; sin recuperarlos, el
   * navegador solo entrega el ultimo y el trazo se vuelve una sucesion de
   * rectas largas.
   */
  const pointsFrom = (
    event: ReactPointerEvent<HTMLCanvasElement>,
    canvas: HTMLCanvasElement,
  ): StrokePoint[] => {
    const native = event.nativeEvent;
    const batch =
      typeof native.getCoalescedEvents === "function"
        ? native.getCoalescedEvents()
        : [];
    return (batch.length > 0 ? batch : [native]).map((item) =>
      pointFrom(canvas, item.clientX, item.clientY),
    );
  };

  const startStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFrom(event.currentTarget, event.clientX, event.clientY);
    lastPointRef.current = point;
    lastMidRef.current = point;
    const scale = scaleRef.current || 1;
    activeStrokeRef.current = {
      ink,
      width: (stroke * 2) / scale,
      points: [{ x: point.x / scale, y: point.y / scale }],
    };
  };

  /** Guarda el punto en el espacio de referencia del trazo en curso. */
  const trackPoint = (point: StrokePoint): void => {
    const active = activeStrokeRef.current;
    if (!active) return;
    const scale = scaleRef.current || 1;
    active.points.push({ x: point.x / scale, y: point.y / scale });
  };

  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!lastPointRef.current) return;
    event.preventDefault();
    const canvas = event.currentTarget;
    const context = canvas.getContext("2d");
    if (!context) return;

    for (const point of pointsFrom(event, canvas)) {
      const previous = lastPointRef.current;
      const from = lastMidRef.current;
      if (!previous || !from) break;
      const mid = midpoint(previous, point);
      drawStrokeSegment(context, from, previous, mid, {
        ink,
        width: stroke * 2,
      });
      lastPointRef.current = point;
      lastMidRef.current = mid;
      trackPoint(point);
    }
  };

  const endStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    let previous = lastPointRef.current;
    let from = lastMidRef.current;
    lastPointRef.current = null;
    lastMidRef.current = null;
    const canvas = event.currentTarget;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    const context = canvas.getContext("2d");
    if (previous && from && context) {
      // El dedo se sigue moviendo entre el ultimo `pointermove` y el
      // `pointerup`: sin procesar las coordenadas del propio `pointerup`
      // ese ultimo tramo nunca se pinta y la firma queda cortada.
      const style = { ink, width: stroke * 2 };
      for (const point of pointsFrom(event, canvas)) {
        const mid = midpoint(previous, point);
        drawStrokeSegment(context, from, previous, mid, style);
        previous = point;
        from = mid;
        trackPoint(point);
      }
      // Cola del trazo: del ultimo punto medio al punto donde se levanto
      // el dedo. Si coinciden es que el dedo no llego a moverse y no hay
      // nada que rematar.
      if (from.x !== previous.x || from.y !== previous.y) {
        drawStrokeSegment(context, from, previous, previous, style);
      }
    }

    const active = activeStrokeRef.current;
    activeStrokeRef.current = null;
    if (active && active.points.length > 1) {
      strokesRef.current = [...strokesRef.current, active];
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
      // Incluido el trazo que siguiera en curso al pulsar guardar.
      const active = activeStrokeRef.current;
      canvas = exportStrokes(
        active ? [...strokesRef.current, active] : strokesRef.current,
        referenceSizeRef.current,
      );
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
      title={title ?? strings.createTitle}
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
            {touch && !landscape ? (
              <p className="rounded-ios-sm flex items-center gap-2 border border-white/10 bg-white/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <RotateCw aria-hidden="true" className="size-4 shrink-0" />
                {strings.rotateHint}
              </p>
            ) : null}
            <canvas
              ref={canvasRef}
              onPointerDown={startStroke}
              onPointerMove={continueStroke}
              onPointerUp={endStroke}
              onPointerCancel={endStroke}
              aria-label={strings.drawHint}
              className="mx-auto block h-auto w-full touch-none rounded-ios-sm border border-white/14 bg-white"
              style={{
                aspectRatio: `${drawSize.width} / ${drawSize.height}`,
                maxWidth: initials ? `${drawSize.width}px` : undefined,
              }}
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {initials ? strings.initialsHint : strings.drawHint}
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
                maxLength={initials ? MAX_TYPED_INITIALS_LENGTH : MAX_TYPED_LENGTH}
                placeholder={
                  initials ? strings.initialsPlaceholder : strings.typePlaceholder
                }
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
