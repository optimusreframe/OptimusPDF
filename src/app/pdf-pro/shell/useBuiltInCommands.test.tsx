import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { PRO_OPERATIONS } from "@/app/pdf-pro/proOperations";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { PRO_TAB_IDS } from "@/app/pdf-pro/ProTabs";
import { searchCommands } from "@/app/pdf-pro/shell/proCommands";
import { goToPageCommands, useBuiltInCommands, type BuiltInCommandArgs } from "@/app/pdf-pro/shell/useBuiltInCommands";
import { createViewerStore } from "@/app/pdf-pro/viewer/viewerStore";
import { TOOL_SLUGS, getTool } from "@/lib/tools-registry";

function makeArgs(patch: Partial<BuiltInCommandArgs> = {}): BuiltInCommandArgs {
  const api = createViewerStore();
  api.setPageCount(40);
  return {
    enabled: true,
    language: "es",
    t: es,
    api,
    pageCount: 40,
    canUndo: true,
    canRedo: false,
    busy: false,
    goToTab: vi.fn(),
    applyOperation: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    download: vi.fn(),
    exportDocument: vi.fn(),
    closeDocument: vi.fn(),
    openShortcuts: vi.fn(),
    toggleThumbs: vi.fn(),
    togglePanel: vi.fn(),
    openTool: vi.fn(),
    ...patch,
  };
}

const build = (args = makeArgs()) => ({ args, commands: renderHook(() => useBuiltInCommands(args)).result.current });
const find = (commands: ReturnType<typeof build>["commands"], id: string) => commands.find((c) => c.id === id)!;

describe("comandos propios de la suite", () => {
  it("desactivada no genera nada (no cuesta nada con la paleta cerrada)", () => {
    expect(build(makeArgs({ enabled: false })).commands).toEqual([]);
  });

  it("hay un comando por cada pestaña, con su nombre en el idioma activo", () => {
    const { commands } = build();
    for (const id of PRO_TAB_IDS) {
      expect(find(commands, `tab:${id}`).label).toBe(PRO_STRINGS.es.palette.goToTab(PRO_STRINGS.es.suite.tabs[id]));
    }
  });

  it("ir a una pestaña llama al manejador con su id", () => {
    const { commands, args } = build();
    find(commands, "tab:sign").run();
    expect(args.goToTab).toHaveBeenCalledWith("sign");
  });

  it("lee PRO_OPERATIONS: cada operacion de documento completo es un comando", () => {
    const { commands, args } = build();
    for (const operation of PRO_OPERATIONS.filter((op) => op.kind === "document")) {
      const command = find(commands, `op:${operation.id}`);
      expect(command.label).toBe(PRO_STRINGS.es.operations[operation.labelKey]);
      command.run();
      expect(args.applyOperation).toHaveBeenCalledWith(operation);
    }
  });

  it("las operaciones se desactivan mientras otra se aplica", () => {
    const { commands } = build(makeArgs({ busy: true }));
    const first = PRO_OPERATIONS.find((op) => op.kind === "document")!;
    expect(find(commands, `op:${first.id}`).disabled).toBe(true);
  });

  it("«Abrir herramienta suelta» existe para cada herramienta viva menos PDF Pro", () => {
    const { commands, args } = build();
    const live = TOOL_SLUGS.filter((slug) => slug !== "pdf-pro" && getTool(slug).status === "live");
    for (const slug of live) {
      const command = find(commands, `tool:${slug}`);
      expect(command.label).toBe(PRO_STRINGS.es.palette.openTool(es.tools[slug].name));
      command.run();
      expect(args.openTool).toHaveBeenCalledWith(slug);
    }
    expect(commands.some((c) => c.id === "tool:pdf-pro")).toBe(false);
    expect(live.length).toBeGreaterThan(20);
  });

  it("deshacer y rehacer reflejan el historial y llevan su atajo", () => {
    const { commands, args } = build(makeArgs({ canUndo: true, canRedo: false }));
    expect(find(commands, "doc:undo").disabled).toBe(false);
    expect(find(commands, "doc:redo").disabled).toBe(true);
    expect(find(commands, "doc:undo").shortcut).toBe("Ctrl+Z");
    find(commands, "doc:undo").run();
    expect(args.undo).toHaveBeenCalled();
  });

  it("descargar, exportar, atajos y cerrar delegan en la suite", () => {
    const { commands, args } = build();
    find(commands, "doc:download").run();
    find(commands, "doc:export").run();
    find(commands, "doc:shortcuts").run();
    find(commands, "doc:close").run();
    expect(args.download).toHaveBeenCalled();
    expect(args.exportDocument).toHaveBeenCalled();
    expect(args.openShortcuts).toHaveBeenCalled();
    expect(args.closeDocument).toHaveBeenCalled();
  });

  it("los comandos de vista usan la API del visor", () => {
    const { commands, args } = build();
    find(commands, "view:zoom-in").run();
    expect(args.api.getZoom()).toBe(1.25);
    find(commands, "view:zoom-out").run();
    find(commands, "view:fit").run();
    expect(args.api.getZoom()).toBe(1);
    find(commands, "view:last").run();
    expect(args.api.getCurrentPage()).toBe(39);
    find(commands, "view:first").run();
    expect(args.api.getCurrentPage()).toBe(0);
    find(commands, "view:next").run();
    expect(args.api.getCurrentPage()).toBe(1);
    find(commands, "view:prev").run();
    expect(args.api.getCurrentPage()).toBe(0);
    find(commands, "view:select-all").run();
    expect(args.api.getSelectedPages()).toHaveLength(40);
    find(commands, "view:clear-selection").run();
    expect(args.api.getSelectedPages()).toEqual([]);
  });

  it("sin paginas los comandos de salto estan desactivados", () => {
    const { commands } = build(makeArgs({ pageCount: 0 }));
    expect(find(commands, "view:next").disabled).toBe(true);
    expect(find(commands, "view:select-all").disabled).toBe(true);
  });

  it("alternar miniaturas y panel delega en la suite", () => {
    const { commands, args } = build();
    find(commands, "view:thumbs").run();
    find(commands, "view:panel").run();
    expect(args.toggleThumbs).toHaveBeenCalled();
    expect(args.togglePanel).toHaveBeenCalled();
  });

  it("los textos salen en ingles con el idioma en", () => {
    const { commands } = build(makeArgs({ language: "en", t: en }));
    expect(find(commands, "doc:undo").label).toBe(PRO_STRINGS.en.palette.undo);
    expect(find(commands, "tab:pages").label).toBe(PRO_STRINGS.en.palette.goToTab(PRO_STRINGS.en.suite.tabs.pages));
  });

  it("la busqueda encuentra «rotar» en espanol y «rotate» por sus palabras clave", () => {
    const { commands } = build();
    expect(searchCommands(commands, "rotar 90").some((c) => c.id === "op:rotate-all")).toBe(true);
    expect(searchCommands(commands, "comprimir").some((c) => c.id === "op:compress")).toBe(true);
    expect(searchCommands(commands, "zoom").some((c) => c.id === "view:zoom-in")).toBe(true);
    expect(searchCommands(commands, "guardar").some((c) => c.id === "doc:download")).toBe(true);
  });
});

describe("goToPageCommands (Ir a la pagina N)", () => {
  const api = createViewerStore();
  api.setPageCount(500);

  it("un numero dentro del documento da un comando que salta a esa pagina", () => {
    const [command] = goToPageCommands("es", api, 500, "250");
    expect(command.label).toBe(PRO_STRINGS.es.palette.goToPage(250));
    command.run();
    expect(api.getCurrentPage()).toBe(249);
  });

  it("acepta texto alrededor («ir a 12», «pag. 12»)", () => {
    expect(goToPageCommands("es", api, 500, "ir a 12")).toHaveLength(1);
    expect(goToPageCommands("es", api, 500, "pag. 12")[0].id).toBe("goto:12");
  });

  it("«rotar 90» NO ofrece saltar a la pagina 90 (el numero es de otro comando)", () => {
    expect(goToPageCommands("es", api, 500, "rotar 90")).toEqual([]);
    expect(goToPageCommands("es", api, 500, "90 grados")).toEqual([]);
    expect(goToPageCommands("es", api, 500, "comprimir 9")).toEqual([]);
  });

  it("acepta las formas habituales en los dos idiomas", () => {
    for (const query of ["12", "p12", "p 12", "pag 12", "pagina 12", "ir a 12", "ir a la pagina 12", "go to page 12", "page 12", "#12"]) {
      const [command] = goToPageCommands("es", api, 500, query);
      expect(command?.id, query).toBe("goto:12");
    }
  });

  it("fuera de rango, cero o sin numero no da nada", () => {
    expect(goToPageCommands("es", api, 500, "501")).toEqual([]);
    expect(goToPageCommands("es", api, 500, "0")).toEqual([]);
    expect(goToPageCommands("es", api, 500, "rotar")).toEqual([]);
    expect(goToPageCommands("es", api, 500, "")).toEqual([]);
  });

  it("dos numeros distintos no se interpretan como una pagina", () => {
    expect(goToPageCommands("es", api, 500, "3 y 4")).toEqual([]);
  });

  it("sin paginas no hay comando", () => {
    expect(goToPageCommands("es", api, 0, "1")).toEqual([]);
  });

  it("el texto sale en el idioma activo", () => {
    expect(goToPageCommands("en", api, 500, "7")[0].label).toBe(PRO_STRINGS.en.palette.goToPage(7));
  });
});
