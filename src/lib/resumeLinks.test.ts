import { describe, expect, it } from "vitest";
import {
  RESUME_KINDS,
  RESUME_PARAM,
  isValidResumeId,
  parseResume,
  readResumeFromSearch,
  resumeHref,
  resumeKindsOfTool,
  resumeValue,
  toolOfResumeKind,
  withoutResume,
  type ResumeKind,
} from "@/lib/resumeLinks";
import { TOOL_SLUGS } from "@/lib/tools-registry";

/**
 * `?resume=<tipo>:<id>` es entrada NO confiable (cualquiera la escribe o la pega): lista blanca de tipos, id con su
 * expresion exacta, y una herramienta solo acepta los tipos que son suyos.
 */

const HEX = "0123456789abcdef".repeat(4); // 64 hex
const SESSION = "s-mgx4k2w1-1a2b3c4d";

describe("parseResume - lo valido", () => {
  it.each([
    ["sign", HEX],
    ["session", SESSION],
    ["edit", HEX],
    ["pro", HEX],
  ] as const)("acepta %s:<id valido>", (kind, id) => {
    expect(parseResume(`${kind}:${id}`)).toEqual({ kind, id });
  });

  it("cada tipo de la lista blanca tiene herramienta y expresion de id", () => {
    for (const kind of RESUME_KINDS) {
      expect(TOOL_SLUGS).toContain(toolOfResumeKind(kind));
      expect(isValidResumeId(kind, kind === "session" ? SESSION : HEX)).toBe(true);
    }
  });

  it("resumeHref y parseResume son inversos y el valor no necesita escape", () => {
    for (const target of [
      { kind: "sign", id: HEX },
      { kind: "session", id: SESSION },
      { kind: "edit", id: HEX },
      { kind: "pro", id: HEX },
    ] as const) {
      const href = resumeHref(target);
      const url = new URL(href, "http://localhost");
      expect(url.pathname).toBe(`/${toolOfResumeKind(target.kind)}`);
      expect(url.searchParams.get(RESUME_PARAM)).toBe(resumeValue(target));
      expect(href).toBe(`/${toolOfResumeKind(target.kind)}?resume=${target.kind}:${target.id}`);
      expect(parseResume(url.searchParams.get(RESUME_PARAM))).toEqual(target);
    }
  });
});

describe("parseResume - valores manipulados", () => {
  const bad: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["numero", 42],
    ["objeto", { kind: "edit", id: HEX }],
    ["lista", [`edit:${HEX}`]],
    ["vacio", ""],
    ["solo tipo", "edit"],
    ["solo tipo con dos puntos", "edit:"],
    ["sin tipo", `:${HEX}`],
    ["tipo desconocido", `delete:${HEX}`],
    ["tipo en mayusculas", `EDIT:${HEX}`],
    ["tipo con espacio", ` edit:${HEX}`],
    ["constructor (prototipo)", `constructor:${HEX}`],
    ["__proto__", `__proto__:${HEX}`],
    ["toString", `toString:${HEX}`],
    ["hasOwnProperty", `hasOwnProperty:${HEX}`],
    ["esquema javascript", `javascript:alert(1)`],
    ["etiqueta script", `<script>alert(1)</script>`],
    ["etiqueta en el id", `edit:<img src=x onerror=alert(1)>`],
    ["ruta relativa", `edit:../../etc/passwd`],
    ["ruta en el id hex", `edit:${HEX.slice(0, 40)}/../../x`],
    ["id corto", `edit:${HEX.slice(0, 63)}`],
    ["id largo", `edit:${HEX}0`],
    ["id con mayusculas", `edit:${HEX.toUpperCase()}`],
    ["id no hex", `pro:${"g".repeat(64)}`],
    ["id con espacio al final", `pro:${HEX} `],
    ["id con salto de linea", `pro:${HEX}\n`],
    ["id con NUL", `pro:${HEX.slice(0, 63)}\u0000`],
    ["id con comillas", `sign:"${HEX.slice(0, 62)}"`],
    ["dos puntos de mas", `edit:${HEX}:extra`],
    ["fingerprint como sesion", `session:${HEX}`],
    ["sesion como fingerprint", `edit:${SESSION}`],
    ["sesion sin prefijo", `session:mgx4k2w1-1a2b3c4d`],
    ["sesion con mayusculas", `session:S-MGX4K2W1-1A2B3C4D`],
    ["sesion con caracteres raros", `session:s-abc-<x>`],
    ["sesion vacia", `session:s--`],
    ["texto enorme", `edit:${"a".repeat(100_000)}`],
    ["unicode", `edit:${"é".repeat(64)}`],
  ];
  it.each(bad)("rechaza %s", (_label, value) => {
    expect(parseResume(value)).toBeNull();
  });

  it("isValidResumeId rechaza lo que no es texto", () => {
    expect(isValidResumeId("edit", undefined)).toBe(false);
    expect(isValidResumeId("edit", 12)).toBe(false);
    expect(isValidResumeId("edit", null)).toBe(false);
  });
});

describe("readResumeFromSearch", () => {
  const all = RESUME_KINDS as readonly ResumeKind[];

  it("sin parametro: ni presente ni objetivo", () => {
    expect(readResumeFromSearch("", all)).toEqual({ present: false, target: null });
    expect(readResumeFromSearch("?otro=1", all)).toEqual({ present: false, target: null });
  });

  it("valido y permitido: devuelve el objetivo (con o sin '?' y con ':' escapado)", () => {
    expect(readResumeFromSearch(`?resume=edit:${HEX}`, ["edit"])).toEqual({ present: true, target: { kind: "edit", id: HEX } });
    expect(readResumeFromSearch(`resume=edit%3A${HEX}`, ["edit"]).target).toEqual({ kind: "edit", id: HEX });
    expect(readResumeFromSearch(`?x=1&resume=pro:${HEX}&y=2`, ["pro"]).target).toEqual({ kind: "pro", id: HEX });
  });

  it("un tipo valido de OTRA herramienta no restaura nada (pero se limpia)", () => {
    expect(readResumeFromSearch(`?resume=pro:${HEX}`, ["edit"])).toEqual({ present: true, target: null });
    expect(readResumeFromSearch(`?resume=session:${SESSION}`, ["edit"])).toEqual({ present: true, target: null });
    expect(readResumeFromSearch(`?resume=sign:${HEX}`, ["session"])).toEqual({ present: true, target: null });
  });

  it("el tipo debe estar en la lista permitida de la herramienta, no solo en la global", () => {
    expect(readResumeFromSearch(`?resume=edit:${HEX}`, []).target).toBeNull();
    expect(readResumeFromSearch(`?resume=edit:${HEX}`, ["sign", "session"]).target).toBeNull();
  });

  it("varios resume= a la vez no restauran nada", () => {
    expect(readResumeFromSearch(`?resume=edit:${HEX}&resume=edit:${HEX}`, ["edit"])).toEqual({ present: true, target: null });
    expect(readResumeFromSearch(`?resume=bad&resume=edit:${HEX}`, ["edit"])).toEqual({ present: true, target: null });
  });

  it("valores manipulados: presentes pero sin objetivo, sin lanzar", () => {
    for (const raw of ["<script>", "%E0%A4%A", "%00", "__proto__:x", "edit:%2e%2e%2f", "a".repeat(5000), "resume", "&&&"]) {
      expect(() => readResumeFromSearch(`?resume=${raw}`, all)).not.toThrow();
      expect(readResumeFromSearch(`?resume=${raw}`, all).target).toBeNull();
    }
  });

  it("resume vacio cuenta como presente (se limpia) pero no restaura", () => {
    expect(readResumeFromSearch("?resume=", all)).toEqual({ present: true, target: null });
  });
});

describe("resumeKindsOfTool", () => {
  it("Firmar restaura documento suelto y sesion; Editar y PDF Pro, uno; el resto, ninguno", () => {
    expect(resumeKindsOfTool("sign-pdf")).toEqual(["sign", "session"]);
    expect(resumeKindsOfTool("edit-pdf")).toEqual(["edit"]);
    expect(resumeKindsOfTool("pdf-pro")).toEqual(["pro"]);
    expect(resumeKindsOfTool("merge-pdf")).toEqual([]);
  });
});

describe("withoutResume", () => {
  it("quita solo resume y conserva ruta, resto de parametros y hash", () => {
    expect(withoutResume(`/sign-pdf?resume=session:${SESSION}`)).toBe("/sign-pdf");
    expect(withoutResume(`/edit-pdf?a=1&resume=edit:${HEX}&b=2#top`)).toBe("/edit-pdf?a=1&b=2#top");
    expect(withoutResume(`http://localhost:3000/pdf-pro?resume=pro:${HEX}`)).toBe("/pdf-pro");
    expect(withoutResume("/edit-pdf")).toBe("/edit-pdf");
  });

  it("quita todas las repeticiones", () => {
    expect(withoutResume("/edit-pdf?resume=a&resume=b")).toBe("/edit-pdf");
  });
});
