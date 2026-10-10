import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FloatingFieldBar } from "@/app/sign-pdf/FloatingFieldBar";

/**
 * La barra flotante nunca debe quedar TAPADA por la barra de zoom y paginas (W5-U5 · B1): con la nav
 * a media pantalla (aun sin fijar arriba), la colocacion «encima del bloque» caia DENTRO de ella
 * y la nav (z-30) tapaba Fuente/tamano/color. Editar lo pide con `avoidSticky`; Firmar no.
 */

const rect = (top: number, height: number, left = 0, width = 375) =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

function Harness({
  aboveSticky,
  selectionId = "a",
  onChildClick,
  withHandle,
}: {
  aboveSticky?: boolean;
  selectionId?: string | null;
  onChildClick?: () => void;
  /** Un tirador externo de 44 px bajo el bloque (D1). */
  withHandle?: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div data-canvas-sticky="" style={{ top: "12px" }} />
      <div ref={stageRef} data-stage="">
        <div ref={clipRef}>
          <div ref={hostRef} data-host="">
            <div data-element-kind="text" data-element-id="a" data-drag-mode="move" />
            <div data-element-kind="text" data-element-id="b" data-drag-mode="move" />
            {withHandle ? <div data-resize-handle="se" /> : null}
          </div>
        </div>
      </div>
      {/* Hermana de la hoja (no hija): asi las referencias ya estan puestas al medir la primera vez. */}
      <div>
        <FloatingFieldBar
          stageRef={stageRef}
          clipRef={clipRef}
          hostRef={hostRef}
          selection={selectionId === null ? null : { kind: "text", id: selectionId }}
          layoutKey="k"
          label="Opciones"
          onEscape={() => {}}
          onTabBackward={() => {}}
          onTabForward={() => false}
          aboveSticky={aboveSticky}
        >
          <button type="button" onClick={onChildClick}>
            x
          </button>
        </FloatingFieldBar>
      </div>
    </div>
  );
}

const HANDLE = { top: 420 };
const NAV = { top: 300, height: 44 }; // pegajosa pero aun SIN fijar: top 300 > 12
const STAGE_TOP = 350;

beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-canvas-sticky")) return rect(NAV.top, NAV.height);
    if (this.hasAttribute("data-resize-handle")) return rect(HANDLE.top, 44, 180, 44);
    if (this.hasAttribute("data-element-id")) return rect(400, 20, 60, 120);
    if (this.hasAttribute("data-stage") || this.hasAttribute("data-host")) return rect(STAGE_TOP, 900);
    if (this.hasAttribute("data-floating-bar")) return rect(0, 100, 0, 300);
    if (this.tagName === "HEADER") return rect(0, 0);
    return rect(STAGE_TOP, 900);
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 100 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 375 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error — restaura los accesores de prueba
  delete HTMLElement.prototype.offsetWidth;
  // @ts-expect-error — idem
  delete HTMLElement.prototype.offsetHeight;
});

/** Borde superior de la barra en coordenadas de ventana. */
async function barTop(): Promise<number> {
  const bar = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-floating-bar]");
    expect(el).not.toBeNull();
    expect(el!.style.visibility).toBe("visible");
    return el!;
  });
  return Number.parseFloat(bar.style.top) + STAGE_TOP;
}

describe("FloatingFieldBar y la barra de zoom/paginas", () => {
  it("con aboveSticky la barra va POR ENCIMA de la nav (z-40 > z-30): sus controles reciben el toque aunque caiga sobre ella", async () => {
    render(<Harness aboveSticky />);
    // Sigue encima del bloque (la nav aun no esta fijada): el bloque queda libre para volver a tocarlo.
    expect(await barTop()).toBeLessThan(NAV.top + NAV.height);
    const bar = document.querySelector<HTMLElement>("[data-floating-bar]")!;
    expect(bar.className).toContain("z-40");
    expect(bar.className).not.toContain("z-20");
  });

  it("sin aboveSticky (Firmar) se conserva el comportamiento de siempre: misma colocacion y z-20", async () => {
    render(<Harness />);
    expect(await barTop()).toBeLessThan(NAV.top + NAV.height);
    const bar = document.querySelector<HTMLElement>("[data-floating-bar]")!;
    expect(bar.className).toContain("z-20");
    expect(bar.className).not.toContain("z-40");
  });

  it("Firmar (sin aboveSticky) ignora la ventana visual: con teclado virtual la barra se coloca igual que sin el; Editar si la usa", async () => {
    const setVisual = (visual: { offsetTop: number; height: number } | undefined) =>
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: visual && { ...visual, addEventListener: () => {}, removeEventListener: () => {} },
      });
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
    try {
      const layout = async (above: boolean, visual: { offsetTop: number; height: number } | undefined) => {
        cleanup();
        setVisual(visual);
        render(<Harness aboveSticky={above} />);
        await barTop();
        const bar = document.querySelector<HTMLElement>("[data-floating-bar]")!;
        return { top: bar.style.top, left: bar.style.left, docked: bar.hasAttribute("data-docked"), side: bar.getAttribute("data-side") };
      };
      const none = await layout(false, undefined);
      const keyboard = { offsetTop: 0, height: 420 };
      expect(await layout(false, keyboard)).toEqual(none);
      // Mutacion: Editar la activa (EditFloatingBar y ElementFloatingBar pasan `aboveSticky`) y SI cambia.
      const editNone = await layout(true, undefined);
      const editKeyboard = await layout(true, keyboard);
      expect(editKeyboard).not.toEqual(editNone);
    } finally {
      setVisual(undefined);
      Object.defineProperty(window, "innerHeight", { configurable: true, value: originalHeight });
    }
  });

  it("con la nav YA fijada arriba la barra sigue colocandose debajo de ella (comportamiento previo, con y sin la opcion)", async () => {
    for (const above of [true, false]) {
      cleanup();
      NAV.top = 12; // pegada: top == su `top` de estilo
      render(<Harness aboveSticky={above} />);
      expect(await barTop()).toBeGreaterThanOrEqual(12 + NAV.height);
      NAV.top = 300;
    }
  });

  it("la descripcion accesible se enlaza al grupo y se lee una vez", async () => {
    function WithDescription() {
      const stageRef = useRef<HTMLDivElement>(null);
      const clipRef = useRef<HTMLDivElement>(null);
      const hostRef = useRef<HTMLDivElement>(null);
      return (
        <>
          <div ref={stageRef} data-stage="">
            <div ref={clipRef}>
              <div ref={hostRef} data-host="">
                <div data-element-kind="text" data-element-id="a" data-drag-mode="move" />
              </div>
            </div>
          </div>
          <FloatingFieldBar
            stageRef={stageRef}
            clipRef={clipRef}
            hostRef={hostRef}
            selection={{ kind: "text", id: "a" }}
            layoutKey="k"
            label="Opciones"
            description="Alt y flechas cambian el tamaño"
            onEscape={() => {}}
            onTabBackward={() => {}}
            onTabForward={() => false}
          >
            <button type="button">x</button>
          </FloatingFieldBar>
        </>
      );
    }
    render(<WithDescription />);
    const bar = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-floating-bar]");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(document.getElementById(bar.getAttribute("aria-describedby")!)!.textContent).toBe("Alt y flechas cambian el tamaño");
  });
});

describe("FloatingFieldBar acoplada cuando no cabe sin tapar el elemento (W5-U5 · N1)", () => {
  /** Una barra altisima (500) no cabe ni arriba ni abajo del bloque en una ventana de 768. */
  function tall(height = 500) {
    // Solo la barra: la sonda de la zona segura tambien lee `offsetHeight`.
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-floating-bar") ? height : 0;
      },
    });
  }

  it("con aboveSticky se ACOPLA al borde inferior util (fixed) y desplaza la pagina para que el bloque quede encima", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    tall();
    render(<Harness aboveSticky />);
    const bar = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-floating-bar]");
      expect(el).not.toBeNull();
      expect(el!.hasAttribute("data-docked")).toBe(true);
      return el!;
    });
    expect(bar.className).toContain("fixed");
    // safeBottom = 768 - 8,75 rem (140) = 628; arriba: 628 - 500 - 4.
    expect(Number.parseFloat(bar.style.top)).toBe(124);
    // El bloque (y 400..420) pasaria por debajo del borde superior de la barra (124): se sube la pagina.
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0][0]).toMatchObject({ top: 304 });
  });

  it("(D1) el ancla incluye los tiradores externos: el desplazamiento al acoplar deja el TIRADOR (no solo el bloque) sobre la barra", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    tall();
    render(<Harness aboveSticky withHandle />);
    await waitFor(() => expect(document.querySelector("[data-docked]")).not.toBeNull());
    expect(scroll).toHaveBeenCalledTimes(1);
    // Sin tirador el desplazamiento es 304 (hasta el borde inferior del bloque + 8); con el tirador de 44 px, 348.
    expect(scroll.mock.calls[0][0]).toMatchObject({ top: 348 });
  });

  it("(D1) si la barra cabe pero la paleta fija taparia los tiradores, la pagina sube lo justo (una vez)", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    // Tirador de 640 a 684; zona libre hasta 528 (768 - 140 de barras fijas - 100 de la sonda simulada).
    HANDLE.top = 640;
    try {
      render(<Harness aboveSticky withHandle />);
      await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.calls[0][0]).toMatchObject({ top: 158 }); // 684 + 2 - 528
    } finally {
      HANDLE.top = 420;
    }
  });

  it("(D1) Firmar ignora los tiradores: misma colocacion que sin ellos", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    tall();
    render(<Harness withHandle />);
    await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
    expect(document.querySelector("[data-docked]")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });

  it("desplaza UNA sola vez por seleccion/geometria (no pelea con el scroll)", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    tall();
    render(<Harness aboveSticky />);
    await waitFor(() => expect(document.querySelector("[data-docked]")).not.toBeNull());
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("sin aboveSticky (Firmar) NO se acopla ni desplaza: el comportamiento de siempre", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    tall();
    render(<Harness />);
    await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
    expect(document.querySelector("[data-docked]")).toBeNull();
    expect(document.querySelector("[data-floating-bar]")!.className).toContain("absolute");
    expect(scroll).not.toHaveBeenCalled();
  });

  it("con el teclado virtual abierto las barras fijas de abajo ya no restan sitio: se acopla al borde de la ventana visual", async () => {
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: { offsetTop: 0, height: 468, addEventListener() {}, removeEventListener() {} } });
    tall(450);
    render(<Harness aboveSticky />);
    const bar = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-docked]");
      expect(el).not.toBeNull();
      return el!;
    });
    // Ventana visual = 468 (768 - 300 de teclado): safeBottom = 468 - 4; barra de 450 -> top 10.
    // (Con la reserva de las barras fijas de abajo, 8,75 rem, no habria sitio: top = 0.)
    expect(Number.parseFloat(bar.style.top)).toBe(10);
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  });

  function mockVisualViewport(initial: number) {
    const target = new EventTarget();
    const state = { offsetTop: 0, height: initial };
    Object.defineProperties(target, {
      height: { get: () => state.height },
      offsetTop: { get: () => state.offsetTop },
    });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: target });
    return {
      resize(height: number) {
        state.height = height;
        target.dispatchEvent(new Event("resize"));
      },
    };
  }

  it("(N6) si el teclado se abre DESPUES de acoplar, la barra sube y la pagina se vuelve a desplazar (una vez, tras estabilizarse)", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    const viewport = mockVisualViewport(768);
    tall();
    try {
      render(<Harness aboveSticky />);
      await waitFor(() => expect(document.querySelector("[data-docked]")).not.toBeNull());
      expect(scroll).toHaveBeenCalledTimes(1);
      const before = Number.parseFloat(document.querySelector<HTMLElement>("[data-docked]")!.style.top);
      // El teclado se anima: varias alturas seguidas; no se desplaza mientras cambia.
      viewport.resize(600);
      viewport.resize(520);
      viewport.resize(468);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(scroll).toHaveBeenCalledTimes(1);
      // La barra ya subio por encima del teclado.
      const during = Number.parseFloat(document.querySelector<HTMLElement>("[data-docked]")!.style.top);
      expect(during).toBeLessThan(before);
      // Estable: un unico desplazamiento mas, calculado con la geometria final.
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(scroll).toHaveBeenCalledTimes(2);
      // Eventos repetidos con el mismo alto no vuelven a desplazar.
      viewport.resize(468);
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(scroll).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    }
  });

  function touchDown() {
    const event = new Event("pointerdown", { bubbles: true });
    Object.defineProperty(event, "pointerType", { value: "touch" });
    window.dispatchEvent(event);
  }

  it("(N6) tras seleccionar CON EL DEDO, los eventos de raton fantasma no llegan a la barra; un toque nuevo si", async () => {
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
    tall();
    const clicked = vi.fn();
    const { rerender } = render(<Harness aboveSticky selectionId="a" onChildClick={clicked} />);
    await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
    // Un toque con el dedo selecciona OTRO elemento; la barra aparece bajo el dedo y el navegador le manda los eventos
    // de raton de compatibilidad (sin `pointerdown` propio).
    touchDown();
    rerender(<Harness aboveSticky selectionId="b" onChildClick={clicked} />);
    const button = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-floating-bar] button");
      expect(el).not.toBeNull();
      return el!;
    });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(button);
    expect(clicked).not.toHaveBeenCalled();
    // Un toque NUEVO sobre la barra (con su pointerdown) si funciona, aun dentro de la ventana.
    fireEvent.pointerDown(button, { pointerId: 2, pointerType: "touch" });
    fireEvent.click(button);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("(N6) sin toque previo (raton, teclado) la barra de Editar recibe los clics normalmente", async () => {
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
    tall();
    const clicked = vi.fn();
    render(<Harness aboveSticky onChildClick={clicked} />);
    const button = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-floating-bar] button");
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(button);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("(N6) la barra de Editar que SE VA deja de recibir punteros en el acto; la de Firmar no cambia", async () => {
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
    tall();
    const edit = render(<Harness aboveSticky selectionId="a" />);
    const bar = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-floating-bar]");
      expect(el).not.toBeNull();
      return el!;
    });
    await waitFor(() => expect(bar.style.pointerEvents).toBe(""));
    edit.rerender(<Harness aboveSticky selectionId={null} />);
    // Sigue en el DOM mientras sale (animacion) y ya no capta punteros.
    const leaving = document.querySelector<HTMLElement>("[data-floating-bar]");
    if (leaving) expect(leaving.style.pointerEvents).toBe("none");
    edit.unmount();

    const sign = render(<Harness selectionId="a" />);
    const signBar = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-floating-bar]");
      expect(el).not.toBeNull();
      return el!;
    });
    sign.rerender(<Harness selectionId={null} />);
    const signLeaving = document.querySelector<HTMLElement>("[data-floating-bar]") ?? signBar;
    expect(signLeaving.style.pointerEvents).toBe("");
  });

  it("(N6) Firmar no descarta nada: tras un toque, sus eventos de raton llegan igual (comportamiento de siempre)", async () => {
    window.scrollBy = vi.fn() as unknown as typeof window.scrollBy;
    tall();
    const clicked = vi.fn();
    const { rerender } = render(<Harness selectionId="a" onChildClick={clicked} />);
    await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
    touchDown();
    rerender(<Harness selectionId="b" onChildClick={clicked} />);
    const button = await waitFor(() => {
      const el = document.querySelector<HTMLElement>("[data-floating-bar] button");
      expect(el).not.toBeNull();
      return el!;
    });
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fireEvent(button, down);
    expect(down.defaultPrevented).toBe(false);
    fireEvent.click(button);
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it("(N6) Firmar con teclado simulado no cambia: ni acople ni desplazamiento ni reaccion al alto", async () => {
    const scroll = vi.fn();
    window.scrollBy = scroll as unknown as typeof window.scrollBy;
    const viewport = mockVisualViewport(768);
    tall();
    try {
      render(<Harness />);
      await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
      const top = (document.querySelector<HTMLElement>("[data-floating-bar]")!).style.top;
      viewport.resize(468);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(document.querySelector("[data-docked]")).toBeNull();
      expect(document.querySelector<HTMLElement>("[data-floating-bar]")!.style.top).toBe(top);
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
    }
  });
});


describe("FloatingFieldBar en tablas apretadas (W5-U5 · minor b)", () => {
  function Table({ aboveSticky }: { aboveSticky?: boolean }) {
    const stageRef = useRef<HTMLDivElement>(null);
    const clipRef = useRef<HTMLDivElement>(null);
    const hostRef = useRef<HTMLDivElement>(null);
    return (
      <div>
        <div ref={stageRef} data-stage="">
          <div ref={clipRef}>
            <div ref={hostRef} data-host="">
              <div data-element-kind="text" data-element-id="up" data-drag-mode="move" />
              <div data-element-kind="text" data-element-id="a" data-drag-mode="move" />
              <div data-element-kind="text" data-element-id="down" data-drag-mode="move" />
            </div>
          </div>
        </div>
        <div>
          <FloatingFieldBar
            stageRef={stageRef}
            clipRef={clipRef}
            hostRef={hostRef}
            selection={{ kind: "text", id: "a" }}
            layoutKey="k"
            label="Opciones"
            onEscape={() => {}}
            onTabBackward={() => {}}
            onTabForward={() => false}
            aboveSticky={aboveSticky}
          >
            <button type="button">x</button>
          </FloatingFieldBar>
        </div>
      </div>
    );
  }

  beforeEach(() => {
    const boxes: Record<string, DOMRect> = {
      up: rect(300, 90, 400, 90),
      a: rect(400, 16, 500, 60),
      down: rect(420, 90, 400, 90),
    };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const id = this.getAttribute("data-element-id");
      if (id && boxes[id]) return boxes[id];
      if (this.hasAttribute("data-floating-bar")) return rect(0, 44, 0, 300);
      if (this.tagName === "HEADER") return rect(0, 0, 0, 0);
      return rect(100, 900, 0, 1200);
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 44 });
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1200 });
  });

  function barLeftTop() {
    const bar = document.querySelector<HTMLElement>("[data-floating-bar]")!;
    return { left: Number.parseFloat(bar.style.left), top: Number.parseFloat(bar.style.top) + 100 };
  }
  const coversNeighbor = ({ left, top }: { left: number; top: number }) =>
    [
      { x: 400, y: 300, w: 90, h: 90 },
      { x: 400, y: 420, w: 90, h: 90 },
    ].some((n) => left < n.x + n.w && left + 300 > n.x && top < n.y + n.h && top + 44 > n.y);

  it("Editar: junto al bloque en vez de tapar a sus vecinos de arriba y abajo", async () => {
    render(<Table aboveSticky />);
    await waitFor(() => expect(document.querySelector<HTMLElement>("[data-floating-bar]")?.style.visibility).toBe("visible"));
    expect(coversNeighbor(barLeftTop())).toBe(false);
  });

  it("Firmar (sin aboveSticky) conserva la colocacion de siempre: arriba, tapando lo que haya", async () => {
    render(<Table />);
    await waitFor(() => expect(document.querySelector<HTMLElement>("[data-floating-bar]")?.style.visibility).toBe("visible"));
    expect(coversNeighbor(barLeftTop())).toBe(true);
  });
});
