import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoreMenu, type MoreMenuItem } from "@/app/pdf-pro/shell/MoreMenu";

afterEach(cleanup);

const items = (extra: Partial<MoreMenuItem>[] = []): MoreMenuItem[] => [
  { id: "a", label: "Primera", shortcut: "Ctrl+K", onSelect: vi.fn() },
  { id: "b", label: "Segunda", onSelect: vi.fn(), separatorBefore: true },
  { id: "c", label: "Tercera", checked: true, onSelect: vi.fn() },
  { id: "d", label: "Cuarta", checked: false, onSelect: vi.fn() },
  { id: "e", label: "Solo estrecha", narrowOnly: true, onSelect: vi.fn() },
  ...extra.map((patch, index) => ({ id: `x${index}`, label: `Extra ${index}`, onSelect: vi.fn(), ...patch })),
];

const trigger = () => screen.getByRole("button", { name: "Más acciones" });
const open = () => fireEvent.click(trigger());

describe("MoreMenu (boton de menu WAI-ARIA)", () => {
  it("cerrado solo muestra el boton, con aria-haspopup y aria-expanded=false", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("al abrir pinta el menu y lleva el foco a la primera opcion", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("menu", { name: "Más acciones" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
    expect(trigger().getAttribute("aria-controls")).toBe(screen.getByRole("menu").id);
  });

  it("los elementos con estado son menuitemcheckbox con aria-checked", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    const checkboxes = screen.getAllByRole("menuitemcheckbox");
    expect(checkboxes.map((el) => el.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("las flechas, Inicio y Fin mueven el foco dando la vuelta", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    const menu = screen.getByRole("menu");
    const all = [...screen.getAllByRole("menuitem"), ...screen.getAllByRole("menuitemcheckbox")];
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Segunda");
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(all.find((el) => el.textContent?.includes("Solo estrecha")) ?? null);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement?.textContent).toContain("Primera");
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement?.textContent).toContain("Solo estrecha");
  });

  it("elegir una opcion la ejecuta y cierra el menu", () => {
    const list = items();
    render(<MoreMenu label="Más acciones" items={list} />);
    open();
    fireEvent.click(screen.getByText("Segunda"));
    expect(list[1].onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("una opcion desactivada es enfocable pero no hace nada", () => {
    const list = items([{ disabled: true }]);
    render(<MoreMenu label="Más acciones" items={list} />);
    open();
    const disabled = screen.getByText("Extra 0").closest("button") as HTMLElement;
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(disabled);
    expect(list[list.length - 1].onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("Esc cierra y devuelve el foco al boton", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("Tab cierra el menu sin atrapar el foco", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("un toque fuera lo cierra", () => {
    render(
      <div>
        <p>fuera</p>
        <MoreMenu label="Más acciones" items={items()} />
      </div>,
    );
    open();
    fireEvent.pointerDown(screen.getByText("fuera"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("un toque dentro no lo cierra", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    fireEvent.pointerDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("la flecha abajo en el boton lo abre", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    fireEvent.keyDown(trigger(), { key: "ArrowDown" });
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("las opciones solo para pantallas estrechas llevan la clase sm:hidden", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    const wrapper = screen.getByText("Solo estrecha").closest("[role=none]") as HTMLElement;
    expect(wrapper.className).toContain("sm:hidden");
  });

  it("cada opcion mide al menos 44 px de alto", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    for (const el of screen.getAllByRole("menuitem")) expect(el.className).toContain("min-h-11");
  });

  it("muestra el atajo de la opcion", () => {
    render(<MoreMenu label="Más acciones" items={items()} />);
    open();
    expect(screen.getByText("Ctrl+K")).toBeTruthy();
  });
});
