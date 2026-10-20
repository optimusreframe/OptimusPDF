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
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { MOBILE_FULLSCREEN_QUERY, Sheet } from "@/components/ui/Sheet";
import { Slider } from "@/components/ui/Slider";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { colorName } from "@/lib/colorNames";
import { useI18n, useT } from "@/lib/i18n";
import { SignatureImportSheet } from "@/app/sign-pdf/SignatureImportSheet";
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
  /**
   * Baul de firmas (opcional y SEPARADO de `onSave`, que no cambia): si se
   * pasa, el pie ofrece la casilla «Recordar en este dispositivo»
   * (desmarcada por defecto). Con ella marcada, al guardar se llama primero
   * a `onSave` (la firma se usa igual pase lo que pase con el baul) y luego a
   * `onRemember` con el nombre del firmante. Quien lo pasa decide que hacer
   * (y como contar el resultado); sin esta prop no hay casilla.
   */
  onRemember?: (draft: SignatureDraft, who: { signerName: string }) => void;
  /** Nombre ya conocido del firmante (varios firmantes). Vacio/ausente = se pide en un campo. */
  signerName?: string;
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

/**
 * Fuente de la firma escrita en el canvas (la misma pila que la vista previa,
 * con `var(--font-caveat)` ya resuelta). Una sola funcion para medir, dibujar
 * y esperar: el canvas exportado nunca usa una familia distinta de la que se
 * comprobo.
 */
function typedFontSpec(fontIndex: number): string {
  return `${TYPE_FONT_SIZE}px ${resolveFontFamily(SIGNATURE_FONTS[fontIndex])}`;
}

/** Tiempo maximo de espera de la fuente antes de avisar (W6-C, N1). */
export const SIGNATURE_FONT_TIMEOUT_MS = 4000;

const FONT_FALLBACK_NOTICE = {
  es: "La fuente de la firma no cargó: se usará una fuente de respaldo. Pulsa «Usar esta firma» otra vez para guardarla así, o elige otro estilo.",
  en: "The signature font did not load: a fallback font will be used. Press “Use this signature” again to save it that way, or pick another style.",
} as const;

/**
 * Lista `font` sin las familias «X Fallback»: la cara de AJUSTE DE METRICAS que `next/font` declara junto a cada
 * fuente web (`@font-face { font-family: "Caveat Fallback"; src: local(Arial) }`). No es una fuente de la firma, solo
 * evita saltos de maquetacion mientras baja la real, y en un equipo sin Arial (Linux, Android, ChromeOS, el runner de
 * CI) queda en estado "error" PARA SIEMPRE: `document.fonts.check()` devuelve entonces false para toda la pila aunque
 * Caveat ya este cargada y el aviso de «la fuente no cargo» salia siempre. La disponibilidad se comprueba sobre las
 * familias reales; si Caveat misma falla (red caida) sigue en la lista y `check` sigue siendo false: nunca una firma
 * silenciosamente distinta. Si no hay nada que quitar (o no queda nada) devuelve `font` tal cual.
 */
export function withoutMetricFallbacks(font: string): string {
  const match = /^(.*?\d(?:px|pt|em|rem))\s+(.+)$/.exec(font);
  if (!match) return font;
  const families = match[2].match(/"[^"]*"|'[^']*'|[^,]+/g)?.map((family) => family.trim()).filter(Boolean) ?? [];
  const kept = families.filter((family) => !/^["']?[^"',]+ Fallback["']?$/.test(family));
  if (kept.length === 0 || kept.length === families.length) return font;
  return `${match[1]} ${kept.join(", ")}`;
}

/** Un rango de `unicode-range` («U+0000-00FF, U+0131, U+4??») cubre algun caracter de `text`. */
export function unicodeRangeCovers(range: string, text: string): boolean {
  const codePoints = Array.from(text, (character) => character.codePointAt(0) ?? 0);
  if (codePoints.length === 0) return false;
  for (const token of range.split(",")) {
    const match = /^\s*U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?\s*$/i.exec(token);
    if (!match) continue;
    const start = parseInt(match[1].replace(/\?/g, "0"), 16);
    const end = match[2] !== undefined ? parseInt(match[2], 16) : parseInt(match[1].replace(/\?/g, "F"), 16);
    if (codePoints.some((codePoint) => codePoint >= start && codePoint <= end)) return true;
  }
  return false;
}

/**
 * Hay una cara de las familias REALES de `font` que cubre `text` y aun no esta cargada (`loading`, `unloaded` o
 * `error`). Safari devuelve `true` en `document.fonts.check()` MIENTRAS la fuente se descarga y llama «error» al estado
 * de una cara `font-display: swap` que sigue bajando (el WebKit de Playwright: «error» durante toda la espera y
 * «loaded» al llegar): fiarse solo de `check` exportaba la firma con la fuente de respaldo, en silencio y distinta de la
 * vista previa. Con la fuente caida de verdad tambien cuenta como pendiente: `loadSignatureFont` lo resuelve (rechaza o
 * agota el plazo) y se avisa.
 */
function hasUnloadedFace(fonts: FontFaceSet, font: string, text: string): boolean {
  if (typeof (fonts as unknown as Iterable<FontFace>)[Symbol.iterator] !== "function") return false;
  const match = /^(.*?\d(?:px|pt|em|rem))\s+(.+)$/.exec(font);
  const families = (match?.[2].match(/"[^"]*"|'[^']*'|[^,]+/g) ?? [])
    .map((family) => family.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter(Boolean);
  if (families.length === 0) return false;
  for (const face of fonts as unknown as Iterable<FontFace>) {
    const family = String(face.family).trim().replace(/^["']|["']$/g, "").toLowerCase();
    if (!families.includes(family) || face.status === "loaded") continue;
    if (unicodeRangeCovers(face.unicodeRange || "U+0-10FFFF", text)) return true;
  }
  return false;
}

/**
 * `true` si el canvas ya puede dibujar `text` con `font` sin caer en la fuente
 * de respaldo. Sin la API de fuentes (jsdom, navegadores muy viejos) no hay
 * nada que esperar.
 */
export function signatureFontReady(font: string, text: string): boolean {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts || typeof fonts.check !== "function") return true;
  try {
    const real = withoutMetricFallbacks(font);
    return fonts.check(real, text) && !hasUnloadedFace(fonts, real, text);
  } catch {
    return true;
  }
}

/**
 * Espera a que `font` este lista para `text` (carga + `document.fonts.ready`)
 * y confirma con `check`. Resuelve `false` si no llega a tiempo o falla: quien
 * llama avisa en vez de exportar en silencio una firma con otra fuente.
 */
export function loadSignatureFont(
  font: string,
  text: string,
  timeoutMs: number = SIGNATURE_FONT_TIMEOUT_MS,
): Promise<boolean> {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts || typeof fonts.load !== "function") return Promise.resolve(true);
  const realFont = withoutMetricFallbacks(font);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    fonts
      .load(realFont, text)
      .then(() => fonts.ready)
      .then(() => {
        clearTimeout(timer);
        resolve(signatureFontReady(font, text));
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
  });
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
  onRemember,
  signerName,
}: SignatureComposerProps) {
  const t = useT();
  const { language } = useI18n();
  const initials = variant === "initials";
  // El aviso y el lienzo apaisado solo tienen sentido con el aparato en
  // la mano: en un escritorio la ventana ya es ancha de serie.
  const touch = useMediaQuery(COARSE_POINTER_QUERY);
  const landscape = useMediaQuery(LANDSCAPE_QUERY);
  // Mismo criterio que el Sheet: si no coincide, el lienzo terminaria
  // midiendo un hueco que la tarjeta compacta nunca le da.
  const fullscreen = useMediaQuery(MOBILE_FULLSCREEN_QUERY);
  const [mode, setMode] = useState<ComposerMode>("draw");
  /**
   * En pantalla completa (movil real) tanto la firma como las iniciales
   * aprovechan el lienzo entero: las dos se quedan cortas de espacio en
   * el hueco fijo pequeño, y ese hueco fijo solo tiene sentido cuando el
   * `Sheet` no es pantalla completa (tarjeta compacta de escritorio).
   */
  const fillCanvas = fullscreen && mode === "draw";
  const [measuredSize, setMeasuredSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const drawSize =
    fillCanvas && measuredSize
      ? measuredSize
      : DRAW_SIZES[variant][touch && landscape ? "landscape" : "portrait"];
  const [ink, setInk] = useState<string>(SIGNATURE_INKS[0]);
  const [stroke, setStroke] = useState(4);
  const [typed, setTyped] = useState("");
  const [fontIndex, setFontIndex] = useState(0);
  /** «Subir»: el PNG de tinta ya limpio que devolvio la hoja de subida (`SignatureImportSheet`, U6.2). */
  const [uploaded, setUploaded] = useState<SignatureDraft | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [warning, setWarning] = useState(false);
  /* N1: la fuente de «Escribir» aun no esta lista al guardar / no cargo a tiempo. */
  const [fontBusy, setFontBusy] = useState(false);
  const [fontNotice, setFontNotice] = useState(false);
  /** Estilos cuyo respaldo ya se aviso: la siguiente pulsacion guarda tal cual. */
  const fontFallbackAckRef = useRef<Set<number>>(new Set());
  /* Baul de firmas: casilla desmarcada y sin nombre cada vez que se abre. */
  const [remember, setRemember] = useState(false);
  /** `null` = aun no lo ha tocado: se precarga con lo escrito en «Escribir». */
  const [rememberNameEdit, setRememberNameEdit] = useState<string | null>(null);
  const [rememberNotice, setRememberNotice] = useState("");
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setRemember(false);
      setRememberNameEdit(null);
      setRememberNotice("");
    }
  }
  const knownName = signerName?.trim() ?? "";
  /**
   * El nombre no se pide dos veces: si ya se escribio el nombre en «Escribir»
   * (solo una firma; las iniciales no son un nombre), el campo de «Recordar»
   * arranca con ese valor y se puede corregir. Una vez editado, manda lo editado.
   */
  const rememberName =
    rememberNameEdit ?? (!initials && mode === "type" ? typed.trim() : "");
  const rememberNameRef = useRef<HTMLInputElement>(null);

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
  /** Contenedor que se mide en pantalla completa para llenar el lienzo. */
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  /** Ultima medida del contenedor, a la espera de que no haya trazo en curso. */
  const pendingSizeRef = useRef<{ width: number; height: number } | null>(
    null,
  );
  const applyPendingSizeRef = useRef<() => void>(() => {});

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
   * En pantalla completa el lienzo no tiene un tamaño fijo: llena lo que
   * quede libre entre la cabecera y los controles, y eso varia con cada
   * dispositivo. Se mide el contenedor real con `ResizeObserver` en vez de
   * asumir un valor.
   */
  useEffect(() => {
    applyPendingSizeRef.current = () => {
      const pending = pendingSizeRef.current;
      // Nunca a mitad de un trazo: cambiar el tamaño del lienzo bajo el
      // dedo lo dejaria en blanco justo cuando el usuario esta dibujando.
      if (!pending || activeStrokeRef.current) return;
      setMeasuredSize((current) => {
        if (
          current &&
          Math.abs(current.width - pending.width) < 4 &&
          Math.abs(current.height - pending.height) < 4
        ) {
          return current;
        }
        return pending;
      });
    };
  });

  useEffect(() => {
    if (!open || mode !== "draw" || !fillCanvas) {
      // Sin gesto de medida en marcha, la `measuredSize` que hubiera queda
      // sin usar: `drawSize` ya la ignora en cuanto `fillCanvas` es falso.
      pendingSizeRef.current = null;
      return;
    }
    const wrap = canvasWrapRef.current;
    if (!wrap) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width < 40 || height < 40) return;
      pendingSizeRef.current = {
        width: Math.round(width),
        height: Math.round(height),
      };
      applyPendingSizeRef.current();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [open, mode, fillCanvas]);

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
    // Si un giro o un cambio de tamaño llego mientras el dedo seguia en el
    // lienzo, se aplico en diferido: ahora que el trazo ya cerro, toca.
    applyPendingSizeRef.current();
  };

  // Precarga: la fuente solo se descarga cuando algo la usa, asi que se pide al
  // abrir el compositor y al cambiar de estilo; al guardar casi nunca se espera.
  useEffect(() => {
    if (!open) return;
    void loadSignatureFont(typedFontSpec(fontIndex), "Aa");
  }, [open, fontIndex]);

  const buildTyped = (): HTMLCanvasElement | null => {
    const text = typed.trim();
    if (text.length === 0) return null;
    const measure = document.createElement("canvas");
    const measureContext = measure.getContext("2d");
    if (!measureContext) return null;
    const font = typedFontSpec(fontIndex);
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

  /** Cierra el flujo de guardado con el lienzo ya construido. */
  const finishSave = (canvas: HTMLCanvasElement | null) => {
    finishDraft(canvas ? toDraft(canvas) : null);
  };

  /** Igual, con el borrador ya hecho (la imagen subida llega como PNG limpio, no como canvas). */
  const finishDraft = (draft: SignatureDraft | null) => {
    if (!draft) {
      setWarning(true);
      return;
    }
    setWarning(false);
    if (remember && onRemember) {
      const who = knownName || rememberName.trim();
      if (!who) {
        // Sin nombre no se guarda: se explica y se deja corregir, sin cerrar.
        setRememberNotice(strings.vaultRememberNeedsName);
        rememberNameRef.current?.focus();
        return;
      }
      onSave(draft);
      onRemember(draft, { signerName: who });
    } else {
      onSave(draft);
    }
    onClose();
  };

  const save = () => {
    if (fontBusy) return;
    if (mode === "draw") {
      // Incluido el trazo que siguiera en curso al pulsar guardar.
      const active = activeStrokeRef.current;
      finishSave(
        exportStrokes(
          active ? [...strokesRef.current, active] : strokesRef.current,
          referenceSizeRef.current,
        ),
      );
      return;
    }
    if (mode !== "type") {
      finishDraft(uploaded);
      return;
    }
    // N1: el canvas exportado debe usar la MISMA fuente que la vista previa.
    // Si la fuente aun no esta lista, se espera (con tope) antes de medir y
    // dibujar; si no llega, se avisa en vez de exportar en silencio otra firma.
    const text = typed.trim();
    const font = typedFontSpec(fontIndex);
    if (
      text.length === 0 ||
      signatureFontReady(font, text) ||
      fontFallbackAckRef.current.has(fontIndex)
    ) {
      finishSave(buildTyped());
      return;
    }
    setFontBusy(true);
    void loadSignatureFont(font, text).then((ready) => {
      setFontBusy(false);
      if (!ready) {
        fontFallbackAckRef.current.add(fontIndex);
        setFontNotice(true);
        return;
      }
      finishSave(buildTyped());
    });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title ?? strings.createTitle}
      closeLabel={t.common.close}
      mobileFullscreen
    >
      <div
        className={cn(
          "pb-2",
          fillCanvas ? "flex h-full min-h-0 flex-col gap-3" : "space-y-5",
        )}
      >
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
          <div
            className={cn(
              fillCanvas ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-3",
            )}
          >
            {touch && !landscape && !fillCanvas ? (
              <p className="rounded-ios-sm flex items-center gap-2 border border-white/10 bg-white/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <RotateCw aria-hidden="true" className="size-4 shrink-0" />
                {strings.rotateHint}
              </p>
            ) : null}
            <div
              ref={fillCanvas ? canvasWrapRef : undefined}
              className={fillCanvas ? "min-h-[96px] flex-1" : undefined}
            >
              <canvas
                ref={canvasRef}
                // El trazo es del lienzo: la hoja no se arrastra desde aqui (ver `Sheet`).
                data-sheet-no-drag=""
                onPointerDown={startStroke}
                onPointerMove={continueStroke}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
                aria-label={strings.drawHint}
                className={cn(
                  "block touch-none rounded-ios-sm border border-white/14 bg-white",
                  fillCanvas ? "h-full w-full" : "mx-auto h-auto w-full",
                )}
                style={
                  fillCanvas
                    ? undefined
                    : {
                        aspectRatio: `${drawSize.width} / ${drawSize.height}`,
                        maxWidth: initials ? `${drawSize.width}px` : undefined,
                      }
                }
              />
            </div>
            <div className="flex shrink-0 items-center justify-between gap-3">
              {fillCanvas ? null : (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {initials ? strings.initialsHint : strings.drawHint}
                </p>
              )}
              <Button variant="ghost" size="sm" onClick={resetCanvas}>
                <Eraser aria-hidden="true" className="size-3.5" />
                {strings.clear}
              </Button>
              {fillCanvas ? (
                <div role="radiogroup" aria-label={strings.inkLabel} className="flex gap-0">
                  {SIGNATURE_INKS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      role="radio"
                      aria-checked={color === ink}
                      aria-label={colorName(color, language)}
                      title={colorName(color, language)}
                      onClick={() => setInk(color)}
                      className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal"
                    >
                      {/* El boton mide 44 px (zona tactil real); la muestra visible es el circulo de dentro. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-6 rounded-full border-2 transition-all duration-200 ease-spring",
                          color === ink
                            ? "border-signal scale-110"
                            : "border-white/20 group-hover:border-white/40",
                        )}
                        style={{ backgroundColor: color }}
                      />
                    </button>
                  ))}
                </div>
              ) : null}
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
                className="ui-label mb-1.5 block text-muted-foreground"
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
                onChange={(event) => {
                  setTyped(event.target.value);
                  setFontNotice(false);
                  fontFallbackAckRef.current.clear();
                }}
                className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
              />
            </div>
            <div>
              <span className="ui-label mb-2 block text-muted-foreground">
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
                      onClick={() => {
                        setFontIndex(index);
                        setFontNotice(false);
                      }}
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
            <Button
              variant="secondary"
              size="md"
              fullWidth
              wrap
              onClick={() => setImportOpen(true)}
            >
              <ImageUp aria-hidden="true" className="size-4" />
              {uploaded ? strings.inkImport.changeImage : strings.uploadPick}
            </Button>
            {uploaded ? (
              <div
                className="flex min-h-20 items-center justify-center rounded-ios-sm border border-white/10 bg-white p-2"
                data-composer-upload-preview
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={uploaded.dataUrl}
                  alt={strings.inkImport.slotAlt(initials ? "initials" : "signature")}
                  className="max-h-24 w-auto max-w-full object-contain"
                />
              </div>
            ) : (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {strings.uploadHint}
              </p>
            )}
            <SignatureImportSheet
              open={importOpen}
              onClose={() => setImportOpen(false)}
              strings={strings}
              target={{
                kind: "draft",
                variant,
                onUse: (draft) => {
                  setUploaded(draft);
                  setWarning(false);
                },
              }}
              preferSignerName={signerName}
            />
          </div>
        ) : null}

        {mode !== "upload" && !fillCanvas ? (
          <div>
            <span className="ui-label mb-2 block text-muted-foreground">
              {strings.inkLabel}
            </span>
            <div role="radiogroup" aria-label={strings.inkLabel} className="flex gap-0">
              {SIGNATURE_INKS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={color === ink}
                  aria-label={colorName(color, language)}
                  title={colorName(color, language)}
                  onClick={() => setInk(color)}
                  className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal"
                >
                  {/* El boton mide 44 px (zona tactil real); la muestra visible es el circulo de dentro. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-9 rounded-full border-2 transition-all duration-200 ease-spring",
                      color === ink
                        ? "border-signal scale-110"
                        : "border-white/20 group-hover:border-white/40",
                    )}
                    /* Tinta del documento: es dato del usuario, no un token del tema. */
                    style={{ backgroundColor: color }}
                  />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {warning ? (
          <p role="alert" className="text-sm text-destructive">
            {strings.emptyWarning}
          </p>
        ) : null}

        {/* Aviso de la fuente de «Escribir» (N1): solo existe mientras hay aviso. */}
        {fontNotice && mode === "type" ? (
          <p
            role="status"
            aria-live="polite"
            data-font-notice=""
            className="text-sm text-destructive-text"
          >
            {FONT_FALLBACK_NOTICE[language]}
          </p>
        ) : null}

        {onRemember ? (
          <div className="space-y-2">
            <Checkbox
              label={strings.vaultRemember}
              hint={strings.vaultRememberHint}
              checked={remember}
              onChange={(next) => {
                setRemember(next);
                setRememberNotice("");
              }}
            />
            {remember && knownName ? (
              <p className="pl-[34px] text-footnote text-muted-foreground">
                {strings.vaultRememberFor(knownName)}
              </p>
            ) : null}
            {remember && !knownName ? (
              <div className="pl-[34px]">
                <label
                  htmlFor="signature-remember-name"
                  className="ui-label mb-1.5 block text-muted-foreground"
                >
                  {strings.vaultRememberNameLabel}
                </label>
                <input
                  ref={rememberNameRef}
                  id="signature-remember-name"
                  type="text"
                  value={rememberName}
                  maxLength={200}
                  placeholder={strings.vaultRememberNamePlaceholder}
                  aria-invalid={rememberNotice ? true : undefined}
                  onChange={(event) => {
                    setRememberNameEdit(event.target.value);
                    setRememberNotice("");
                  }}
                  className="h-11 w-full rounded-ios-sm border border-white/14 bg-white/5 px-3 text-sm pointer-coarse:text-base text-foreground transition-colors placeholder:text-muted-foreground/60 focus:border-signal/60 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal"
                />
              </div>
            ) : null}
            {/* Region de estado siempre montada: solo cambia su contenido. */}
            <p
              role="status"
              aria-live="polite"
              className={
                rememberNotice
                  ? "pl-[34px] text-footnote text-destructive-text"
                  : "sr-only"
              }
            >
              {rememberNotice}
            </p>
          </div>
        ) : null}

        <Button size="lg" fullWidth onClick={save} disabled={fontBusy} aria-busy={fontBusy || undefined}>
          {strings.save}
        </Button>
      </div>
    </Sheet>
  );
}
