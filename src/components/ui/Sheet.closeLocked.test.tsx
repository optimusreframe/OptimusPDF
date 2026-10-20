import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetReducedMotionPrefCache } from "@/hooks/useReducedMotionPref";
import { Sheet } from "./Sheet";

/*
 * `closeLocked` (opt-in): mientras es verdadero la hoja NO se cierra (ni Escape, ni el fondo, ni la X, ni el arrastre), avisa
 * de cada intento con `onCloseBlocked` y se cierra con normalidad en cuanto se desbloquea. Lo usa «Importar paquete» para no
 * perder su resultado si se cierra mientras se escribe. Sin la opción, la hoja se comporta como siempre.
 */

const translateY = (element: HTMLElement): number | null => {
  const match = /translateY\((-?[\d.]+)px\)/.exec(element.style.transform);
  return match ? Number(match[1]) : null;
};
const scrim = () => document.querySelector<HTMLElement>("[data-sheet-scrim]")!;
const frames = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

function matchMediaStub(): (query: string) => MediaQueryList {
  return (query: string) =>
    ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }) as unknown as MediaQueryList;
}

function Harness({ locked, onClose, onBlocked }: { locked: boolean; onClose: () => void; onBlocked?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <Sheet
      open={open}
      onClose={() => {
        onClose();
        setOpen(false);
      }}
      title="Importar"
      closeLabel="Cerrar"
      closeLocked={locked}
      onCloseBlocked={onBlocked}
    >
      <button type="button">Aceptar</button>
    </Sheet>
  );
}

function pointer(kind: "pointerDown" | "pointerMove" | "pointerUp", element: Element, init: { pointerId: number; pointerType: string; clientY: number; button?: number }, timeStamp: number) {
  const event = createEvent[kind](element, init);
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  fireEvent(element, event);
}

beforeEach(() => {
  window.matchMedia = matchMediaStub();
  resetReducedMotionPrefCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetReducedMotionPrefCache();
  MotionGlobalConfig.skipAnimations = true;
});

describe("Sheet · closeLocked", () => {
  it("bloqueada: Escape, el fondo y la X no cierran, cada intento avisa y la X lo dice con aria-disabled", async () => {
    const onClose = vi.fn();
    const onBlocked = vi.fn();
    render(<Harness locked onClose={onClose} onBlocked={onBlocked} />);
    const close = screen.getByRole("button", { name: "Cerrar" });
    expect(close.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(scrim());
    fireEvent.click(close);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onClose).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector("[data-sheet-closing]")).toBeNull();
  });

  it("arrastrar para cerrar mientras está bloqueada: el panel vuelve a su sitio y no se cierra", async () => {
    const onClose = vi.fn();
    const onBlocked = vi.fn();
    render(<Harness locked onClose={onClose} onBlocked={onBlocked} />);
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    const header = screen.getByRole("heading", { name: "Importar" }).parentElement!;
    let now = 1000;
    pointer("pointerDown", header, { pointerId: 9, pointerType: "touch", button: 0, clientY: 100 }, now);
    for (const y of [110, 140, 180]) {
      now += 16;
      pointer("pointerMove", dialog, { pointerId: 9, pointerType: "touch", clientY: y }, now);
    }
    pointer("pointerUp", dialog, { pointerId: 9, pointerType: "touch", clientY: 180 }, now);
    await frames();
    await waitFor(() => expect(translateY(dialog)).toBeCloseTo(0, 0));
    expect(onClose).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it("al desbloquear se cierra con normalidad y la X deja de decir aria-disabled", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Harness locked onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onClose).not.toHaveBeenCalled();
    rerender(<Harness locked={false} onClose={onClose} />);
    expect(screen.getByRole("button", { name: "Cerrar" }).hasAttribute("aria-disabled")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sin la opción la hoja se cierra como siempre (Escape y X)", async () => {
    const onClose = vi.fn();
    const onBlocked = vi.fn();
    render(<Harness locked={false} onClose={onClose} onBlocked={onBlocked} />);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
