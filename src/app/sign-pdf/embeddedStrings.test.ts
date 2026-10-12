import { describe, expect, it } from "vitest";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { SIGN_EMBEDDED_STRINGS, withEmbeddedWording } from "@/app/sign-pdf/signEmbeddedStrings";
import { FILL_EMBEDDED_STRINGS, withFillWording } from "@/app/sign-pdf/fillEmbeddedStrings";

/** Textos de los modos Firmar y Rellenar de PDF Pro (Wave 7 · U7): paridad es/en y modismos de «aplicar». */

function sample(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(sample);
  if (typeof value === "function") {
    const fn = value as (...args: unknown[]) => unknown;
    const out: unknown[] = [];
    for (const args of [[1, 2], [2, 3], [["Ana"]], [["Ana", "Luis"]], ["Ana"], [0, 0]]) {
      try {
        out.push(fn(...args));
      } catch {
        // La funcion espera otro tipo de argumento: esa muestra no vale.
      }
    }
    return out.filter((item): item is string => typeof item === "string");
  }
  return [];
}

describe.each([
  ["Firmar", SIGN_EMBEDDED_STRINGS],
  ["Rellenar", FILL_EMBEDDED_STRINGS],
] as const)("textos del modo %s", (_name, table) => {
  it("es y en tienen exactamente las mismas claves", () => {
    expect(Object.keys(table.en).sort()).toEqual(Object.keys(table.es).sort());
  });

  it("ninguna cadena esta vacia y ninguna se repite igual en los dos idiomas (salvo nombres propios)", () => {
    for (const key of Object.keys(table.es) as (keyof typeof table.es)[]) {
      const es = sample(table.es[key]);
      const en = sample(table.en[key]);
      expect(es.length, String(key)).toBeGreaterThan(0);
      for (const text of [...es, ...en]) expect(text.trim().length, String(key)).toBeGreaterThan(0);
      expect(es.join("|"), String(key)).not.toBe(en.join("|"));
    }
  });

  it("no queda ningun marcador de plantilla sin sustituir", () => {
    for (const language of ["es", "en"] as const) {
      for (const value of Object.values(table[language])) {
        for (const text of sample(value)) expect(text).not.toMatch(/\{\w+\}|undefined|NaN/);
      }
    }
  });
});

describe("textos de Firmar embebido", () => {
  it("la etiqueta del snapshot nombra a los firmantes con 1 o 2 nombres", () => {
    expect(SIGN_EMBEDDED_STRINGS.es.joinNames(["Ana"])).toBe("Ana");
    expect(SIGN_EMBEDDED_STRINGS.es.joinNames(["Ana", "Luis"])).toBe("Ana y Luis");
    expect(SIGN_EMBEDDED_STRINGS.en.joinNames(["Ana", "Luis"])).toBe("Ana and Luis");
    expect(SIGN_EMBEDDED_STRINGS.es.labelSignedBy("Ana y Luis")).toBe("Firmado por Ana y Luis");
    expect(SIGN_EMBEDDED_STRINGS.en.labelSignedBy("Ana and Luis")).toBe("Signed by Ana and Luis");
  });

  it("une tres nombres con comas (aunque el producto solo permite dos firmantes)", () => {
    expect(SIGN_EMBEDDED_STRINGS.es.joinNames(["A", "B", "C"])).toBe("A, B y C");
  });

  it("un nombre vacio no deja basura", () => {
    expect(SIGN_EMBEDDED_STRINGS.es.joinNames([])).toBe("");
  });

  it("dice que NO es una firma digital criptografica y que la sesion no se guarda como borrador", () => {
    expect(SIGN_EMBEDDED_STRINGS.es.notDigital).toMatch(/no una firma digital/i);
    expect(SIGN_EMBEDDED_STRINGS.es.sessionNote).toMatch(/borrador/i);
    expect(SIGN_EMBEDDED_STRINGS.en.notDigital).toMatch(/not a cryptographic digital signature/i);
    expect(SIGN_EMBEDDED_STRINGS.en.sessionNote).toMatch(/draft/i);
  });

  it("el conmutador no se llama igual que la pestana «Firmar» de PDF Pro (dos pestanas con el mismo nombre confunden a un lector de pantalla)", () => {
    expect(SIGN_EMBEDDED_STRINGS.es.switchSign).not.toBe("Firmar");
    expect(SIGN_EMBEDDED_STRINGS.en.switchSign).not.toBe("Sign");
  });

  it("el conmutador nombra las dos herramientas", () => {
    expect(SIGN_EMBEDDED_STRINGS.es.switchSign).toBe("Firmar documento");
    expect(SIGN_EMBEDDED_STRINGS.es.switchFill).toMatch(/Rellenar/);
    expect(SIGN_EMBEDDED_STRINGS.es.switchConfirmBody("Firmar documento")).toContain("Firmar documento");
    expect(SIGN_EMBEDDED_STRINGS.en.switchConfirmBody("Sign")).toContain("Sign");
  });
});

describe("withEmbeddedWording", () => {
  it.each(["es", "en"] as const)("(%s) cambia solo los textos que dicen descargar y conserva el resto", (language) => {
    const base = SIGN_STRINGS[language];
    const embedded = withEmbeddedWording(language);
    expect(embedded.applyAndDownload).not.toBe(base.applyAndDownload);
    expect(embedded.finishAndDownload).not.toBe(base.finishAndDownload);
    expect(embedded.modeSingleHint).not.toBe(base.modeSingleHint);
    const changed = Object.keys(base).filter(
      (key) => (embedded as Record<string, unknown>)[key] !== (base as Record<string, unknown>)[key],
    );
    expect(changed.sort()).toEqual(["applyAndDownload", "finishAndDownload", "modeSingleHint"]);
  });

  it("ningun texto cambiado menciona descargar", () => {
    for (const language of ["es", "en"] as const) {
      const embedded = withEmbeddedWording(language);
      for (const key of ["applyAndDownload", "finishAndDownload", "modeSingleHint"] as const) {
        expect(embedded[key]).not.toMatch(/descarg|download/i);
      }
    }
  });
});

describe("withFillWording", () => {
  it.each(["es", "en"] as const)("(%s) sustituye los textos de firmar del lienzo y nada mas", (language) => {
    const base = SIGN_STRINGS[language];
    const fill = withFillWording(language);
    const changed = Object.keys(base).filter(
      (key) => (fill as Record<string, unknown>)[key] !== (base as Record<string, unknown>)[key],
    );
    expect(changed.sort()).toEqual(
      [
        "canvasEmptyHint",
        "checkingDocument",
        "detectedFieldsSummary",
        "documentHint",
        "documentTitle",
        "lowConfidenceHint",
        "scanFound",
        "slotsNeedSigners",
      ].sort(),
    );
  });

  it("los avisos de campos detectados dicen «antes de aplicar», no «antes de firmar»", () => {
    expect(withFillWording("es").detectedFieldsSummary(3)).toMatch(/antes de aplicar/);
    expect(withFillWording("es").detectedFieldsSummary(1)).toMatch(/1 campo/);
    expect(withFillWording("en").detectedFieldsSummary(3)).toMatch(/before applying/);
    expect(withFillWording("es").scanFound(2, 4)).toMatch(/página 4/);
  });

  it("el texto de ayuda no habla de firmas", () => {
    expect(withFillWording("es").documentHint).not.toMatch(/firma|iniciales/i);
    expect(withFillWording("en").documentHint).not.toMatch(/signature|initials/i);
  });
});

describe("textos de Rellenar embebido", () => {
  it("la etiqueta cuenta los campos con su plural", () => {
    expect(FILL_EMBEDDED_STRINGS.es.labelFilled(1)).toBe("Formulario rellenado (1 campo)");
    expect(FILL_EMBEDDED_STRINGS.es.labelFilled(5)).toBe("Formulario rellenado (5 campos)");
    expect(FILL_EMBEDDED_STRINGS.en.labelFilled(1)).toBe("Form filled in (1 field)");
    expect(FILL_EMBEDDED_STRINGS.en.labelFilled(5)).toBe("Form filled in (5 fields)");
  });

  it("los avisos de campos encontrados y recortes tienen singular y plural", () => {
    expect(FILL_EMBEDDED_STRINGS.es.formFound(1)).toMatch(/1 campo de formulario/);
    expect(FILL_EMBEDDED_STRINGS.es.formFound(5)).toMatch(/5 campos/);
    expect(FILL_EMBEDDED_STRINGS.es.willTruncate(1)).toMatch(/1 valor/);
    expect(FILL_EMBEDDED_STRINGS.es.willTruncate(3)).toMatch(/3 valores/);
    expect(FILL_EMBEDDED_STRINGS.en.skippedFields(2)).toMatch(/2 fields/);
  });

  it("el aviso de caracteres sin glifo los nombra", () => {
    expect(FILL_EMBEDDED_STRINGS.es.unsupportedChars("✓ 你")).toContain("✓ 你");
    expect(FILL_EMBEDDED_STRINGS.en.unsupportedChars("✓")).toContain("✓");
  });
});
