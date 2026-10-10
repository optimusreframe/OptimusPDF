import { describe, expect, it } from "vitest";
import { uniqueZipName, zipNameKey } from "@/lib/pdf/entryNames";

/** `Set` que corta con un error si se le consulta demasiadas veces: detecta un bucle sin fin sin colgar el test. */
class BudgetSet extends Set<string> {
  private calls = 0;
  constructor(private readonly budget: number) {
    super();
  }
  override has(value: string): boolean {
    this.calls += 1;
    if (this.calls > this.budget) throw new Error(`bucle sin fin: mas de ${this.budget} consultas`);
    return super.has(value);
  }
}

describe("uniqueZipName — src/lib/pdf/entryNames.ts", () => {
  it("el primer nombre se conserva y los repetidos reciben (2), (3)... desde startAt", () => {
    const used = new Set<string>();
    const names = ["foto.pdf", "foto.pdf", "foto.pdf"].map((name) => uniqueZipName(name, used, { startAt: 2 }));
    expect(names).toEqual(["foto.pdf", "foto (2).pdf", "foto (3).pdf"]);
  });

  it("sin distinguir mayusculas ni forma Unicode con zipNameKey", () => {
    const used = new Set<string>();
    const options = { startAt: 2, key: zipNameKey };
    const nfc = "Camión.pdf";
    const nfd = "Camión.pdf";
    expect(uniqueZipName(nfc, used, options)).toBe(nfc);
    expect(uniqueZipName("CAMIÓN.PDF", used, options)).toBe("CAMIÓN (2).PDF");
    expect(uniqueZipName(nfd, used, options)).toBe("Camión (3).pdf");
  });

  it("termina siempre: con un `key` que lo colapsa todo no itera sin tope", () => {
    const used = new BudgetSet(50_000);
    const collapse = () => "siempre-lo-mismo";
    uniqueZipName("a.pdf", used, { key: collapse });
    // Con la clave degenerada todo choca: el tope corta y devuelve un nombre distinto igualmente.
    expect(() => uniqueZipName("a.pdf", used, { key: collapse })).not.toThrow();
  });
});
