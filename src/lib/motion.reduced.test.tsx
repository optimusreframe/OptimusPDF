import { act, render, waitFor } from "@testing-library/react";
import { MotionConfig, MotionGlobalConfig, animate, motion } from "motion/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reducedAnimateOptions } from "./motion";

/*
 * Integracion con el motor de `motion` en jsdom: comprueba el modelo de
 * reduced motion (solo cambia COMO se llega al estado final, nunca el
 * estado final). jsdom se crea con pretendToBeVisual, asi que hay
 * requestAnimationFrame real (~16ms).
 *
 * Este archivo prueba el propio motor, asi que necesita la interpolacion
 * real: el setup global activa `skipAnimations` (ver vitest.setup.dom.ts)
 * y aqui se desactiva. En vez de dormir un plazo fijo y esperar que hayan
 * pasado "los frames justos", cada espera es un `waitFor` sobre el estado
 * que importa, de modo que no depende de lo cargada que este la maquina.
 */

beforeAll(() => {
  MotionGlobalConfig.skipAnimations = false;
});
afterAll(() => {
  MotionGlobalConfig.skipAnimations = true;
});

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
    // x salta al destino en el primer frame; opacity (duracion 1 s) sigue en
    // camino. En ese primer frame opacity aun vale 1 (t = 0), por eso se
    // espera a que haya avanzado algo antes de comprobar que no ha llegado.
    await waitFor(() => {
      expect(translateX(el)).toBe(-300);
      expect(Number(el.style.opacity)).toBeLessThan(1);
    });
    expect(Number(el.style.opacity)).toBeGreaterThan(0.2);
    el.remove();
  });

  it("sin reduceMotion, tras 1 frame x todavia NO esta en destino (control)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    animate(el, { x: -300 }, reducedAnimateOptions({ duration: 1 }, false));
    // Espera a que se pinte el primer frame (x deja de ser null) y comprueba
    // que sigue en camino en vez de haber saltado al destino.
    await waitFor(() => expect(translateX(el)).not.toBeNull());

    expect(translateX(el)).toBeGreaterThan(-300);
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

    await waitFor(() => expect(Number(box.style.opacity)).toBe(0));

    expect(translateX(box)).toBe(-300);
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
