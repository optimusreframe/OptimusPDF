import { type ComponentPropsWithoutRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { EditWorkspace, type EditWorkspaceProps } from "@/app/edit-pdf/EditWorkspace";
import { useEditSession } from "@/app/edit-pdf/useEditSession";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { makeBlock, metricsFor } from "@/app/edit-pdf/editTestUtils";

/**
 * Wave 10 · C-A3: en el movil, «Editar PDF» (herramienta suelta) coloca su paleta fija SOBRE las barras fijas de abajo
 * (la de «Procesar» y la pestana) midiendolas, y sube al nivel de la barra de zoom y paginas (`z-30`) para que esta no
 * la tape en una pantalla baja. Escritorio y modo incrustado (PDF Pro) no llevan la distancia medida.
 */

const mocks = vi.hoisted(() => ({ doc: { numPages: 1 } as unknown }));

vi.mock("@/app/edit-pdf/useEditDocument", () => ({
  useEditDocument: () => ({ doc: mocks.doc, pageCount: 1, error: null }),
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
  return <EditWorkspace file={file} session={edit} strings={EDIT_STRINGS.es} flow={EDIT_FLOW_STRINGS.es} {...props} />;
}

const palette = () => document.querySelector<HTMLElement>("[data-tool-palette]");

/** Barra fija de abajo como la de «Procesar» del movil: 375 px de ancho, `bottom: 72px`, 96 px de alto. */
function addBottomBar(height = 96) {
  const bar = document.createElement("div");
  bar.setAttribute("data-test-bar", "");
  Object.assign(bar.style, { position: "fixed", bottom: "72px" });
  bar.dataset.height = String(height);
  document.body.appendChild(bar);
  return bar;
}

function stubPhone(phone: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width") ? phone : query.includes("min-width") ? !phone : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 812 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const height = Number((this as HTMLElement).dataset?.height ?? 0);
    const isBar = this.hasAttribute("data-test-bar");
    const top = 812 - 72 - height;
    return {
      x: 0,
      y: isBar ? top : 0,
      width: isBar ? 375 : 0,
      height: isBar ? height : 0,
      left: 0,
      top: isBar ? top : 0,
      right: isBar ? 375 : 0,
      bottom: isBar ? top + height : 0,
      toJSON: () => ({}),
    } as DOMRect;
  });
  stubPhone(true);
});

afterEach(() => {
  document.body.querySelectorAll("[data-test-bar]").forEach((el) => el.remove());
  vi.restoreAllMocks();
});

describe("EditWorkspace · paleta movil sobre las barras fijas de abajo", () => {
  it("movil con una barra de 96 px sobre la pestana: la paleta lleva `--edit-palette-bottom` = 72 + 96 px y sube a z-30", async () => {
    addBottomBar(96);
    render(<Harness />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.style.getPropertyValue("--edit-palette-bottom")).toBe("168px");
    // La clase lee la variable y, sin medida, cae a la distancia de siempre (9,25 rem + zona segura).
    expect(palette()!.className).toContain("max-md:bottom-[var(--edit-palette-bottom,calc(9.25rem+env(safe-area-inset-bottom,0px)))]");
    expect(palette()!.className).toContain("max-md:z-30");
    expect(palette()!.className).toContain("max-md:fixed");
  });

  it("una barra mas alta (motivo de dos lineas, 114 px) sube la paleta con ella", async () => {
    addBottomBar(114);
    render(<Harness />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.style.getPropertyValue("--edit-palette-bottom")).toBe("186px");
  });

  it("sin barras fijas no hay variable: vale la distancia de siempre", async () => {
    render(<Harness />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.style.getPropertyValue("--edit-palette-bottom")).toBe("");
    expect(palette()!.getAttribute("style")).toBeNull();
  });

  it("en escritorio no hay variable aunque haya barras", async () => {
    stubPhone(false);
    addBottomBar(96);
    render(<Harness />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.style.getPropertyValue("--edit-palette-bottom")).toBe("");
  });

  it("incrustado (PDF Pro): la paleta va en el flujo, sin variable ni banda fija", async () => {
    addBottomBar(96);
    render(<Harness embedded />);
    await waitFor(() => expect(palette()).not.toBeNull());
    expect(palette()!.style.getPropertyValue("--edit-palette-bottom")).toBe("");
    expect(palette()!.className).not.toContain("max-md:fixed");
    expect(palette()!.className).not.toContain("max-md:z-30");
  });
});
