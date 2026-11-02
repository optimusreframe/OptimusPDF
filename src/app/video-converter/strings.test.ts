import { describe, expect, it } from "vitest";
import { STRINGS } from "@/app/video-converter/strings";

/** Los `{marcadores}` de una frase, ordenados. */
function placeholders(text: string): string[] {
  return Array.from(text.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
}

function flatten(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, inner]) => flatten(inner, prefix ? `${prefix}.${key}` : key));
  return [];
}

describe("textos del convertidor de video", () => {
  const es = flatten(STRINGS.es);
  const en = flatten(STRINGS.en);

  it("ES y EN tienen exactamente las mismas claves", () => {
    expect(en.map(([key]) => key)).toEqual(es.map(([key]) => key));
  });

  it("ninguna frase esta vacia", () => {
    for (const [key, text] of [...es, ...en]) expect(text.trim(), key).not.toBe("");
  });

  it("cada frase usa los mismos marcadores en los dos idiomas", () => {
    const english = new Map(en);
    for (const [key, text] of es) expect(placeholders(english.get(key) ?? ""), key).toEqual(placeholders(text));
  });

  it("todo aviso y todo error tiene texto en ES y EN (una frase por codigo)", () => {
    for (const language of ["es", "en"] as const) {
      for (const text of Object.values(STRINGS[language].issues)) expect(text.length).toBeGreaterThan(10);
      for (const error of Object.values(STRINGS[language].errors)) {
        expect(error.title.length).toBeGreaterThan(3);
        expect(error.message.length).toBeGreaterThan(3);
      }
    }
  });
});
