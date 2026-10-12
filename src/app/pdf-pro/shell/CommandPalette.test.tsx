import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { CommandPalette } from "@/app/pdf-pro/shell/CommandPalette";
import type { ProCommand } from "@/app/pdf-pro/shell/proCommands";
import { SetLanguage } from "@/app/pdf-pro/viewer/viewerTestUtils";

const P = PRO_STRINGS.es.palette;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(cleanup);

const sleep = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

function makeCommands(run = vi.fn()): ProCommand[] {
  return [
    { id: "doc:undo", label: "Deshacer", group: "document", shortcut: "Ctrl+Z", run },
    { id: "doc:redo", label: "Rehacer", group: "document", disabled: true, run },
    { id: "op:rotate", label: "Rotar todas las páginas 90°", group: "operations", keywords: ["girar"], run },
    { id: "tab:pages", label: "Ir a la pestaña Páginas", group: "tabs", run },
    { id: "view:zoom", label: "Acercar", group: "view", keywords: ["zoom"], run },
    { id: "tool:merge", label: "Abrir herramienta suelta: Unir PDF", group: "tools", run },
  ];
}

type Props = Partial<React.ComponentProps<typeof CommandPalette>>;

function Host({ commands, open = true, onClose, ...rest }: Props) {
  const [isOpen, setOpen] = useState(open);
  return (
    <LanguageProvider>
      <button type="button">abrir</button>
      <CommandPalette
        open={isOpen}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        commands={commands ?? makeCommands()}
        {...rest}
      />
    </LanguageProvider>
  );
}

async function openPalette(props: Props = {}) {
  render(<Host {...props} />);
  await screen.findByRole("combobox", { name: P.label });
  await sleep(30);
  return screen.getByRole("combobox", { name: P.label }) as HTMLInputElement;
}

const optionLabels = () => screen.getAllByRole("option").map((el) => el.querySelector("span")?.textContent);
const active = (input: HTMLElement) => document.getElementById(input.getAttribute("aria-activedescendant")!)!;

describe("apertura y estructura", () => {
  it("es un dialogo modal con titulo, un combobox y un listbox", async () => {
    const input = await openPalette();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("listbox", { name: P.resultsLabel })).toBeTruthy();
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
  });

  it("el foco queda en el campo de busqueda", async () => {
    const input = await openPalette();
    expect(document.activeElement).toBe(input);
  });

  it("sin buscar lista todos los comandos ordenados por grupo", async () => {
    await openPalette();
    expect(optionLabels()).toEqual([
      "Deshacer",
      "Rehacer",
      "Rotar todas las páginas 90°",
      "Ir a la pestaña Páginas",
      "Acercar",
      "Abrir herramienta suelta: Unir PDF",
    ]);
  });

  it("cada opcion muestra su grupo o su atajo", async () => {
    await openPalette();
    const options = screen.getAllByRole("option");
    expect(within(options[0]).getByText("Ctrl+Z")).toBeTruthy();
    expect(within(options[2]).getByText(P.groups.operations)).toBeTruthy();
  });

  it("cerrada no se pinta", () => {
    render(<Host open={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("la hoja se llama «Paleta de comandos»", async () => {
    await openPalette();
    expect(screen.getByRole("dialog").textContent).toContain(P.title);
  });
});

describe("busqueda", () => {
  it("filtra por lo escrito, sin acentos ni mayusculas", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "PAGINAS" } });
    expect([...optionLabels()].sort()).toEqual(["Ir a la pestaña Páginas", "Rotar todas las páginas 90°"]);
  });

  it("tambien busca en las palabras clave", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "girar" } });
    expect(optionLabels()).toEqual(["Rotar todas las páginas 90°"]);
  });

  it("varias palabras deben coincidir todas", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "rotar 90" } });
    expect(optionLabels()).toEqual(["Rotar todas las páginas 90°"]);
    fireEvent.change(input, { target: { value: "rotar zoom" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it("sin coincidencias muestra el aviso y oculta la lista", async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: "qqqq" } });
    expect(screen.getByText(P.empty)).toBeTruthy();
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("los comandos dinamicos (Ir a la pagina N) van los primeros", async () => {
    const run = vi.fn();
    const input = await openPalette({
      dynamicCommands: (query) =>
        /\d+/.test(query) ? [{ id: "goto:12", label: P.goToPage(12), group: "view", run }] : [],
    });
    fireEvent.change(input, { target: { value: "12" } });
    expect(optionLabels()[0]).toBe(P.goToPage(12));
  });

  it("al buscar, el primero queda activo", async () => {
    const input = await openPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.change(input, { target: { value: "a" } });
    expect(active(input).getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-0$/);
  });
});

describe("teclado (aria-activedescendant: el foco no sale del campo)", () => {
  it("las flechas mueven la opcion activa y dan la vuelta", async () => {
    const input = await openPalette();
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-0$/);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-1$/);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-5$/);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-0$/);
    expect(document.activeElement).toBe(input);
  });

  it("Av Pag y Re Pag se mueven varias a la vez y se detienen en los extremos", async () => {
    const input = await openPalette();
    fireEvent.keyDown(input, { key: "PageDown" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-5$/);
    fireEvent.keyDown(input, { key: "PageUp" });
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-0$/);
  });

  it("solo la opcion activa tiene aria-selected", async () => {
    const input = await openPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const selected = screen.getAllByRole("option").filter((el) => el.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe(input.getAttribute("aria-activedescendant"));
  });

  it("pasar el raton por una opcion la activa", async () => {
    const input = await openPalette();
    fireEvent.mouseMove(screen.getAllByRole("option")[3]);
    expect(input.getAttribute("aria-activedescendant")).toMatch(/-opt-3$/);
  });
});

describe("ejecucion", () => {
  it("Intro cierra la paleta y ejecuta el comando activo", async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const input = await openPalette({ commands: makeCommands(run), onClose });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    await sleep(20);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("un clic en una opcion la ejecuta", async () => {
    const run = vi.fn();
    await openPalette({ commands: makeCommands(run) });
    fireEvent.click(screen.getByText("Acercar"));
    await sleep(20);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("al ejecutar, el foco sale del campo de texto al instante (Ctrl+Z no queda bloqueado mientras la hoja se va)", async () => {
    const input = await openPalette();
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(document.activeElement).not.toBe(input);
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
  });

  it("un comando desactivado se ve pero no se ejecuta ni cierra", async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const input = await openPalette({ commands: makeCommands(run), onClose });
    const redo = screen.getByText("Rehacer").closest("[role=option]") as HTMLElement;
    expect(redo.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(redo);
    await sleep(20);
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Enter sin resultados no hace nada", async () => {
    const onClose = vi.fn();
    const input = await openPalette({ onClose });
    fireEvent.change(input, { target: { value: "qqqq" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Ctrl+K o Cmd+K dentro del campo cierran la paleta", async () => {
    const onClose = vi.fn();
    const input = await openPalette({ onClose });
    fireEvent.keyDown(input, { key: "k", ctrlKey: true });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc la cierra", async () => {
    const onClose = vi.fn();
    await openPalette({ onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("un comando que lleva el foco a otra parte no lo pierde al cerrarse la hoja", async () => {
    const target = document.createElement("button");
    target.textContent = "destino";
    document.body.appendChild(target);
    try {
      const run = vi.fn(() => target.focus());
      const input = await openPalette({
        commands: [{ id: "x", label: "Llevar el foco", run }],
      });
      fireEvent.keyDown(input, { key: "Enter" });
      await sleep(50);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(target);
    } finally {
      target.remove();
    }
  });
});

describe("anuncios por la region viva unica", () => {
  it("anuncia el numero de resultados tras una pausa, no por cada letra", async () => {
    const announce = vi.fn();
    const input = await openPalette({ announce });
    fireEvent.change(input, { target: { value: "r" } });
    fireEvent.change(input, { target: { value: "ro" } });
    fireEvent.change(input, { target: { value: "rot" } });
    expect(announce).not.toHaveBeenCalled();
    await sleep(650);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(P.resultsCount(screen.getAllByRole("option").length));
  });

  it("no anuncia nada sin consulta", async () => {
    const announce = vi.fn();
    await openPalette({ announce });
    await sleep(650);
    expect(announce).not.toHaveBeenCalled();
  });

  it("no anuncia tras ejecutar un comando (la hoja aun se esta cerrando)", async () => {
    const announce = vi.fn();
    const input = await openPalette({ announce });
    fireEvent.change(input, { target: { value: "acercar" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await sleep(700);
    expect(announce).not.toHaveBeenCalled();
  });

  it("singular para un solo resultado", () => {
    expect(P.resultsCount(1)).toBe("1 resultado");
  });
});

describe("idioma", () => {
  it("los textos fijos salen en ingles con el idioma en", async () => {
    render(
      <LanguageProvider>
        <SetLanguage language="en" />
        <CommandPalette open onClose={() => undefined} commands={makeCommands()} />
      </LanguageProvider>,
    );
    const E = PRO_STRINGS.en.palette;
    await screen.findByRole("combobox", { name: E.label });
    expect(screen.getByRole("dialog").textContent).toContain(E.title);
    expect(screen.getByText(E.hint)).toBeTruthy();
  });
});
