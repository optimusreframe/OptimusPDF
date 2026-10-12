import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetCropOverlayForTests,
  getCropOverlay,
  publishCropOverlay,
  requestCropRect,
  subscribeCropOverlay,
  subscribeCropRequests,
} from "@/app/pdf-pro/ops/cropOverlay";

/** Gancho `cropOverlay` entre el panel de Recortar y el visor (U3). */

afterEach(() => __resetCropOverlayForTests());

const RECT = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

describe("cropOverlay", () => {
  it("publica y retira la seleccion, avisando a los suscritos", () => {
    const listener = vi.fn();
    subscribeCropOverlay(listener);
    expect(getCropOverlay()).toBeNull();
    publishCropOverlay({ rect: RECT, pageIndex: 2 });
    expect(getCropOverlay()).toEqual({ rect: RECT, pageIndex: 2 });
    publishCropOverlay(null);
    expect(getCropOverlay()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("darse de baja deja de avisar", () => {
    const listener = vi.fn();
    const off = subscribeCropOverlay(listener);
    off();
    publishCropOverlay({ rect: RECT, pageIndex: 0 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("el visor pide una seleccion y el panel suscrito la recibe", () => {
    const listener = vi.fn();
    subscribeCropRequests(listener);
    requestCropRect(RECT);
    expect(listener).toHaveBeenCalledWith(RECT);
  });

  it("sin panel suscrito pedir una seleccion no hace nada ni falla", () => {
    expect(() => requestCropRect(RECT)).not.toThrow();
  });

  it("varios suscritos reciben cada peticion y la baja es individual", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeCropRequests(a);
    subscribeCropRequests(b);
    requestCropRect(RECT);
    offA();
    requestCropRect(RECT);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });
});
