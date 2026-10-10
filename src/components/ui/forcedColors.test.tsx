import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Sheet } from "@/components/ui/Sheet";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { LanguageProvider } from "@/lib/i18n";
import {
  ChoiceGroup,
  ColorSwatches,
  ToggleRow,
} from "@/components/tool/OptionControls";
import { PositionGrid } from "@/components/tool/PositionGrid";

/*
 * W6-C · D6: `forced-colors` (Windows «Contraste alto»). El modo descarta
 * rellenos translucidos y sombras, asi que cada control se delimita con
 * bordes del sistema (ButtonText / Highlight / GrayText / CanvasText).
 * jsdom no emula el modo: el contrato se comprueba por clases `forced-colors:`
 * (la medida real, con `forcedColors: "active"`, esta en
 * e2e/specs/a11y-sweep.spec.ts). Sin cambios fuera del modo: ninguna de estas
 * clases existe sin el prefijo.
 */
const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const has = (el: Element, token: string) => tokens(el).includes(token);

describe("forced-colors — Button", () => {
  it.each(["primary", "secondary", "ghost", "destructive"] as const)(
    "%s lleva borde del sistema (ButtonText) para que se vea sin relleno",
    (variant) => {
      render(<Button variant={variant}>Acción</Button>);
      const button = screen.getByRole("button");
      expect(has(button, "forced-colors:border")).toBe(true);
      expect(
        has(button, "forced-colors:border-[ButtonText]") ||
          has(button, "forced-colors:border-[Highlight]"),
      ).toBe(true);
    },
  );

  it("el primario se distingue del resto: borde de 2 px en Highlight", () => {
    render(<Button variant="primary">Procesar</Button>);
    const button = screen.getByRole("button");
    expect(has(button, "forced-colors:border-2")).toBe(true);
    expect(has(button, "forced-colors:border-[Highlight]")).toBe(true);
  });

  it("deshabilitado pasa a GrayText (texto y borde) sin la opacidad del 50 %", () => {
    render(<Button disabled>Procesar</Button>);
    const button = screen.getByRole("button");
    expect(has(button, "forced-colors:disabled:text-[GrayText]")).toBe(true);
    expect(has(button, "forced-colors:disabled:border-[GrayText]")).toBe(true);
    expect(has(button, "forced-colors:disabled:opacity-100")).toBe(true);
  });

  it("buttonClasses (enlaces con aspecto de boton) incluye las mismas reglas", () => {
    const classes = buttonClasses("secondary", "md").split(/\s+/);
    expect(classes).toContain("forced-colors:border-[ButtonText]");
    expect(classes).toContain("forced-colors:disabled:text-[GrayText]");
  });
});

describe("forced-colors — SegmentedControl", () => {
  const options = [
    { value: "a", label: "Uno" },
    { value: "b", label: "Dos" },
  ];

  it("la pista lleva borde ButtonText y el pulgar (opción activa) un anillo grueso en Highlight", () => {
    const { container } = render(
      <SegmentedControl options={options} value="a" onChange={() => {}} label="Modo" />,
    );
    const track = screen.getByRole("tablist");
    expect(has(track, "forced-colors:border")).toBe(true);
    expect(has(track, "forced-colors:border-[ButtonText]")).toBe(true);
    const thumb = container.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(has(thumb, "forced-colors:border-2")).toBe(true);
    expect(has(thumb, "forced-colors:border-[Highlight]")).toBe(true);
  });
});

describe("forced-colors — Checkbox, Badge, ProgressBar", () => {
  it("Checkbox: caja con ButtonText, marcada = Highlight, check en HighlightText, deshabilitada GrayText", () => {
    const { container } = render(<Checkbox label="Aplanar" checked onChange={() => {}} />);
    const input = screen.getByRole("checkbox");
    expect(has(input, "forced-colors:border-[ButtonText]")).toBe(true);
    expect(has(input, "forced-colors:checked:bg-[Highlight]")).toBe(true);
    expect(has(input, "forced-colors:checked:border-[Highlight]")).toBe(true);
    expect(has(input, "forced-colors:disabled:border-[GrayText]")).toBe(true);
    const check = container.querySelector("svg") as SVGElement;
    expect(has(check, "forced-colors:text-[HighlightText]")).toBe(true);
  });

  it.each(["neutral", "signal", "live", "soon", "success", "destructive"] as const)(
    "Badge %s lleva borde CanvasText en forced-colors",
    (variant) => {
      render(<Badge variant={variant}>Estado</Badge>);
      const badge = screen.getByText("Estado");
      expect(has(badge, "forced-colors:border")).toBe(true);
      expect(has(badge, "forced-colors:border-[CanvasText]")).toBe(true);
    },
  );

  it("el punto del Badge se pinta con CanvasText (bg-current se descarta en el modo)", () => {
    const { container } = render(
      <Badge dot variant="live">
        Local
      </Badge>,
    );
    const dot = container.querySelector('span[aria-hidden="true"]') as HTMLElement;
    expect(has(dot, "forced-colors:bg-[CanvasText]")).toBe(true);
  });

  it("ProgressBar: pista con borde y relleno en Highlight (sin ellos el progreso no se vería)", () => {
    const { container } = render(<ProgressBar value={40} label="Progreso" />);
    const track = screen.getByRole("progressbar");
    expect(has(track, "forced-colors:border-[CanvasText]")).toBe(true);
    const fill = container.querySelector("[class*='bg-signal']") as HTMLElement;
    expect(has(fill, "forced-colors:bg-[Highlight]")).toBe(true);
  });
});

describe("forced-colors — selector de idioma y Sheet", () => {
  it("LanguageToggle: pista con borde y pulgar activo con anillo Highlight", () => {
    const { container } = render(
      <LanguageProvider>
        <LanguageToggle />
      </LanguageProvider>,
    );
    const spans = Array.from(container.querySelectorAll('span[aria-hidden="true"]'));
    expect(spans.some((s) => has(s, "forced-colors:border-[ButtonText]"))).toBe(true);
    expect(spans.some((s) => has(s, "forced-colors:border-[Highlight]"))).toBe(true);
  });

  it("Sheet: el panel se delimita con borde CanvasText, el asa y el cierre también", () => {
    render(
      <LanguageProvider>
        <Sheet open onClose={vi.fn()} title="Opciones" closeLabel="Cerrar">
          <p>contenido</p>
        </Sheet>
      </LanguageProvider>,
    );
    const dialog = screen.getByRole("dialog");
    const panel = dialog.querySelector(".material-thick") as HTMLElement;
    expect(has(panel, "forced-colors:border-[CanvasText]")).toBe(true);
    const close = screen.getByRole("button", { name: "Cerrar" });
    expect((close.querySelector("span") as HTMLElement).className).toContain(
      "forced-colors:border-[ButtonText]",
    );
  });
});

describe("forced-colors — controles compartidos de opciones", () => {
  it("ChoiceGroup: la opción activa lleva borde grueso Highlight; las demás ButtonText", () => {
    render(
      <ChoiceGroup
        label="Tipografía"
        value="b"
        choices={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
        onChange={() => {}}
      />,
    );
    const [a, b] = screen.getAllByRole("radio");
    expect(has(a, "forced-colors:border-[ButtonText]")).toBe(true);
    expect(has(b, "forced-colors:border-2")).toBe(true);
    expect(has(b, "forced-colors:border-[Highlight]")).toBe(true);
    expect(has(b.querySelector("svg")!, "forced-colors:text-[Highlight]")).toBe(true);
  });

  it("ColorSwatches: relleno conservado (forced-color-adjust none), borde CanvasText y aro Highlight en la elegida", () => {
    render(
      <ColorSwatches
        label="Color"
        value="#0d4bff"
        colors={["#000000", "#0d4bff"]}
        onChange={() => {}}
      />,
    );
    const [plain, picked] = screen.getAllByRole("radio");
    for (const swatch of [plain, picked]) {
      expect(has(swatch, "forced-colors:[forced-color-adjust:none]")).toBe(true);
      expect(has(swatch, "forced-colors:border-[CanvasText]")).toBe(true);
    }
    expect(has(picked, "forced-colors:outline-[Highlight]")).toBe(true);
    expect(has(plain, "forced-colors:outline-[Highlight]")).toBe(false);
  });

  it("ToggleRow (interruptor): pista con borde; activado = Highlight con pomo HighlightText, apagado = pomo ButtonText", () => {
    const { rerender } = render(<ToggleRow label="Opción" checked onChange={() => {}} />);
    const track = () => screen.getByRole("switch").querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(has(track(), "forced-colors:border-[ButtonText]")).toBe(true);
    expect(has(track(), "forced-colors:bg-[Highlight]")).toBe(true);
    expect(has(track().firstElementChild!, "forced-colors:bg-[HighlightText]")).toBe(true);
    rerender(<ToggleRow label="Opción" checked={false} onChange={() => {}} />);
    expect(has(track(), "forced-colors:bg-[Highlight]")).toBe(false);
    expect(has(track().firstElementChild!, "forced-colors:bg-[ButtonText]")).toBe(true);
  });

  it("PositionGrid: la celda elegida lleva borde grueso Highlight y su punto Highlight; el resto ButtonText", () => {
    render(
      <PositionGrid
        label="Posición"
        value="middle-center"
        onChange={() => {}}
        anchorLabels={{}}
      />,
    );
    const cells = screen.getAllByRole("radio");
    const picked = cells.find((c) => c.getAttribute("aria-checked") === "true")!;
    const other = cells.find((c) => c.getAttribute("aria-checked") === "false")!;
    expect(has(picked, "forced-colors:border-2")).toBe(true);
    expect(has(picked, "forced-colors:border-[Highlight]")).toBe(true);
    expect(has(picked.firstElementChild!, "forced-colors:bg-[Highlight]")).toBe(true);
    expect(has(other, "forced-colors:border-[ButtonText]")).toBe(true);
    expect(has(other.firstElementChild!, "forced-colors:bg-[ButtonText]")).toBe(true);
    expect(has(screen.getByRole("radiogroup"), "forced-colors:border-[ButtonText]")).toBe(true);
  });
});
