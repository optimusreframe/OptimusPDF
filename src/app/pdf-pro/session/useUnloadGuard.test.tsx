import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useUnloadGuard } from "@/app/pdf-pro/session/useUnloadGuard";

function Probe({ active }: { active: boolean }) {
  useUnloadGuard(active);
  return null;
}

/**
 * `defaultPrevented` por si solo NO distingue `preventDefault()` de asignar `returnValue = ""`: el `returnValue` de un
 * `Event` generico es el booleano heredado y `""` equivale a `false`, que cancela el evento. Por eso tambien se espia
 * `preventDefault` (el manejador DEBE llamarlo: es lo que exigen los navegadores modernos).
 */
function fire(): BeforeUnloadEvent & { preventCalls: number } {
  const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent & { preventCalls: number };
  const prevent = vi.spyOn(event, "preventDefault");
  window.dispatchEvent(event);
  event.preventCalls = prevent.mock.calls.length;
  return event;
}

afterEach(() => cleanup());

describe("useUnloadGuard", () => {
  it("activo: cancela el cierre (el navegador pone su aviso)", () => {
    render(<Probe active />);
    expect(fire().defaultPrevented).toBe(true);
  });

  it("activo: llama a preventDefault (no basta con `returnValue`)", () => {
    render(<Probe active />);
    const event = fire();
    expect(event.preventCalls).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("inactivo: no llama a preventDefault", () => {
    render(<Probe active={false} />);
    expect(fire().preventCalls).toBe(0);
  });

  it("inactivo: no hace nada", () => {
    render(<Probe active={false} />);
    expect(fire().defaultPrevented).toBe(false);
  });

  it("al pasar de activo a inactivo retira el manejador", () => {
    const view = render(<Probe active />);
    view.rerender(<Probe active={false} />);
    expect(fire().defaultPrevented).toBe(false);
  });

  it("al pasar de inactivo a activo lo registra", () => {
    const view = render(<Probe active={false} />);
    view.rerender(<Probe active />);
    expect(fire().defaultPrevented).toBe(true);
  });

  it("al desmontar retira el manejador", () => {
    const view = render(<Probe active />);
    view.unmount();
    expect(fire().defaultPrevented).toBe(false);
  });

  it("solo registra UN manejador aunque se re-renderice", () => {
    const add = vi.spyOn(window, "addEventListener");
    const view = render(<Probe active />);
    view.rerender(<Probe active />);
    view.rerender(<Probe active />);
    expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1);
    add.mockRestore();
  });
});
