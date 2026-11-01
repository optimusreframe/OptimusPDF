import { describe, expect, it } from "vitest";
import {
  CLIENT_PROFILES_SCHEMA,
  MAX_CLIENT_PROFILES,
  MAX_PROFILE_NAME_CHARS,
  MAX_PROFILE_VALUES,
  MAX_PROFILE_VALUE_CHARS,
  checkClientProfiles,
  cleanProfileText,
  clientProfilesJson,
  isStorableProfileKey,
  parseProfileValue,
  sameClientProfile,
} from "@/lib/clientProfile/schema";
import type { ClientProfile } from "@/lib/autofill/types";

/**
 * Esquema de los perfiles de cliente: el MISMO saneado para lo que hay en el navegador y para lo que llega de un paquete
 * (hostil o corrupto). Todos los datos de aqui son INVENTADOS.
 */

const AT = "2026-10-20T10:00:00.000Z";
const value = (text: string, source: "extracted" | "typed" = "extracted") => ({ value: text, updatedAt: AT, source });
const profile = (id: string, name: string, values: Record<string, ReturnType<typeof value>>): ClientProfile => ({ id, name, values, updatedAt: AT });
const wrap = (profiles: unknown[]) => ({ version: CLIENT_PROFILES_SCHEMA, profiles });

describe("claves guardables", () => {
  it("acepta las del registro y las desconocidas con buena forma", () => {
    for (const key of ["insuredName1", "phone", "claimNumber", "futureKey", "a.b_c"]) expect(isStorableProfileKey(key), key).toBe(true);
  });

  it("rechaza mala forma y todo lo que choca con el prototipo", () => {
    for (const key of ["", "1abc", "Bad Key", "__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "a".repeat(41)]) expect(isStorableProfileKey(key), key).toBe(false);
    expect(isStorableProfileKey(7)).toBe(false);
  });
});

describe("texto", () => {
  it("recorta, junta espacios y quita controles y marcas bidi", () => {
    expect(cleanProfileText("  Ana \t  Pérez\u0000 ", 50)).toBe("Ana Pérez");
    expect(cleanProfileText("Ana\u202eodnuf", 50)).toBe("Anaodnuf");
    // Espacios que no son el normal (no rompible, em) tambien se juntan en uno.
    expect(cleanProfileText("Ana\u00a0\u2003  Pérez", 50)).toBe("Ana Pérez");
  });

  it("vacio, demasiado largo o no texto -> null", () => {
    expect(cleanProfileText("   ", 10)).toBeNull();
    expect(cleanProfileText("x".repeat(11), 10)).toBeNull();
    expect(cleanProfileText(5, 10)).toBeNull();
  });

  it("un valor se acepta con 2+ caracteres, fecha y source validos", () => {
    expect(parseProfileValue(value("Ana Pérez"))).toEqual(value("Ana Pérez"));
    expect(parseProfileValue(value("A"))).toBeNull();
    expect(parseProfileValue({ ...value("Ana"), updatedAt: "ayer" })).toBeNull();
    expect(parseProfileValue({ ...value("Ana"), source: "otro" })).toBeNull();
    expect(parseProfileValue(value("x".repeat(MAX_PROFILE_VALUE_CHARS + 1)))).toBeNull();
    expect(parseProfileValue("Ana")).toBeNull();
  });
});

describe("checkClientProfiles", () => {
  it("un perfil valido pasa tal cual y la fecha se normaliza a ISO", () => {
    const checked = checkClientProfiles(wrap([profile("cp-1", "Pérez, María", { insuredName1: value("María Pérez"), phone: value("555-0100", "typed") })]));
    expect(checked).toMatchObject({ ok: true, dropped: 0 });
    if (checked.ok) expect(checked.profiles).toEqual([profile("cp-1", "Pérez, María", { insuredName1: value("María Pérez"), phone: value("555-0100", "typed") })]);
  });

  it("estructura equivocada -> rechazo total", () => {
    for (const raw of [null, [], "x", { version: 2, profiles: [] }, { version: 1 }, { version: 1, profiles: {} }]) expect(checkClientProfiles(raw), JSON.stringify(raw)).toEqual({ ok: false });
  });

  it("mas de 20 perfiles o mas de 40 valores en uno -> rechazo total (origen hostil)", () => {
    const many = Array.from({ length: MAX_CLIENT_PROFILES + 1 }, (_, i) => profile(`cp-${i}`, `P${i}`, { phone: value("555-0100") }));
    expect(checkClientProfiles(wrap(many))).toEqual({ ok: false });
    const wide = Object.fromEntries(Array.from({ length: MAX_PROFILE_VALUES + 1 }, (_, i) => [`k${i}`, value("valor")]));
    expect(checkClientProfiles(wrap([profile("cp-1", "Ancho", wide)]))).toEqual({ ok: false });
    expect(checkClientProfiles(wrap(many.slice(0, MAX_CLIENT_PROFILES)))).toMatchObject({ ok: true });
  });

  it("descarta lo que no vale sin tumbar el resto y lo cuenta", () => {
    const checked = checkClientProfiles(
      wrap([
        profile("cp-1", "Bueno", { phone: value("555-0100"), email: value("a"), "Bad Key": value("zzz"), constructor: value("zzz") }),
        profile("cp-1", "Repetido", { phone: value("555-0199") }),
        profile("mal id!", "Id malo", { phone: value("555-0100") }),
        profile("cp-3", "   ", { phone: value("555-0100") }),
        profile("cp-4", "Sin valores validos", { phone: value("x") }),
        "no es un perfil",
      ]),
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.profiles.map((p) => [p.id, Object.keys(p.values)])).toEqual([["cp-1", ["phone"]]]);
    // email corto, 2 claves malas, id repetido, id malo, nombre vacio, valor corto + perfil sin valores, y la entrada que no es un perfil.
    expect(checked.dropped).toBe(9);
  });

  it("__proto__ como clave de valores no contamina nada y se descarta", () => {
    const raw = JSON.parse('{"version":1,"profiles":[{"id":"cp-1","name":"X","updatedAt":"2026-10-20T10:00:00.000Z","values":{"__proto__":{"value":"hack","updatedAt":"2026-10-20T10:00:00.000Z","source":"typed"},"phone":{"value":"555-0100","updatedAt":"2026-10-20T10:00:00.000Z","source":"typed"}}}]}');
    const checked = checkClientProfiles(raw);
    expect(checked.ok && checked.profiles[0].values).toEqual({ phone: value("555-0100", "typed") });
    expect(({} as Record<string, unknown>).value).toBeUndefined();
  });

  it("un nombre de 80 caracteres entra y de 81 se descarta", () => {
    expect(checkClientProfiles(wrap([profile("cp-1", "n".repeat(MAX_PROFILE_NAME_CHARS), { phone: value("555-0100") })]))).toMatchObject({ ok: true, dropped: 0 });
    expect(checkClientProfiles(wrap([profile("cp-1", "n".repeat(MAX_PROFILE_NAME_CHARS + 1), { phone: value("555-0100") })]))).toMatchObject({ ok: true, dropped: 1 });
  });
});

describe("JSON canonico y comparacion", () => {
  it("ordena las claves: mismo contenido -> mismo texto, sin importar el orden de insercion", () => {
    const a = profile("cp-1", "X", { phone: value("555-0100"), email: value("a@b.co") });
    const b = profile("cp-1", "X", { email: value("a@b.co"), phone: value("555-0100") });
    expect(clientProfilesJson([a])).toBe(clientProfilesJson([b]));
    expect(JSON.parse(clientProfilesJson([a]))).toMatchObject({ version: 1 });
  });

  it("ida y vuelta: lo escrito se vuelve a leer igual", () => {
    const original = [profile("cp-1", "Pérez", { insuredName1: value("María Pérez"), address: value("Calle 1 #2, Ciudad", "typed") })];
    const back = checkClientProfiles(JSON.parse(clientProfilesJson(original)));
    expect(back.ok && back.profiles).toEqual(original);
  });

  it("sameClientProfile ignora el id pero no el contenido", () => {
    const a = profile("cp-1", "X", { phone: value("555-0100") });
    expect(sameClientProfile(a, { ...a, id: "otro" })).toBe(true);
    expect(sameClientProfile(a, profile("cp-1", "X", { phone: value("555-0101") }))).toBe(false);
    expect(sameClientProfile(a, { ...a, name: "Y" })).toBe(false);
  });
});
