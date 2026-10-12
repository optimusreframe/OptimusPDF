import { afterEach, describe, expect, it } from "vitest";
import type { ProModeDefinition } from "@/app/pdf-pro/modes/modeTypes";
import { getProMode, listProModes, registerProMode } from "@/app/pdf-pro/modes/proModes";

/** Registro de modos de PDF Pro (Wave 7 · U6): lo comparten Editar, Anotar, Firmar y Rellenar. */

const Stub = (() => null) as unknown as ProModeDefinition["Component"];
const def = (tab: ProModeDefinition["tab"], extra: Partial<ProModeDefinition> = {}): ProModeDefinition => ({
  id: tab === "edit" ? "edit" : tab === "annotate" ? "annotate" : tab === "sign" ? "sign" : "fill",
  tab,
  labelKey: tab,
  Component: Stub,
  ...extra,
});

const disposers: Array<() => void> = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
});
const register = (d: ProModeDefinition) => {
  const dispose = registerProMode(d);
  disposers.push(dispose);
  return dispose;
};

describe("registro de modos", () => {
  it("registra un modo y lo encuentra por su pestaña", () => {
    const d = def("edit");
    register(d);
    expect(getProMode("edit")).toBe(d);
  });

  it("una pestaña sin modo devuelve undefined", () => {
    expect(getProMode("protect")).toBeUndefined();
    expect(getProMode("")).toBeUndefined();
    expect(getProMode("home")).toBeUndefined();
  });

  it("el registro devuelve la funcion que lo retira", () => {
    const dispose = register(def("sign"));
    expect(getProMode("sign")).toBeDefined();
    dispose();
    expect(getProMode("sign")).toBeUndefined();
  });

  it("registrar otra vez la misma pestaña REEMPLAZA el modo", () => {
    const first = def("annotate", { labelKey: "uno" });
    const second = def("annotate", { labelKey: "dos" });
    register(first);
    register(second);
    expect(getProMode("annotate")).toBe(second);
  });

  it("retirar un registro viejo NO quita el modo que lo reemplazo", () => {
    const disposeFirst = register(def("annotate", { labelKey: "uno" }));
    const second = def("annotate", { labelKey: "dos" });
    register(second);
    disposeFirst();
    expect(getProMode("annotate")).toBe(second);
  });

  it("retirar dos veces es inocuo", () => {
    const dispose = register(def("fill"));
    dispose();
    expect(() => dispose()).not.toThrow();
    expect(getProMode("fill")).toBeUndefined();
  });

  it("listProModes devuelve los registrados", () => {
    register(def("edit"));
    register(def("fill"));
    const tabs = listProModes().map((d) => d.tab);
    expect(tabs).toContain("edit");
    expect(tabs).toContain("fill");
  });

  it("listProModes es una copia: modificarla no toca el registro", () => {
    register(def("edit"));
    listProModes().length = 0;
    expect(getProMode("edit")).toBeDefined();
  });

  it("guarda la herramienta suelta equivalente (informativa)", () => {
    register(def("edit", { preferredTool: "edit-pdf" }));
    expect(getProMode("edit")?.preferredTool).toBe("edit-pdf");
  });
});
