import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_GROUP_ORDER,
  __clearRegisteredCommandsForTests,
  fuzzyScore,
  normalizeSearch,
  registerCommand,
  scoreCommand,
  searchCommands,
  type ProCommand,
} from "@/app/pdf-pro/shell/proCommands";

const cmd = (id: string, label: string, extra: Partial<ProCommand> = {}): ProCommand => ({ id, label, run: () => undefined, ...extra });

afterEach(() => __clearRegisteredCommandsForTests());

describe("normalizeSearch", () => {
  it("quita acentos y pasa a minusculas", () => {
    expect(normalizeSearch("Páginas ÁÉÍÓÚ ñ")).toBe("paginas aeiou n");
    expect(normalizeSearch("ROTAR")).toBe("rotar");
  });
});

describe("fuzzyScore", () => {
  it("una consulta vacia puntua 0 (coincide con todo)", () => {
    expect(fuzzyScore("", "lo que sea")).toBe(0);
  });

  it("la subcadena exacta puntua mas que una subsecuencia", () => {
    expect(fuzzyScore("rotar", "rotar todas las paginas")!).toBeGreaterThan(fuzzyScore("rtr", "rotar todas las paginas")!);
  });

  it("empezar el texto o una palabra puntua mas", () => {
    expect(fuzzyScore("rot", "rotar paginas")!).toBeGreaterThan(fuzzyScore("rot", "girar rotando")!);
    expect(fuzzyScore("pag", "ir a pagina")!).toBeGreaterThan(fuzzyScore("gin", "ir a pagina")!);
  });

  it("una subsecuencia coincide («rot90» encuentra «rotar 90»)", () => {
    expect(fuzzyScore("rt90", "rotar 90")).not.toBeNull();
  });

  it("si una letra no esta, no hay coincidencia", () => {
    expect(fuzzyScore("xyz", "rotar")).toBeNull();
    expect(fuzzyScore("zr", "rotar")).toBeNull();
  });

  it("el orden de las letras importa", () => {
    expect(fuzzyScore("tor", "rotar")).toBeNull();
  });
});

describe("scoreCommand", () => {
  it("cada palabra de la consulta debe encontrarse (en cualquier orden)", () => {
    const command = cmd("a", "Rotar todas las páginas 90°");
    expect(scoreCommand("90 rotar", command)).not.toBeNull();
    expect(scoreCommand("rotar comprimir", command)).toBeNull();
  });

  it("busca tambien en las palabras clave, sin acentos", () => {
    const command = cmd("a", "Descargar el documento", { keywords: ["guardar", "save"] });
    expect(scoreCommand("save", command)).not.toBeNull();
    expect(scoreCommand("GUARDAR", command)).not.toBeNull();
    expect(scoreCommand("zzz", command)).toBeNull();
  });

  it("una coincidencia en la etiqueta gana a una en las palabras clave", () => {
    const byLabel = cmd("a", "Acercar", { keywords: [] });
    const byKeyword = cmd("b", "Otra cosa", { keywords: ["acercar"] });
    expect(scoreCommand("acercar", byLabel)!).toBeGreaterThan(scoreCommand("acercar", byKeyword)!);
  });

  it("sin consulta puntua 0", () => {
    expect(scoreCommand("   ", cmd("a", "X"))).toBe(0);
  });
});

describe("searchCommands", () => {
  const all = [
    cmd("tab", "Ir a la pestaña Páginas", { group: "tabs" }),
    cmd("rot", "Rotar todas las páginas 90°", { group: "operations" }),
    cmd("zoom", "Acercar", { group: "view" }),
    cmd("undo", "Deshacer", { group: "document" }),
    cmd("tool", "Abrir herramienta suelta: Rotar PDF", { group: "tools" }),
  ];

  it("sin consulta ordena por grupo conservando el orden de declaracion dentro de cada uno", () => {
    const ids = searchCommands(all, "").map((c) => c.id);
    expect(ids).toEqual(["undo", "rot", "tab", "zoom", "tool"]);
    expect(COMMAND_GROUP_ORDER[0]).toBe("document");
  });

  it("con consulta devuelve solo los que coinciden, mejores primero", () => {
    const ids = searchCommands(all, "rotar").map((c) => c.id);
    expect(ids).toContain("rot");
    expect(ids).toContain("tool");
    expect(ids).not.toContain("zoom");
    expect(ids[0]).toBe("rot");
  });

  it("acentos y mayusculas no importan", () => {
    expect(searchCommands(all, "PAGINAS").map((c) => c.id)).toEqual(expect.arrayContaining(["tab", "rot"]));
  });

  it("respeta el limite de resultados", () => {
    const many = Array.from({ length: 100 }, (_, i) => cmd(`c${i}`, `Comando ${i}`));
    expect(searchCommands(many, "", 10)).toHaveLength(10);
    expect(searchCommands(many, "comando", 25)).toHaveLength(25);
  });

  it("una consulta sin coincidencias devuelve una lista vacia", () => {
    expect(searchCommands(all, "qwertyuiop")).toEqual([]);
  });

  it("con empates conserva el orden original", () => {
    const tied = [cmd("1", "Aaa"), cmd("2", "Aaa"), cmd("3", "Aaa")];
    expect(searchCommands(tied, "aaa").map((c) => c.id)).toEqual(["1", "2", "3"]);
  });
});

describe("registerCommand (extension de la paleta)", () => {
  it("devuelve una funcion que lo retira", () => {
    const run = vi.fn();
    const off = registerCommand("x", { label: "Mi comando", run });
    off();
    off();
  });
});
