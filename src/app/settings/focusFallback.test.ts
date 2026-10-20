// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusFallbackWhenIdle } from "@/app/settings/focusFallback";

/** Foco de respaldo tras cerrar una hoja cuando el botón que la abrió ya no existe (U4.7). */

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="fallback">Fallback</button><button id="other">Otro</button>';
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const fallback = () => document.getElementById("fallback");

describe("focusFallbackWhenIdle", () => {
  it("si el foco cayó en <body>, lo lleva al destino", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    focusFallbackWhenIdle(fallback);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(fallback());
  });

  it("si el foco ya está en otra parte, no lo toca", () => {
    document.getElementById("other")?.focus();
    focusFallbackWhenIdle(fallback);
    vi.advanceTimersByTime(200);
    expect(document.activeElement?.id).toBe("other");
  });

  it("espera a que la hoja termine de salir (mientras haya un diálogo modal no mueve el foco)", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    focusFallbackWhenIdle(fallback);
    vi.advanceTimersByTime(600);
    expect(document.activeElement).not.toBe(fallback());
    dialog.remove();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(fallback());
  });

  it("se rinde tras el plazo si la hoja no sale nunca", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    focusFallbackWhenIdle(fallback, 300);
    vi.advanceTimersByTime(2000);
    dialog.remove();
    vi.advanceTimersByTime(500);
    expect(document.activeElement).not.toBe(fallback());
  });

  it("un destino que ya no existe no rompe nada", () => {
    (document.activeElement as HTMLElement | null)?.blur();
    focusFallbackWhenIdle(() => null);
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
  });
});
