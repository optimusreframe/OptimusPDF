import { type ComponentPropsWithoutRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { EditWorkspace, type EditWorkspaceProps } from "@/app/edit-pdf/EditWorkspace";
import { useEditSession } from "@/app/edit-pdf/useEditSession";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { makeBlock, metricsFor } from "@/app/edit-pdf/editTestUtils";
import { TrayProvider, type TrayValue } from "@/components/tool/trayRouting";

/**
 * M5 · N2: dentro de la bandeja de PDF Pro en movil, la paleta y «Aplanar pagina» se pintan en sus huecos (portal), elegir una
 * herramienta avisa al anfitrion (que cierra la bandeja) y la herramienta armada se reporta para que la barra del modo la nombre.
 * Sin bandeja todo se pinta donde siempre.
 */
const mocks = vi.hoisted(() => ({ doc: { numPages: 3 } as unknown }));

vi.mock("@/app/edit-pdf/useEditDocument", () => ({
  useEditDocument: () => ({ doc: mocks.doc, pageCount: 3, error: null }),
  usePageText: () => ({
    status: "ready",
    analysis: { blocks: [makeBlock("p0-b0", { text: "Titulo" })], hiddenCount: 0, hasTextLayer: true, failed: false },
  }),
}));

vi.mock("@/app/edit-pdf/EditSurface", async () => {
  const react = await import("react");
  return {
    EditSurface: function EditSurfaceStub(props: {
      pageIndex: number;
      hostRef: { current: HTMLDivElement | null };
      clipRef: { current: HTMLDivElement | null };
      onMetrics: (m: unknown, page: number) => void;
      hostProps?: ComponentPropsWithoutRef<"div">;
      children?: ReactNode;
    }) {
      const { pageIndex, hostRef, clipRef, onMetrics, hostProps, children } = props;
      react.useEffect(() => {
        onMetrics(metricsFor(), pageIndex);
        return () => onMetrics(null, -1);
      }, [pageIndex]);
      return (
        <div ref={clipRef}>
          <div ref={hostRef} data-page-index={pageIndex} {...hostProps}>
            {children}
          </div>
        </div>
      );
    },
  };
});

const file = new File(["%PDF"], "doc.pdf", { type: "application/pdf" });

function Harness(props: Partial<EditWorkspaceProps> = {}) {
  const edit = useEditSession({ shortcuts: false });
  return <EditWorkspace file={file} session={edit} strings={EDIT_STRINGS.es} flow={EDIT_FLOW_STRINGS.es} embedded {...props} />;
}

const palette = () => document.querySelector<HTMLElement>("[data-tool-palette]");
const flatten = () => document.querySelector<HTMLElement>("[data-page-actions]");

let slots: { palette: HTMLDivElement; actions: HTMLDivElement; privacy: HTMLDivElement };
let tray: TrayValue;

beforeEach(() => {
  slots = { palette: document.createElement("div"), actions: document.createElement("div"), privacy: document.createElement("div") };
  document.body.append(slots.palette, slots.actions, slots.privacy);
  tray = { slots, onToolPicked: vi.fn(), reportTool: vi.fn() };
});

afterEach(() => {
  cleanup();
  for (const slot of Object.values(slots)) slot.remove();
  vi.restoreAllMocks();
});

describe("EditWorkspace · bandeja de herramientas de PDF Pro", () => {
  it("con bandeja la paleta y «Aplanar pagina» van a sus huecos, no al flujo del editor", async () => {
    const { container } = render(
      <TrayProvider value={tray}>
        <Harness />
      </TrayProvider>,
    );
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(slots.palette.contains(palette())).toBe(true);
    expect(container.contains(palette())).toBe(false);
    expect(slots.actions.contains(flatten())).toBe(true);
  });

  it("sin bandeja la paleta se pinta en el editor (escritorio, tablet con paneles, «Editar PDF» suelto)", async () => {
    const { container } = render(<Harness />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(container.contains(palette())).toBe(true);
    expect(container.contains(flatten())).toBe(true);
  });

  it("movil horizontal: sin hueco de paleta en la bandeja, la paleta sigue en su columna y «Aplanar» va a la bandeja", async () => {
    const landscape: TrayValue = { ...tray, slots: { actions: slots.actions, privacy: slots.privacy } };
    const { container } = render(
      <TrayProvider value={landscape}>
        <Harness />
      </TrayProvider>,
    );
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(container.contains(palette())).toBe(true);
    expect(slots.actions.contains(flatten())).toBe(true);
  });

  it("elegir una herramienta avisa a la bandeja (se cierra) y reporta la herramienta armada con su nombre; volver a Seleccionar la retira", async () => {
    render(
      <TrayProvider value={tray}>
        <Harness />
      </TrayProvider>,
    );
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(tray.reportTool).toHaveBeenLastCalledWith(null);
    const rect = document.querySelector<HTMLElement>('[data-palette-item="rect"]')!;
    fireEvent.click(rect);
    expect(tray.onToolPicked).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(tray.reportTool).toHaveBeenLastCalledWith(expect.objectContaining({ id: "rect", label: expect.any(String) })));
    const armed = vi.mocked(tray.reportTool).mock.calls.at(-1)![0]!;
    expect(armed.label.length).toBeGreaterThan(2);
    expect(armed.icon).toBeTruthy();
    // Otra herramienta: se avisa de nuevo (la bandeja se vuelve a cerrar tras reabrirla).
    fireEvent.click(document.querySelector<HTMLElement>('[data-palette-item="select"]')!);
    expect(tray.onToolPicked).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(tray.reportTool).toHaveBeenLastCalledWith(null));
  });

  it("en la paleta del modo incrustado hay 8 px entre botones (VI-07) y en el movil horizontal bajito son dos columnas", async () => {
    render(<Harness />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.className).toContain("max-md:gap-2");
    expect(palette()!.className).toContain("[@media(max-height:479.98px)]:md:grid-cols-2");
  });
});
