import { describe, expect, it } from "vitest";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";

/** El bloque de textos de «retomar sin buscar» (U0.3): paridad ES/EN, sin claves crudas ni marcadores sin sustituir. */

const es = SIGN_STRINGS.es.resume;
const en = SIGN_STRINGS.en.resume;

const ITEMS = [
  { name: "Ana", done: true },
  { name: "Luis", done: false },
];

/** Los argumentos con sentido de cada funcion de texto (el resto de claves son cadenas). */
const CALLS: Partial<Record<keyof typeof es, unknown[][]>> = {
  cardDocuments: [[["A.pdf"]], [["A.pdf", "B.pdf", "C.pdf", "D.pdf"]]],
  cardSigners: [[["Ana", "Luis"]]],
  cardCollected: [[ITEMS]],
  cardSavedAgo: [["hace 5 minutos"]],
  cardMore: [[1], [3]],
  signerFallback: [[1], [2]],
  discardBody: [[1], [2]],
  offerBody: [["hace 5 minutos"]],
  removedOne: [["Contrato.pdf"]],
  removedMany: [[2]],
  draftsCount: [[1], [3]],
};

function sample(table: typeof es, key: keyof typeof es): string[] {
  const value = table[key];
  if (typeof value === "string") return [value];
  const calls = CALLS[key];
  if (!calls) return [];
  const fn = value as unknown as (...args: unknown[]) => string;
  return calls.map((args) => fn(...args));
}

describe("textos de retomar y salir (ES/EN)", () => {
  it("es y en tienen exactamente las mismas claves", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it("ninguna cadena esta vacia, ninguna es igual en los dos idiomas y ninguna deja un marcador sin sustituir", () => {
    for (const key of Object.keys(es) as (keyof typeof es)[]) {
      const spanish = sample(es, key);
      const english = sample(en, key);
      expect(spanish.length, String(key)).toBeGreaterThan(0);
      expect(english.length, String(key)).toBeGreaterThan(0);
      for (const text of [...spanish, ...english]) {
        expect(text.trim().length, String(key)).toBeGreaterThan(0);
        expect(text, String(key)).not.toMatch(/\{\w+\}|undefined|NaN|resume\./);
      }
      expect(spanish.join("|"), String(key)).not.toBe(english.join("|"));
    }
  });

  it("los textos que las pruebas y el usuario buscan existen tal cual", () => {
    expect(es.cardTitle).toBe("Tienes una firma sin terminar");
    expect(es.offerTitle).toBe("Retomar lo que tenías");
    expect(es.leaveTitle).toBe("¿Salir de la firma?");
    expect(es.leaveBodySaved).toContain("Todo está guardado en este dispositivo");
    expect(es.leaveStay).toBe("Seguir firmando");
    expect(es.leaveLeave).toBe("Salir");
    expect(es.resume).toBe("Retomar");
    expect(es.discard).toBe("Descartar");
    expect(es.viewAll).toBe("Ver todos");
    expect(es.offerStartOver).toBe("Empezar de nuevo");
  });

  it("«firmas recogidas» sigue el formato «Ana ✓, Luis pendiente»", () => {
    const items = [
      { name: "Ana", done: true },
      { name: "Luis", done: false },
    ];
    expect(es.cardCollected(items)).toBe("Firmas recogidas: Ana ✓, Luis pendiente");
    expect(en.cardCollected(items)).toBe("Signatures collected: Ana ✓, Luis pending");
  });

  it("la lista de documentos se recorta a dos y «N mas» cuando son muchos", () => {
    expect(es.cardDocuments(["A.pdf"])).toBe("Documento: A.pdf");
    expect(es.cardDocuments(["A.pdf", "B.pdf", "C.pdf"])).toBe("Documentos: A.pdf, B.pdf, C.pdf");
    expect(es.cardDocuments(["A", "B", "C", "D", "E"])).toBe("Documentos: A, B y 3 más");
    expect(en.cardDocuments(["A", "B", "C", "D", "E"])).toBe("Documents: A, B and 3 more");
  });

  it("singular y plural", () => {
    expect(es.cardMore(1)).toBe("Hay 1 más sin terminar.");
    expect(es.cardMore(3)).toBe("Hay 3 más sin terminar.");
    expect(es.draftsCount(1)).toBe("1 guardado");
    expect(es.draftsCount(4)).toBe("4 guardados");
    expect(en.draftsCount(1)).toBe("1 saved");
    expect(es.removedOne("Anexo B.pdf")).toBe("Quitaste «Anexo B.pdf» de la ronda.");
    expect(es.removedMany(2)).toBe("Quitaste 2 documentos de la ronda.");
  });
});
