import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import {
  LiveSinkProvider,
  StatusRegion,
  createBatchedSink,
  useRoutedAnnouncement,
  type LiveSink,
} from "@/components/tool/liveRouting";
import { Sheet } from "@/components/ui/Sheet";

afterEach(() => cleanup());

function Probe({ text }: { text: string }) {
  const routed = useRoutedAnnouncement(text);
  return <output data-testid="probe">{routed ? "routed" : "own"}</output>;
}

describe("StatusRegion", () => {
  it("sin sumidero (ruta suelta) es una region viva de siempre", () => {
    render(<StatusRegion text="Hola">Hola</StatusRegion>);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("Hola");
  });

  it("con sumidero NO es region viva, sigue mostrando su contenido y respeta as/className/atributos", () => {
    const sink = vi.fn();
    render(
      <LiveSinkProvider value={sink}>
        <StatusRegion as="p" text="Visible" className="sr-only" data-x="1">
          Visible
        </StatusRegion>
      </LiveSinkProvider>,
    );
    expect(screen.queryByRole("status")).toBeNull();
    const node = screen.getByText("Visible");
    expect(node.tagName).toBe("P");
    expect(node.className).toBe("sr-only");
    expect(node.getAttribute("data-x")).toBe("1");
    expect(node.hasAttribute("aria-live")).toBe(false);
  });

  it("el valor inicial NO se anuncia; un cambio posterior si, una sola vez", () => {
    const sink = vi.fn();
    const view = render(
      <LiveSinkProvider value={sink}>
        <StatusRegion text="uno">uno</StatusRegion>
      </LiveSinkProvider>,
    );
    expect(sink).not.toHaveBeenCalled();
    view.rerender(
      <LiveSinkProvider value={sink}>
        <StatusRegion text="dos">dos</StatusRegion>
      </LiveSinkProvider>,
    );
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith("dos");
    // Mismo texto en otro pintado: nada nuevo que decir.
    view.rerender(
      <LiveSinkProvider value={sink}>
        <StatusRegion text="dos">dos otra vez</StatusRegion>
      </LiveSinkProvider>,
    );
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("un texto vacio (se retira el aviso) no se anuncia", () => {
    const sink = vi.fn();
    const view = render(
      <LiveSinkProvider value={sink}>
        <StatusRegion text="algo">algo</StatusRegion>
      </LiveSinkProvider>,
    );
    view.rerender(
      <LiveSinkProvider value={sink}>
        <StatusRegion text="">{""}</StatusRegion>
      </LiveSinkProvider>,
    );
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("useRoutedAnnouncement", () => {
  it("dice si hay sumidero", () => {
    const sink: LiveSink = () => {};
    render(<Probe text="a" />);
    expect(screen.getByTestId("probe").textContent).toBe("own");
    cleanup();
    render(
      <LiveSinkProvider value={sink}>
        <Probe text="a" />
      </LiveSinkProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("routed");
  });
});

describe("Sheet quita el sumidero", () => {
  it("dentro de una hoja modal cada mensaje vive en su propia region (la de fuera no llega al dialogo)", () => {
    const sink = vi.fn();
    render(
      <LiveSinkProvider value={sink}>
        <Sheet open onClose={() => {}} title="Hoja" closeLabel="Cerrar">
          <StatusRegion text="dentro">dentro</StatusRegion>
        </Sheet>
      </LiveSinkProvider>,
    );
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("dentro");
  });
});

describe("createBatchedSink", () => {
  it("junta los avisos del mismo instante en uno y no repite el mismo texto", async () => {
    const deliver = vi.fn();
    const sink = createBatchedSink(deliver);
    sink("A");
    sink("B");
    sink("A");
    expect(deliver).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith("A B");
  });

  it("los avisos de instantes distintos se entregan por separado", async () => {
    const deliver = vi.fn();
    const sink = createBatchedSink(deliver);
    sink("A");
    await act(async () => {
      await Promise.resolve();
    });
    sink("B");
    await act(async () => {
      await Promise.resolve();
    });
    expect(deliver.mock.calls.map((call) => call[0])).toEqual(["A", "B"]);
  });
});
