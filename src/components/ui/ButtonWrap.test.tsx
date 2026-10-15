import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button, buttonClasses } from "@/components/ui/Button";

/*
 * F0-fix3 · rotulos largos: el boton base no parte el texto (`whitespace-nowrap`) y tiene alto fijo, asi que con una
 * tipografia ancha (DejaVu en Linux, Roboto en Android) a 375 px un rotulo de ~35 caracteres desbordaba la pantalla.
 * `wrap` lo parte sin cambiar nada cuando cabe en una linea. jsdom no hace layout: el contrato se comprueba por clases
 * (la medida real, con una fuente ancha forzada, esta en e2e/specs/sign-wide-font.spec.ts).
 */
const tokens = (el: Element) => (el.getAttribute("class") ?? "").split(/\s+/);

describe("Button · wrap", () => {
  it("sin `wrap` el boton es el de siempre: alto fijo y sin partir el texto", () => {
    render(<Button size="md">Rotulo</Button>);
    const classes = tokens(screen.getByRole("button", { name: "Rotulo" }));
    expect(classes).toContain("whitespace-nowrap");
    expect(classes).toContain("h-11");
    for (const wrapped of ["h-auto!", "whitespace-normal!", "max-w-full", "min-h-11"]) expect(classes).not.toContain(wrapped);
  });

  it("con `wrap` parte en lineas, no supera a su contenedor y conserva el alto minimo de su tamano", () => {
    const heights = { sm: "min-h-9", md: "min-h-11", lg: "min-h-14" } as const;
    for (const size of ["sm", "md", "lg"] as const) {
      const { unmount } = render(
        <Button size={size} wrap>
          {`Rotulo ${size}`}
        </Button>,
      );
      const button = screen.getByRole("button", { name: `Rotulo ${size}` });
      const classes = tokens(button);
      // `!` porque `h-*` y `whitespace-nowrap` del tamano base tienen la misma especificidad que las utilidades de `wrap`.
      for (const wanted of ["h-auto!", "whitespace-normal!", "max-w-full", "text-center", heights[size]]) {
        expect(classes, `${size}: ${wanted}`).toContain(wanted);
      }
      // `wrap` no es un atributo del DOM.
      expect(button.hasAttribute("wrap")).toBe(false);
      unmount();
    }
  });

  it("el alto minimo de `md` sigue siendo 44 px (11 x 4) y el de `lg` 56 px", () => {
    expect(buttonClasses("primary", "md", undefined, true)).toContain("min-h-11");
    expect(buttonClasses("primary", "lg", undefined, true)).toContain("min-h-14");
    expect(buttonClasses("primary", "md")).not.toContain("min-h-11");
  });

  it("un `className` propio sigue pudiendo anadir clases junto a `wrap`", () => {
    render(
      <Button wrap className="extra-class">
        Rotulo
      </Button>,
    );
    const classes = tokens(screen.getByRole("button", { name: "Rotulo" }));
    expect(classes).toContain("extra-class");
    expect(classes).toContain("whitespace-normal!");
  });
});
