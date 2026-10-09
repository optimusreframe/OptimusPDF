import { describe, expect, it } from "vitest";
import {
  instantiateTemplate,
  instantiateTemplateForAll,
  type SignTemplate,
} from "@/app/sign-pdf/signTemplates";
import { MAX_SIGNERS } from "@/app/sign-pdf/signLimits";

/** Contadores propios: los ids que acuñan son predecibles. */
function minters() {
  let signer = 0;
  let field = 0;
  let text = 0;
  return {
    mintSignerId: () => `sg-${(signer += 1)}`,
    mintFieldId: () => `fld-${(field += 1)}`,
    mintTextFieldId: () => `txt-${(text += 1)}`,
  };
}

const RECT = { x: 0.1, y: 0.1, width: 0.2, height: 0.1 };

function template(over: Partial<SignTemplate> = {}): SignTemplate {
  return {
    id: "tpl-1",
    name: "Contrato",
    savedAt: "2026-01-01T00:00:00.000Z",
    sourcePageCount: 3,
    signers: [{ name: "Ana" }, { name: "Luis" }],
    fields: [
      { signerIndex: 0, pageIndex: 0, type: "signature", rect: RECT },
      { signerIndex: 1, pageIndex: 0, type: "initials", rect: RECT },
      { signerIndex: 0, pageIndex: 2, type: "signature", rect: RECT },
    ],
    textFields: [{ pageIndex: 1, rect: RECT, label: "Nombre" }],
    ...over,
  };
}

describe("instantiateTemplate (API de siempre, tras el refactor)", () => {
  it("aplica a un documento: firmantes con ids y colores nuevos, huecos y campos", () => {
    const result = instantiateTemplate(template(), { pageCount: 3, ...minters() });
    expect(result).not.toBeNull();
    expect(result!.signers.map((s) => s.name)).toEqual(["Ana", "Luis"]);
    expect(result!.signers.map((s) => s.id)).toEqual(["sg-1", "sg-2"]);
    expect(result!.fields).toHaveLength(3);
    expect(result!.textFields).toHaveLength(1);
    expect(result!.dropped).toBe(0);
    expect(result!.fields[0].signerId).toBe("sg-1");
    expect(result!.fields[1].signerId).toBe("sg-2");
    expect(result!.textFields[0].source).toBe("manual");
  });

  it("descarta lo que cae en paginas que no existen y lo cuenta", () => {
    const result = instantiateTemplate(template(), { pageCount: 1, ...minters() });
    expect(result!.fields).toHaveLength(2);
    expect(result!.textFields).toHaveLength(0);
    expect(result!.dropped).toBe(2);
  });

  it("devuelve null (sin acunar ningun id) si la plantilla traia algo y NADA cabe", () => {
    const mint = minters();
    let minted = 0;
    const result = instantiateTemplate(
      template({
        fields: [{ signerIndex: 0, pageIndex: 5, type: "signature", rect: RECT }],
        textFields: [],
      }),
      { pageCount: 2, ...mint, mintSignerId: () => `sg-${(minted += 1)}` },
    );
    expect(result).toBeNull();
    expect(minted).toBe(0);
  });

  it("una plantilla con mas de MAX_SIGNERS firmantes se trunca y cuenta lo que colgaba de los sobrantes", () => {
    const crowd = template({
      signers: [{ name: "A" }, { name: "B" }, { name: "C" }],
      fields: [
        { signerIndex: 0, pageIndex: 0, type: "signature", rect: RECT },
        { signerIndex: 2, pageIndex: 0, type: "signature", rect: RECT },
      ],
      textFields: [],
    });
    const result = instantiateTemplate(crowd, { pageCount: 1, ...minters() });
    expect(result!.signers).toHaveLength(MAX_SIGNERS);
    expect(result!.fields).toHaveLength(1);
    expect(result!.dropped).toBe(1);
  });
});

describe("instantiateTemplateForAll", () => {
  const docs = [
    { id: "doc-1", pageCount: 3 },
    { id: "doc-2", pageCount: 3 },
  ];

  it("fija los firmantes UNA sola vez", () => {
    const mint = minters();
    let signerMints = 0;
    const result = instantiateTemplateForAll(template(), docs, {
      ...mint,
      mintSignerId: () => {
        signerMints += 1;
        return mint.mintSignerId();
      },
    });
    expect(signerMints).toBe(2);
    expect(result!.signers.map((s) => s.id)).toEqual(["sg-1", "sg-2"]);
  });

  it("repite los huecos y campos en cada documento, ligados a los MISMOS firmantes", () => {
    const result = instantiateTemplateForAll(template(), docs, minters())!;
    const signerIds = new Set(result.signers.map((s) => s.id));
    for (const doc of docs) {
      const layout = result.perDoc[doc.id];
      expect(layout.fields).toHaveLength(3);
      expect(layout.textFields).toHaveLength(1);
      expect(layout.fields.every((f) => signerIds.has(f.signerId))).toBe(true);
    }
  });

  it("los ids de huecos y campos son propios de cada documento (nunca se comparten)", () => {
    const result = instantiateTemplateForAll(template(), docs, minters())!;
    const fieldIds = docs.flatMap((d) => result.perDoc[d.id].fields.map((f) => f.id));
    const textIds = docs.flatMap((d) => result.perDoc[d.id].textFields.map((f) => f.id));
    expect(new Set(fieldIds).size).toBe(fieldIds.length);
    expect(new Set(textIds).size).toBe(textIds.length);
  });

  it("las paginas que no existen en un documento se descartan SOLO en ese documento y se suman en dropped", () => {
    const result = instantiateTemplateForAll(
      template(),
      [
        { id: "doc-1", pageCount: 3 },
        { id: "doc-2", pageCount: 1 },
      ],
      minters(),
    )!;
    expect(result.perDoc["doc-1"].fields).toHaveLength(3);
    expect(result.perDoc["doc-1"].dropped).toBe(0);
    expect(result.perDoc["doc-2"].fields).toHaveLength(2);
    expect(result.perDoc["doc-2"].textFields).toHaveLength(0);
    expect(result.perDoc["doc-2"].dropped).toBe(2);
    expect(result.dropped).toBe(2);
  });

  it("un documento donde no cabe nada queda sin huecos, pero si cabe en otro se aplica", () => {
    const only = template({
      fields: [{ signerIndex: 0, pageIndex: 4, type: "signature", rect: RECT }],
      textFields: [],
    });
    const result = instantiateTemplateForAll(
      only,
      [
        { id: "doc-1", pageCount: 5 },
        { id: "doc-2", pageCount: 2 },
      ],
      minters(),
    )!;
    expect(result.perDoc["doc-1"].fields).toHaveLength(1);
    expect(result.perDoc["doc-2"].fields).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it("devuelve null si no cabe nada en NINGUN documento (no se pierden los firmantes actuales por nada)", () => {
    const only = template({
      fields: [{ signerIndex: 0, pageIndex: 9, type: "signature", rect: RECT }],
      textFields: [],
    });
    expect(
      instantiateTemplateForAll(only, docs, minters()),
    ).toBeNull();
  });

  it("sin documentos no aplica nada", () => {
    expect(instantiateTemplateForAll(template(), [], minters())).toBeNull();
  });

  it("una plantilla vacia (solo firmantes) se aplica a todos sin huecos", () => {
    const result = instantiateTemplateForAll(
      template({ fields: [], textFields: [] }),
      docs,
      minters(),
    )!;
    expect(result.signers).toHaveLength(2);
    expect(result.perDoc["doc-1"].fields).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("trunca una plantilla heredada con >2 firmantes (una vez) y suma lo descartado de cada documento", () => {
    const crowd = template({
      signers: [{ name: "A" }, { name: "B" }, { name: "C" }],
      fields: [
        { signerIndex: 0, pageIndex: 0, type: "signature", rect: RECT },
        { signerIndex: 2, pageIndex: 0, type: "signature", rect: RECT },
      ],
      textFields: [],
    });
    const result = instantiateTemplateForAll(crowd, docs, minters())!;
    expect(result.signers).toHaveLength(MAX_SIGNERS);
    expect(result.perDoc["doc-1"].fields).toHaveLength(1);
    expect(result.perDoc["doc-2"].fields).toHaveLength(1);
    expect(result.dropped).toBe(2);
  });

  it("con un solo documento da lo mismo que instantiateTemplate", () => {
    const one = instantiateTemplateForAll(template(), [{ id: "doc-1", pageCount: 2 }], minters())!;
    const single = instantiateTemplate(template(), { pageCount: 2, ...minters() })!;
    expect(one.signers).toEqual(single.signers);
    expect(one.perDoc["doc-1"].fields).toEqual(single.fields);
    expect(one.perDoc["doc-1"].textFields).toEqual(single.textFields);
    expect(one.dropped).toBe(single.dropped);
  });
});
