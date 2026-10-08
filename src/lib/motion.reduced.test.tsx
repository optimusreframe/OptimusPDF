import { act, render } from "@testing-library/react";
import { MotionConfig, animate, motion } from "motion/react";
import { describe, expect, it } from "vitest";
import { reducedAnimateOptions } from "./motion";

/*
 * Integracion con el motor de `motion` en jsdom: comprueba el modelo de
 * reduced motion (solo cambia COMO se llega al estado final, nunca el
 * estado final). jsdom se crea con pretendToBeVisual, asi que hay
 * requestAnimationFrame real (~16ms).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const translateX = (el: HTMLElement) => {
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform);
  return m ? Number(m[1]) : null;
};

describe("animate(elementoDOM) con reducedAnimateOptions", () => {
  it("con reduceMotion:true, tras 1 frame x esta en destino y opacity sigue en camino", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    animate(el, { x: -300, opacity: 0.2 }, reducedAnimateOptions({ duration: 1 }, true));
    await sleep(60);

    expect(translateX(el)).toBe(-300);
    const opacity = Number(el.style.opacity);
    expect(opacity).toBeGreaterThan(0.2);
    expect(opacity).toBeLessThan(1);
    el.remove();
  });

  it("sin reduceMotion, tras 1 frame x todavia NO esta en destino (control)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    animate(el, { x: -300 }, reducedAnimateOptions({ duration: 1 }, false));
    await sleep(60);

    const x = translateX(el);
    expect(x).not.toBeNull();
    expect(x).toBeGreaterThan(-300);
    el.remove();
  });
});

describe("<MotionConfig reducedMotion=\"always\">", () => {
  it("animate={{x:-300, opacity:0}} termina con translateX(-300px) y opacity 0 (estado final intacto)", async () => {
    const { getByTestId } = render(
      <MotionConfig reducedMotion="always">
        <motion.div
          data-testid="box"
          initial={{ x: 0, opacity: 1 }}
          animate={{ x: -300, opacity: 0 }}
          transition={{ duration: 0.1 }}
        />
      </MotionConfig>,
    );
    const box = getByTestId("box");

    await act(async () => {
      await sleep(400);
    });

    expect(translateX(box)).toBe(-300);
    expect(Number(box.style.opacity)).toBe(0);
  });

  it("initial={false}: no hay animacion de montaje, el estado final esta desde el primer frame", async () => {
    const { getByTestId } = render(
      <MotionConfig reducedMotion="always">
        <motion.div
          data-testid="box"
          initial={false}
          animate={{ x: -300, opacity: 0.4 }}
          transition={{ duration: 1 }}
        />
      </MotionConfig>,
    );
    const box = getByTestId("box");

    expect(translateX(box)).toBe(-300);
    expect(Number(box.style.opacity)).toBe(0.4);

    await act(async () => {
      await sleep(40);
    });
    expect(translateX(box)).toBe(-300);
    expect(Number(box.style.opacity)).toBe(0.4);
  });
});
