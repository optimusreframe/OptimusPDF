import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "@/lib/backup/__fixtures__/memoryStorage";
import {
  CLIENT_PROFILES_STORAGE_KEY,
  MAX_CLIENT_PROFILES,
  __resetClientProfilesCacheForTests,
  clearClientProfiles,
  clientProfilesAvailable,
  deleteClientProfile,
  findClientProfileByName,
  getClientProfile,
  listClientProfiles,
  removeClientProfileValue,
  renameClientProfile,
  replaceClientProfiles,
  saveClientProfile,
  setClientProfileValue,
  useClientProfiles,
} from "@/lib/clientProfile/store";

/** Almacen de perfiles de cliente (localStorage de jsdom). Datos INVENTADOS. */

beforeEach(() => {
  window.localStorage.clear();
  __resetClientProfilesCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const AT = new Date("2026-10-20T10:00:00.000Z");
const save = (name: string, values: Record<string, string> = { insuredName1: name, phone: "555-0100" }, now = AT) => saveClientProfile({ name, values, now });

describe("guardar y leer", () => {
  it("guarda un perfil, lo lista y queda escrito en localStorage con su version", () => {
    const result = save("Pérez, María");
    expect(result.ok).toBe(true);
    expect(listClientProfiles().map((p) => [p.name, Object.keys(p.values).sort()])).toEqual([["Pérez, María", ["insuredName1", "phone"]]]);
    expect(JSON.parse(window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY) as string)).toMatchObject({ version: 1, profiles: [{ name: "Pérez, María" }] });
    expect(getClientProfile(listClientProfiles()[0].id)?.values.phone).toMatchObject({ value: "555-0100", source: "extracted", updatedAt: AT.toISOString() });
  });

  it("sobrevive a una recarga (la cache se vuelve a leer)", () => {
    save("Pérez, María");
    __resetClientProfilesCacheForTests();
    expect(listClientProfiles()).toHaveLength(1);
  });

  it("vacia el nombre o sin ningun valor guardable -> empty, y no escribe nada", () => {
    expect(saveClientProfile({ name: "  ", values: { phone: "555-0100" } })).toEqual({ ok: false, reason: "empty" });
    expect(saveClientProfile({ name: "X", values: { phone: "a", "Bad Key": "valor", constructor: "valor" } })).toEqual({ ok: false, reason: "empty" });
    expect(window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBeNull();
  });

  it("guardar otra vez con el mismo nombre (sin importar mayusculas ni tildes) ACTUALIZA: los valores nuevos pisan y los demas se conservan", () => {
    save("Pérez, María", { insuredName1: "María Pérez", phone: "555-0100", email: "m@ejemplo.test" });
    const again = save("perez, maria", { phone: "555-0199" }, new Date("2026-10-21T10:00:00.000Z"));
    expect(again.ok).toBe(true);
    expect(listClientProfiles()).toHaveLength(1);
    const only = listClientProfiles()[0];
    expect(Object.fromEntries(Object.entries(only.values).map(([k, v]) => [k, v.value]))).toEqual({ insuredName1: "María Pérez", phone: "555-0199", email: "m@ejemplo.test" });
    expect(findClientProfileByName("PEREZ, MARIA")?.id).toBe(only.id);
  });

  it("el origen de cada valor puede ser distinto (corregido a mano o leido)", () => {
    saveClientProfile({ name: "Mixto", values: { phone: "555-0100", email: "m@ejemplo.test" }, source: { phone: "typed" } });
    const stored = listClientProfiles()[0].values;
    expect([stored.phone.source, stored.email.source]).toEqual(["typed", "extracted"]);
  });

  it("los mas recientes primero", () => {
    save("Antiguo", undefined, new Date("2026-10-01T10:00:00.000Z"));
    save("Nuevo", undefined, new Date("2026-10-10T10:00:00.000Z"));
    expect(listClientProfiles().map((p) => p.name)).toEqual(["Nuevo", "Antiguo"]);
  });
});

describe("tope de 20 perfiles", () => {
  it("el 21 no entra (full) y NO borra ninguno por su cuenta; actualizar uno existente si se puede", () => {
    for (let i = 0; i < MAX_CLIENT_PROFILES; i += 1) expect(save(`Cliente ${i}`).ok).toBe(true);
    expect(save("Cliente 20")).toEqual({ ok: false, reason: "full" });
    expect(listClientProfiles()).toHaveLength(MAX_CLIENT_PROFILES);
    expect(save("Cliente 3", { email: "x@ejemplo.test" }).ok).toBe(true);
    expect(listClientProfiles()).toHaveLength(MAX_CLIENT_PROFILES);
  });
});

describe("editar, renombrar y borrar", () => {
  it("renombra (nombre vacio no se acepta)", () => {
    const { profile } = save("Antes") as { ok: true; profile: { id: string } };
    expect(renameClientProfile(profile.id, "Despues")).toMatchObject({ ok: true });
    expect(getClientProfile(profile.id)?.name).toBe("Despues");
    expect(renameClientProfile(profile.id, "   ")).toEqual({ ok: false, reason: "empty" });
    expect(renameClientProfile("no-existe", "X")).toEqual({ ok: false, reason: "notFound" });
  });

  it("corrige un valor (queda como escrito a mano) y rechaza vacio o de 1 caracter", () => {
    const { profile } = save("X") as { ok: true; profile: { id: string } };
    expect(setClientProfileValue(profile.id, "phone", "555-0777")).toMatchObject({ ok: true });
    expect(getClientProfile(profile.id)?.values.phone).toMatchObject({ value: "555-0777", source: "typed" });
    expect(setClientProfileValue(profile.id, "phone", "7")).toEqual({ ok: false, reason: "empty" });
    expect(setClientProfileValue(profile.id, "Bad Key", "valor")).toEqual({ ok: false, reason: "empty" });
    expect(getClientProfile(profile.id)?.values.phone.value).toBe("555-0777");
  });

  it("quita un valor; si era el ultimo, el perfil se borra", () => {
    const { profile } = save("X", { phone: "555-0100", email: "m@ejemplo.test" }) as { ok: true; profile: { id: string } };
    expect(removeClientProfileValue(profile.id, "phone")).toEqual({ ok: true, profileDeleted: false });
    expect(Object.keys(getClientProfile(profile.id)?.values ?? {})).toEqual(["email"]);
    expect(removeClientProfileValue(profile.id, "email")).toEqual({ ok: true, profileDeleted: true });
    expect(getClientProfile(profile.id)).toBeUndefined();
    expect(removeClientProfileValue(profile.id, "email")).toEqual({ ok: false, profileDeleted: false });
  });

  it("borra un perfil y borra TODOS (la clave desaparece)", () => {
    const a = save("A") as { ok: true; profile: { id: string } };
    save("B");
    expect(deleteClientProfile(a.profile.id)).toBe(true);
    expect(deleteClientProfile(a.profile.id)).toBe(false);
    expect(listClientProfiles().map((p) => p.name)).toEqual(["B"]);
    expect(clearClientProfiles()).toBe(true);
    expect(listClientProfiles()).toEqual([]);
    expect(window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBeNull();
  });
});

describe("robustez", () => {
  it("texto corrupto o ajeno en localStorage -> lista vacia, sin lanzar", () => {
    for (const raw of ["{no json", "[]", JSON.stringify({ version: 9, profiles: [] }), JSON.stringify({ version: 1, profiles: [{ id: "x" }] })]) {
      window.localStorage.setItem(CLIENT_PROFILES_STORAGE_KEY, raw);
      __resetClientProfilesCacheForTests();
      expect(listClientProfiles(), raw).toEqual([]);
    }
  });

  it("sin localStorage (bloqueado): no hay almacen, guardar dice unavailable y borrar no falla", () => {
    const blocked = new Proxy({}, { get: () => () => { throw new Error("bloqueado"); } }) as unknown as Storage;
    vi.stubGlobal("localStorage", blocked);
    __resetClientProfilesCacheForTests();
    expect(listClientProfiles()).toEqual([]);
    expect(save("X")).toEqual({ ok: false, reason: "unavailable" });
    expect(listClientProfiles()).toEqual([]);
    // Borrar con el almacen bloqueado dice que NO se pudo: la interfaz no debe afirmar «borrado».
    expect(clearClientProfiles()).toBe(false);
  });

  it("cuota llena al guardar -> unavailable y la lista no cambia", () => {
    const memory = new MemoryStorage();
    vi.stubGlobal("localStorage", memory);
    __resetClientProfilesCacheForTests();
    expect(save("Uno").ok).toBe(true);
    memory.failOn = CLIENT_PROFILES_STORAGE_KEY;
    expect(save("Dos")).toEqual({ ok: false, reason: "unavailable" });
    expect(listClientProfiles().map((p) => p.name)).toEqual(["Uno"]);
  });

  it("otra pestana cambia los datos (evento storage): la cache se relee", () => {
    save("Mio");
    window.localStorage.removeItem(CLIENT_PROFILES_STORAGE_KEY);
    expect(listClientProfiles()).toHaveLength(1);
    window.dispatchEvent(new StorageEvent("storage", { key: CLIENT_PROFILES_STORAGE_KEY }));
    expect(listClientProfiles()).toEqual([]);
  });

  it("clientProfilesAvailable refleja si hay localStorage", () => {
    expect(clientProfilesAvailable()).toBe(true);
  });
});

describe("error de cuota sin codigo", () => {
  it("se reconoce por su nombre (los navegadores no lo dan todos igual) y deja lo anterior intacto", () => {
    const memory = new MemoryStorage();
    vi.stubGlobal("localStorage", memory);
    __resetClientProfilesCacheForTests();
    save("Uno");
    const raw = memory.getItem(CLIENT_PROFILES_STORAGE_KEY);
    const keep = memory.setItem.bind(memory);
    memory.setItem = (key: string, value: string) => {
      if (key === CLIENT_PROFILES_STORAGE_KEY && value !== raw) throw Object.assign(new Error("llena"), { name: "QuotaExceededError" });
      keep(key, value);
    };
    const ok = { id: "cp-9", name: "Nuevo", values: { phone: { value: "555-0100", updatedAt: AT.toISOString(), source: "typed" as const } }, updatedAt: AT.toISOString() };
    expect(replaceClientProfiles([ok], raw)).toBe("quota");
    expect(memory.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBe(raw);
  });
});

describe("useClientProfiles", () => {
  it("re-renderiza al guardar, renombrar y borrar", () => {
    const { result } = renderHook(() => useClientProfiles());
    expect(result.current).toEqual([]);
    let id = "";
    act(() => {
      id = (save("Ana") as { ok: true; profile: { id: string } }).profile.id;
    });
    expect(result.current.map((p) => p.name)).toEqual(["Ana"]);
    act(() => {
      renameClientProfile(id, "Ana B");
    });
    expect(result.current.map((p) => p.name)).toEqual(["Ana B"]);
    act(() => {
      clearClientProfiles();
    });
    expect(result.current).toEqual([]);
  });
});

describe("replaceClientProfiles (lo usa el respaldo)", () => {
  it("escribe lo saneado y avisa; si lo guardado ya no es lo que vio la vista previa -> changed y no toca nada", () => {
    save("Uno");
    const raw = window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY);
    expect(replaceClientProfiles([], "otro texto")).toBe("changed");
    expect(window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBe(raw);
    expect(replaceClientProfiles([], raw)).toBe("ok");
    expect(listClientProfiles()).toEqual([]);
  });

  it("un perfil con datos invalidos no se escribe (unavailable) en vez de colar basura", () => {
    const bad = { id: "mal id!", name: "X", values: { phone: { value: "555-0100", updatedAt: AT.toISOString(), source: "typed" as const } }, updatedAt: AT.toISOString() };
    expect(replaceClientProfiles([bad], null)).toBe("unavailable");
    expect(window.localStorage.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBeNull();
  });

  it("si el navegador no deja escribir, se restaura lo anterior (quota)", () => {
    const memory = new MemoryStorage();
    vi.stubGlobal("localStorage", memory);
    __resetClientProfilesCacheForTests();
    save("Uno");
    const raw = memory.getItem(CLIENT_PROFILES_STORAGE_KEY);
    const ok = { id: "cp-9", name: "Nuevo", values: { phone: { value: "555-0100", updatedAt: AT.toISOString(), source: "typed" as const } }, updatedAt: AT.toISOString() };
    memory.failOn = CLIENT_PROFILES_STORAGE_KEY;
    expect(replaceClientProfiles([ok], raw)).toBe("quota");
    memory.failOn = null;
    expect(memory.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBe(raw);
    expect(listClientProfiles().map((p) => p.name)).toEqual(["Uno"]);
  });
});
