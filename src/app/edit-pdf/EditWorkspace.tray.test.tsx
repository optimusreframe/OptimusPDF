import { type ComponentPropsWithoutRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

let slots: { palette: HTMLDivElement; actions: HTMLDivElement; privacy: HTMLDivElement; history: HTMLDivElement };
let tray: TrayValue;

beforeEach(() => {
  slots = {
    palette: document.createElement("div"),
    actions: document.createElement("div"),
    privacy: document.createElement("div"),
    history: document.createElement("div"),
  };
  document.body.append(slots.palette, slots.actions, slots.privacy, slots.history);
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

  it("(M6 · a) con hueco `history` deshacer y rehacer van a la barra del modo (portal) y la paleta de la bandeja no los repite", async () => {
    const { container } = render(
      <TrayProvider value={tray}>
        <Harness />
      </TrayProvider>,
    );
    await waitFor(() => expect(palette()).not.toBeNull());
    const undo = slots.history.querySelector<HTMLElement>('[data-history-button="undo"]');
    const redo = slots.history.querySelector<HTMLElement>('[data-history-button="redo"]');
    expect(undo?.getAttribute("aria-label")).toBe(EDIT_STRINGS.es.inline.undo);
    expect(redo?.getAttribute("aria-label")).toBe(EDIT_STRINGS.es.inline.redo);
    // Sin cambios: apagados con `aria-disabled` (no `disabled`: el foco no se pierde).
    expect(undo?.getAttribute("aria-disabled")).toBe("true");
    expect(undo?.hasAttribute("disabled")).toBe(false);
    expect(container.querySelector("[data-history-button]")).toBeNull();
    expect(palette()!.querySelector('[data-palette-item="undo"]')).toBeNull();
    expect(palette()!.querySelector('[data-palette-item="redo"]')).toBeNull();
  });

  it("(M6 · b) con la paleta en la bandeja es UNA fila desplazable sin tarjeta propia (la bandeja ya la tiene)", async () => {
    render(
      <TrayProvider value={tray}>
        <Harness />
      </TrayProvider>,
    );
    await waitFor(() => expect(palette()).not.toBeNull());
    const className = palette()!.className;
    expect(className).toContain("overflow-x-auto");
    expect(className).not.toContain("material-thick");
    expect(className).not.toContain("max-md:grid");
    for (const item of Array.from(palette()!.querySelectorAll<HTMLElement>("[data-palette-item]"))) {
      expect(item.className).toContain("w-11");
      expect(item.className).toContain("flex-none");
    }
  });

  it("(M6 · rail) con el hueco `history` pero sin hueco de paleta (movil horizontal ancho) la columna conserva deshacer/rehacer", async () => {
    const landscape: TrayValue = { ...tray, slots: { actions: slots.actions, privacy: slots.privacy, history: slots.history } };
    render(
      <TrayProvider value={landscape}>
        <Harness />
      </TrayProvider>,
    );
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.querySelector('[data-palette-item="undo"]')).not.toBeNull();
    expect(slots.history.querySelector('[data-history-button="undo"]')).not.toBeNull();
  });

  it("(M6 · f) el aviso de la herramienta armada se retira solo a los 4 s en el telefono (queda en el DOM para lectores) y «Imagen» lo conserva", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <TrayProvider value={tray}>
          <Harness />
        </TrayProvider>,
      );
      await waitFor(() => expect(palette()).not.toBeNull());
      fireEvent.click(document.querySelector<HTMLElement>('[data-palette-item="rect"]')!);
      const box = () => document.querySelector<HTMLElement>("[data-tool-hint-box]")!;
      await waitFor(() => expect(box().className).toContain("absolute"));
      act(() => {
        vi.advanceTimersByTime(3900);
      });
      expect(box().className).toContain("absolute");
      act(() => {
        vi.advanceTimersByTime(200);
      });
      await waitFor(() => expect(box().className).toBe("sr-only"));
      expect(document.querySelector("[data-tool-hint]")!.textContent!.length).toBeGreaterThan(5);
      // Otra herramienta: el aviso vuelve a salir y a retirarse.
      fireEvent.click(document.querySelector<HTMLElement>('[data-palette-item="ellipse"]')!);
      await waitFor(() => expect(box().className).toContain("absolute"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("(M6 · f) sin bandeja (escritorio) el aviso de la herramienta armada NO se retira solo", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<Harness />);
      await waitFor(() => expect(palette()).not.toBeNull());
      fireEvent.click(document.querySelector<HTMLElement>('[data-palette-item="rect"]')!);
      const box = () => document.querySelector<HTMLElement>("[data-tool-hint-box]")!;
      await waitFor(() => expect(box().className).toContain("absolute"));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(box().className).toContain("absolute");
    } finally {
      vi.useRealTimers();
    }
  });

  it("en la paleta del modo incrustado hay 8 px entre botones (VI-07) y en el movil horizontal bajito son dos columnas", async () => {
    render(<Harness />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.className).toContain("max-md:gap-2");
    expect(palette()!.className).toContain("[@media(max-height:479.98px)]:md:grid-cols-2");
  });
});
