import { describe, expect, it } from "vitest";
import { analyzePage, assignSharing, buildAnchors, buildLines, buildPhrases, mergeLines, ruledPaperLines, type Candidate, type LineInfo } from "@/lib/pdf/autoMapPage";
import { FONT, filler, hline, pageData, text } from "@/lib/pdf/testing/autoMapFixtures";

const EM = 11.016;

function analyze(input: Parameters<typeof pageData>[0], signers: 1 | 2 = 2) {
  return analyzePage(pageData(input), { signers });
}

/** Propuestas de la asociacion etiqueta-raya (sin las que aporta el detector de huecos de texto de W6). */
const mine = (c: readonly Candidate[]) => c.filter((x) => x.reasonCode !== "text-slot");
const sigs = (c: readonly Candidate[]) => mine(c).filter((x) => x.type === "signature");
const inits = (c: readonly Candidate[]) => mine(c).filter((x) => x.type === "initials");
const center = (c: Candidate) => (c.rect.x0 + c.rect.x1) / 2;

describe("etiqueta a la izquierda de la raya («Firma: ____»)", () => {
  const label = text("Client Signature:", 72, 400, FONT, 80);
  it("asocia la etiqueta con la raya que empieza justo despues", () => {
    const { candidates } = analyze({ texts: [label], segments: [hline(160, 360, 398)] });
    expect(sigs(candidates)).toHaveLength(1);
    expect(sigs(candidates)[0]).toMatchObject({ signerIndex: 0, tier: "high", reasonCode: "label-line-right", source: "label" });
  });

  it("el hueco maximo etiqueta-raya de una firma es de 14 em (de la propia etiqueta)", () => {
    const near = analyze({ texts: [label], segments: [hline(152 + 13.5 * FONT, 152 + 13.5 * FONT + 150, 398)] });
    expect(sigs(near.candidates)).toHaveLength(1);
    const far = analyze({ texts: [label], segments: [hline(152 + 15 * FONT, 152 + 15 * FONT + 150, 398)] });
    expect(sigs(far.candidates)).toHaveLength(0);
  });

  it("el hueco maximo de unas iniciales es de 7 em", () => {
    const initials = text("(INITIAL)", 400, 100, FONT, 45);
    const near = analyze({ texts: [initials], segments: [hline(445 + 6.5 * FONT, 445 + 6.5 * FONT + 60, 98)] });
    expect(inits(near.candidates).length).toBeGreaterThan(0);
    expect(inits(near.candidates)[0].reasonCode).not.toBe("label-only");
    const far = analyze({ texts: [initials], segments: [hline(445 + 8 * FONT, 445 + 8 * FONT + 60, 98)] });
    expect(inits(far.candidates).every((c) => c.reasonCode === "label-only")).toBe(true);
  });

  it("una raya en otra fila no es de la etiqueta", () => {
    const { candidates } = analyze({ texts: [label], segments: [hline(160, 360, 360)] });
    expect(sigs(candidates)).toHaveLength(0);
  });

  it("texto ajeno entre la etiqueta y la raya la bloquea", () => {
    const blocker = text("some other words", 170, 400, FONT, 90);
    const { candidates } = analyze({ texts: [label, blocker], segments: [hline(270, 420, 398)] });
    expect(sigs(candidates)).toHaveLength(0);
  });
});

describe("etiqueta debajo de la raya (la leyenda de una linea de firma)", () => {
  it("asocia la leyenda con la raya de encima", () => {
    const { candidates } = analyze({ texts: [text("Signature of Policyholder", 100, 380, FONT, 140)], segments: [hline(100, 300, 400)] });
    expect(sigs(candidates)[0]).toMatchObject({ signerIndex: 0, tier: "high", reasonCode: "label-line-above" });
  });

  it("el hueco maximo es de 2,4 em entre la raya y la parte alta de la leyenda", () => {
    // baseline = linea - (hueco + 0.85*FONT)
    const at = (gap: number) => analyze({ texts: [text("Signature", 100, 400 - gap * FONT - 0.85 * FONT, FONT, 60)], segments: [hline(100, 300, 400)] });
    expect(sigs(at(2.2).candidates)).toHaveLength(1);
    expect(sigs(at(2.7).candidates)).toHaveLength(0);
  });

  it("una leyenda desalineada con la raya no cuenta", () => {
    const { candidates } = analyze({ texts: [text("Signature", 400, 380, FONT, 60)], segments: [hline(100, 300, 400)] });
    expect(sigs(candidates)).toHaveLength(0);
  });
});

describe("etiqueta encima de la raya (el rotulo de un campo; el hueco queda entre ambos)", () => {
  const above = (gap: number) => analyze({ texts: [text("Date", 100, 400 + gap * FONT, FONT, 25)], segments: [hline(100, 250, 400)] });
  it("una fecha rotulada encima de su raya", () => {
    const { candidates } = above(1.5);
    const date = candidates.find((c) => c.type === "date");
    expect(date).toBeDefined();
    expect(date!.reasonCode).toBe("label-line-below");
  });
  it("el hueco maximo entre el rotulo y la raya es de 3,4 em", () => {
    expect(above(3.0).candidates.some((c) => c.type === "date" && c.reasonCode !== "text-slot")).toBe(true);
    expect(above(4.2).candidates.some((c) => c.type === "date" && c.reasonCode !== "text-slot")).toBe(false);
  });
  it("una firma con el rotulo pegado encima de la raya", () => {
    const near = analyze({ texts: [text("Signature", 100, 400 + 1.2 * FONT, FONT, 50)], segments: [hline(100, 300, 400)] });
    expect(sigs(near.candidates)).toHaveLength(1);
    const far = analyze({ texts: [text("Signature", 100, 400 + 2.6 * FONT, FONT, 50)], segments: [hline(100, 300, 400)] });
    expect(sigs(far.candidates)).toHaveLength(0);
  });
});

describe("rayas validas", () => {
  const label = text("Signature:", 72, 400, FONT, 55);
  it("el ancho minimo de una raya es de 2,6 em", () => {
    const ok = analyze({ texts: [label], segments: [hline(135, 135 + 2.7 * EM, 398)] });
    expect(sigs(ok.candidates)).toHaveLength(1);
    const short = analyze({ texts: [label], segments: [hline(135, 135 + 2.3 * EM, 398)] });
    expect(sigs(short.candidates)).toHaveLength(0);
  });

  it("una raya de mas del 62 % de la pagina es un separador", () => {
    const wide = analyze({ texts: [label], segments: [hline(135, 135 + 0.65 * 612, 398)] });
    expect(sigs(wide.candidates)).toHaveLength(0);
    const ok = analyze({ texts: [label], segments: [hline(135, 135 + 0.55 * 612, 398)] });
    expect(sigs(ok.candidates)).toHaveLength(1);
  });

  it("una raya gruesa (barra) no es un hueco", () => {
    const bar = analyze({ texts: [label], segments: [{ ...hline(135, 335, 398), thickness: 9 }] });
    expect(sigs(bar.candidates)).toHaveLength(0);
  });

  it("el borde de una celda de tabla (verticales en los dos extremos) no es una raya de firma", () => {
    const verticals = [{ x: 135, y0: 360, y1: 420 }, { x: 335, y0: 360, y1: 420 }];
    const { candidates } = analyze({ texts: [label], segments: [hline(135, 335, 398)], verticals });
    expect(sigs(candidates)).toHaveLength(0);
    const oneSide = analyze({ texts: [label], segments: [hline(135, 335, 398)], verticals: [verticals[0]] });
    expect(sigs(oneSide.candidates)).toHaveLength(1);
  });

  it("papel pautado: cinco rayas iguales a paso regular no son huecos", () => {
    const ruled = Array.from({ length: 6 }, (_, i) => hline(135, 335, 398 - i * 24));
    const { candidates } = analyze({ texts: [label], segments: ruled });
    expect(sigs(candidates)).toHaveLength(0);
    const three = Array.from({ length: 3 }, (_, i) => hline(135, 335, 398 - i * 24));
    expect(sigs(analyze({ texts: [label], segments: three }).candidates)).toHaveLength(1);
  });

  it("ruledPaperLines solo marca grupos largos y regulares", () => {
    const mk = (y: number): LineInfo => ({ x0: 100, x1: 300, y, thickness: 0.7, fromText: -1, dashed: false });
    expect(ruledPaperLines([0, 1, 2, 3, 4, 5].map((i) => mk(700 - i * 24)), EM).size).toBe(6);
    expect(ruledPaperLines([0, 1, 2, 3].map((i) => mk(700 - i * 24)), EM).size).toBe(0);
    expect(ruledPaperLines([700, 640, 590, 500, 410, 405].map(mk), EM).size).toBe(0);
  });

  it("une rayas del mismo y que se tocan, no las de dos textos distintos", () => {
    const a: LineInfo = { x0: 100, x1: 200, y: 300, thickness: 0.7, fromText: -1, dashed: false };
    const b: LineInfo = { ...a, x0: 200.5, x1: 300 };
    expect(mergeLines([a, b], EM)).toHaveLength(1);
    expect(mergeLines([a, { ...b, x0: 230, x1: 300 }], EM)).toHaveLength(2);
    expect(mergeLines([{ ...a, fromText: 3 }, { ...b, fromText: 3 }], EM)).toHaveLength(2);
  });
});

describe("guiones bajos como raya", () => {
  it("«Signature: ______» en un solo texto", () => {
    const { candidates } = analyze({ texts: [text("Signature: ________________", 72, 400, FONT, 230)] });
    expect(sigs(candidates)).toHaveLength(1);
    expect(sigs(candidates)[0].host!.x0).toBeGreaterThan(100);
  });

  it("un texto con dos hileras separadas por un espacio da dos rayas", () => {
    const built = buildLines(pageData({ texts: [text("________ ________", 72, 400, FONT, 140)] }), EM);
    expect(built.lines).toHaveLength(2);
  });
});

describe("la raya que sale de un texto de subrayados", () => {
  it("una leyenda DEBAJO de una hilera de guiones bajos (texto aparte) rotula esa hilera", () => {
    const texts = [text("________________________", 72, 400, FONT, 200), text("Signature of Client", 72, 380, FONT, 100)];
    const { candidates } = analyze({ texts });
    expect(sigs(candidates)).toHaveLength(1);
    expect(sigs(candidates)[0].reasonCode).toBe("label-line-above");
  });
});

describe("firmantes", () => {
  const colLeft = text("Signature of Client", 72, 380, FONT, 100);
  const colRight = text("Signature of Client", 340, 380, FONT, 100);
  const lines = [hline(72, 280, 400), hline(340, 548, 400)];

  it("dos columnas: izquierda = firmante 1, derecha = firmante 2", () => {
    const { candidates } = analyze({ texts: [colLeft, colRight], segments: lines });
    const s = sigs(candidates).sort((a, b) => center(a) - center(b));
    expect(s.map((c) => c.signerIndex)).toEqual([0, 1]);
  });

  it("apiladas: de arriba abajo", () => {
    const stack = [hline(72, 280, 500), hline(72, 280, 400)];
    const texts = [text("Signature", 72, 480, FONT, 60), text("Signature", 72, 380, FONT, 60)];
    const { candidates } = analyze({ texts, segments: stack });
    const s = sigs(candidates).sort((a, b) => b.rect.y0 - a.rect.y0);
    expect(s.map((c) => c.signerIndex)).toEqual([0, 1]);
  });

  it("la pista numerica manda sobre la posicion", () => {
    const left = text("Signer 2 signature", 72, 380, FONT, 100);
    const right = text("Signer 1 signature", 340, 380, FONT, 100);
    const { candidates } = analyze({ texts: [left, right], segments: lines });
    const byX = sigs(candidates).sort((a, b) => center(a) - center(b));
    expect(byX.map((c) => c.signerIndex)).toEqual([1, 0]);
  });

  it("«Co-insured» es el firmante 2", () => {
    const left = text("Insured Signature", 72, 380, FONT, 100);
    const right = text("Co-insured Signature", 340, 380, FONT, 110);
    const { candidates } = analyze({ texts: [left, right], segments: lines });
    const byX = sigs(candidates).sort((a, b) => center(a) - center(b));
    expect(byX.map((c) => c.signerIndex)).toEqual([0, 1]);
  });

  it("la firma de la otra parte (ajustador) no es de un firmante y queda en `review`", () => {
    const right = text("Licensed Public Adjuster Signature", 340, 380, FONT, 170);
    const { candidates } = analyze({ texts: [colLeft, right], segments: lines });
    const company = sigs(candidates).find((c) => center(c) > 300)!;
    expect(company.signerIndex).toBeUndefined();
    expect(company.notes).toContain("company");
    const first = sigs(candidates).find((c) => center(c) < 300)!;
    expect(first.signerIndex).toBe(0);
  });

  it("una tercera firma de cliente no tiene firmante", () => {
    const stack = [hline(72, 280, 600), hline(72, 280, 500), hline(72, 280, 400)];
    const texts = [580, 480, 380].map((y) => text("Signature of Policyholder", 72, y, FONT, 130));
    const { candidates } = analyze({ texts, segments: stack });
    const s = sigs(candidates).sort((a, b) => b.rect.y0 - a.rect.y0);
    expect(s.map((c) => c.signerIndex)).toEqual([0, 1, undefined]);
    expect(s[2].notes).toContain("no-signer");
  });

  it("la fecha junto a una firma hereda su firmante; junto a la de la otra parte, ninguno", () => {
    const texts = [
      colLeft,
      text("Date", 72 + 220, 380, FONT, 25),
      text("Licensed Public Adjuster Signature", 340, 380, FONT, 170),
      text("Date", 548 + 12, 380, FONT, 25),
    ];
    const segs = [hline(72, 280, 400), hline(290, 330, 400), hline(340, 540, 400), hline(555, 600, 400)];
    const { candidates } = analyze({ texts, segments: segs });
    const dates = candidates.filter((c) => c.type === "date").sort((a, b) => center(a) - center(b));
    expect(dates).toHaveLength(2);
    expect(dates[0].signerIndex).toBe(0);
    expect(dates[1].signerIndex).toBeUndefined();
  });
});

describe("raya compartida por varias etiquetas", () => {
  it("«Firma ... Fecha» bajo una sola raya: cada etiqueta recibe su tramo", () => {
    const texts = [text("Client Signature", 72, 380, FONT, 90), text("Date", 330, 380, FONT, 25)];
    const { candidates } = analyze({ texts, segments: [hline(72, 400, 400)] });
    const s = sigs(candidates)[0];
    const d = candidates.find((c) => c.type === "date")!;
    expect(s).toBeDefined();
    expect(d).toBeDefined();
    expect(s.rect.x1).toBeLessThanOrEqual(d.rect.x0);
    expect(d.rect.x1).toBeLessThanOrEqual(400.001);
  });

  it("no comparte una raya entre etiquetas que se solapan", () => {
    const line: LineInfo = { x0: 72, x1: 400, y: 400, thickness: 0.7, fromText: -1, dashed: false };
    const mk = (left: number, right: number, cost: number) => ({
      anchor: { phraseLeft: left, phraseRight: right } as never,
      line,
      relation: "above" as const,
      cost,
    });
    const shared = assignSharing([mk(72, 160, 0.5), mk(150, 230, 0.6)], EM);
    expect(shared).toHaveLength(1);
  });
});

describe("iniciales", () => {
  const label = text("(INITIAL)", 480, 100, FONT, 45);
  it("raya larga y dos firmantes: dos mitades, firmante 1 a la izquierda", () => {
    const { candidates } = analyze({ texts: [label], segments: [hline(530, 640 > 612 ? 600 : 640, 98)] });
    const list = inits(candidates).sort((a, b) => center(a) - center(b));
    expect(list.map((c) => c.signerIndex)).toEqual([0, 1]);
    expect(list.every((c) => c.tier === "high")).toBe(true);
    expect(list[0].rect.x1).toBeLessThanOrEqual(list[1].rect.x0 + 1e-6);
  });

  it("raya corta: dos casillas contiguas dentro de la pagina", () => {
    const { candidates } = analyze({ texts: [text("(INITIAL)", 440, 100, FONT, 45)], segments: [hline(490, 536, 98)] });
    const list = inits(candidates).sort((a, b) => center(a) - center(b));
    expect(list).toHaveLength(2);
    expect(list[0].rect.x0).toBe(490);
    expect(list[1].rect.x1).toBeLessThanOrEqual(612 * (1 - 0.035) + 1e-6);
    expect(list[0].signerIndex).toBe(0);
  });

  it("raya corta cerca del borde: se desplaza a la izquierda para respetar el margen", () => {
    const { candidates } = analyze({ texts: [text("(INITIAL)", 440, 100, FONT, 45)], segments: [hline(520, 566, 98)] });
    const list = inits(candidates).sort((a, b) => center(a) - center(b));
    expect(list).toHaveLength(2);
    expect(list[1].rect.x1).toBeLessThanOrEqual(612 * (1 - 0.035) + 1e-6);
    expect(list[0].rect.x0).toBeLessThan(520);
    expect(list[0].rect.x0).toBeGreaterThan(485);
  });

  it("un firmante: una sola casilla", () => {
    const { candidates } = analyze({ texts: [label], segments: [hline(530, 600, 98)] }, 1);
    expect(inits(candidates)).toHaveLength(1);
    expect(inits(candidates)[0].signerIndex).toBe(0);
  });

  it("marcas «(____/____)» del propio documento junto a «(Initials)»", () => {
    const t = text("Insured(s) (Initials) (______/______) acknowledge receipt of a copy of page 2", 72, 60, FONT, 330);
    const { candidates } = analyze({ texts: [t] });
    const list = inits(candidates).sort((a, b) => center(a) - center(b));
    expect(list).toHaveLength(2);
    expect(list[0].reasonCode).toBe("label-slots");
  });

  it("una casilla vacia junto a «Initials»", () => {
    const { candidates } = analyze({
      texts: [text("Initials", 400, 87, FONT, 40)],
      boxes: [{ x0: 460, y0: 75, x1: 560, y1: 105, stroke: true }],
    });
    const list = inits(candidates);
    expect(list).toHaveLength(2);
    expect(list[0].reasonCode).toBe("label-box");
  });

  it("una casilla con texto dentro (numero de pagina) no es de iniciales", () => {
    const { candidates } = analyze({
      texts: [text("Initials", 400, 87, FONT, 40), text("Page 3", 480, 87, FONT, 35)],
      boxes: [{ x0: 460, y0: 75, x1: 560, y1: 105, stroke: true }],
    });
    expect(inits(candidates).every((c) => c.reasonCode === "label-only")).toBe(true);
  });

  it("una casilla estrecha (menos de 2,2 em de ancho) no es de iniciales", () => {
    const { candidates } = analyze({
      texts: [text("Initials", 400, 87, FONT, 40)],
      boxes: [{ x0: 450, y0: 70, x1: 466, y1: 100, stroke: true }],
    });
    expect(inits(candidates).every((c) => c.reasonCode === "label-only")).toBe(true);
  });

  it("un cuadradito (casilla de marcar) no es de iniciales", () => {
    const { candidates } = analyze({
      texts: [text("Initials", 400, 87, FONT, 40)],
      boxes: [{ x0: 450, y0: 85, x1: 460, y1: 95, stroke: true }],
    });
    expect(inits(candidates).every((c) => c.reasonCode === "label-only")).toBe(true);
  });

  it("etiqueta sin raya: hueco a su derecha en `review`", () => {
    const { candidates } = analyze({ texts: [text("Initials:", 72, 100, FONT, 45)] });
    expect(inits(candidates).length).toBeGreaterThan(0);
    expect(inits(candidates).every((c) => c.tier === "high" === false && c.reasonCode === "label-only")).toBe(true);
  });
});

describe("avisos de colocacion", () => {
  it("un hueco que taparia un parrafo se marca `covers-text`", () => {
    const texts = [text("(INITIAL)", 480, 100, FONT, 45), text("A long clause of the agreement about payment terms that sits right above", 400, 118, FONT, 200)];
    const { candidates } = analyze({ texts, segments: [hline(530, 600, 98)] }, 1);
    expect(inits(candidates)[0].notes).toContain("covers-text");
  });

  it("sin texto encima no hay aviso", () => {
    const { candidates } = analyze({ texts: [text("(INITIAL)", 480, 100, FONT, 45)], segments: [hline(530, 600, 98)] }, 1);
    expect(inits(candidates)[0].notes).not.toContain("covers-text");
  });

  it("una imagen debajo del hueco se marca `covers-image`", () => {
    const { candidates } = analyze({
      texts: [text("Signature:", 72, 400, FONT, 55)],
      segments: [hline(135, 335, 398)],
      images: [{ x0: 130, y0: 390, x1: 340, y1: 450 }],
    });
    expect(sigs(candidates)[0].notes).toContain("covers-image");
  });

  it("el texto de la raya (guiones bajos) no cuenta como texto cubierto", () => {
    const { candidates } = analyze({ texts: [text("Signature: ________________", 72, 400, FONT, 230)] });
    expect(sigs(candidates)[0].notes).not.toContain("covers-text");
  });
});

describe("prosa y paginas sin etiquetas", () => {
  it("las palabras clave dentro de frases no son etiquetas", () => {
    const prose = [
      text("You may sign this agreement only after reading every section of the contract carefully today", 72, 400, FONT, 468),
      text("The initial payment is due when the work starts and the balance is paid after completion of the work", 72, 380, FONT, 468),
    ];
    const { candidates } = analyze({ texts: prose, segments: [hline(100, 250, 398), hline(100, 250, 378)] });
    expect(candidates.filter((c) => c.type !== "text")).toHaveLength(0);
  });

  it("una pagina sin texto o una pagina truncada no se analiza", () => {
    expect(analyze({}).candidates).toHaveLength(0);
    const truncated = { ...pageData({ texts: [text("Signature:", 72, 400, FONT, 55)], segments: [hline(135, 335, 398)] }), truncated: true };
    expect(analyzePage(truncated, { signers: 2 }).candidates).toHaveLength(0);
  });

  it("frases: las etiquetas separadas por un hueco ancho son frases distintas", () => {
    const phrases = buildPhrases([text("Insured (1) Signature", 72, 400, FONT, 100), text("Date", 230, 400, FONT, 25)]);
    expect(phrases).toHaveLength(2);
    const joined = buildPhrases([text("Signature", 72, 400, FONT, 50), text("of Client", 125, 400, FONT, 45)]);
    expect(joined).toHaveLength(1);
  });

  it("una hilera de guiones bajos corta la frase de su etiqueta", () => {
    const phrases = buildPhrases([text("Loss Address:", 72, 400, FONT, 70), text("____________", 145, 400, FONT, 80), text("Date of Loss:", 230, 400, FONT, 65)]);
    expect(phrases).toHaveLength(3);
  });

  it("una etiqueta recibe el rol y la pista solo de su propio tramo", () => {
    const first = buildAnchors(buildPhrases([text("Insured (1) Signature Date", 72, 400, FONT, 160)]));
    expect(first.find((a) => a.kind === "signature")!.hint).toBe(0);
    const date = first.find((a) => a.kind === "date")!;
    expect(date.hint).toBeUndefined();
    expect(date.role).toBe("unknown");
    expect(date.text).toBe("Date");
    const second = buildAnchors(buildPhrases([text("Date Insured (2) Signature", 72, 400, FONT, 140)]));
    expect(second.find((a) => a.kind === "signature")!.hint).toBe(1);
    expect(second.find((a) => a.kind === "date")!.hint).toBeUndefined();
    expect(second.find((a) => a.kind === "date")!.text).toBe("Date");
  });
});

describe("texto de relleno no produce campos", () => {
  it("un contrato de relleno sin etiquetas ni rayas no da ningun campo", () => {
    expect(analyze({ texts: filler(40) }).candidates).toHaveLength(0);
  });
});
