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
});
