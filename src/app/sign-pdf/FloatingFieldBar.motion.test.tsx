import { forwardRef, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { FloatingFieldBar } from "@/app/sign-pdf/FloatingFieldBar";
import { springs, withCrossFadeOpacity } from "@/lib/motion";

/**
 * Animacion de la barra flotante (W5-U5). La de EDITAR entra y sale SOLO con opacidad: un resorte de escala dejaba su
 * caja moviendose ~1 s y nada que mida su posicion (un dedo, un clic automatico con reintentos) la daba por quieta.
 * La de FIRMAR conserva EXACTAMENTE la animacion de HEAD (escala 0,92 -> 1, salida 0,96, muelle `snappy`).
 */

type Captured = { initial: unknown; animate: unknown; exit: unknown; transition: unknown };
const seen: Captured[] = [];

vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>();
  const MotionDiv = forwardRef<HTMLDivElement, Record<string, unknown>>(function MotionDiv(props, ref) {
    const { initial, animate, exit, transition, children, style, ...rest } = props;
    seen.push({ initial, animate, exit, transition });
    const domProps: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (!key.startsWith("whileHover") && !key.startsWith("whileTap") && !key.startsWith("layout")) domProps[key] = value;
    }
    return (
      <div ref={ref} style={style as React.CSSProperties} {...domProps}>
        {children as React.ReactNode}
      </div>
    );
  });
  return { ...actual, motion: { ...actual.motion, div: MotionDiv } };
});

const rect = (top: number, height: number, left = 0, width = 375) =>
  ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) }) as DOMRect;

function Harness({ aboveSticky }: { aboveSticky?: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={stageRef}>
        <div ref={clipRef}>
          <div ref={hostRef}>
            <div data-element-kind="text" data-element-id="a" data-drag-mode="move" />
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
  seen.length = 0;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.hasAttribute("data-element-id")) return rect(400, 20, 60, 120);
    if (this.hasAttribute("data-floating-bar")) return rect(0, 44, 0, 300);
    return rect(100, 900, 0, 1200);
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 44 });
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 1200 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error — restaura los accesores de prueba
  delete HTMLElement.prototype.offsetWidth;
  // @ts-expect-error — idem
  delete HTMLElement.prototype.offsetHeight;
});

const hasTransform = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Object.keys(value).some((key) => /^(scale|scaleX|scaleY|transform|x|y|rotate|skew)/.test(key));

async function mounted(aboveSticky: boolean): Promise<Captured> {
  render(<Harness aboveSticky={aboveSticky} />);
  await waitFor(() => expect(document.querySelector("[data-floating-bar]")).not.toBeNull());
  const last = seen[seen.length - 1];
  expect(last).toBeDefined();
  return last;
}

describe("FloatingFieldBar: animacion de entrada y salida", () => {
  it("la barra de EDITAR (aboveSticky) entra y sale SOLO con opacidad: ni escala ni transformaciones", async () => {
    const motion = await mounted(true);
    for (const phase of [motion.initial, motion.animate, motion.exit]) {
      expect(hasTransform(phase)).toBe(false);
      expect(phase).toHaveProperty("opacity");
    }
    expect(motion.initial).toEqual({ opacity: 0 });
    expect(motion.animate).toEqual({ opacity: 1 });
    // Tween corto (sin resorte: un resorte deja la caja moviendose ~1 s).
    expect(motion.transition).toEqual({ duration: 0.1 });
    expect((motion.exit as { transition?: unknown }).transition).toEqual({ duration: 0.1 });
    // Ningun fotograma de ninguna renderizacion declara escala.
    for (const entry of seen) {
      expect(hasTransform(entry.initial)).toBe(false);
      expect(hasTransform(entry.animate)).toBe(false);
      expect(hasTransform(entry.exit)).toBe(false);
    }
  });

  it("la barra de FIRMAR conserva la animacion de HEAD (escala 0,92 -> 1, salida a 0,96, muelle snappy)", async () => {
    const motion = await mounted(false);
    expect(motion.initial).toEqual({ opacity: 0, scale: 0.92 });
    expect(motion.animate).toEqual({ opacity: 1, scale: 1 });
    expect(motion.exit).toEqual({ opacity: 0, scale: 0.96, transition: { duration: 0.12 } });
    expect(motion.transition).toEqual(withCrossFadeOpacity(springs.snappy));
  });
});
