import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  MAX_SIGNERS,
  MAX_TOTAL_BYTES,
  admitDocuments,
} from "@/app/sign-pdf/signLimits";
import { instantiateTemplate, type SignTemplate } from "@/app/sign-pdf/signTemplates";
import { SIGNER_COLORS } from "@/lib/pdf/sign";
import { MAX_SAFE_FILE_SIZE } from "@/lib/pdf/core";

const MB = 1024 * 1024;
const f = (name: string, mb = 1) => ({ name, size: mb * MB });

describe("limites — src/app/sign-pdf/signLimits.ts", () => {
  it("los topes son los del plan", () => {
    expect(MAX_SIGNERS).toBe(2);
    expect(MAX_DOCUMENTS).toBe(10);
    expect(MAX_DOCUMENT_BYTES).toBe(100 * MB);
    expect(MAX_TOTAL_BYTES).toBe(200 * MB);
    // Y coincide con el aviso de peso del dropzone.
    expect(MAX_DOCUMENT_BYTES).toBe(MAX_SAFE_FILE_SIZE);
  });

  it("MAX_SIGNERS es aparte de la paleta: SOLO_COLOR usa el indice 4, la paleta no se acorta", () => {
    expect(SIGNER_COLORS.length).toBeGreaterThan(4);
    expect(SIGNER_COLORS.length).toBeGreaterThan(MAX_SIGNERS);
  });
});

describe("admitDocuments", () => {
  it("admite todo lo que cabe y conserva el orden", () => {
    const result = admitDocuments([], [f("a"), f("b"), f("c")]);
    expect(result.accepted.map((x) => x.name)).toEqual(["a", "b", "c"]);
    expect(result.rejected).toEqual([]);
  });

  it("rechaza el undecimo documento con motivo 'count'", () => {
    const current = Array.from({ length: 10 }, (_, i) => f(`d${i}`));
    const result = admitDocuments(current, [f("extra")]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([{ file: expect.objectContaining({ name: "extra" }), reason: "count" }]);
  });

  it("de un lote, entran los que caben y el resto se rechaza", () => {
    const current = Array.from({ length: 8 }, (_, i) => f(`d${i}`));
    const result = admitDocuments(current, [f("a"), f("b"), f("c")]);
    expect(result.accepted.map((x) => x.name)).toEqual(["a", "b"]);
    expect(result.rejected.map((x) => x.file.name)).toEqual(["c"]);
  });

  it("un documento de mas de 100 MB no entra nunca (motivo 'size'), ni siquiera siendo el unico", () => {
    const result = admitDocuments([], [f("grande", 101)]);
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].reason).toBe("size");
  });

  it("exactamente 100 MB si entra", () => {
    expect(admitDocuments([], [f("justo", 100)]).accepted).toHaveLength(1);
  });

  it("rechaza lo que haria pasar de 200 MB en total (motivo 'total')", () => {
    const result = admitDocuments([f("a", 100), f("b", 90)], [f("c", 20)]);
    expect(result.rejected).toEqual([{ file: expect.objectContaining({ name: "c" }), reason: "total" }]);
  });

  it("el total cuenta lo que ya estaba y lo recien admitido", () => {
    const result = admitDocuments([f("a", 100)], [f("b", 60), f("c", 60), f("d", 30)]);
    expect(result.accepted.map((x) => x.name)).toEqual(["b", "d"]);
    expect(result.rejected.map((x) => x.file.name)).toEqual(["c"]);
  });

  it("los topes se pueden ajustar", () => {
    const result = admitDocuments([], [f("a"), f("b")], { maxDocuments: 1 });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0].reason).toBe("count");
  });
});

describe("plantillas con mas firmantes que MAX_SIGNERS", () => {
  const rect = { x: 0.1, y: 0.1, width: 0.2, height: 0.05 };
  const template: SignTemplate = {
    id: "t1",
    name: "Antigua",
    savedAt: "2026-01-01T00:00:00.000Z",
    sourcePageCount: 2,
    signers: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }],
    fields: [
      { signerIndex: 0, pageIndex: 0, type: "signature", rect },
      { signerIndex: 1, pageIndex: 0, type: "signature", rect },
      { signerIndex: 2, pageIndex: 0, type: "signature", rect },
      { signerIndex: 3, pageIndex: 1, type: "initials", rect },
    ],
    textFields: [],
  };
  let n = 0;
  const deps = {
    pageCount: 2,
    mintSignerId: () => `sg-${(n += 1)}`,
    mintFieldId: () => `f-${(n += 1)}`,
    mintTextFieldId: () => `t-${(n += 1)}`,
  };

  it("se truncan a 2 firmantes y lo que colgaba de los demas cuenta como descartado", () => {
    const result = instantiateTemplate(template, deps);
    expect(result?.signers).toHaveLength(MAX_SIGNERS);
    expect(result?.fields).toHaveLength(2);
    expect(result?.dropped).toBe(2);
  });

  it("una plantilla dentro del limite no descarta nada", () => {
    const small: SignTemplate = { ...template, signers: template.signers.slice(0, 2), fields: template.fields.slice(0, 2) };
    const result = instantiateTemplate(small, deps);
    expect(result?.signers).toHaveLength(2);
    expect(result?.dropped).toBe(0);
  });
});
