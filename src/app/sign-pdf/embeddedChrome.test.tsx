import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import {
  EmbeddedBar,
  EmbeddedSessionShell,
  useBusyFocus,
  useEmbeddedShell,
  useFocusReturn,
  useModeHostBridge,
} from "@/app/sign-pdf/embeddedChrome";
import {
  ProModeHostContext,
  type ProModeControls,
  type ProModeHostValue,
} from "@/app/pdf-pro/modes/modeContext";

/** Piezas comunes de los modos con «Aplicar» de PDF Pro (Wave 7 · U7). */

function file(name = "a.pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

/** Un hijo con estado propio que se ve y se manipula desde fuera. */
function Child({ label = "hijo" }: { label?: string }) {
  const shell = useEmbeddedShell();
  const [count, setCount] = useState(0);
  return (
    <div>
      <p data-testid="count">{count}</p>
      <p data-testid="phase">{shell.phase}</p>
      <p data-testid="notice">{shell.notice ?? ""}</p>
      <button onClick={() => setCount((value) => value + 1)}>{label}-sumar</button>
      <button onClick={() => shell.setDirty(true)}>sucio</button>
      <button onClick={() => shell.setDirty(false)}>limpio</button>
      <button onClick={() => shell.setPhase("applying")}>aplicando</button>
      <button onClick={() => shell.dismissNotice()}>cerrar-aviso</button>
    </div>
  );
}

const bytesA = new Uint8Array([1]);
const bytesB = new Uint8Array([2]);

describe("EmbeddedSessionShell", () => {
  it("monta a los hijos y avisa de que no hay trabajo sin aplicar", () => {
    const onDirty = vi.fn();
    render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="descartada" onDirtyChange={onDirty}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("phase").textContent).toBe("editing");
    expect(onDirty).toHaveBeenLastCalledWith(false);
  });

  it("el trabajo sin aplicar sube al anfitrion y al limpiarse baja", () => {
    const onDirty = vi.fn();
    render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="x" onDirtyChange={onDirty}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("sucio"));
    expect(onDirty).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByText("limpio"));
    expect(onDirty).toHaveBeenLastCalledWith(false);
  });

  it("al desmontar baja el trabajo sin aplicar (el anfitrion no se queda con un 'sucio' fantasma)", () => {
    const onDirty = vi.fn();
    const { unmount } = render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="x" onDirtyChange={onDirty}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("sucio"));
    unmount();
    expect(onDirty).toHaveBeenLastCalledWith(false);
  });

  it("otro documento con trabajo sin aplicar: la sesion se remonta vacia y se avisa", () => {
    const onDirty = vi.fn();
    const view = render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="Sesion descartada" onDirtyChange={onDirty}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("hijo-sumar"));
    fireEvent.click(screen.getByText("sucio"));
    expect(screen.getByTestId("count").textContent).toBe("1");
    view.rerender(
      <EmbeddedSessionShell file={file()} bytes={bytesB} resetNotice="Sesion descartada" onDirtyChange={onDirty}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("notice").textContent).toBe("Sesion descartada");
    expect(onDirty).toHaveBeenLastCalledWith(false);
  });

  it("otro documento SIN trabajo sin aplicar: se remonta en silencio", () => {
    const view = render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("hijo-sumar"));
    view.rerender(
      <EmbeddedSessionShell file={file()} bytes={bytesB} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("notice").textContent).toBe("");
  });

  it("si se estaba aplicando, el snapshot nuevo es el resultado esperado: sin aviso y de vuelta a 'editing'", () => {
    const view = render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("sucio"));
    fireEvent.click(screen.getByText("aplicando"));
    expect(screen.getByTestId("phase").textContent).toBe("applying");
    view.rerender(
      <EmbeddedSessionShell file={file()} bytes={bytesB} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("notice").textContent).toBe("");
    expect(screen.getByTestId("phase").textContent).toBe("editing");
  });

  it("la identidad es la referencia de los bytes: un File nuevo con los MISMOS bytes no reinicia nada", () => {
    const view = render(
      <EmbeddedSessionShell file={file("uno.pdf")} bytes={bytesA} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("hijo-sumar"));
    view.rerender(
      <EmbeddedSessionShell file={file("otro.pdf")} bytes={bytesA} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("count").textContent).toBe("1");
  });

  it("sin bytes, la identidad es la del File", () => {
    const first = file();
    const view = render(
      <EmbeddedSessionShell file={first} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("hijo-sumar"));
    view.rerender(
      <EmbeddedSessionShell file={first} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("count").textContent).toBe("1");
    view.rerender(
      <EmbeddedSessionShell file={file()} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("count").textContent).toBe("0");
  });

  it("el aviso se puede cerrar", () => {
    const view = render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("sucio"));
    view.rerender(
      <EmbeddedSessionShell file={file()} bytes={bytesB} resetNotice="aviso" onDirtyChange={() => {}}>
        <Child />
      </EmbeddedSessionShell>,
    );
    expect(screen.getByTestId("notice").textContent).toBe("aviso");
    fireEvent.click(screen.getByText("cerrar-aviso"));
    expect(screen.getByTestId("notice").textContent).toBe("");
  });

  it("getIdentity siempre devuelve el documento VIGENTE, no el de la sesion (carrera de aplicar)", () => {
    const probe: { getIdentity: (() => object) | null; own: object | null } = { getIdentity: null, own: null };
    function Probe() {
      const shell = useEmbeddedShell();
      useEffect(() => {
        probe.getIdentity = shell.getIdentity;
        probe.own = shell.identity;
      });
      return null;
    }
    const view = render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="x" onDirtyChange={() => {}}>
        <Probe />
      </EmbeddedSessionShell>,
    );
    const firstIdentity = probe.own;
    expect(probe.getIdentity!()).toBe(bytesA);
    view.rerender(
      <EmbeddedSessionShell file={file()} bytes={bytesB} resetNotice="x" onDirtyChange={() => {}}>
        <Probe />
      </EmbeddedSessionShell>,
    );
    expect(firstIdentity).toBe(bytesA);
    expect(probe.getIdentity!()).toBe(bytesB);
  });

  it("useEmbeddedShell fuera del shell lanza un error claro", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useEmbeddedShell())).toThrow(/EmbeddedSessionShell/);
    spy.mockRestore();
  });

  it("el callback de trabajo sin aplicar puede cambiar entre pintados sin perder el ultimo estado", () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="x" onDirtyChange={first}>
        <Child />
      </EmbeddedSessionShell>,
    );
    view.rerender(
      <EmbeddedSessionShell file={file()} bytes={bytesA} resetNotice="x" onDirtyChange={second}>
        <Child />
      </EmbeddedSessionShell>,
    );
    fireEvent.click(screen.getByText("sucio"));
    expect(second).toHaveBeenLastCalledWith(true);
  });
});

describe("useFocusReturn", () => {
  function Focusable({ show }: { show: boolean }) {
    const ref = useRef<HTMLElement>(null);
    return (
      <div>
        <div role="tablist">
          <button role="tab" aria-selected="true">
            Firmar
          </button>
        </div>
        <div data-pro-region="viewer" tabIndex={-1}>
          visor
        </div>
        {show ? <Mode rootRef={ref} /> : null}
      </div>
    );
  }
  function Mode({ rootRef }: { rootRef: React.RefObject<HTMLElement | null> }) {
    useFocusReturn(rootRef);
    return (
      <section ref={rootRef}>
        <button>dentro</button>
      </section>
    );
  }

  it("al desmontar con el foco dentro, vuelve a la pestana activa (no a <body>)", () => {
    const view = render(<Focusable show />);
    screen.getByText("dentro").focus();
    expect(document.activeElement).toBe(screen.getByText("dentro"));
    view.rerender(<Focusable show={false} />);
    expect(document.activeElement).toBe(screen.getByRole("tab"));
  });

  it("si el foco estaba fuera del modo, no lo toca", () => {
    const view = render(<Focusable show />);
    screen.getByRole("tab").focus();
    view.rerender(<Focusable show={false} />);
    expect(document.activeElement).toBe(screen.getByRole("tab"));
  });
});

describe("useBusyFocus", () => {
  function Busy({ busy }: { busy: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useBusyFocus(ref, busy);
    return (
      <div>
        <div ref={ref} inert={busy}>
          <button>dentro</button>
        </div>
        <div data-pro-mode-actions="">
          <div tabIndex={-1} data-pro-mode-status-wrap="">
            estado
          </div>
        </div>
      </div>
    );
  }

  it("al ponerse ocupado con el foco dentro, lo lleva a la zona de estado de la barra", () => {
    const view = render(<Busy busy={false} />);
    screen.getByText("dentro").focus();
    view.rerender(<Busy busy />);
    expect(document.activeElement).toBe(screen.getByText("estado"));
  });

  it("sin ocupado no mueve el foco", () => {
    render(<Busy busy={false} />);
    screen.getByText("dentro").focus();
    expect(document.activeElement).toBe(screen.getByText("dentro"));
  });
});

describe("EmbeddedBar", () => {
  const base = {
    phase: "editing" as const,
    progress: 0,
    ready: true,
    readyText: "Listo",
    notReadyText: "Falta algo",
    error: null,
    statusId: "estado",
    applyLabel: "Aplicar",
    discardLabel: "Descartar",
    applyingLabel: "Aplicando",
    onApply: () => {},
    onCancel: () => {},
  };

  it("listo: 'Aplicar' habilitado y el estado dice «Listo»", () => {
    render(<EmbeddedBar {...base} />);
    expect((screen.getByRole("button", { name: "Aplicar" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole("status").textContent).toBe("Listo");
  });

  it("no listo: 'Aplicar' deshabilitado y descrito por el motivo", () => {
    render(<EmbeddedBar {...base} ready={false} />);
    const apply = screen.getByRole("button", { name: "Aplicar" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(apply.getAttribute("aria-describedby")).toBe("estado");
    expect(document.getElementById("estado")?.textContent).toBe("Falta algo");
  });

  it("aplicando: barra de progreso con su valor y botones deshabilitados", () => {
    render(<EmbeddedBar {...base} phase="applying" progress={0.4} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    expect((screen.getByRole("button", { name: "Aplicar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Descartar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("con anfitrion no pinta botones (los dibuja el anfitrion) pero conserva el estado", () => {
    render(<EmbeddedBar {...base} hosted />);
    expect(screen.queryByRole("button", { name: "Aplicar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Descartar" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Listo");
  });

  it("un error se anuncia con role=alert", () => {
    render(<EmbeddedBar {...base} error="Algo fallo" />);
    expect(screen.getByRole("alert").textContent).toBe("Algo fallo");
  });

  it("los botones llaman a sus manejadores", () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<EmbeddedBar {...base} onApply={onApply} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("la zona de estado es enfocable por codigo y lleva sus avisos hijos", () => {
    render(
      <EmbeddedBar {...base}>
        <p>aviso extra</p>
      </EmbeddedBar>,
    );
    expect(document.querySelector("[data-pro-mode-status-wrap]")?.getAttribute("tabindex")).toBe("-1");
    expect(screen.getByText("aviso extra")).toBeTruthy();
  });
});

describe("useModeHostBridge", () => {
  function hostValue(overrides: Partial<ProModeHostValue> = {}): ProModeHostValue & { controls: ProModeControls | null } {
    const value = {
      tab: "sign",
      initialPage: 2,
      reportPage: vi.fn(),
      registerControls: vi.fn((controls: ProModeControls | null) => {
        value.controls = controls;
      }),
      intent: null,
      busy: false,
      controls: null as ProModeControls | null,
      ...overrides,
    };
    return value;
  }

  it("sin anfitrion: no esta hospedado, no registra nada y la pagina inicial es 0", () => {
    const { result } = renderHook(() => useModeHostBridge(async () => true));
    expect(result.current.hosted).toBe(false);
    expect(result.current.hostBusy).toBe(false);
    expect(result.current.initialPage).toBe(0);
    expect(() => result.current.reportPage(3)).not.toThrow();
  });

  it("con anfitrion: registra los controles y 'apply' llama a la version MAS RECIENTE de la funcion", async () => {
    const host = hostValue();
    const first = vi.fn(async () => false);
    const second = vi.fn(async () => true);
    const { rerender, result } = renderHook(({ apply }) => useModeHostBridge(apply), {
      initialProps: { apply: first },
      wrapper: ({ children }) => <ProModeHostContext.Provider value={host}>{children}</ProModeHostContext.Provider>,
    });
    expect(result.current.hosted).toBe(true);
    expect(result.current.initialPage).toBe(2);
    expect(host.controls).not.toBeNull();
    rerender({ apply: second });
    expect(await host.controls!.apply()).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("'cancel' del anfitrion llama a la version mas reciente de la funcion de cancelar", () => {
    const host = hostValue();
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cancel }) => useModeHostBridge(async () => true, cancel), {
      initialProps: { cancel: first },
      wrapper: ({ children }) => <ProModeHostContext.Provider value={host}>{children}</ProModeHostContext.Provider>,
    });
    rerender({ cancel: second });
    host.controls!.cancel!();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("sin funcion de cancelar, 'cancel' no hace nada ni lanza", () => {
    const host = hostValue();
    renderHook(() => useModeHostBridge(async () => true), {
      wrapper: ({ children }) => <ProModeHostContext.Provider value={host}>{children}</ProModeHostContext.Provider>,
    });
    expect(() => host.controls!.cancel!()).not.toThrow();
  });

  it("al desmontar retira los controles del anfitrion", () => {
    const host = hostValue();
    const { unmount } = renderHook(() => useModeHostBridge(async () => true), {
      wrapper: ({ children }) => <ProModeHostContext.Provider value={host}>{children}</ProModeHostContext.Provider>,
    });
    expect(host.controls).not.toBeNull();
    unmount();
    expect(host.controls).toBeNull();
  });

  it("expone 'busy' del anfitrion y su reportPage", () => {
    const host = hostValue({ busy: true });
    const { result } = renderHook(() => useModeHostBridge(async () => true), {
      wrapper: ({ children }) => <ProModeHostContext.Provider value={host}>{children}</ProModeHostContext.Provider>,
    });
    expect(result.current.hostBusy).toBe(true);
    act(() => result.current.reportPage(4));
    expect(host.reportPage).toHaveBeenCalledWith(4);
  });
});
