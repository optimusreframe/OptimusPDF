import { afterEach, describe, expect, it } from "vitest";
import { clearHandoff, hasHandoff, setHandoff, takeHandoff } from "@/app/pdf-pro/proHandoff";

const file = () => new File(["x"], "a.pdf", { type: "application/pdf" });

afterEach(() => clearHandoff());

describe("traspaso: cuantos PDF habia en la herramienta de origen", () => {
  it("por defecto es 1", () => {
    setHandoff(file(), "merge-pdf");
    expect(takeHandoff()?.total).toBe(1);
  });

  it("guarda el total para avisar de que solo se abre el primero", () => {
    setHandoff(file(), "merge-pdf", 3);
    expect(takeHandoff()).toMatchObject({ from: "merge-pdf", total: 3 });
  });

  it("un total absurdo se normaliza a un entero >= 1", () => {
    setHandoff(file(), "merge-pdf", 0);
    expect(takeHandoff()?.total).toBe(1);
    setHandoff(file(), "merge-pdf", -4);
    expect(takeHandoff()?.total).toBe(1);
    setHandoff(file(), "merge-pdf", 2.9);
    expect(takeHandoff()?.total).toBe(2);
  });

  it("se consume una sola vez", () => {
    setHandoff(file(), "compress-pdf", 2);
    expect(hasHandoff()).toBe(true);
    takeHandoff();
    expect(hasHandoff()).toBe(false);
    expect(takeHandoff()).toBeNull();
  });
});
