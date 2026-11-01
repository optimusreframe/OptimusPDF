import { beforeEach, describe, expect, it } from "vitest";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { KIT_AT, storedProfilesRaw, wipeProfiles } from "@/lib/backup/__fixtures__/clientProfilesKit";
import { asFile, timed } from "@/lib/backup/__fixtures__/testKit";
import {
  MAX_CLIENT_PROFILES,
  MAX_CLIENT_PROFILES_JSON_BYTES,
  applyClientProfilesImport,
  defaultClientProfileDecisions,
  planClientProfilesImport,
  type ClientProfilesImportPlan,
} from "@/lib/backup/modules/clientProfiles";
import { listClientProfiles } from "@/lib/clientProfile/store";

/**
 * Corpus HOSTIL del modulo «Perfiles de cliente» (patron de `scanSessions.hostile.test.ts`): cada paquete malo se rechaza o se
 * recorta SIN romper el resto, en menos de 2 s, y NUNCA escribe nada al planificar. Se forja el `profiles.json` a mano; el
 * contenedor (zips hostiles, rutas, bombas) ya tiene su corpus aparte.
 */

type Raw = Record<string, unknown>;
const value = (text: unknown, extra: Raw = {}): Raw => ({ value: text, updatedAt: KIT_AT, source: "typed", ...extra });
const profile = (id: unknown, name: unknown, values: Raw, extra: Raw = {}): Raw => ({ id, name, updatedAt: KIT_AT, values, ...extra });

beforeEach(() => {
  window.localStorage.clear();
  wipeProfiles();
});

async function planOf(json: string | Raw, schemaVersion = 1): Promise<ClientProfilesImportPlan> {
  const text = typeof json === "string" ? json : JSON.stringify(json);
  const blob = await buildPackage({ modules: [{ name: "client-profiles", schemaVersion, files: [{ path: "client-profiles/profiles.json", data: new TextEncoder().encode(text), type: "application/json" }] }] });
  const read = await readPackage(asFile(blob));
  const plan = await timed(async () => planClientProfilesImport(read));
  // Planificar NUNCA escribe.
  expect(storedProfilesRaw()).toBeNull();
  return plan;
}
const doc = (profiles: unknown[], extra: Raw = {}): Raw => ({ version: 1, profiles, ...extra });

describe("estructura imposible: el modulo entero se descarta (damaged) sin tocar nada", () => {
  it("mas de 20 perfiles", async () => {
    const many = Array.from({ length: MAX_CLIENT_PROFILES + 1 }, (_, i) => profile(`cp-${i}`, `P${i}`, { phone: value("555-0100") }));
    expect((await planOf(doc(many))).state).toBe("damaged");
  });

  it("mas de 40 valores en un perfil", async () => {
    const wide = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`k${i}`, value("valor")]));
    expect((await planOf(doc([profile("cp-1", "Ancho", wide)]))).state).toBe("damaged");
  });

  it("JSON con anidamiento de bomba", async () => {
    const deep = `{"version":1,"profiles":[],"x":${"[".repeat(40)}${"]".repeat(40)}}`;
    expect((await planOf(deep)).state).toBe("damaged");
  });

  it("JSON mas grande que el tope del modulo (1 MiB) aunque sea valido: el contenedor ni lo empaqueta ni lo lee", async () => {
    const pad = "x".repeat(MAX_CLIENT_PROFILES_JSON_BYTES + 10);
    await expect(planOf(doc([profile("cp-1", "Ok", { phone: value("555-0100") })], { pad }))).rejects.toMatchObject({ code: "tooLarge" });
  });

  it("version interna distinta, perfiles que no son lista, texto que no es JSON, vacio", async () => {
    for (const json of [{ version: 2, profiles: [] }, { version: 1, profiles: {} }, { version: "1", profiles: [] }, "no json", "", "null", "[]", '"x"']) {
      expect((await planOf(json as string | Raw)).state, JSON.stringify(json)).toBe("damaged");
    }
  });
});

describe("contenido malo: se recorta lo que no vale y el resto entra", () => {
  it("claves peligrosas, mala forma, valores largos/cortos/no texto, fechas y source invalidos", async () => {
    const plan = await planOf(
      doc([
        profile("cp-1", "Bueno", {
          phone: value("555-0100"),
          constructor: value("pisa el prototipo"),
          toString: value("tampoco"),
          "mala clave": value("zzz"),
          prototype: value("zzz"),
          email: value("x".repeat(501)),
          address: value("A"),
          claimNumber: value({ evil: true }),
          lossDate: value("2026-10-01", { updatedAt: "ayer" }),
          insurer: value("Aseguradora Demo", { source: "robot" }),
          policyNumber: value("POL-0001", { source: "extracted" }),
        }),
      ]),
    );
    expect(plan.state).toBe("ok");
    expect(plan.items).toHaveLength(1);
    expect(Object.keys(plan.items[0].payload.values).sort()).toEqual(["phone", "policyNumber"]);
    expect(plan.counts.invalid).toBe(9);
    expect(({} as Record<string, unknown>).evil).toBeUndefined();
  });

  it("__proto__ real (JSON.parse lo crea como clave propia) no contamina y se descarta", async () => {
    const text = `{"version":1,"profiles":[{"id":"cp-1","name":"X","updatedAt":"${KIT_AT}","values":{"__proto__":{"value":"hack","updatedAt":"${KIT_AT}","source":"typed"},"phone":{"value":"555-0100","updatedAt":"${KIT_AT}","source":"typed"}}}]}`;
    const plan = await planOf(text);
    expect(Object.keys(plan.items[0].payload.values)).toEqual(["phone"]);
    expect(Object.getPrototypeOf(plan.items[0].payload.values)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "value")).toBe(false);
  });

  it("controles, marcas bidi y espacios de mas se limpian en nombre y valores", async () => {
    const plan = await planOf(doc([profile("cp-1", "  Pérez\u0000\u202e,   Ana  ", { address: value("Calle\t1\u200f  \n#2") })]));
    expect(plan.items[0].name).toBe("Pérez , Ana");
    expect(plan.items[0].payload.values.address.value).toBe("Calle 1 #2");
  });

  it("ids repetidos, con mala forma o ausentes, nombres vacios y perfiles sin valores validos se descartan", async () => {
    const plan = await planOf(
      doc([
        profile("cp-1", "Primero", { phone: value("555-0100") }),
        profile("cp-1", "Repetido", { phone: value("555-0199") }),
        profile("../../etc/passwd", "Ruta", { phone: value("555-0100") }),
        profile(undefined, "Sin id", { phone: value("555-0100") }),
        profile("cp-2", "", { phone: value("555-0100") }),
        profile("cp-3", "Vacio", {}),
        profile("cp-4", "Solo basura", { phone: value("") }),
        42,
        null,
      ]),
    );
    expect(plan.items.map((i) => [i.id, i.name])).toEqual([["cp-1", "Primero"]]);
  });

  it("un perfil de 20 x 40 valores (el maximo) se planifica en < 2 s y se importa entero", async () => {
    const max = Array.from({ length: MAX_CLIENT_PROFILES }, (_, p) => profile(`cp-${p}`, `Cliente ${p}`, Object.fromEntries(Array.from({ length: 40 }, (_, k) => [`k${k}`, value(`valor ${p}-${k}`)]))));
    const plan = await planOf(doc(max));
    expect(plan.items).toHaveLength(MAX_CLIENT_PROFILES);
    expect(await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan))).toMatchObject({ ok: true, written: MAX_CLIENT_PROFILES });
    expect(listClientProfiles()).toHaveLength(MAX_CLIENT_PROFILES);
    expect(listClientProfiles().every((p) => Object.keys(p.values).length === 40)).toBe(true);
  });
});
