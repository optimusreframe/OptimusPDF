import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __clearRegisteredCommandsForTests,
  registerCommand,
  useRegisteredCommands,
} from "@/app/pdf-pro/shell/proCommands";
import {
  __clearProActionsForTests,
  getProAction,
  registerProAction,
  useProAction,
} from "@/app/pdf-pro/shell/proActions";

afterEach(() => {
  cleanup();
  __clearRegisteredCommandsForTests();
  __clearProActionsForTests();
});

describe("registerCommand + useRegisteredCommands", () => {
  it("un comando registrado aparece y al retirarlo desaparece", () => {
    const { result } = renderHook(() => useRegisteredCommands());
    expect(result.current).toEqual([]);
    let off!: () => void;
    act(() => {
      off = registerCommand("mi-modo:accion", { label: "Mi accion", keywords: ["x"], run: () => undefined });
    });
    expect(result.current.map((c) => c.id)).toEqual(["mi-modo:accion"]);
    expect(result.current[0].label).toBe("Mi accion");
    act(() => off());
    expect(result.current).toEqual([]);
  });

  it("un mismo id sustituye al anterior y retirar el viejo no quita el nuevo", () => {
    const { result } = renderHook(() => useRegisteredCommands());
    let offOld!: () => void;
    act(() => {
      offOld = registerCommand("c", { label: "Viejo", run: () => undefined });
      registerCommand("c", { label: "Nuevo", run: () => undefined });
    });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].label).toBe("Nuevo");
    act(() => offOld());
    expect(result.current[0].label).toBe("Nuevo");
  });

  it("varios comandos conservan el orden de registro", () => {
    const { result } = renderHook(() => useRegisteredCommands());
    act(() => {
      registerCommand("a", { label: "A", run: () => undefined });
      registerCommand("b", { label: "B", run: () => undefined });
      registerCommand("c", { label: "C", run: () => undefined });
    });
    expect(result.current.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("el comando conserva su funcion de ejecucion", () => {
    const run = vi.fn();
    const { result } = renderHook(() => useRegisteredCommands());
    act(() => {
      registerCommand("a", { label: "A", run });
    });
    result.current[0].run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("la lista es estable (misma referencia) mientras nadie registra nada", () => {
    const { result, rerender } = renderHook(() => useRegisteredCommands());
    act(() => {
      registerCommand("a", { label: "A", run: () => undefined });
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe("acciones globales de la barra (guardar / exportar)", () => {
  it("sin registrar manda el valor por defecto (null)", () => {
    expect(getProAction("save")).toBeNull();
    expect(getProAction("export")).toBeNull();
  });

  it("registrar una accion la pone en uso y retirarla vuelve al valor por defecto", () => {
    const handler = vi.fn();
    const off = registerProAction("export", handler);
    getProAction("export")!();
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    expect(getProAction("export")).toBeNull();
  });

  it("retirar un manejador viejo no quita el nuevo", () => {
    const offOld = registerProAction("save", vi.fn());
    const next = vi.fn();
    registerProAction("save", next);
    offOld();
    expect(getProAction("save")).not.toBeNull();
    getProAction("save")!();
    expect(next).toHaveBeenCalled();
  });

  it("useProAction registra mientras el componente esta montado y llama siempre a la ultima version", () => {
    let calls: string[] = [];
    const { rerender, unmount } = renderHook(({ label }) => useProAction("save", () => calls.push(label)), {
      initialProps: { label: "uno" },
    });
    getProAction("save")!();
    rerender({ label: "dos" });
    getProAction("save")!();
    expect(calls).toEqual(["uno", "dos"]);
    unmount();
    expect(getProAction("save")).toBeNull();
    calls = [];
  });

  it("useProAction con active=false no registra", () => {
    renderHook(() => useProAction("export", () => undefined, false));
    expect(getProAction("export")).toBeNull();
  });
});
