import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  SignatureComposer,
  drawStrokeSegment,
  midpoint,
  type SignatureComposerVariant,
  type SignatureDraft,
  type StrokePoint,
} from "@/app/sign-pdf/SignatureComposer";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LanguageProvider } from "@/lib/i18n";
import { MOBILE_FULLSCREEN_QUERY } from "@/components/ui/Sheet";

const strings = SIGN_STRINGS.es;

const BOX_WIDTH = 640;
const BOX_HEIGHT = 220;

const COARSE = "(pointer: coarse)";
const LANDSCAPE = "(orientation: landscape)";
const FULLSCREEN = MOBILE_FULLSCREEN_QUERY;

/**
 * jsdom no trae canvas, asi que el contexto 2D se sustituye por uno que
 * apunta lo que recibe. Lo que se comprueba aqui es la forma del trazo
 * —los puntos de control y los ajustes de linea—, no el rasterizado.
 */
type Op = { name: string; args: number[] };

type Recorder = {
  ops: Op[];
  context: {
    lineCap: string;
    lineJoin: string;
    lineWidth: number;
    dash: number[];
    dashCalls: number;
  };
};

let recorder: Recorder;

function newRecorder(): Recorder {
  const ops: Op[] = [];
  const context = {
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt",
    lineJoin: "miter",
    dash: [] as number[],
    dashCalls: 0,
    setLineDash(segments: number[]) {
      context.dash = segments;
      context.dashCalls += 1;
      ops.push({ name: "setLineDash", args: segments });
    },
    getLineDash: () => context.dash,
    beginPath: () => ops.push({ name: "beginPath", args: [] }),
    stroke: () => ops.push({ name: "stroke", args: [context.lineWidth] }),
    moveTo: (x: number, y: number) => ops.push({ name: "moveTo", args: [x, y] }),
    lineTo: (x: number, y: number) => ops.push({ name: "lineTo", args: [x, y] }),
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) =>
      ops.push({ name: "quadraticCurveTo", args: [cx, cy, x, y] }),
    clearRect: () => ops.push({ name: "clearRect", args: [] }),
    drawImage: () => ops.push({ name: "drawImage", args: [] }),
    setTransform: () => ops.push({ name: "setTransform", args: [] }),
  };
  return { ops, context } as unknown as Recorder;
}

/** Consultas de medios controlables: el giro se simula desde el test. */
let matching: string[] = [];
const mediaListeners = new Set<() => void>();

function setMedia(queries: string[]): void {
  matching = queries;
  act(() => {
    for (const listener of [...mediaListeners]) listener();
  });
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const originalRect = Element.prototype.getBoundingClientRect;
const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return recorder.context;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;

  // jsdom no rasteriza: el PNG se sustituye por las medidas del lienzo,
  // que es justo lo que hay que comprobar de la exportacion.
  HTMLCanvasElement.prototype.toDataURL = function toDataURL(
    this: HTMLCanvasElement,
  ) {
    return `data:image/png;${this.width}x${this.height}`;
  } as unknown as typeof HTMLCanvasElement.prototype.toDataURL;

  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: BOX_WIDTH,
      height: BOX_HEIGHT,
      top: 0,
      left: 0,
      right: BOX_WIDTH,
      bottom: BOX_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };

  window.matchMedia = ((query: string) => ({
    get matches() {
      return matching.includes(query);
    },
    media: query,
    onchange: null,
    addEventListener: (_type: string, listener: () => void) =>
      mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      mediaListeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  Element.prototype.getBoundingClientRect = originalRect;
  HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
});

let saved: SignatureDraft | null = null;

beforeEach(() => {
  recorder = newRecorder();
  matching = [];
  mediaListeners.clear();
  saved = null;
});

function open(variant?: SignatureComposerVariant) {
  return render(
    <LanguageProvider>
      <SignatureComposer
        open
        onClose={() => {}}
        onSave={(draft) => {
          saved = draft;
        }}
        strings={strings}
        variant={variant}
      />
    </LanguageProvider>,
  );
}

function canvas(): HTMLCanvasElement {
  return screen.getByLabelText(strings.drawHint) as HTMLCanvasElement;
}

/** Traza un garabato: pulsar, mover dos veces y levantar. */
function scribble(): void {
  const target = canvas();
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 100, clientY: 50 });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: 200, clientY: 100 });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: 300, clientY: 150 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 300, clientY: 150 });
}

/**
 * Garabato que ocupa casi todo el lienzo: en apaisado no cabe a tamaño
 * real, asi que obliga a encoger la tinta en pantalla.
 */
function bigScribble(): void {
  const target = canvas();
  fireEvent.pointerDown(target, { pointerId: 1, clientX: 60, clientY: 20 });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: 300, clientY: 120 });
  fireEvent.pointerMove(target, { pointerId: 1, clientX: 600, clientY: 210 });
  fireEvent.pointerUp(target, { pointerId: 1, clientX: 600, clientY: 210 });
}

/** Pulsa "usar firma" y devuelve las medidas del PNG exportado. */
function savedSize(): { width: number; height: number } {
  fireEvent.click(screen.getByRole("button", { name: strings.save }));
  const draft = saved;
  if (!draft) throw new Error("no se guardo ninguna firma");
  const match = /(\d+)x(\d+)$/.exec(draft.dataUrl);
  if (!match) throw new Error(`data URL inesperada: ${draft.dataUrl}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Cada segmento del trazo, en orden: de donde arranca, control y final. */
function segments(): { from: number[]; control: number[]; end: number[] }[] {
  const found: { from: number[]; control: number[]; end: number[] }[] = [];
  for (let index = 0; index < recorder.ops.length; index += 1) {
    if (recorder.ops[index].name !== "moveTo") continue;
    const next = recorder.ops[index + 1];
    if (next?.name !== "quadraticCurveTo") continue;
    found.push({
      from: recorder.ops[index].args,
      control: next.args.slice(0, 2),
      end: next.args.slice(2),
    });
  }
  return found;
}

/** Grosor con el que se pinto cada segmento, en orden. */
function strokeWidths(): number[] {
  return recorder.ops
    .filter((op) => op.name === "stroke")
    .map((op) => op.args[0]);
}

describe("midpoint — src/app/sign-pdf/SignatureComposer.tsx", () => {
  it("devuelve el punto medio exacto entre dos puntos", () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
    expect(midpoint({ x: -4, y: 8 }, { x: 4, y: -8 })).toEqual({ x: 0, y: 0 });
  });
});

describe("drawStrokeSegment — src/app/sign-pdf/SignatureComposer.tsx", () => {
  it("pinta tinta continua con extremos y uniones redondeados", () => {
    const from: StrokePoint = { x: 0, y: 0 };
    const control: StrokePoint = { x: 10, y: 10 };
    const to: StrokePoint = { x: 20, y: 0 };

    drawStrokeSegment(
      recorder.context as unknown as CanvasRenderingContext2D,
      from,
      control,
      to,
      { ink: "#0b0b0c", width: 8 },
    );

    expect(recorder.context.lineCap).toBe("round");
    expect(recorder.context.lineJoin).toBe("round");
    expect(recorder.context.dash).toEqual([]);
    expect(recorder.context.dashCalls).toBe(1);
    expect(segments()).toEqual([
      { from: [0, 0], control: [10, 10], end: [20, 0] },
    ]);
  });
});

describe("SignatureComposer — src/app/sign-pdf/SignatureComposer.tsx", () => {
  it("el trazo encadena los segmentos por el punto medio, sin huecos", () => {
    open();
    scribble();

    const drawn = segments();
    expect(drawn.length).toBeGreaterThanOrEqual(3);

    // El lienzo mide el doble que su caja: (100,50) cae en (200,100).
    expect(drawn[0].from).toEqual([200, 100]);
    expect(drawn[0].control).toEqual([200, 100]);
    expect(drawn[0].end).toEqual([300, 150]);
    // Segundo movimiento: el punto capturado es el control, y el final es
    // el nuevo punto medio.
    expect(drawn[1].control).toEqual([400, 200]);
    expect(drawn[1].end).toEqual([500, 250]);
    // Al levantar el dedo se remata la cola hasta el ultimo punto.
    expect(drawn[drawn.length - 1].end).toEqual([600, 300]);

    // Continuidad: cada segmento arranca donde acabo el anterior.
    for (let index = 1; index < drawn.length; index += 1) {
      expect(drawn[index].from).toEqual(drawn[index - 1].end);
    }
  });

  it("remata el trazo en las coordenadas reales del pointerup", () => {
    open();
    const target = canvas();
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 300, clientY: 150 });
    // El dedo se sigue moviendo tras el ultimo `pointermove`: el trazo
    // tiene que llegar hasta aqui, no cortarse en el punto anterior.
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 400, clientY: 200 });

    const drawn = segments();
    // El lienzo mide el doble que su caja: (400,200) cae en (800,400).
    expect(drawn[drawn.length - 1].end).toEqual([800, 400]);
    for (let index = 1; index < drawn.length; index += 1) {
      expect(drawn[index].from).toEqual(drawn[index - 1].end);
    }
  });

  it("girar el telefono ida y vuelta no encoge ni adelgaza la tinta", () => {
    matching = [COARSE];
    open();
    scribble();

    const original = segments();
    const originalWidths = strokeWidths();
    expect(original.length).toBeGreaterThanOrEqual(3);

    recorder.ops.length = 0;
    setMedia([COARSE, LANDSCAPE]);
    expect(segments()).toEqual(original);

    recorder.ops.length = 0;
    setMedia([COARSE]);
    expect(segments()).toEqual(original);
    expect(strokeWidths()).toEqual(originalWidths);
  });

  it("exporta el mismo PNG en vertical que en apaisado", () => {
    matching = [COARSE];
    const view = open();
    bigScribble();
    const portrait = savedSize();
    view.unmount();

    recorder = newRecorder();
    mediaListeners.clear();
    saved = null;
    matching = [COARSE];
    open();
    bigScribble();

    // El giro encoge la tinta en pantalla (el lienzo apaisado es mas
    // bajo), pero eso no puede tocar la resolucion de la exportacion.
    const onScreen = segments();
    recorder.ops.length = 0;
    setMedia([COARSE, LANDSCAPE]);
    const rotated = segments();
    expect(rotated.length).toBe(onScreen.length);
    expect(rotated[0].end[1]).toBeLessThan(onScreen[0].end[1]);

    expect(savedSize()).toEqual(portrait);
  });

  it("un trazo grueso junto al borde no se recorta al exportar", () => {
    open();
    fireEvent.change(screen.getByLabelText(strings.strokeLabel), {
      target: { value: "10" },
    });

    // Trazo horizontal pegado al borde inferior: sin sumar el radio, la
    // caja de la tinta tendria altura cero y el grosor se perderia.
    const target = canvas();
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 100, clientY: 219 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 300, clientY: 219 });
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 500, clientY: 219 });

    recorder.ops.length = 0;
    // Caja: de 200-10 a 1000+10 de ancho, y el grosor entero de alto.
    expect(savedSize()).toEqual({ width: 820, height: 20 });

    const drawn = segments();
    expect(drawn.length).toBeGreaterThan(0);
    for (const item of drawn) {
      expect(item.from[1]).toBe(10);
      expect(item.end[1]).toBe(10);
    }
  });

  it("un arrastre fuera del lienzo no mete tinta invisible en la exportacion", () => {
    open();
    const target = canvas();
    // Con el puntero capturado los eventos siguen llegando aunque el
    // dedo se salga del lienzo (tipico en movil). La pantalla recorta ese
    // tramo sola, pero la exportacion reconstruye desde los puntos: sin
    // recortarlos, la caja de la tinta se dispara y la firma sale
    // encogida.
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 900, clientY: 400 });
    fireEvent.pointerUp(target, { pointerId: 1, clientX: 1200, clientY: 900 });

    // El lienzo mide 1280x440: ningun punto pintado puede pasar de ahi.
    const drawn = segments();
    expect(drawn.length).toBeGreaterThan(0);
    for (const item of drawn) {
      for (const [x, y] of [item.from, item.control, item.end]) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(1280);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(440);
      }
    }
    expect(drawn[drawn.length - 1].end).toEqual([1280, 440]);

    // Caja de la tinta: de (200,100) a la esquina recortada (1280,440),
    // mas el radio del trazo (4) por cada lado.
    expect(savedSize()).toEqual({ width: 1088, height: 348 });
  });

  it("girar el telefono a mitad de un trazo no borra lo dibujado", () => {
    matching = [COARSE];
    open();
    const target = canvas();
    // El dedo sigue apoyado: no hay `pointerup`.
    fireEvent.pointerDown(target, { pointerId: 1, clientX: 60, clientY: 20 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 300, clientY: 120 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 600, clientY: 210 });

    recorder.ops.length = 0;
    setMedia([COARSE, LANDSCAPE]);

    // El lienzo apaisado (320 de alto) no admite los 424 que ocupa el
    // trazo en curso con su radio, asi que se repinta encogido.
    const scale = 320 / 424;
    const drawn = segments();
    expect(drawn.length).toBeGreaterThanOrEqual(2);
    expect(drawn[0].from[0]).toBeCloseTo(120 * scale, 6);
    expect(drawn[0].from[1]).toBeCloseTo(40 * scale, 6);
    expect(drawn[drawn.length - 1].end[0]).toBeCloseTo(1200 * scale, 6);
    for (let index = 1; index < drawn.length; index += 1) {
      expect(drawn[index].from).toEqual(drawn[index - 1].end);
    }
  });

  it("ningun trazo se dibuja con la linea discontinua activa", () => {
    open();
    scribble();

    expect(recorder.context.dash).toEqual([]);
    for (const op of recorder.ops) {
      if (op.name === "setLineDash") expect(op.args).toEqual([]);
    }
    expect(recorder.context.lineCap).toBe("round");
    expect(recorder.context.lineJoin).toBe("round");
  });

  it("volver al modo de dibujo no arrastra el trazo anterior", () => {
    open();
    scribble();

    fireEvent.click(screen.getByRole("tab", { name: strings.modeType }));
    fireEvent.click(screen.getByRole("tab", { name: strings.modeDraw }));
    fireEvent.click(screen.getByRole("button", { name: strings.save }));

    expect(screen.getByRole("alert").textContent).toBe(strings.emptyWarning);
  });

  it("en un movil en vertical invita a girar el telefono", () => {
    matching = [COARSE];
    open();

    expect(screen.getByText(strings.rotateHint)).toBeTruthy();
  });

  it("con raton no molesta con el aviso de girar", () => {
    open();

    expect(screen.queryByText(strings.rotateHint)).toBeNull();
  });

  it("girar el telefono ensancha el lienzo y retira el aviso", () => {
    matching = [COARSE];
    open();

    const portraitWidth = canvas().width;
    const portraitHeight = canvas().height;
    expect(portraitWidth).toBeGreaterThan(0);

    setMedia([COARSE, LANDSCAPE]);

    expect(canvas().width).toBeGreaterThan(portraitWidth);
    expect(canvas().height).toBeLessThan(portraitHeight);
    expect(screen.queryByText(strings.rotateHint)).toBeNull();
  });

  it("en pantalla completa el lienzo de iniciales llena el hueco, igual que el de firma", () => {
    // Antes de la correccion, `!initials` excluia siempre a las iniciales
    // de `fillCanvas` y el lienzo se quedaba en la caja fija pequeña
    // aunque `fullscreen` fuera cierto en un movil real.
    matching = [COARSE, FULLSCREEN];
    open("initials");

    expect(canvas().className).toContain("h-full");
    expect(canvas().className).toContain("w-full");
    expect(canvas().className).not.toContain("mx-auto");
    expect(canvas().style.aspectRatio).toBe("");
  });

  it("en pantalla completa el lienzo de firma sigue llenando el hueco (sin regresion)", () => {
    matching = [COARSE, FULLSCREEN];
    open("signature");

    expect(canvas().className).toContain("h-full");
    expect(canvas().className).toContain("w-full");
    expect(canvas().className).not.toContain("mx-auto");
    expect(canvas().style.aspectRatio).toBe("");
  });

  it("fuera de pantalla completa las iniciales siguen en su caja fija pequeña", () => {
    // Sin `fullscreen` (p. ej. la tarjeta compacta de escritorio),
    // `fillCanvas` debe seguir siendo falso: no se toca ese caso.
    matching = [COARSE, LANDSCAPE];
    open("initials");

    expect(canvas().className).toContain("mx-auto");
    expect(canvas().style.aspectRatio).not.toBe("");
  });
});
