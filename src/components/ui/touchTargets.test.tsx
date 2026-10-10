import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { HIT_44, HIT_44_PSEUDO } from "@/components/ui/touchTarget";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import { ColorSwatches } from "@/components/tool/OptionControls";
import { PageTile, TileButton, ToggleRow } from "@/app/organize-pdf/pageToolkit";
import { ImageOrderGrid } from "@/app/jpg-to-pdf/ImageOrderGrid";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/*
 * W6-C · D9: objetivos tactiles de 44 px con puntero grueso, sin cambiar el
 * aspecto con raton. jsdom no hace layout ni evalua `pointer: coarse`: el
 * contrato se comprueba por clases `pointer-coarse:` (la medida real, con
 * emulacion tactil y `elementFromPoint`, esta en e2e/specs/a11y-sweep.spec.ts).
 */
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 3,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  // ImageOrderGrid crea object URLs de las fotos.
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => {};
});

const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);
const has = (el: Element, token: string) => tokens(el).includes(token);

describe("HIT_44: pseudo-elemento de 44 px centrado", () => {
  it("alto exacto de 44 px centrado (independiente del borde), ancho 44 o el del control", () => {
    const parts = HIT_44_PSEUDO.split(/\s+/);
    for (const token of [
      "pointer-coarse:before:absolute",
      "pointer-coarse:before:top-1/2",
      "pointer-coarse:before:left-1/2",
      "pointer-coarse:before:h-11",
      "pointer-coarse:before:w-11",
      "pointer-coarse:before:min-w-full",
      "pointer-coarse:before:-translate-x-1/2",
      "pointer-coarse:before:-translate-y-1/2",
    ]) {
      expect(parts, token).toContain(token);
    }
    // Nada de `inset-y-*`: con un borde de 1 px dejaba 42 px (secundario sm).
    expect(HIT_44_PSEUDO).not.toMatch(/inset-y/);
  });

  it("HIT_44 anade `relative` solo con puntero grueso (no toca el flujo con raton)", () => {
    expect(HIT_44.split(/\s+/)).toContain("pointer-coarse:relative");
    expect(HIT_44.split(/\s+/).filter((t) => !t.startsWith("pointer-coarse:"))).toEqual([]);
  });
});

describe("Button sm y SegmentedControl sm", () => {
  it.each(["primary", "secondary", "ghost", "destructive"] as const)(
    "Button sm %s: 36 px con raton y zona de 44 px con puntero grueso",
    (variant) => {
      render(
        <Button variant={variant} size="sm">
          Ver borradores
        </Button>,
      );
      const button = screen.getByRole("button");
      expect(has(button, "h-9")).toBe(true);
      for (const token of HIT_44.split(/\s+/)) expect(has(button, token), token).toBe(true);
    },
  );

  it("Button md y lg ya miden 44 px o más: no llevan el pseudo-elemento", () => {
    render(
      <>
        <Button size="md">Medio</Button>
        <Button size="lg">Grande</Button>
      </>,
    );
    for (const name of ["Medio", "Grande"]) {
      expect(screen.getByRole("button", { name }).className).not.toContain("pointer-coarse:before");
    }
  });

  it("«Crear mi firma» sigue sin llevar `pointer-coarse:h-11` (aserción de W3: el vecino es el que crece)", () => {
    render(
      <Button size="sm" variant="primary">
        Crear mi firma
      </Button>,
    );
    expect(has(screen.getByRole("button"), "pointer-coarse:h-11")).toBe(false);
  });

  it("SegmentedControl sm: las pestañas amplían su zona a 44 px con puntero grueso", () => {
    render(
      <SegmentedControl
        size="sm"
        label="Herramienta"
        value="a"
        onChange={() => {}}
        options={[
          { value: "a", label: "Rectángulo" },
          { value: "b", label: "Pincel" },
        ]}
      />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      for (const token of HIT_44.split(/\s+/)) expect(has(tab, token), token).toBe(true);
    }
  });

  it("SegmentedControl md ya mide 44 px: sin pseudo-elemento", () => {
    render(
      <SegmentedControl
        label="Modo"
        value="a"
        onChange={() => {}}
        options={[
          { value: "a", label: "Uno" },
          { value: "b", label: "Dos" },
        ]}
      />,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.className).not.toContain("pointer-coarse:before");
    }
    expect(has(screen.getByRole("tablist"), "min-h-11")).toBe(true);
  });
});

describe("Checkbox: toda la fila es el objetivo", () => {
  it("el ::after de la etiqueta cubre la fila (caja de 22 px + hueco + texto) y la fila es su bloque contenedor", () => {
    render(<Checkbox label="Aplanar" checked={false} onChange={() => {}} />);
    const label = screen.getByText("Aplanar");
    expect(has(label, "after:absolute")).toBe(true);
    expect(has(label, "after:inset-0")).toBe(true);
    const row = label.parentElement as HTMLElement;
    expect(has(row, "relative")).toBe(true);
    expect(has(row, "min-h-11")).toBe(true);
  });

  it("pulsar la etiqueta alterna la casilla", () => {
    const onChange = vi.fn();
    render(<Checkbox label="Aplanar" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByText("Aplanar"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("organize-pdf: PageTile y TileButton", () => {
  it("TileButton compacto (24 px) y normal (28 px) pasan a 44 px con puntero grueso", () => {
    render(
      <>
        <TileButton label="Normal" onClick={() => {}}>
          <svg aria-hidden="true" />
        </TileButton>
        <TileButton label="Compacto" compact onClick={() => {}}>
          <svg aria-hidden="true" />
        </TileButton>
      </>,
    );
    const normal = screen.getByRole("button", { name: "Normal" });
    const compact = screen.getByRole("button", { name: "Compacto" });
    expect(has(normal, "size-7")).toBe(true);
    expect(has(compact, "size-6")).toBe(true);
    expect(has(normal, "pointer-coarse:size-11")).toBe(true);
    expect(has(compact, "pointer-coarse:size-11")).toBe(true);
  });

  it("PageTile: con puntero grueso las acciones salen de la miniatura al flujo y envuelven (5 x 44 px no caben en 165 px)", () => {
    const { container } = render(
      <PageTile
        number={1}
        label="Página 1"
        compactActions
        actions={
          <>
            {[1, 2, 3, 4, 5].map((n) => (
              <TileButton key={n} label={`Acción ${n}`} compact onClick={() => {}}>
                <svg aria-hidden="true" />
              </TileButton>
            ))}
          </>
        }
      />,
    );
    const pill = screen.getByRole("button", { name: "Acción 1" }).parentElement as HTMLElement;
    const wrapper = pill.parentElement as HTMLElement;
    expect(has(wrapper, "pointer-coarse:static")).toBe(true);
    expect(has(wrapper, "pointer-coarse:mt-2")).toBe(true);
    expect(has(pill, "pointer-coarse:flex-wrap")).toBe(true);
    expect(has(pill, "pointer-coarse:justify-center")).toBe(true);
    // Con raton nada cambia: sigue siendo la pildora absoluta sobre la miniatura.
    expect(has(wrapper, "absolute")).toBe(true);
    expect(container.querySelectorAll("button")).toHaveLength(5);
  });

  it("PageTile: el ocultar-hasta-hover solo aplica con raton (con el dedo no hay hover y las acciones deben verse)", () => {
    render(
      <PageTile
        number={1}
        label="Página 1"
        actions={
          <TileButton label="Girar" onClick={() => {}}>
            <svg aria-hidden="true" />
          </TileButton>
        }
      />,
    );
    const wrapper = screen.getByRole("button", { name: "Girar" }).parentElement!.parentElement as HTMLElement;
    expect(has(wrapper, "md:pointer-fine:opacity-0")).toBe(true);
    expect(has(wrapper, "md:opacity-0")).toBe(false);
    expect(has(wrapper, "md:pointer-fine:group-hover/tile:opacity-100")).toBe(true);
    expect(has(wrapper, "md:pointer-fine:group-focus-within/tile:opacity-100")).toBe(true);
  });

  it("ToggleRow de organize (casilla de 16 px): la fila mide 44 px y la etiqueta cubre toda la fila", () => {
    const onChange = vi.fn();
    render(<ToggleRow label="Quitar marcas" checked={false} onChange={onChange} />);
    const label = screen.getByText("Quitar marcas").closest("label") as HTMLElement;
    expect(has(label, "after:absolute")).toBe(true);
    expect(has(label, "after:inset-0")).toBe(true);
    const row = label.parentElement as HTMLElement;
    expect(has(row, "relative")).toBe(true);
    expect(has(row, "pointer-coarse:min-h-11")).toBe(true);
    fireEvent.click(label);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("jpg-to-pdf, Unir y muestras de color", () => {
  it("jpg-to-pdf: Subir/Bajar de 24 px pasan a 44 px con puntero grueso", () => {
    const files = [1, 2, 3].map((n) => new File([new Uint8Array([n])], `foto${n}.jpg`, { type: "image/jpeg" }));
    render(
      <LanguageProvider>
        <ImageOrderGrid files={files} onOrderChange={() => {}} />
      </LanguageProvider>,
    );
    const buttons = [...screen.getAllByRole("button", { name: "Subir" }), ...screen.getAllByRole("button", { name: "Bajar" })];
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(has(button, "size-6")).toBe(true);
      expect(has(button, "pointer-coarse:size-11")).toBe(true);
    }
  });

  it("Unir (PageThumbnailGrid): Subir/Bajar/Quitar de 32 px pasan a 44 px (no 40) y la fila envuelve si no cabe", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "doc.pdf", { type: "application/pdf" });
    const { container } = render(
      <LanguageProvider>
        <PageThumbnailGrid files={[file]} selectable reorderable removable />
      </LanguageProvider>,
    );
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Quitar" })).toHaveLength(3));
    for (const name of ["Subir", "Bajar", "Quitar"]) {
      for (const button of screen.getAllByRole("button", { name })) {
        expect(has(button, "size-8")).toBe(true);
        expect(has(button, "pointer-coarse:size-11")).toBe(true);
        expect(has(button, "pointer-coarse:size-10")).toBe(false);
      }
    }
    const row = screen.getAllByRole("button", { name: "Quitar" })[0].parentElement as HTMLElement;
    expect(has(row, "flex-wrap")).toBe(true);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("muestras de color (8 por panel): 36 px con raton y zona de 44 px con puntero grueso; el hueco sube a 12 px para que la elegida (scale-110) no pise a las vecinas", () => {
    render(
      <ColorSwatches
        label="Color"
        value="#000000"
        colors={["#000000", "#5b6470", "#c0c6cf", "#0d4bff"]}
        onChange={() => {}}
      />,
    );
    const group = screen.getByRole("radiogroup");
    expect(has(group, "gap-2")).toBe(true);
    expect(has(group, "pointer-coarse:gap-3")).toBe(true);
    expect(has(group, "flex-wrap")).toBe(true);
    for (const swatch of screen.getAllByRole("radio")) {
      expect(has(swatch, "size-9")).toBe(true);
      for (const token of HIT_44.split(/\s+/)) expect(has(swatch, token), token).toBe(true);
    }
  });
});
