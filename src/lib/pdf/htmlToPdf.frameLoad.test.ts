import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPolledOnload } from "@/lib/pdf/htmlToPdf";

/**
 * Safari no ejecuta manejadores de eventos sobre los elementos de un documento sin scripts (el iframe aislado de
 * `htmlToPdf`), y html2canvas espera `iframe.onload` en el iframe de clonado que crea ahi dentro: la conversion se
 * quedaba en el 11 % para siempre. `installPolledOnload` da a ese iframe un `onload` que dispara la PAGINA al ver
 * `readyState === "complete"`. Aqui no hay DOM (entorno node): el iframe se simula con un objeto que solo tiene lo que
 * el codigo lee (`contentDocument.readyState`).
 */
type FakeFrame = { contentDocument: { readyState: string } | null; onload?: unknown };

function makeFrame(readyState = "loading"): { frame: FakeFrame; typed: HTMLIFrameElement } {
  const frame: FakeFrame = { contentDocument: { readyState } };
  installPolledOnload(frame as unknown as HTMLIFrameElement);
  return { frame, typed: frame as unknown as HTMLIFrameElement };
}

describe("installPolledOnload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("llama al manejador UNA vez, con el iframe como this y un evento load, cuando el documento esta complete", () => {
    const { frame, typed } = makeFrame("loading");
    const handler = vi.fn(function (this: unknown, event: Event) {
      return [this, event.type];
    });
    frame.onload = handler;
    vi.advanceTimersByTime(500);
    expect(handler).not.toHaveBeenCalled();

    frame.contentDocument!.readyState = "interactive";
    vi.advanceTimersByTime(500);
    expect(handler).not.toHaveBeenCalled();

    frame.contentDocument!.readyState = "complete";
    vi.advanceTimersByTime(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.contexts[0]).toBe(typed);
    expect(handler.mock.calls[0][0].type).toBe("load");

    vi.advanceTimersByTime(5000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("si el manejador se retira (onload = null, como hace html2canvas dentro del suyo), no se llama", () => {
    const { frame } = makeFrame("loading");
    const handler = vi.fn();
    frame.onload = handler;
    frame.onload = null;
    frame.contentDocument!.readyState = "complete";
    vi.advanceTimersByTime(1000);
    expect(handler).not.toHaveBeenCalled();
    expect(frame.onload).toBeNull();
  });

  it("html2canvas se desasigna dentro de su propio manejador sin que se vuelva a disparar", () => {
    const { frame } = makeFrame("complete");
    const handler = vi.fn(() => {
      frame.onload = null;
    });
    frame.onload = handler;
    vi.advanceTimersByTime(1000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reasignar el manejador antes de que cargue sustituye al anterior", () => {
    const { frame } = makeFrame("loading");
    const first = vi.fn();
    const second = vi.fn();
    frame.onload = first;
    frame.onload = second;
    frame.contentDocument!.readyState = "complete";
    vi.advanceTimersByTime(200);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("un documento que nunca termina no deja el temporizador vivo para siempre (a los 15 s se entrega igual)", () => {
    const { frame } = makeFrame("loading");
    const handler = vi.fn();
    frame.onload = handler;
    vi.advanceTimersByTime(14_000);
    expect(handler).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("un contentDocument ilegible o ausente cuenta como «aun no cargado»", () => {
    const { frame } = makeFrame("loading");
    frame.contentDocument = null;
    const handler = vi.fn();
    frame.onload = handler;
    vi.advanceTimersByTime(1000);
    expect(handler).not.toHaveBeenCalled();
  });
});
