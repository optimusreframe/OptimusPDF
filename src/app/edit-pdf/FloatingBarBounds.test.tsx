import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { FloatingFieldBar } from "@/app/sign-pdf/FloatingFieldBar";

/**
 * La barra flotante dentro de una region con scroll PROPIO (el modo Editar/Anotar de PDF Pro, Wave 7 · U6): la zona
 * segura es la caja visible de esa region, no la ventana, y los desplazamientos de acople van a ella. Sin region
 * (`boundsRef` ausente) todo sigue exactamente como antes.
 */

const rect = (top: number, height: number, left = 0, width = 1000) =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

const REGION = { top: 300, height: 400 }; // la region con scroll: de 300 a 700 de ventana
const STAGE_TOP = 100;
let anchor = { top: 320, height: 20 };

function Harness({ withBounds }: { withBounds: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const boundsRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={boundsRef} data-region="">
        <div ref={stageRef} data-stage="">
          <div ref={clipRef}>
            <div ref={hostRef} data-host="">
              <div data-element-kind="text" data-element-id="a" data-drag-mode="move" />
            </div>
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
          aboveSticky
          boundsRef={withBounds ? boundsRef : undefined}
        >
          <button type="button">x</button>
        </FloatingFieldBar>
      </div>
    </div>
  );
}

beforeEach(() => {
  anchor = { top: 320, height: 20 };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-region")) return rect(REGION.top, REGION.height);
    if (this.hasAttribute("data-element-id")) return rect(anchor.top, anchor.height, 60, 120);
    if (this.hasAttribute("data-floating-bar")) return rect(0, 44, 0, 300);
    if (this.hasAttribute("data-stage") || this.hasAttribute("data-host")) return rect(STAGE_TOP, 1200);
    if (this.tagName === "HEADER") return rect(0, 0);
    return rect(STAGE_TOP, 1200);
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 44 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1000 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error — restaura los accesores de prueba
  delete HTMLElement.prototype.offsetWidth;
  // @ts-expect-error — idem
  delete HTMLElement.prototype.offsetHeight;
});

async function placement() {
  const bar = await waitFor(() => {
    const el = document.querySelector<HTMLElement>("[data-floating-bar]");
    expect(el).not.toBeNull();
    expect(el!.style.visibility).toBe("visible");
    return el!;
  });
  return { side: bar.dataset.side, top: Number.parseFloat(bar.style.top) + STAGE_TOP, bar };
}

describe("FloatingFieldBar con una region de scroll propia", () => {
  it("un elemento pegado al borde superior de la region lleva la barra ABAJO (arriba quedaria fuera de ella)", async () => {
    render(<Harness withBounds />);
    const { side, top } = await placement();
    expect(side).toBe("bottom");
    expect(top).toBeGreaterThanOrEqual(REGION.top);
  });

  it("sin region, la misma geometria deja la barra arriba (la zona segura es la ventana)", async () => {
    render(<Harness withBounds={false} />);
    const { side } = await placement();
    expect(side).toBe("top");
  });

  it("un elemento por encima de la region (scroll) oculta la barra en vez de dejarla anclada al borde", async () => {
    anchor = { top: 200, height: 20 };
    render(<Harness withBounds />);
    await waitFor(() => expect(document.querySelector("[data-floating-bar]")).toBeNull(), { timeout: 1500 }).catch(() => undefined);
    const bar = document.querySelector<HTMLElement>("[data-floating-bar]");
    expect(bar === null || bar.style.visibility === "hidden").toBe(true);
  });

  it("un elemento por debajo de la region tambien la oculta", async () => {
    anchor = { top: 720, height: 20 };
    render(<Harness withBounds />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const bar = document.querySelector<HTMLElement>("[data-floating-bar]");
    expect(bar === null || bar.style.visibility === "hidden").toBe(true);
  });

  it("la barra queda dentro de la region (nunca por debajo de su borde inferior)", async () => {
    anchor = { top: 640, height: 40 };
    render(<Harness withBounds />);
    const { top, bar } = await placement();
    expect(top + 44).toBeLessThanOrEqual(REGION.top + REGION.height + 1);
    expect(bar).toBeTruthy();
  });

  it("sin region el comportamiento no cambia: un elemento fuera de la ventana util no importa", async () => {
    anchor = { top: 200, height: 20 };
    render(<Harness withBounds={false} />);
    const { bar } = await placement();
    expect(bar.dataset.side).toBeDefined();
  });
});
