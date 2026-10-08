import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TileButton } from "@/app/organize-pdf/pageToolkit";

// `pageToolkit` importa el motor de PDF solo para sus miniaturas; aqui no se usa.
vi.mock("@/lib/pdf/core", () => ({
  closePdfDocument: vi.fn(),
  openPdfDocument: vi.fn(),
  renderPageToDataUrl: vi.fn(),
  toPdfError: vi.fn(),
}));

/*
 * W1-D: el icono del boton destructivo ("Quitar esta pagina") va sobre un tinte
 * rojo al pasar el puntero (`hover:bg-destructive/20`). Con el color de RELLENO
 * (`text-destructive`) quedaba a ~4,2:1 en oscuro; el token de texto
 * (`text-destructive-text`) da >= 5:1 (medido en navegador, ver
 * docs/PLAN-REDISENO.md). jsdom no pinta: el contrato se comprueba por clases.
 */
const has = (cls: string, token: string) =>
  cls.split(/\s+/).includes(token);

describe("TileButton: contraste del tono destructivo", () => {
  it("usa `text-destructive-text` (no el relleno `text-destructive`) y conserva el fondo de hover", () => {
    render(
      <TileButton label="Quitar esta página" tone="destructive" onClick={() => {}}>
        <svg aria-hidden="true" />
      </TileButton>,
    );
    const cls = screen.getByRole("button", { name: "Quitar esta página" }).className;
    expect(has(cls, "text-destructive-text")).toBe(true);
    expect(has(cls, "text-destructive")).toBe(false);
    expect(has(cls, "hover:bg-destructive/20")).toBe(true);
  });

  it("el tono plano no usa rojo: muted en reposo y foreground sobre veladura blanca al pasar el puntero", () => {
    render(
      <TileButton label="Mover" onClick={() => {}}>
        <svg aria-hidden="true" />
      </TileButton>,
    );
    const cls = screen.getByRole("button", { name: "Mover" }).className;
    expect(has(cls, "text-muted-foreground")).toBe(true);
    expect(has(cls, "hover:text-foreground")).toBe(true);
    expect(cls).not.toMatch(/destructive/);
  });
});
