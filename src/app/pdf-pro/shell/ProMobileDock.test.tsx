import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { PRO_TAB_IDS } from "@/app/pdf-pro/ProTabs";
import { ProMobileDock } from "@/app/pdf-pro/shell/ProMobileDock";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(cleanup);

const S = PRO_STRINGS.es;

describe("barra inferior de movil", () => {
  it("tiene un boton por herramienta, todos con aria-haspopup=dialog", () => {
    render(<ProMobileDock language="es" openTab={null} onSelect={() => undefined} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(PRO_TAB_IDS.map((id) => S.suite.tabs[id]));
    for (const button of buttons) expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("es una barra de herramientas con nombre", () => {
    render(<ProMobileDock language="es" openTab={null} onSelect={() => undefined} />);
    expect(screen.getByRole("toolbar", { name: S.shell.dockLabel })).toBeTruthy();
  });

  it("cada boton mide al menos 44 px (min-h-14)", () => {
    render(<ProMobileDock language="es" openTab={null} onSelect={() => undefined} />);
    for (const button of screen.getAllByRole("button")) expect(button.className).toContain("min-h-14");
  });

  it("marca como expandida la herramienta con la hoja abierta", () => {
    render(<ProMobileDock language="es" openTab="sign" onSelect={() => undefined} />);
    expect(screen.getByRole("button", { name: S.suite.tabs.sign }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: S.suite.tabs.edit }).getAttribute("aria-expanded")).toBe("false");
  });

  it("pulsar un boton avisa de la herramienta elegida", () => {
    const onSelect = vi.fn();
    render(<ProMobileDock language="es" openTab={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: S.suite.tabs.protect }));
    expect(onSelect).toHaveBeenCalledWith("protect");
  });

  it("un solo tabulador (roving) que sigue al foco y a las flechas", () => {
    render(<ProMobileDock language="es" openTab={null} onSelect={() => undefined} />);
    const stops = () => screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].textContent).toBe(S.suite.tabs.home);
    const toolbar = screen.getByRole("toolbar");
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe(S.suite.tabs.pages);
    expect(stops()[0].textContent).toBe(S.suite.tabs.pages);
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement?.textContent).toBe(S.suite.tabs.convert);
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement?.textContent).toBe(S.suite.tabs.home);
    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(document.activeElement?.textContent).toBe(S.suite.tabs.convert);
    fireEvent.keyDown(toolbar, { key: "Home" });
    expect(document.activeElement?.textContent).toBe(S.suite.tabs.home);
  });

  it("las flechas solo mueven el foco, no abren la hoja (activacion manual)", () => {
    const onSelect = vi.fn();
    render(<ProMobileDock language="es" openTab={null} onSelect={onSelect} />);
    fireEvent.keyDown(screen.getByRole("toolbar"), { key: "ArrowRight" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("los textos salen en ingles con el idioma en", () => {
    render(<ProMobileDock language="en" openTab={null} onSelect={() => undefined} />);
    expect(screen.getByRole("toolbar", { name: PRO_STRINGS.en.shell.dockLabel })).toBeTruthy();
    expect(screen.getByRole("button", { name: PRO_STRINGS.en.suite.tabs.sign })).toBeTruthy();
  });

  it("cada boton tiene un ancho minimo de 48 px: a 320 px el dock se desplaza en vez de tocar las etiquetas (VI-03) y a 375 px los siete caben", () => {
    render(<ProMobileDock language="es" openTab={null} onSelect={() => undefined} />);
    // M5 · N3: `min-w-[max(3rem,min-content)]` NO es CSS valido (`CSS.supports` da false): el navegador la ignoraba y las celdas
    // se apretaban a 38-41 px. La celda mide 48 px como minimo con `flex-basis` y sin encoger (`flex-[1_0_3rem]`): su ancho minimo
    // automatico es el de la etiqueta, asi que nunca se tocan. Y el dock se desplaza (con ajuste a cada celda) si no caben.
    for (const button of screen.getAllByRole("button")) {
      expect(button.className).toContain("flex-[1_0_3rem]");
      expect(button.className).not.toContain("min-w-[max(");
      expect(button.className).toContain("snap-start");
    }
    expect(screen.getByRole("toolbar").className).toContain("overflow-x-auto");
    expect(screen.getByRole("toolbar").className).toContain("snap-x");
  });
});

describe("raíl lateral (movil horizontal)", () => {
  it("es una barra vertical: las flechas arriba/abajo mueven el foco y las de los lados no", () => {
    render(<ProMobileDock rail language="es" openTab={null} onSelect={() => undefined} />);
    const toolbar = screen.getByRole("toolbar");
    expect(toolbar.getAttribute("aria-orientation")).toBe("vertical");
    expect(toolbar.getAttribute("data-rail")).toBe("");
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: S.suite.tabs.pages }));
    fireEvent.keyDown(toolbar, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toBe(S.suite.tabs.pages);
    fireEvent.keyDown(toolbar, { key: "ArrowUp" });
    expect(document.activeElement?.textContent).toBe(S.suite.tabs.home);
  });

  it("respeta la zona segura izquierda (isla/notch) y sigue siendo de 44 px o mas por boton", () => {
    render(<ProMobileDock rail language="es" openTab={null} onSelect={() => undefined} />);
    expect(screen.getByRole("toolbar").className).toContain("safe-area-inset-left");
    for (const button of screen.getAllByRole("button")) expect(button.className).toContain("min-h-14");
  });

  it("la barra inferior normal no es vertical", () => {
    render(<ProMobileDock language="es" openTab={null} onSelect={() => undefined} />);
    expect(screen.getByRole("toolbar").hasAttribute("aria-orientation")).toBe(false);
    expect(screen.getByRole("toolbar").hasAttribute("data-rail")).toBe(false);
  });
});
