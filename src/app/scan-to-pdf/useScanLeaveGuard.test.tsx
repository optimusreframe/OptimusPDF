import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { __resetNavigationGuardForTests, interceptNavigation } from "@/lib/navigationGuard";
import { shouldWarnBeforeUnload, useScanLeaveGuard, type ScanLeaveState, type ScanWork } from "@/app/scan-to-pdf/useScanLeaveGuard";

const work = (patch: Partial<ScanWork> = {}): ScanWork => ({ progress: true, sessionId: "scan-0001", saved: true, pages: 3, ...patch });

describe("shouldWarnBeforeUnload: solo avisa si hay algo que perder", () => {
  it("sin escaneo o sin progreso, nunca", () => {
    expect(shouldWarnBeforeUnload(null, true)).toBe(false);
    expect(shouldWarnBeforeUnload(work({ progress: false }), true)).toBe(false);
  });
  it("todo guardado y ninguna escritura pendiente: no molesta", () => {
    expect(shouldWarnBeforeUnload(work(), false)).toBe(false);
  });
  it("escritura pendiente o no guardado: avisa", () => {
    expect(shouldWarnBeforeUnload(work(), true)).toBe(true);
    expect(shouldWarnBeforeUnload(work({ saved: false }), false)).toBe(true);
  });
});

function Probe({ value, pending, onState }: { value: ScanWork | null; pending: boolean; onState: (state: ScanLeaveState) => void }) {
  const state = useScanLeaveGuard(value, () => pending);
  onState(state);
  return null;
}

describe("useScanLeaveGuard", () => {
  afterEach(() => {
    __resetNavigationGuardForTests();
    window.history.replaceState(null, "", "/");
  });

  it("con progreso pone la sesion en la direccion y, al quitarse, la limpia", () => {
    window.history.replaceState(null, "", "/scan-to-pdf");
    let state!: ScanLeaveState;
    const { rerender } = render(<Probe value={work()} pending={false} onState={(s) => (state = s)} />);
    expect(window.location.search).toBe("?scan=scan-0001");
    expect(state.open).toBe(false);
    rerender(<Probe value={null} pending={false} onState={(s) => (state = s)} />);
    expect(window.location.search).toBe("");
  });

  it("un enlace interno con progreso abre la hoja en vez de navegar; «Seguir» la cierra y «Salir» repite la navegacion", () => {
    window.history.replaceState(null, "", "/scan-to-pdf");
    let state!: ScanLeaveState;
    render(<Probe value={work({ pages: 4 })} pending={false} onState={(s) => (state = s)} />);
    const proceed = vi.fn();
    let cancelled = false;
    act(() => {
      cancelled = interceptNavigation("/merge-pdf", proceed);
    });
    expect(cancelled).toBe(true);
    expect(state.open).toBe(true);
    expect(state.saved).toBe(true);
    expect(state.pages).toBe(4);
    act(() => state.onStay());
    expect(state.open).toBe(false);
    expect(proceed).not.toHaveBeenCalled();
    act(() => {
      interceptNavigation("/merge-pdf", proceed);
    });
    act(() => state.onLeave());
    expect(proceed).toHaveBeenCalledTimes(1);
  });

  it("sin progreso la guarda deja pasar todo", () => {
    let state!: ScanLeaveState;
    render(<Probe value={null} pending={false} onState={(s) => (state = s)} />);
    expect(interceptNavigation("/otra", () => {})).toBe(false);
    expect(state.open).toBe(false);
  });

  it("beforeunload: preventDefault solo con algo sin guardar", () => {
    let pending = false;
    const { rerender } = render(<Probe value={work()} pending={pending} onState={() => {}} />);
    const fire = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);
    pending = true;
    rerender(<Probe value={work()} pending={pending} onState={() => {}} />);
    expect(fire()).toBe(true);
    pending = false;
    rerender(<Probe value={work({ saved: false })} pending={pending} onState={() => {}} />);
    expect(fire()).toBe(true);
  });

  it("la hoja dice la verdad: «no guardado» cuando no lo esta", () => {
    let state!: ScanLeaveState;
    render(<Probe value={work({ saved: false })} pending={false} onState={(s) => (state = s)} />);
    act(() => {
      interceptNavigation("/x", () => {});
    });
    expect(state.open).toBe(true);
    expect(state.saved).toBe(false);
  });
});
