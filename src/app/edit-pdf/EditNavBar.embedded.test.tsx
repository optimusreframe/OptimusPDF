import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { EditNavBar } from "@/app/edit-pdf/EditNavBar";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

/** La barra de zoom y paginas dentro de PDF Pro (Wave 7 · U6) no se pega bajo la cabecera de la web. */

afterEach(cleanup);

function renderBar(embedded?: boolean) {
  const strings = EDIT_STRINGS.es;
  return render(
    <EditNavBar
      zoom={1}
      onZoomIn={vi.fn()}
      onZoomOut={vi.fn()}
      pageIndex={0}
      pageCount={3}
      onGoTo={vi.fn()}
      stripOpen={false}
      onToggleStrip={vi.fn()}
      stripId="strip"
      strings={strings}
      s={strings.inline}
      embedded={embedded}
    />,
  );
}

describe("EditNavBar embebida", () => {
  it("por defecto es pegajosa y lleva la marca que la barra flotante busca", () => {
    const { container } = renderBar();
    const nav = container.firstElementChild as HTMLElement;
    expect(nav.className).toContain("sticky");
    expect(nav.hasAttribute("data-canvas-sticky")).toBe(true);
    expect(nav.hasAttribute("data-nav-embedded")).toBe(false);
  });

  it("embebida es relativa, sin la marca pegajosa y con su propia marca", () => {
    const { container } = renderBar(true);
    const nav = container.firstElementChild as HTMLElement;
    expect(nav.className).not.toContain("sticky");
    expect(nav.className).toContain("relative");
    expect(nav.hasAttribute("data-canvas-sticky")).toBe(false);
    expect(nav.hasAttribute("data-nav-embedded")).toBe(true);
  });

  it("conserva los mismos controles", () => {
    const a = renderBar();
    const normal = a.container.querySelectorAll("button, input").length;
    cleanup();
    const b = renderBar(true);
    expect(b.container.querySelectorAll("button, input").length).toBe(normal);
  });
});
