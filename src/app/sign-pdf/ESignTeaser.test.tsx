import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ESignTeaser } from "@/app/sign-pdf/ESignTeaser";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider, useI18n, type Language } from "@/lib/i18n";

/**
 * «E-sign · Pedir firma por email» (F0 · U0.7): solo visual y deshabilitada. Sin logica: ni red, ni navegacion, ni estado.
 */

function UseLanguage({ language }: { language: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => {
    setLanguage(language);
  }, [language, setLanguage]);
  return null;
}

function renderTeaser(language: Language = "es", props: { className?: string } = {}) {
  return render(
    <LanguageProvider>
      <UseLanguage language={language} />
      <ESignTeaser {...props} />
    </LanguageProvider>,
  );
}

beforeEach(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ESignTeaser", () => {
  it("es un boton DESHABILITADO para la tecnologia de apoyo (aria-disabled), pero enfocable", () => {
    renderTeaser();
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    // `aria-disabled` y no `disabled`: sigue en el orden de tabulacion y se puede enfocar.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("type")).toBe("button");
  });

  it("dice «E-sign · Pedir firma por email» con la insignia «Próximamente»", () => {
    renderTeaser();
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("E-sign · Pedir firma por email");
    expect(button.textContent).toContain("Próximamente");
    // El lector de pantalla lo anuncia como no disponible: nombre accesible con la insignia y descripcion «Disponible próximamente».
    expect(screen.getByRole("button", { name: "E-sign · Pedir firma por email Próximamente" })).toBeTruthy();
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(document.getElementById(button.getAttribute("aria-describedby") as string)?.textContent).toBe("Disponible próximamente");
  });

  it("en ingles: «E-sign · Request signature by email» + «Soon» + «Coming soon», sin claves crudas", () => {
    renderTeaser("en");
    const button = screen.getByRole("button", { name: "E-sign · Request signature by email Soon" });
    expect(button).toBeTruthy();
    expect(document.getElementById(button.getAttribute("aria-describedby") as string)?.textContent).toBe("Coming soon");
    expect(document.body.textContent).not.toMatch(/esign|\.label|\.soon/);
  });

  it("los textos salen de las cadenas de Firmar (ES y EN a la par)", () => {
    for (const language of ["es", "en"] as const) {
      const strings = SIGN_STRINGS[language].esign;
      expect(strings.label.length).toBeGreaterThan(5);
      expect(strings.soon.length).toBeGreaterThan(2);
      expect(strings.unavailable.length).toBeGreaterThan(5);
    }
  });

  it("tocarlo NO hace nada: ni navega, ni llama a la red, ni abre nada, ni cambia el DOM", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    const beacon = vi.fn();
    Object.defineProperty(navigator, "sendBeacon", { value: beacon, configurable: true });
    try {
      const { container } = renderTeaser();
      const before = container.innerHTML;
      const button = screen.getByRole("button");
      const href = window.location.href;
      fireEvent.click(button);
      fireEvent.pointerDown(button);
      fireEvent.pointerUp(button);
      fireEvent.keyDown(button, { key: "Enter" });
      fireEvent.keyDown(button, { key: " " });
      fireEvent.keyUp(button, { key: " " });
      expect(window.location.href).toBe(href);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(xhr).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(container.innerHTML).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("no es un enlace ni lleva formulario: no hay a donde ir", () => {
    const { container } = renderTeaser();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("mide al menos 44 px de alto y se ve como deshabilitado sin atenuar el texto con opacidad (se lee con el contraste de siempre)", () => {
    renderTeaser();
    const button = screen.getByRole("button");
    expect(button.className).toContain("min-h-11");
    expect(button.className).toContain("cursor-not-allowed");
    expect(button.className).toContain("border-dashed");
    expect(button.className).toContain("text-muted-foreground");
    expect(button.className).not.toMatch(/(^|\s)opacity-/);
    expect(button.className).not.toMatch(/hover:|active:/);
  });

  it("el foco se ve (anillo de foco visible)", () => {
    renderTeaser();
    expect(screen.getByRole("button").className).toContain("focus-visible:outline-2");
  });

  it("el icono es decorativo y la clase extra se aplica al contenedor", () => {
    const { container } = renderTeaser("es", { className: "mt-3 sm:max-w-sm" });
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("[data-esign-teaser]")?.className).toContain("mt-3");
  });
});
