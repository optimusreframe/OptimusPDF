import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Square } from "lucide-react";
import { TrayPortal, TrayProvider, useTray, type TrayValue } from "@/components/tool/trayRouting";

/** M5 · N2: la bandeja de herramientas de PDF Pro en movil. Sin bandeja (o sin ese hueco) cada pieza se pinta en su sitio. */
afterEach(cleanup);

const value = (slots: TrayValue["slots"]): TrayValue => ({ slots, onToolPicked: vi.fn(), reportTool: vi.fn() });

describe("TrayPortal", () => {
  it("sin bandeja (escritorio, ruta suelta «Editar PDF») pinta la pieza donde esta", () => {
    render(
      <div data-testid="in-place">
        <TrayPortal slot="palette">
          <button type="button">Rectángulo</button>
        </TrayPortal>
      </div>,
    );
    expect(screen.getByTestId("in-place").contains(screen.getByRole("button", { name: "Rectángulo" }))).toBe(true);
  });

  it("con bandeja y el hueco montado lleva la pieza a ese hueco (por portal) y no a su sitio", () => {
    const target = document.createElement("div");
    document.body.append(target);
    render(
      <TrayProvider value={value({ palette: target })}>
        <div data-testid="in-place">
          <TrayPortal slot="palette">
            <button type="button">Rectángulo</button>
          </TrayPortal>
        </div>
      </TrayProvider>,
    );
    const button = screen.getByRole("button", { name: "Rectángulo" });
    expect(target.contains(button)).toBe(true);
    expect(screen.getByTestId("in-place").contains(button)).toBe(false);
    target.remove();
  });

  it("con bandeja pero el hueco aun sin montar espera: no pinta nada (se monta en el siguiente commit)", () => {
    render(
      <TrayProvider value={value({ palette: null })}>
        <TrayPortal slot="palette">
          <button type="button">Rectángulo</button>
        </TrayPortal>
      </TrayProvider>,
    );
    expect(screen.queryByRole("button", { name: "Rectángulo" })).toBeNull();
  });

  it("un hueco que la bandeja NO ofrece (movil horizontal: la paleta sigue siendo una columna) se pinta en su sitio", () => {
    const target = document.createElement("div");
    document.body.append(target);
    render(
      <TrayProvider value={value({ privacy: target })}>
        <div data-testid="in-place">
          <TrayPortal slot="palette">
            <button type="button">Rectángulo</button>
          </TrayPortal>
          <TrayPortal slot="privacy">
            <p>Privacidad</p>
          </TrayPortal>
        </div>
      </TrayProvider>,
    );
    expect(screen.getByTestId("in-place").contains(screen.getByRole("button", { name: "Rectángulo" }))).toBe(true);
    expect(target.contains(screen.getByText("Privacidad"))).toBe(true);
    target.remove();
  });
});

describe("useTray", () => {
  it("devuelve la bandeja del proveedor, o null sin proveedor", () => {
    const tray = value({});
    function Probe() {
      const current = useTray();
      return <p>{current === tray ? "la bandeja" : current === null ? "ninguna" : "otra"}</p>;
    }
    const { unmount } = render(<Probe />);
    expect(screen.getByText("ninguna")).toBeTruthy();
    unmount();
    render(
      <TrayProvider value={tray}>
        <Probe />
      </TrayProvider>,
    );
    expect(screen.getByText("la bandeja")).toBeTruthy();
  });

  it("los avisos del editor llegan al anfitrion (herramienta armada y elegida)", () => {
    const tray = value({});
    function Picker() {
      const current = useTray()!;
      return (
        <button
          type="button"
          onClick={() => {
            current.reportTool({ id: "rect", label: "Rectángulo", icon: Square });
            current.onToolPicked();
          }}
        >
          elegir
        </button>
      );
    }
    render(
      <TrayProvider value={tray}>
        <Picker />
      </TrayProvider>,
    );
    screen.getByRole("button", { name: "elegir" }).click();
    expect(tray.reportTool).toHaveBeenCalledWith({ id: "rect", label: "Rectángulo", icon: Square });
    expect(tray.onToolPicked).toHaveBeenCalledTimes(1);
  });
});
