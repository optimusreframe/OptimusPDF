import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChevronDown } from "lucide-react";
import { MoreMenu } from "@/app/pdf-pro/shell/MoreMenu";

/** Menu «Mas» ampliado en U8: icono propio, identificador, apertura por señal (atajos) y foco al elegir una opcion. */

afterEach(() => cleanup());

const items = (onSelect = vi.fn()) => [
  { id: "a", label: "Descargar PDF", shortcut: "Ctrl/⌘ S", onSelect },
  { id: "b", label: "Guardar como…", onSelect: vi.fn() },
];

describe("MoreMenu · U8", () => {
  it("marca el contenedor con su identificador y admite un icono propio", () => {
    const { container } = render(<MoreMenu label="Guardar y exportar" items={items()} menuId="save" icon={ChevronDown} />);
    expect(container.querySelector("[data-menu='save']")).not.toBeNull();
    expect(container.querySelector("button svg")).not.toBeNull();
  });

  it("`hiddenBelow` oculta el menu entero en pantallas estrechas (clase max-sm:hidden)", () => {
    const { container } = render(<MoreMenu label="Guardar" items={items()} hiddenBelow="sm" menuId="save" />);
    expect(container.querySelector("[data-menu='save']")!.className).toContain("max-sm:hidden");
  });

  it("sin `hiddenBelow` no se oculta", () => {
    const { container } = render(<MoreMenu label="Guardar" items={items()} menuId="save" />);
    expect(container.querySelector("[data-menu='save']")!.className).not.toContain("max-sm:hidden");
  });

  it("no se abre al montar aunque la señal valga algo", () => {
    render(<MoreMenu label="Guardar" items={items()} openSignal={3} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("cada vez que sube la señal se abre, con el foco en la primera opcion", () => {
    const view = render(<MoreMenu label="Guardar" items={items()} openSignal={0} />);
    view.rerender(<MoreMenu label="Guardar" items={items()} openSignal={1} />);
    const menu = screen.getByRole("menu", { name: "Guardar" });
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    view.rerender(<MoreMenu label="Guardar" items={items()} openSignal={2} />);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("una señal que no cambia no reabre un menu cerrado", () => {
    const view = render(<MoreMenu label="Guardar" items={items()} openSignal={1} />);
    view.rerender(<MoreMenu label="Guardar" items={items()} openSignal={1} />);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("elegir una opcion cierra el menu y el foco ya esta en el boton CUANDO se ejecuta (una hoja recordaria <body> si no)", () => {
    let focusedAtSelect: Element | null = null;
    const onSelect = vi.fn(() => {
      focusedAtSelect = document.activeElement;
    });
    render(<MoreMenu label="Guardar" items={items(onSelect)} />);
    const trigger = screen.getByRole("button", { name: "Guardar" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: /Descargar PDF/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(focusedAtSelect).toBe(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("una opcion desactivada no se ejecuta ni cierra el menu", () => {
    const onSelect = vi.fn();
    render(<MoreMenu label="Guardar" items={[{ id: "a", label: "Nada", onSelect, disabled: true }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Nada" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("muestra el atajo de cada opcion como <kbd>", () => {
    render(<MoreMenu label="Guardar" items={items()} />);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByText("Ctrl/⌘ S").tagName).toBe("KBD");
  });
});

describe("MoreMenu · teclado y opciones solo-estrechas", () => {
  const narrowItems = [
    { id: "a", label: "Paleta", onSelect: vi.fn() },
    { id: "b", label: "Descargar PDF", narrowOnly: true, onSelect: vi.fn() },
    { id: "c", label: "Exportar", onSelect: vi.fn() },
  ];

  function stubWide(wide: boolean) {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: wide && query.includes("min-width: 640px"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
  }
  afterEach(() => vi.unstubAllGlobals());

  it("en pantalla ancha las flechas se saltan las opciones `narrowOnly` (estan ocultas con sm:hidden)", () => {
    stubWide(true);
    render(<MoreMenu label="Mas" items={narrowItems} />);
    fireEvent.click(screen.getByRole("button", { name: "Mas" }));
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("en pantalla estrecha las recorre todas", () => {
    stubWide(false);
    render(<MoreMenu label="Mas" items={narrowItems} />);
    fireEvent.click(screen.getByRole("button", { name: "Mas" }));
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
  });
});
