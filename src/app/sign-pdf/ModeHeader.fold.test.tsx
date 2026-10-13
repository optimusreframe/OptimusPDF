import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModeHeader, ModeHeaderSlotContext, type ModeWarning } from "@/app/sign-pdf/embeddedChrome";
import { SIGN_EMBEDDED_STRINGS } from "@/app/sign-pdf/signEmbeddedStrings";

/**
 * B1: la cabecera de un modo (Firmar / Rellenar) pliega DOS o mas avisos en UNA linea resumen expandible y deja uno
 * solo como siempre. El texto completo no se pierde plegado (lectores de pantalla) y nada de esto es region viva.
 */

afterEach(cleanup);

const A: ModeWarning = { code: "a", short: "Corto A", full: "Texto completo A" };
const B: ModeWarning = { code: "b", short: "Corto B", full: "Texto completo B" };
const NOTE: ModeWarning = { code: "editedText", short: "Texto editado", full: "Nota completa del texto editado", tone: "info" };

function header(warnings: ModeWarning[], count = SIGN_EMBEDDED_STRINGS.es.warningsCount) {
  return (
    <ModeHeader
      notesLabel="Qué debes saber"
      notes={["nota"]}
      warningsLabel="Antes de aplicar"
      warnings={warnings}
      warningsCount={count}
    />
  );
}

const warningsList = () => document.querySelector<HTMLElement>("[data-pro-mode-warnings]");

describe("ModeHeader · avisos plegados", () => {
  it("sin avisos no hay lista ni resumen", () => {
    render(header([]));
    expect(warningsList()).toBeNull();
    expect(document.querySelector("[data-notice-fold]")).toBeNull();
  });

  it("UN aviso: una linea con el texto corto, como siempre (sin plegar)", () => {
    render(header([A]));
    expect(document.querySelector("[data-notice-fold]")).toBeNull();
    expect(warningsList()!.querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByText("Corto A")).toBeTruthy();
    expect(screen.getByText("Texto completo A").className).toContain("sr-only");
  });

  it("DOS avisos: una linea «2 avisos» expandible; las dos entradas siguen en el documento", () => {
    render(header([A, B]));
    const fold = screen.getByRole("button", { name: "2 avisos" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(warningsList()!.querySelectorAll("li")).toHaveLength(2);
    // Plegado: nada del texto completo se ve, pero sigue ahi para lectores de pantalla.
    expect(screen.getByText("Texto completo A").className).toContain("sr-only");
    expect(screen.getByText("Texto completo B").className).toContain("sr-only");
    expect(screen.queryByText("Corto A")).toBeNull();
    expect(document.querySelector("[data-notice-fold-panel]")!.className).toContain("sr-only");
  });

  it("al expandir se ve el texto completo de cada aviso (no el corto)", () => {
    render(header([A, B]));
    fireEvent.click(screen.getByRole("button", { name: "2 avisos" }));
    expect(screen.getByText("Texto completo A").className).not.toContain("sr-only");
    expect(screen.getByText("Texto completo B").className).not.toContain("sr-only");
    expect(document.querySelector("[data-notice-fold-panel]")!.className).not.toContain("sr-only");
    const items = [...warningsList()!.querySelectorAll("li")];
    expect(items.map((li) => li.getAttribute("title"))).toEqual(["Texto completo A", "Texto completo B"]);
  });

  it("la lista conserva su nombre accesible y la etiqueta de cada aviso", () => {
    render(header([A, B]));
    expect(warningsList()!.getAttribute("aria-label")).toBe("Antes de aplicar");
    expect([...warningsList()!.querySelectorAll("li")].map((li) => li.getAttribute("data-warning"))).toEqual(["a", "b"]);
  });

  it("tres avisos (dos del documento y la nota del texto editado): «3 avisos», y la nota lleva icono neutro", () => {
    render(header([A, B, NOTE]));
    expect(screen.getByRole("button", { name: "3 avisos" })).toBeTruthy();
    const noteItem = warningsList()!.querySelector('[data-warning="editedText"]')!;
    expect(noteItem.querySelector("svg")!.getAttribute("class")).toContain("text-muted-foreground");
    expect(warningsList()!.querySelector('[data-warning="a"] svg')!.getAttribute("class")).toContain("text-accent-edit");
  });

  it("sin `warningsCount` el resumen sale de la etiqueta de la lista", () => {
    render(
      <ModeHeader notesLabel="x" notes={["n"]} warningsLabel="Avisos" warnings={[A, B, NOTE]} />,
    );
    expect(screen.getByRole("button", { name: "Avisos (3)" })).toBeTruthy();
  });

  it("en ingles: «2 notices»", () => {
    render(header([A, B], SIGN_EMBEDDED_STRINGS.en.warningsCount));
    expect(screen.getByRole("button", { name: "2 notices" })).toBeTruthy();
  });

  it("no hay ninguna region viva en la cabecera: ni plegada ni expandida", () => {
    render(header([A, B]));
    fireEvent.click(screen.getByRole("button", { name: "2 avisos" }));
    expect(document.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});

describe("ModeHeader · con hueco en la fila de controles (PDF Pro)", () => {
  function WithSlot({ warnings }: { warnings: ModeWarning[] }) {
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    return (
      <>
        <div ref={setSlot} data-slot="" />
        <ModeHeaderSlotContext.Provider value={slot}>
          <div data-host="">{header(warnings)}</div>
        </ModeHeaderSlotContext.Provider>
      </>
    );
  }

  it("con dos avisos el resumen va EN la fila y no queda contenedor en el flujo (no resta alto al lienzo)", () => {
    render(<WithSlot warnings={[A, B]} />);
    expect(document.querySelector("[data-slot] [data-notice-fold]")).not.toBeNull();
    expect(document.querySelector("[data-slot] [data-pro-mode-notes]")).not.toBeNull();
    expect(document.querySelector("[data-pro-mode-header]")).toBeNull();
    expect(document.querySelector("[data-host]")!.children).toHaveLength(0);
  });

  it("sin avisos tampoco queda contenedor", () => {
    render(<WithSlot warnings={[]} />);
    expect(document.querySelector("[data-pro-mode-header]")).toBeNull();
    expect(document.querySelector("[data-slot] [data-pro-mode-notes]")).not.toBeNull();
  });

  it("con UN aviso sigue su linea debajo de la fila, como siempre", () => {
    render(<WithSlot warnings={[A]} />);
    expect(document.querySelector("[data-pro-mode-header] [data-pro-mode-warnings]")).not.toBeNull();
    expect(document.querySelector("[data-slot] [data-notice-fold]")).toBeNull();
  });

  it("el estado de plegado sobrevive a repintar la cabecera (el hueco no la remonta)", () => {
    const view = render(<WithSlot warnings={[A, B]} />);
    fireEvent.click(screen.getByRole("button", { name: "2 avisos" }));
    view.rerender(<WithSlot warnings={[A, B]} />);
    expect(screen.getByRole("button", { name: "2 avisos" }).getAttribute("aria-expanded")).toBe("true");
  });
});
