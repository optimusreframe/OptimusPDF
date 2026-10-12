import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearHandoff, hasHandoff, setHandoff, takeHandoff } from "@/app/pdf-pro/proHandoff";
import { fakeFile } from "@/app/pdf-pro/proTestUtils";

beforeEach(() => clearHandoff());

describe("proHandoff — store en memoria de modulo", () => {
  it("sin nada pendiente, takeHandoff devuelve null", () => {
    expect(takeHandoff()).toBeNull();
    expect(hasHandoff()).toBe(false);
  });

  it("setHandoff + takeHandoff devuelve el MISMO File por referencia y la herramienta de origen", () => {
    const file = fakeFile(32, "uno.pdf");
    setHandoff(file, "merge-pdf");
    const taken = takeHandoff();
    expect(taken?.file).toBe(file);
    expect(taken?.from).toBe("merge-pdf");
  });

  it("takeHandoff consume: la segunda lectura es null (recargar o volver atras no reabre un archivo viejo)", () => {
    setHandoff(fakeFile(), "split-pdf");
    expect(takeHandoff()).not.toBeNull();
    expect(takeHandoff()).toBeNull();
  });

  it("un nuevo setHandoff reemplaza al anterior (un solo hueco)", () => {
    const first = fakeFile(16, "a.pdf");
    const second = fakeFile(16, "b.pdf");
    setHandoff(first, "merge-pdf");
    setHandoff(second, "compress-pdf");
    const taken = takeHandoff();
    expect(taken?.file).toBe(second);
    expect(taken?.from).toBe("compress-pdf");
  });

  it("hasHandoff mira sin consumir", () => {
    setHandoff(fakeFile(), "rotate-pdf");
    expect(hasHandoff()).toBe(true);
    expect(hasHandoff()).toBe(true);
    expect(takeHandoff()).not.toBeNull();
    expect(hasHandoff()).toBe(false);
  });

  it("clearHandoff descarta sin abrir", () => {
    setHandoff(fakeFile(), "rotate-pdf");
    clearHandoff();
    expect(takeHandoff()).toBeNull();
  });

  it("NO se persiste: no toca localStorage, sessionStorage ni IndexedDB (todo ello lanzaria si se usara)", () => {
    const boom = new Proxy({}, { get: () => { throw new Error("el traspaso no debe persistir nada"); } });
    vi.stubGlobal("localStorage", boom);
    vi.stubGlobal("sessionStorage", boom);
    vi.stubGlobal("indexedDB", boom);
    expect(() => {
      setHandoff(fakeFile(64, "secreto.pdf"), "merge-pdf");
      takeHandoff();
    }).not.toThrow();
    vi.unstubAllGlobals();
  });

  it("el archivo no se copia ni se lee: conserva nombre, tipo y tamano", () => {
    const file = fakeFile(100, "informe.pdf");
    setHandoff(file, "compress-pdf");
    const taken = takeHandoff()!;
    expect(taken.file.name).toBe("informe.pdf");
    expect(taken.file.type).toBe("application/pdf");
    expect(taken.file.size).toBe(100);
  });
});
