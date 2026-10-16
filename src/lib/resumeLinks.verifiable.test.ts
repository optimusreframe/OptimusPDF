import { describe, expect, it } from "vitest";
import {
  RESUME_KINDS,
  continueHrefFor,
  resumeHref,
  resumeKindsOfTool,
  verifiableResume,
  type ResumeKind,
} from "@/lib/resumeLinks";
import { TOOL_SLUGS } from "@/lib/tools-registry";

const HEX = "ab".repeat(32);
const SESSION = "s-mgx4k2w1-1a2b3c4d";
const idOf = (kind: ResumeKind) => (kind === "session" ? SESSION : HEX);

describe("verifiableResume / continueHrefFor (regla de «Continuar» de Recientes)", () => {
  it("para CADA herramienta del registro y CADA tipo: valido solo si el tipo es de esa herramienta", () => {
    for (const slug of TOOL_SLUGS) {
      for (const kind of RESUME_KINDS) {
        const target = { kind, id: idOf(kind) };
        const owns = resumeKindsOfTool(slug).includes(kind);
        expect(verifiableResume(slug, target), `${slug} ${kind}`).toEqual(owns ? target : null);
        expect(continueHrefFor(slug, target), `${slug} ${kind}`).toBe(owns ? resumeHref(target) : null);
      }
    }
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["texto", "edit:abc"],
    ["numero", 3],
    ["sin id", { kind: "edit" }],
    ["tipo desconocido", { kind: "__proto__", id: HEX }],
    ["tipo constructor", { kind: "constructor", id: HEX }],
    ["id corto", { kind: "edit", id: HEX.slice(1) }],
    ["id en mayusculas", { kind: "edit", id: HEX.toUpperCase() }],
    ["id con ruta", { kind: "edit", id: "../x" }],
    ["id no texto", { kind: "edit", id: 12 }],
  ])("%s -> sin «Continuar»", (_name, target) => {
    expect(verifiableResume("edit-pdf", target)).toBeNull();
    expect(continueHrefFor("edit-pdf", target)).toBeNull();
  });

  it("devuelve un puntero NUEVO con solo tipo e id (no arrastra campos ajenos)", () => {
    const original = { kind: "pro", id: HEX, extra: "<script>" };
    const verified = verifiableResume("pdf-pro", original);
    expect(verified).toEqual({ kind: "pro", id: HEX });
    expect(verified).not.toBe(original);
    expect(Object.keys(verified!)).toEqual(["kind", "id"]);
  });
});
