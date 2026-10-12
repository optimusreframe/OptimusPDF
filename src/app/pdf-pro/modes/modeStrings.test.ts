import { describe, expect, it } from "vitest";
import { MODE_STRINGS, getModeStrings, modeBarName, modeShortName, type ModeStrings } from "@/app/pdf-pro/modes/modeStrings";

/** Los textos de los modos de PDF Pro estan completos y paralelos en es/en. */

function shape(value: unknown): unknown {
  if (typeof value === "function") return "fn";
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]));
  }
  return typeof value;
}

function leaves(value: unknown, path = ""): Array<[string, unknown]> {
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, inner]) => leaves(inner, path ? `${path}.${key}` : key));
  }
  return [[path, value]];
}

describe("textos de los modos", () => {
  it("es y en tienen exactamente las mismas claves y tipos", () => {
    expect(shape(MODE_STRINGS.en)).toEqual(shape(MODE_STRINGS.es));
  });

  it("ninguna cadena esta vacia", () => {
    for (const language of ["es", "en"] as const) {
      for (const [path, value] of leaves(MODE_STRINGS[language])) {
        if (typeof value === "string") expect(value.trim(), `${language}:${path}`).not.toBe("");
      }
    }
  });

  it("las funciones devuelven texto con su dato", () => {
    for (const language of ["es", "en"] as const) {
      const m: ModeStrings = getModeStrings(language);
      expect(m.host.appliedTitle("Anotaciones (3)")).toContain("Anotaciones (3)");
      expect(m.host.leaveBody("Editar")).toContain("Editar");
      expect(m.host.entered("Anotar")).toContain("Anotar");
      expect(m.host.discarded("Anotar")).toContain("Anotar");
      expect(m.edit.label(4)).toContain("4");
      expect(m.annotate.label(7)).toContain("7");
      expect(m.host.regionLabel("Editar")).toContain("Editar");
      expect(m.host.working("Firmar")).toContain("Firmar");
    }
  });

  it("la etiqueta de Anotar es «Anotaciones (N)» y la de Editar «Edición (N)»", () => {
    expect(getModeStrings("es").annotate.label(3)).toBe("Anotaciones (3)");
    expect(getModeStrings("es").edit.label(3)).toBe("Edición (3)");
    expect(getModeStrings("en").annotate.label(3)).toBe("Annotations (3)");
  });

  it("un idioma desconocido cae en español", () => {
    expect(getModeStrings("fr" as never)).toBe(MODE_STRINGS.es);
  });

  it("modeBarName y modeShortName nombran Editar y Anotar y toleran otros modos", () => {
    expect(modeBarName("es", "edit")).toBe("Editando");
    expect(modeBarName("es", "annotate")).toBe("Anotando");
    expect(modeBarName("en", "edit")).toBe("Editing");
    expect(modeBarName("es", "sign")).toBe("Firmando");
    expect(modeShortName("es", "edit")).toBe("Editar");
    expect(modeShortName("en", "annotate")).toBe("Annotate");
    expect(modeShortName("es", "sign")).toBe("Firmar");
    expect(modeBarName("es", "desconocido")).toContain("desconocido");
  });

  it.each(["edit", "annotate", "sign", "fill"] as const)("el modo «%s» tiene nombre traducido en es y en (ninguno devuelve su clave cruda)", (id) => {
    for (const language of ["es", "en"] as const) {
      const bar = modeBarName(language, id);
      const short = modeShortName(language, id);
      expect(bar.trim()).not.toBe("");
      expect(short).not.toBe(id);
      expect(bar).not.toBe(getModeStrings(language).host.working(id));
    }
  });

  it("los nombres de Firmar y Rellenar son los pedidos", () => {
    expect(modeShortName("es", "sign")).toBe("Firmar");
    expect(modeShortName("es", "fill")).toBe("Rellenar formulario");
    expect(modeShortName("en", "sign")).toBe("Sign");
    expect(modeShortName("en", "fill")).toBe("Fill in form");
    expect(modeBarName("es", "fill")).toBe("Rellenando");
  });

  it("las frases de salir con cambios nombran el modo con su nombre traducido", () => {
    expect(getModeStrings("es").host.leaveBody(modeShortName("es", "sign"))).toContain("«Firmar»");
    expect(getModeStrings("en").host.leaveBody(modeShortName("en", "fill"))).toContain("Fill in form");
  });

  it("los comandos de la paleta existen en los dos idiomas con las etiquetas pedidas", () => {
    expect(getModeStrings("es").commands.editText).toBe("Editar texto");
    expect(getModeStrings("es").commands.annotate).toBe("Anotar");
    expect(getModeStrings("es").commands.addImage).toBe("Añadir imagen");
    expect(getModeStrings("en").commands.editText).toBe("Edit text");
    expect(getModeStrings("en").commands.addImage).toBe("Add image");
  });

  it("el texto del botón principal es «Aplicar» / «Apply» y el de salir «Descartar» / «Discard»", () => {
    expect(getModeStrings("es").host.apply).toBe("Aplicar");
    expect(getModeStrings("es").host.discard).toBe("Descartar");
    expect(getModeStrings("en").host.apply).toBe("Apply");
    expect(getModeStrings("en").host.discard).toBe("Discard");
  });
});
