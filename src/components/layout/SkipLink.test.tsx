import { describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { SkipLink, MAIN_CONTENT_ID } from "@/components/layout/SkipLink";
import { Sidebar } from "@/components/layout/Sidebar";
import { Header } from "@/components/layout/Header";
import { LanguageProvider, useI18n, type Language } from "@/lib/i18n";

vi.mock("next/navigation", () => ({ usePathname: () => "/merge-pdf" }));

/*
 * W6-C · D7 «Saltar al contenido» (WCAG 2.4.1). El enlace es el primer
 * elemento enfocable, queda fuera de pantalla hasta recibir el foco y lleva
 * el FOCO (no solo el scroll) a <main tabIndex=-1>. jsdom no pinta ni aplica
 * `sr-only`: el contrato visual se comprueba por clases y el orden de Tab por
 * el orden del DOM (que es el de Tab mientras no haya tabindex positivo).
 */

const has = (cls: string, token: string) => cls.split(/\s+/).includes(token);
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** El idioma vive en un store con cache: se fija por el propio contexto. */
function Lang({ code }: { code: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(code), [code, setLanguage]);
  return null;
}

function renderPage() {
  return render(
    <LanguageProvider>
      <Lang code="es" />
      <SkipLink />
      <div className="flex">
        <Sidebar />
        <div>
          <Header />
          <main id={MAIN_CONTENT_ID} tabIndex={-1}>
            <button type="button">Seleccionar archivo</button>
          </main>
        </div>
      </div>
    </LanguageProvider>,
  );
}

describe("SkipLink — componente", () => {
  it("es un enlace al ancla #content con el texto en español", () => {
    render(
      <LanguageProvider>
        <Lang code="es" />
        <SkipLink />
      </LanguageProvider>,
    );
    const link = screen.getByRole("link", { name: "Saltar al contenido" });
    expect(link.getAttribute("href")).toBe("#content");
  });

  it("el texto sigue el idioma activo (en)", () => {
    render(
      <LanguageProvider>
        <Lang code="en" />
        <SkipLink />
      </LanguageProvider>,
    );
    expect(screen.getByRole("link", { name: "Skip to content" })).toBeTruthy();
  });

  it("está fuera de pantalla en reposo (sr-only) y aparece al enfocarse con teclado (focus-visible)", () => {
    render(
      <LanguageProvider>
        <Lang code="es" />
        <SkipLink />
      </LanguageProvider>,
    );
    const cls = screen.getByRole("link").className;
    expect(has(cls, "sr-only")).toBe(true);
    for (const token of [
      "focus-visible:not-sr-only",
      "focus-visible:fixed",
      "focus-visible:top-3",
      "focus-visible:left-3",
      "focus-visible:z-[100]",
      "focus-visible:outline-2",
    ]) {
      expect(has(cls, token), token).toBe(true);
    }
  });

  it("al activarlo lleva el FOCO a <main> (no solo el scroll) y cancela la navegación del ancla", () => {
    renderPage();
    const link = screen.getByRole("link", { name: "Saltar al contenido" });
    link.focus();
    expect(document.activeElement).toBe(link);
    const notCancelled = fireEvent.click(link);
    expect(notCancelled).toBe(false); // preventDefault: Next no ve un cambio de hash
    expect(document.activeElement).toBe(document.getElementById(MAIN_CONTENT_ID));
  });

  it("tras saltar, el siguiente control en el orden del DOM es el primero de la herramienta", () => {
    renderPage();
    fireEvent.click(screen.getByRole("link", { name: "Saltar al contenido" }));
    const main = document.getElementById(MAIN_CONTENT_ID)!;
    expect(main.getAttribute("tabindex")).toBe("-1");
    // Primer enfocable DESPUES de <main> en el orden del documento: su hijo.
    const order = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = order.find(
      (el) => main.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(next?.textContent).toBe("Seleccionar archivo");
  });

  it("si no hay <main> no hace nada ni rompe (el ancla nativa actúa)", () => {
    render(
      <LanguageProvider>
        <Lang code="es" />
        <SkipLink />
      </LanguageProvider>,
    );
    const link = screen.getByRole("link");
    expect(() => fireEvent.click(link)).not.toThrow();
    // Sin destino no se cancela el comportamiento por defecto.
    expect(fireEvent.click(link)).toBe(true);
  });
});

describe("SkipLink — orden de Tab frente al Sidebar y el Header", () => {
  it("es el PRIMER elemento enfocable del documento, antes del Sidebar y la cabecera", () => {
    renderPage();
    const order = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE));
    expect(order[0].textContent).toBe("Saltar al contenido");
  });

  it("el Sidebar tiene muchos controles antes de la zona principal: sin el enlace serían todos Tab", () => {
    renderPage();
    const main = document.getElementById(MAIN_CONTENT_ID)!;
    const before = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Enlace + colapsar + buscador + inicio + 6 categorías + recientes + ajustes + precios + proyecto + idioma ...
    expect(before.length).toBeGreaterThanOrEqual(12);
    expect(before[0].textContent).toBe("Saltar al contenido");
  });
});

describe("SkipLink — layout raíz", () => {
  const source = readFileSync(path.resolve(process.cwd(), "src/app/layout.tsx"), "utf8");

  it("<SkipLink /> se monta antes que el Sidebar y el Header", () => {
    const skip = source.indexOf("<SkipLink />");
    expect(skip).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(source.indexOf("<Sidebar />"));
    expect(skip).toBeLessThan(source.indexOf("<Header />"));
  });

  it("<main> es el destino: id compartido y tabIndex -1 (foco programático), sin anillo propio", () => {
    expect(source).toMatch(/<main[\s\S]*?id=\{MAIN_CONTENT_ID\}[\s\S]*?tabIndex=\{-1\}[\s\S]*?outline-none[\s\S]*?>/);
    expect(MAIN_CONTENT_ID).toBe("content");
  });
});
