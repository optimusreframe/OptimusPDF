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

describe("EditNavBar · una fila en pantallas estrechas con 8 px entre botones (M5 · N2, VI-07)", () => {
  it("con el dedo los grupos separan sus botones 8 px (antes 0, y «Pagina siguiente» tocaba «Miniaturas»)", () => {
    const { container } = renderBar(true);
    const groups = Array.from(container.querySelectorAll<HTMLElement>('[role="group"], [data-nav-embedded] > div'));
    expect(groups.length).toBeGreaterThanOrEqual(2);
    for (const group of groups) expect(group.className).toContain("pointer-coarse:gap-2");
    expect((container.firstElementChild as HTMLElement).className).toContain("gap-x-2");
  });

  it("por debajo de 380 px el porcentaje y el «/ N» se leen solo por voz para que quepa en UNA fila; el nombre accesible no cambia", () => {
    const { container } = renderBar(true);
    const percent = Array.from(container.querySelectorAll<HTMLElement>("span")).find((span) => /\d+ ?%/.test(span.textContent ?? ""))!;
    expect(percent.className).toContain("max-[379px]:sr-only");
    const total = Array.from(container.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')).find((span) => /3/.test(span.textContent ?? ""))!;
    expect(total.className).toContain("max-[379px]:hidden");
    expect(container.textContent).toContain(EDIT_STRINGS.es.pageOf(1, 3));
    expect((container.firstElementChild as HTMLElement).className).toContain("max-[359px]:px-0.5");
  });
});
