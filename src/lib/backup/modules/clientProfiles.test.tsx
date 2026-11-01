import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { MemoryStorage } from "@/lib/backup/__fixtures__/memoryStorage";
import { KIT_AT, kitProfile, seedProfiles, storedProfilesRaw, wipeProfiles } from "@/lib/backup/__fixtures__/clientProfilesKit";
import { asFile } from "@/lib/backup/__fixtures__/testKit";
import {
  CLIENT_PROFILES_MODULE,
  MAX_CLIENT_PROFILES,
  applyClientProfilesImport,
  checkClientProfilesLimits,
  clientProfilesModuleFromProfiles,
  defaultClientProfileDecisions,
  exportClientProfiles,
  planClientProfilesImport,
  summarizeClientProfiles,
  type ClientProfilesImportPlan,
} from "@/lib/backup/modules/clientProfiles";
import { CURRENT_CLIENT_PROFILES_SCHEMA } from "@/lib/backup/migrations/clientProfiles";
import { CLIENT_PROFILES_SCHEMA } from "@/lib/clientProfile/schema";
import { CLIENT_PROFILES_STORAGE_KEY, __resetClientProfilesCacheForTests, listClientProfiles } from "@/lib/clientProfile/store";
import { editManifest } from "@/lib/backup/__fixtures__/testKit";

/**
 * Modulo «Perfiles de cliente» del respaldo sobre `localStorage` de jsdom: resumen previo, exportar (formato, seleccion),
 * ida y vuelta (con y sin contrasena), fusion (nueva / identica / distinta / conservar ambos), limites y cambios concurrentes.
 */

const PASSWORD = "clave de prueba 1";
const ANA = () => kitProfile("cp-ana", "Pérez, Ana", { email: "ana@ejemplo.test", futureKey: "dato de una version futura" });
const LUIS = () => kitProfile("cp-luis", "Gómez, Luis", { claimNumber: "CLM-0001" }, "2026-10-21T10:00:00.000Z");

beforeEach(() => {
  window.localStorage.clear();
  wipeProfiles();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function packageOf(profiles = [ANA(), LUIS()], password?: string) {
  seedProfiles(profiles);
  const blob = await buildPackage({ modules: [await exportClientProfiles()], password });
  wipeProfiles();
  return readPackage(asFile(blob), password);
}

async function planOf(profiles = [ANA(), LUIS()], password?: string): Promise<ClientProfilesImportPlan> {
  return planClientProfilesImport(await packageOf(profiles, password));
}

describe("constantes", () => {
  it("el esquema de migraciones y el del JSON van a la par, y el modulo se llama client-profiles en el paquete", () => {
    expect(CURRENT_CLIENT_PROFILES_SCHEMA).toBe(CLIENT_PROFILES_SCHEMA);
    expect(CLIENT_PROFILES_MODULE).toBe("client-profiles");
  });
});

describe("resumen previo", () => {
  it("sin perfiles: ok, cero", () => {
    expect(summarizeClientProfiles()).toEqual({ ok: true, profiles: [], count: 0, values: 0 });
  });

  it("con perfiles: nombre y cuantos valores, sin los valores", () => {
    seedProfiles([ANA(), LUIS()]);
    const summary = summarizeClientProfiles();
    expect(summary).toMatchObject({ ok: true, count: 2, values: 7 });
    if (summary.ok) {
      expect(summary.profiles.map((p) => [p.id, p.name, p.valueCount]).sort()).toEqual([["cp-ana", "Pérez, Ana", 4], ["cp-luis", "Gómez, Luis", 3]]);
      expect(JSON.stringify(summary)).not.toContain("555-0100");
    }
  });

  it("sin localStorage: { ok: false }", () => {
    vi.stubGlobal("localStorage", new Proxy({}, { get: () => () => { throw new Error("bloqueado"); } }));
    expect(summarizeClientProfiles()).toEqual({ ok: false });
  });
});

describe("exportar", () => {
  it("el modulo: nombre, esquema, recuento y UN archivo JSON canonico", async () => {
    seedProfiles([ANA(), LUIS()]);
    const input = await exportClientProfiles();
    expect(input).toMatchObject({ name: "client-profiles", schemaVersion: 1, meta: { count: 2, values: 7 } });
    expect(input.files.map((f) => [f.path, f.type])).toEqual([["client-profiles/profiles.json", "application/json"]]);
    expect(JSON.parse(new TextDecoder().decode(input.files[0].data))).toMatchObject({ version: 1, profiles: [{ id: "cp-luis" }, { id: "cp-ana" }] });
  });

  it("solo los perfiles elegidos", async () => {
    seedProfiles([ANA(), LUIS()]);
    const input = await exportClientProfiles({ ids: ["cp-luis"] });
    expect(input.meta).toMatchObject({ count: 1 });
  });

  it("sin almacen lanza unavailable", async () => {
    vi.stubGlobal("localStorage", new Proxy({}, { get: () => () => { throw new Error("bloqueado"); } }));
    await expect(exportClientProfiles()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("puro: clientProfilesModuleFromProfiles no toca el almacen", () => {
    expect(clientProfilesModuleFromProfiles([ANA()]).meta).toEqual({ count: 1, values: 4 });
    expect(storedProfilesRaw()).toBeNull();
  });
});

describe("ida y vuelta", () => {
  for (const password of [undefined, PASSWORD]) {
    it(`${password ? "cifrado" : "en claro"}: exportar -> borrar -> importar deja los mismos perfiles, valores, fechas y claves desconocidas`, async () => {
      const read = await packageOf([ANA(), LUIS()], password);
      expect(read.encrypted).toBe(password !== undefined);
      expect(read.modules.map((m) => [m.name, m.declaredSchemaVersion, m.status])).toEqual([["client-profiles", 1, "ok"]]);
      expect(read.warnings).toEqual([]);
      const plan = planClientProfilesImport(read);
      expect(plan).toMatchObject({ state: "ok", counts: { new: 2, identical: 0, different: 0, invalid: 0 } });
      expect(plan.items.map((i) => [i.id, i.status, i.valueCount])).toEqual([["cp-luis", "new", 3], ["cp-ana", "new", 4]]);
      const result = await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan));
      expect(result).toEqual({ ok: true, written: 2, replaced: 0, keptBoth: 0, skipped: 0 });
      const back = listClientProfiles();
      expect(back.map((p) => p.id).sort()).toEqual(["cp-ana", "cp-luis"]);
      expect(back.find((p) => p.id === "cp-ana")).toEqual(ANA());
      expect(back.find((p) => p.id === "cp-ana")?.values.futureKey.value).toBe("dato de una version futura");
    });
  }

  it("importar otra vez lo mismo: todo «ya lo tienes», no escribe nada", async () => {
    const read = await packageOf();
    const first = planClientProfilesImport(read);
    await applyClientProfilesImport(first, defaultClientProfileDecisions(first));
    const raw = storedProfilesRaw();
    const setItem = vi.spyOn(window.localStorage, "setItem");
    const again = planClientProfilesImport(read);
    expect(again.counts).toEqual({ new: 0, identical: 2, different: 0, invalid: 0 });
    expect(Object.values(defaultClientProfileDecisions(again))).toEqual(["omit", "omit"]);
    expect(await applyClientProfilesImport(again, defaultClientProfileDecisions(again))).toEqual({ ok: true, written: 0, replaced: 0, keptBoth: 0, skipped: 2 });
    expect(setItem).not.toHaveBeenCalled();
    expect(storedProfilesRaw()).toBe(raw);
  });
});

describe("fusion con lo que ya hay", () => {
  async function differentLocal(local: ReturnType<typeof ANA>) {
    const read = await packageOf([ANA()]);
    seedProfiles([local]);
    return planClientProfilesImport(read);
  }

  it("distinto y el local mas ANTIGUO: por defecto se reemplaza", async () => {
    const plan = await differentLocal({ ...ANA(), updatedAt: "2026-09-01T10:00:00.000Z", values: { phone: { value: "555-9999", updatedAt: "2026-09-01T10:00:00.000Z", source: "typed" } } });
    expect(plan.items[0]).toMatchObject({ status: "different", conflictWith: { id: "cp-ana", newer: false } });
    expect(defaultClientProfileDecisions(plan)).toEqual({ "profile:cp-ana": "replace" });
    expect(await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan))).toMatchObject({ ok: true, written: 1, replaced: 1 });
    expect(listClientProfiles()[0].values.phone.value).toBe("555-0100");
  });

  it("distinto y el local mas NUEVO: por defecto se conservan ambos (jamas se pisa lo mas nuevo sin decidirlo)", async () => {
    const plan = await differentLocal({ ...ANA(), updatedAt: "2026-12-01T10:00:00.000Z", values: { phone: { value: "555-9999", updatedAt: "2026-12-01T10:00:00.000Z", source: "typed" } } });
    expect(plan.items[0].conflictWith?.newer).toBe(true);
    expect(defaultClientProfileDecisions(plan)).toEqual({ "profile:cp-ana": "keepBoth" });
    const result = await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan), { copySuffix: "(importado)" });
    expect(result).toMatchObject({ ok: true, written: 1, keptBoth: 1 });
    const names = listClientProfiles().map((p) => p.name).sort();
    expect(names).toEqual(["Pérez, Ana", "Pérez, Ana (importado)"]);
    const copy = listClientProfiles().find((p) => p.name.endsWith("(importado)"));
    expect(copy?.id).not.toBe("cp-ana");
    expect(listClientProfiles().find((p) => p.id === "cp-ana")?.values.phone.value).toBe("555-9999");
  });

  it("omitir no escribe nada; reemplazar/importar sobre el estado equivocado se ignora", async () => {
    const plan = await differentLocal({ ...ANA(), values: { phone: { value: "555-9999", updatedAt: KIT_AT, source: "typed" } } });
    const raw = storedProfilesRaw();
    expect(await applyClientProfilesImport(plan, { "profile:cp-ana": "omit" })).toEqual({ ok: true, written: 0, replaced: 0, keptBoth: 0, skipped: 1 });
    // «import» solo vale para lo nuevo: sobre un perfil distinto no hace nada.
    expect(await applyClientProfilesImport(plan, { "profile:cp-ana": "import" })).toMatchObject({ ok: true, written: 0 });
    expect(await applyClientProfilesImport(plan, {})).toMatchObject({ ok: true, written: 0 });
    expect(storedProfilesRaw()).toBe(raw);
  });
});

describe("limites", () => {
  it("hoy + los que ENTRAN (importar y conservar ambos) no pueden pasar de 20; reemplazar no suma", async () => {
    const read = await packageOf([ANA(), LUIS()]);
    seedProfiles(Array.from({ length: MAX_CLIENT_PROFILES - 1 }, (_, i) => kitProfile(`cp-local-${i}`, `Local ${i}`)));
    const plan = planClientProfilesImport(read);
    const decisions = defaultClientProfileDecisions(plan);
    expect(checkClientProfilesLimits(plan, decisions)).toEqual({ wanted: 2, total: MAX_CLIENT_PROFILES + 1, max: MAX_CLIENT_PROFILES, ok: false });
    const raw = storedProfilesRaw();
    expect(await applyClientProfilesImport(plan, decisions)).toMatchObject({ ok: false, reason: "limit", limits: { wanted: 2, total: MAX_CLIENT_PROFILES + 1, ok: false } });
    expect(storedProfilesRaw()).toBe(raw);
    // Omitiendo uno ya cabe.
    const one = { ...decisions, "profile:cp-luis": "omit" as const };
    expect(checkClientProfilesLimits(plan, one)).toMatchObject({ wanted: 1, total: MAX_CLIENT_PROFILES, ok: true });
    expect(await applyClientProfilesImport(plan, one)).toMatchObject({ ok: true, written: 1 });
    expect(listClientProfiles()).toHaveLength(MAX_CLIENT_PROFILES);
  });
});

describe("lee lo que hay AHORA, no lo que esta pestana recuerda", () => {
  it("si otra pestana escribio y el evento aun no llego, planificar y resumir ven lo nuevo", async () => {
    const read = await packageOf([ANA()]);
    seedProfiles([]);
    expect(listClientProfiles()).toEqual([]);
    // Otra pestana guarda el MISMO perfil: esta pestana todavia recuerda «nada» (sin evento `storage`).
    window.localStorage.setItem(CLIENT_PROFILES_STORAGE_KEY, JSON.stringify({ version: 1, profiles: [ANA()] }));
    expect(planClientProfilesImport(read).counts).toEqual({ new: 0, identical: 1, different: 0, invalid: 0 });
    __resetClientProfilesCacheForTests();
    window.localStorage.setItem(CLIENT_PROFILES_STORAGE_KEY, JSON.stringify({ version: 1, profiles: [ANA(), LUIS()] }));
    expect(listClientProfiles()).toHaveLength(2);
    window.localStorage.setItem(CLIENT_PROFILES_STORAGE_KEY, JSON.stringify({ version: 1, profiles: [ANA()] }));
    expect(summarizeClientProfiles()).toMatchObject({ ok: true, count: 1 });
  });
});

describe("limites con «Reemplazar»", () => {
  it("reemplazar un perfil que ya esta no ocupa un sitio mas: con 20 locales sigue cabiendo", async () => {
    const read = await packageOf([ANA()]);
    const locals = Array.from({ length: MAX_CLIENT_PROFILES - 1 }, (_, i) => kitProfile(`cp-local-${i}`, `Local ${i}`));
    seedProfiles([...locals, { ...ANA(), updatedAt: "2026-09-01T10:00:00.000Z", values: { phone: { value: "555-9999", updatedAt: "2026-09-01T10:00:00.000Z", source: "typed" } } }]);
    const plan = planClientProfilesImport(read);
    expect(plan.items[0].status).toBe("different");
    expect(plan.local.count).toBe(MAX_CLIENT_PROFILES);
    expect(checkClientProfilesLimits(plan, { "profile:cp-ana": "replace" })).toEqual({ wanted: 1, total: MAX_CLIENT_PROFILES, max: MAX_CLIENT_PROFILES, ok: true });
    expect(await applyClientProfilesImport(plan, { "profile:cp-ana": "replace" })).toMatchObject({ ok: true, written: 1, replaced: 1 });
    // «Conservar ambos» SI suma un sitio y ya no cabe.
    expect(checkClientProfilesLimits(plan, { "profile:cp-ana": "keepBoth" })).toMatchObject({ total: MAX_CLIENT_PROFILES + 1, ok: false });
  });
});

describe("cambios concurrentes y fallos de escritura", () => {
  it("si lo guardado cambio desde la vista previa (otra pestana), no se toca nada: changed", async () => {
    const plan = await planOf();
    seedProfiles([kitProfile("cp-otro", "Escrito en otra pestana")]);
    const raw = storedProfilesRaw();
    expect(await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan))).toEqual({ ok: false, reason: "changed" });
    expect(storedProfilesRaw()).toBe(raw);
  });

  it("el cambio justo ANTES de escribir tambien se detecta", async () => {
    const plan = await planOf();
    const result = await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan), {
      beforeWrite: () => window.localStorage.setItem(CLIENT_PROFILES_STORAGE_KEY, JSON.stringify({ version: 1, profiles: [] })),
    });
    expect(result).toEqual({ ok: false, reason: "changed" });
  });

  it("sin espacio: quota y lo anterior queda intacto", async () => {
    seedProfiles([kitProfile("cp-previo", "Previo")]);
    const base = await packageOf([ANA()]);
    seedProfiles([kitProfile("cp-previo", "Previo")]);
    const memory = new MemoryStorage();
    memory.setItem(CLIENT_PROFILES_STORAGE_KEY, storedProfilesRaw() as string);
    vi.stubGlobal("localStorage", memory);
    __resetClientProfilesCacheForTests();
    const plan = planClientProfilesImport(base);
    const raw = memory.getItem(CLIENT_PROFILES_STORAGE_KEY);
    memory.failOn = CLIENT_PROFILES_STORAGE_KEY;
    expect(await applyClientProfilesImport(plan, defaultClientProfileDecisions(plan))).toEqual({ ok: false, reason: "quota" });
    memory.failOn = null;
    expect(memory.getItem(CLIENT_PROFILES_STORAGE_KEY)).toBe(raw);
  });
});

describe("estados del modulo", () => {
  it("un paquete sin el modulo: absent", async () => {
    const blob = await buildPackage({ modules: [{ name: "settings", schemaVersion: 1, files: [{ path: "settings/settings.json", data: new TextEncoder().encode('{"settings":{}}'), type: "application/json" }] }] });
    expect(planClientProfilesImport(await readPackage(asFile(blob)))).toMatchObject({ state: "absent", items: [] });
  });

  it("esquema mas nuevo: newerVersion con el mensaje, sin items", async () => {
    seedProfiles([ANA()]);
    const blob = await buildPackage({ modules: [await exportClientProfiles()] });
    const newer = await editManifest(blob, (manifest) => {
      manifest.modules["client-profiles"].schemaVersion = 99;
    });
    const plan = planClientProfilesImport(await readPackage(asFile(newer)));
    expect(plan).toMatchObject({ state: "newerVersion", items: [] });
    expect(plan.message).toMatch(/versión más nueva/);
  });

  it("JSON roto o con otra forma: damaged", async () => {
    for (const text of ["{no json", "[]", JSON.stringify({ version: 2, profiles: [] }), JSON.stringify({ version: 1, profiles: "x" })]) {
      const blob = await buildPackage({ modules: [{ name: "client-profiles", schemaVersion: 1, files: [{ path: "client-profiles/profiles.json", data: new TextEncoder().encode(text), type: "application/json" }] }] });
      expect(planClientProfilesImport(await readPackage(asFile(blob))).state, text).toBe("damaged");
    }
  });

  it("planificar nunca escribe", async () => {
    const read = await packageOf();
    const setItem = vi.spyOn(window.localStorage, "setItem");
    planClientProfilesImport(read);
    expect(setItem).not.toHaveBeenCalled();
    expect(storedProfilesRaw()).toBeNull();
  });
});

describe("la interfaz no puede colar nada", () => {
  it("un plan manipulado (perfil con id malo, clave con forma invalida, plan de otro estado) se rechaza y no escribe", async () => {
    const plan = await planOf();
    const decisions = defaultClientProfileDecisions(plan);
    const tampered: ClientProfilesImportPlan = {
      ...plan,
      items: plan.items.map((item) => ({ ...item, payload: { ...item.payload, id: "id con espacios!" } })),
    };
    expect(await applyClientProfilesImport(tampered, decisions)).toEqual({ ok: false, reason: "invalid" });
    const sneaky: ClientProfilesImportPlan = {
      ...plan,
      items: plan.items.map((item) => ({ ...item, payload: { ...item.payload, values: { ...item.payload.values, "__proto__": { value: "x", updatedAt: KIT_AT, source: "typed" as const } } } })),
    };
    // Con una clave ajena el saneado la descarta y lo que se escribe es lo limpio.
    await applyClientProfilesImport(sneaky, decisions);
    expect(listClientProfiles().every((p) => !Object.prototype.hasOwnProperty.call(p.values, "__proto__"))).toBe(true);
    wipeProfiles();
    expect(await applyClientProfilesImport({ ...plan, state: "damaged" }, decisions)).toEqual({ ok: false, reason: "blocked" });
    expect(storedProfilesRaw()).toBeNull();
  });
});
