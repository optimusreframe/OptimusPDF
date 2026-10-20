import { beforeEach, describe, expect, it } from "vitest";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  applySettingsImport,
  checkValueHistory,
  defaultSettingsDecisions,
  exportSettings,
  planSettingsImport,
  settingsModuleFromValues,
  summarizeSettings,
  type SettingsImportPlan,
} from "@/lib/backup/modules/settings";
import { SETTINGS_WRITABLE_KEYS, settingDef, settingValuesEqual } from "@/lib/backup/settingsRegistry";
import { MemoryStorage } from "@/lib/backup/__fixtures__/memoryStorage";
import { asFile, editManifest, replaceFile, timed } from "@/lib/backup/__fixtures__/testKit";

/**
 * Modulo «Ajustes»: exportar solo la lista blanca, planificar y aplicar (Reemplazar / Omitir, atomico y revalidado),
 * y el historial de valores como archivo opcional aparte.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const USER_SETTINGS = {
  "optimuspdf.theme": "dark",
  "optimuspdf.language": "en",
  "optimuspdf.sidebarCollapsed": "1",
  "optimuspdf.signPdf.featureFlags": JSON.stringify({ completionCertificate: true, autoApplyTemplates: false, autoDetectFields: false, keyboardNav: true }),
  "optimuspdf.sign.templateSigners": "2",
  "optimuspdf.editPdf.featureFlags": JSON.stringify({ editExistingText: false }),
  "optimuspdf.pro.featureFlags": JSON.stringify({ proAutosave: false }),
  "optimuspdf.pro.layout.v1": JSON.stringify({ thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true }),
  "optimuspdf.sign-pdf.privacyNoticeSeen": "1",
  "optimuspdf.edit-pdf.privacyNoticeSeen": "1",
};

/** Claves que existen en localStorage pero NO viajan, mas basura que no es de la app. */
const FOREIGN = {
  "optimuspdf.lastBackup": "2026-10-01T00:00:00.000Z",
  "optimuspdf.recent": JSON.stringify([{ name: "contrato-secreto.pdf" }]),
  "optimuspdf.valueHistory": JSON.stringify({ version: 1, entries: { nombre: [{ value: "Maria Lopez", lastUsedAt: "2026-10-01T00:00:00.000Z" }] } }),
  "optimuspdf.signTemplates": "[]",
  "optimuspdf.pro.historyHotBytes": "123",
  "optimuspdf.sign-drafts.signal": "{}",
  "apiKey": "sk-live-secreto",
  "otra.app.token": "abc",
};

function fill(storage: MemoryStorage, values: Record<string, string>): MemoryStorage {
  for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
  storage.writes.length = 0;
  return storage;
}

async function packaged(storage: Storage, includeValueHistory = false, password?: string) {
  const mod = await exportSettings({ storage, includeValueHistory });
  const blob = await buildPackage({ modules: [mod], password });
  return { module: mod, blob, read: await readPackage(asFile(blob), password) };
}

function settingsJson(module: Awaited<ReturnType<typeof exportSettings>>): { settings: Record<string, unknown> } {
  return JSON.parse(dec.decode(module.files.find((f) => f.path === "settings/settings.json")!.data));
}

describe("exportar solo la lista blanca", () => {
  it("las claves ajenas, `lastBackup`, recientes, plantillas antiguas y el historial NO viajan", async () => {
    const storage = fill(new MemoryStorage(), { ...USER_SETTINGS, ...FOREIGN });
    const mod = await exportSettings({ storage });
    const body = JSON.stringify(settingsJson(mod));
    for (const key of Object.keys(FOREIGN)) expect(body, key).not.toContain(key);
    for (const secret of ["sk-live-secreto", "contrato-secreto", "Maria Lopez", "2026-10-01"]) expect(body, secret).not.toContain(secret);
    expect(Object.keys(settingsJson(mod).settings).sort()).toEqual(Object.keys(USER_SETTINGS).sort());
    expect(mod.files.map((f) => f.path)).toEqual(["settings/settings.json"]);
    expect(mod.meta).toEqual({ count: 10, includesValueHistory: false });
  });

  it("los valores van ya parseados y canonicos", async () => {
    const storage = fill(new MemoryStorage(), USER_SETTINGS);
    expect(settingsJson(await exportSettings({ storage })).settings).toEqual({
      "optimuspdf.theme": "dark",
      "optimuspdf.language": "en",
      "optimuspdf.sidebarCollapsed": true,
      "optimuspdf.signPdf.featureFlags": { completionCertificate: true, autoApplyTemplates: false, autoDetectFields: false, keyboardNav: true },
      "optimuspdf.sign.templateSigners": 2,
      "optimuspdf.editPdf.featureFlags": { editExistingText: false },
      "optimuspdf.pro.featureFlags": { proAutosave: false },
      "optimuspdf.pro.layout.v1": { thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true },
      "optimuspdf.sign-pdf.privacyNoticeSeen": true,
      "optimuspdf.edit-pdf.privacyNoticeSeen": true,
    });
  });

  it("un valor guardado que ya no es valido (tema roto, JSON roto, rango) no viaja", async () => {
    const storage = fill(new MemoryStorage(), {
      "optimuspdf.theme": "sepia",
      "optimuspdf.language": "es",
      "optimuspdf.signPdf.featureFlags": "{no es json",
      "optimuspdf.pro.layout.v1": JSON.stringify({ thumbsWidth: 9999, contextWidth: 340, thumbsOpen: true, contextOpen: true }),
    });
    expect(settingsJson(await exportSettings({ storage })).settings).toEqual({ "optimuspdf.language": "es" });
  });

  it("sin nada guardado, un modulo vacio pero valido; sin almacenamiento, `unavailable`", async () => {
    const mod = await exportSettings({ storage: new MemoryStorage() });
    expect(settingsJson(mod).settings).toEqual({});
    expect(mod.meta).toEqual({ count: 0, includesValueHistory: false });
    await expect(exportSettings()).rejects.toMatchObject({ code: "unavailable" });
    expect(summarizeSettings()).toMatchObject({ ok: false });
  });

  it("`value-history.json` solo con includeValueHistory (desmarcado por defecto) y solo si hay historial", async () => {
    const storage = fill(new MemoryStorage(), { ...USER_SETTINGS, ...FOREIGN });
    expect((await exportSettings({ storage })).files).toHaveLength(1);
    const withHistory = await exportSettings({ storage, includeValueHistory: true });
    expect(withHistory.files.map((f) => f.path)).toEqual(["settings/settings.json", "settings/value-history.json"]);
    expect(withHistory.meta).toMatchObject({ includesValueHistory: true });
    expect(JSON.parse(dec.decode(withHistory.files[1].data))).toEqual({
      version: 1,
      entries: { nombre: [{ value: "Maria Lopez", lastUsedAt: "2026-10-01T00:00:00.000Z" }] },
    });
    const empty = await exportSettings({ storage: fill(new MemoryStorage(), USER_SETTINGS), includeValueHistory: true });
    expect(empty.files).toHaveLength(1);
    expect(empty.meta).toMatchObject({ includesValueHistory: false });
  });

  it("summarizeSettings cuenta claves y etiquetas del historial sin mostrar contenido", () => {
    const storage = fill(new MemoryStorage(), { ...USER_SETTINGS, ...FOREIGN });
    expect(summarizeSettings({ storage })).toEqual({ ok: true, keys: 10, valueHistoryLabels: 1, valueHistoryValues: 1 });
  });
});

describe("planificar", () => {
  it("en un navegador vacio todo es «Nuevo»; con lo mismo, «idéntico»; con otro valor, «distinto»", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    const empty = planSettingsImport(read, { storage: new MemoryStorage() });
    expect(empty.state).toBe("ok");
    expect(empty.counts).toEqual({ new: 10, identical: 0, different: 0, invalid: 0 });
    expect(defaultSettingsDecisions(empty)).toEqual({ settings: "replace", valueHistory: "omit" });

    const same = planSettingsImport(read, { storage: fill(new MemoryStorage(), USER_SETTINGS) });
    expect(same.counts).toEqual({ new: 0, identical: 10, different: 0, invalid: 0 });
    expect(defaultSettingsDecisions(same).settings).toBe("omit");

    const other = planSettingsImport(read, { storage: fill(new MemoryStorage(), { ...USER_SETTINGS, "optimuspdf.theme": "light", "optimuspdf.language": "es" }) });
    expect(other.counts).toMatchObject({ different: 2, identical: 8 });
    expect(other.items.find((i) => i.key === "optimuspdf.theme")).toMatchObject({ status: "different", value: "dark", local: "light" });
  });

  it("la misma clave con el objeto en otro orden es «idéntico»", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    const reordered = { ...USER_SETTINGS, "optimuspdf.signPdf.featureFlags": JSON.stringify({ keyboardNav: true, autoDetectFields: false, autoApplyTemplates: false, completionCertificate: true }) };
    expect(planSettingsImport(read, { storage: fill(new MemoryStorage(), reordered) }).counts.identical).toBe(10);
  });

  it("modulo ausente / de version mas nueva / ilegible", async () => {
    const { blob, read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    expect(planSettingsImport({ ...read, modules: [] }).state).toBe("absent");
    const newer = await readPackage(asFile(await editManifest(blob, (m) => (m.modules.settings.schemaVersion = 9))));
    expect(planSettingsImport(newer)).toMatchObject({ state: "newerVersion", message: expect.stringContaining("versión más nueva") });
    const broken = await readPackage(asFile(await replaceFile(blob, "settings/settings.json", enc.encode("{no es json"))));
    expect(planSettingsImport(broken).state).toBe("damaged");
    const noFile = await readPackage(asFile(await replaceFile(blob, "settings/settings.json", enc.encode("[]"))));
    expect(planSettingsImport(noFile).state).toBe("damaged");
  });
});

describe("aplicar: Reemplazar / Omitir", () => {
  it("ida y vuelta: exportar de un navegador, importar en otro vacio deja los mismos ajustes (y la version de los de Firmar)", async () => {
    const source = fill(new MemoryStorage(), { ...USER_SETTINGS, ...FOREIGN });
    const { read } = await packaged(source);
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    const result = await applySettingsImport(plan, defaultSettingsDecisions(plan), { storage: target });
    expect(result).toEqual({ ok: true, written: 10, skipped: 0, valueHistory: false, reloadRequired: true });
    const written = target.snapshot();
    for (const [key, value] of Object.entries(USER_SETTINGS)) {
      const entry = settingDef(key)!;
      const back = entry.fromStorage(written[key]);
      expect(back, key).toBeDefined();
      expect(settingValuesEqual(back as never, entry.fromStorage(value) as never), key).toBe(true);
    }
    expect(written["optimuspdf.signPdf.featureFlags.v"]).toBe("2");
    // nada fuera de la lista blanca (ni la fecha del ultimo respaldo, ni lo ajeno)
    expect(target.keys().every((key) => SETTINGS_WRITABLE_KEYS.includes(key))).toBe(true);
    expect(target.keys()).not.toContain("optimuspdf.lastBackup");
    expect(target.keys()).not.toContain("apiKey");
  });

  it("Omitir no escribe nada; un paquete idéntico tampoco", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    expect(await applySettingsImport(plan, { settings: "omit" }, { storage: target })).toEqual({ ok: true, written: 0, skipped: 10, valueHistory: false, reloadRequired: false });
    expect(target.writes).toEqual([]);
    const same = fill(new MemoryStorage(), USER_SETTINGS);
    const samePlan = planSettingsImport(read, { storage: same });
    expect(await applySettingsImport(samePlan, { settings: "replace" }, { storage: same })).toMatchObject({ ok: true, written: 0, skipped: 10 });
    expect(same.writes).toEqual([]);
  });

  it("Reemplazar solo toca lo nuevo o distinto y no borra lo que el paquete no trae", async () => {
    const source = fill(new MemoryStorage(), { "optimuspdf.theme": "dark", "optimuspdf.language": "en" });
    const { read } = await packaged(source);
    const target = fill(new MemoryStorage(), { "optimuspdf.theme": "light", "optimuspdf.language": "en", "optimuspdf.sidebarCollapsed": "1", apiKey: "x" });
    const plan = planSettingsImport(read, { storage: target });
    const result = await applySettingsImport(plan, { settings: "replace" }, { storage: target });
    expect(result).toMatchObject({ ok: true, written: 1, skipped: 1 });
    expect(target.snapshot()).toEqual({ "optimuspdf.theme": "dark", "optimuspdf.language": "en", "optimuspdf.sidebarCollapsed": "1", apiKey: "x" });
    expect(target.writes).toEqual(["optimuspdf.theme"]);
  });

  it("si el almacenamiento cambio desde la vista previa, `changed` y no se escribe nada", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    target.setItem("optimuspdf.theme", "light"); // otra pestana
    target.writes.length = 0;
    expect(await applySettingsImport(plan, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "changed" });
    expect(target.writes).toEqual([]);
  });

  it("ante un fallo de cuota a mitad, se restauran los valores anteriores (atomico en efecto)", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    const target = fill(new MemoryStorage(), { "optimuspdf.theme": "light", "optimuspdf.language": "es" });
    const plan = planSettingsImport(read, { storage: target });
    target.failOn = "optimuspdf.pro.layout.v1";
    const before = target.snapshot();
    expect(await applySettingsImport(plan, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "unavailable" });
    expect(target.snapshot()).toEqual(before);
  });

  it("no hay almacenamiento: `unavailable`; plan bloqueado: `blocked`", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    const plan = planSettingsImport(read, { storage: new MemoryStorage() });
    expect(await applySettingsImport(plan, { settings: "replace" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await applySettingsImport({ ...plan, state: "damaged" }, { settings: "replace" }, { storage: new MemoryStorage() })).toEqual({ ok: false, reason: "blocked" });
  });

  it("un plan manipulado por la interfaz (clave ajena o valor invalido) se rechaza al aplicar", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS));
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    const withForeign: SettingsImportPlan = {
      ...plan,
      items: [...plan.items, { key: "apiKey", group: "sign", status: "new", value: "sk-live", localRaw: null }],
    };
    expect(await applySettingsImport(withForeign, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "invalid" });
    const withProto: SettingsImportPlan = { ...plan, items: [{ key: "__proto__", group: "sign", status: "new", value: "x", localRaw: null }] };
    expect(await applySettingsImport(withProto, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "invalid" });
    const badValue: SettingsImportPlan = { ...plan, items: plan.items.map((i) => (i.key === "optimuspdf.theme" ? { ...i, value: "sepia" } : i)) };
    expect(await applySettingsImport(badValue, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "invalid" });
    const duplicated: SettingsImportPlan = { ...plan, items: [plan.items[0], plan.items[0]] };
    expect(await applySettingsImport(duplicated, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "invalid" });
    expect(target.writes).toEqual([]);
  });

  it("un paquete cifrado con contrasena llega igual", async () => {
    const { read } = await packaged(fill(new MemoryStorage(), USER_SETTINGS), false, "clave-segura-1");
    expect(read.encrypted).toBe(true);
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    expect(await applySettingsImport(plan, defaultSettingsDecisions(plan), { storage: target })).toMatchObject({ ok: true, written: 10 });
  });
});

describe("zips y ajustes hostiles: no escriben nada y no cuelgan", () => {
  async function hostile(json: string | Uint8Array, extra?: (blob: Blob) => Promise<Blob>) {
    const base = await buildPackage({ modules: [settingsModuleFromValues({ "optimuspdf.theme": "dark" })] });
    const blob = await replaceFile(base, "settings/settings.json", typeof json === "string" ? enc.encode(json) : json);
    return readPackage(asFile(extra ? await extra(blob) : blob));
  }

  it("claves ajenas, `__proto__` y `constructor`: solo se cuentan y no se escribe ninguna", async () => {
    const read = await hostile('{"settings":{"apiKey":"sk-live","__proto__":{"polluted":true},"constructor":"x","optimuspdf.lastBackup":"2026-01-01","optimuspdf.recent":"[]","optimuspdf.theme":"light"}}');
    const target = new MemoryStorage();
    const plan = await timed(async () => planSettingsImport(read, { storage: target }));
    expect(plan.ignoredKeys).toBe(5);
    expect(plan.items.map((i) => i.key)).toEqual(["optimuspdf.theme"]);
    await applySettingsImport(plan, { settings: "replace" }, { storage: target });
    expect(target.snapshot()).toEqual({ "optimuspdf.theme": "light" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("tipos cambiados y valores fuera de lista: cada ajuste invalido se aisla; el valido se importa", async () => {
    const read = await hostile(
      JSON.stringify({
        settings: {
          "optimuspdf.theme": { x: 1 },
          "optimuspdf.language": ["es"],
          "optimuspdf.sidebarCollapsed": "1",
          "optimuspdf.signPdf.featureFlags": { keyboardNav: "si" },
          "optimuspdf.sign.templateSigners": 99,
          "optimuspdf.editPdf.featureFlags": { editExistingText: false },
          "optimuspdf.pro.layout.v1": { thumbsWidth: 1e12, contextWidth: 1, thumbsOpen: 0, contextOpen: null },
          "optimuspdf.sign-pdf.privacyNoticeSeen": false,
        },
      }),
    );
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    expect(plan.counts).toEqual({ new: 1, identical: 0, different: 0, invalid: 7 });
    expect(plan.items.filter((i) => i.status === "invalid").every((i) => i.reason === "invalidValue")).toBe(true);
    await applySettingsImport(plan, { settings: "replace" }, { storage: target });
    expect(target.snapshot()).toEqual({ "optimuspdf.editPdf.featureFlags": '{"editExistingText":false}' });
  });

  it("cadenas enormes: ningun valor largo llega a localStorage", async () => {
    const huge = "x".repeat(15_000);
    const read = await hostile(JSON.stringify({ settings: { "optimuspdf.theme": huge, "optimuspdf.language": huge, "optimuspdf.signPdf.featureFlags": { keyboardNav: true, [huge]: true } } }));
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    expect(plan.items.filter((i) => i.status === "invalid")).toHaveLength(2);
    await applySettingsImport(plan, { settings: "replace" }, { storage: target });
    expect(Object.values(target.snapshot()).every((value) => value.length < 200)).toBe(true);
  });

  it("settings.json de mas de 64 KiB: modulo dañado y sin trabajo de mas", async () => {
    const read = await hostile(`{"settings":{"optimuspdf.theme":"dark"},"pad":"${"x".repeat(70_000)}"}`);
    expect(await timed(async () => planSettingsImport(read))).toMatchObject({ state: "damaged", items: [] });
  });

  it("JSON anidado a 10 000 niveles o con 100 000 claves: dañado en < 2 s, sin desbordar la pila", async () => {
    const deep = `{"settings":${"[".repeat(10_000)}${"]".repeat(10_000)}}`;
    expect((await timed(async () => planSettingsImport(await hostile(deep)))).state).toBe("damaged");
    const wide = `{"settings":{${Array.from({ length: 3000 }, (_, i) => `"k${i}":${i}`).join(",")},"optimuspdf.theme":"dark"}}`;
    const plan = await timed(async () => planSettingsImport(await hostile(wide)));
    expect(plan.ignoredKeys).toBe(3000);
    expect(plan.items).toHaveLength(1);
  });

  it("el cuerpo no es un objeto / UTF-8 roto / BOM: dañado", async () => {
    for (const body of ["null", "[]", '"hola"', "42", '{"settings":[1,2]}', '{"settings":"x"}']) {
      expect(planSettingsImport(await hostile(body)).state, body).toBe("damaged");
    }
    expect(planSettingsImport(await hostile(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))).state).toBe("damaged");
    expect(planSettingsImport(await hostile(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("{}")]))).state).toBe("damaged");
  });

  it("settings.json con SHA que no coincide: el modulo queda dañado (no se interpreta)", async () => {
    const base = await buildPackage({ modules: [settingsModuleFromValues({ "optimuspdf.theme": "dark" })] });
    const tampered = await editManifest(base, (m) => {
      m.files[0].sha256 = "0".repeat(64);
    });
    expect(planSettingsImport(await readPackage(asFile(tampered))).state).toBe("damaged");
  });

  it("archivos desconocidos dentro de settings/ se ignoran con aviso y no se leen", async () => {
    const base = await buildPackage({ modules: [settingsModuleFromValues({ "optimuspdf.theme": "dark" })] });
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await base.arrayBuffer());
    zip.file("settings/otro.json", '{"optimuspdf.theme":"light"}');
    const read = await readPackage(asFile(await zip.generateAsync({ type: "blob" })));
    expect(read.warnings.some((w) => w.path === "settings/otro.json")).toBe(true);
    expect(planSettingsImport(read).items[0]).toMatchObject({ key: "optimuspdf.theme", value: "dark" });
  });
});

describe("historial de valores (opcional)", () => {
  const history = (entries: Record<string, unknown>) => JSON.stringify({ version: 1, entries });
  const iso = "2026-10-01T10:00:00.000Z";

  async function withHistory(entries: unknown) {
    const base = await buildPackage({
      modules: [
        settingsModuleFromValues(
          { "optimuspdf.theme": "dark" },
          { nombre: [{ value: "Maria Lopez", lastUsedAt: iso }] },
        ),
      ],
    });
    const blob = await replaceFile(base, "settings/value-history.json", enc.encode(typeof entries === "string" ? entries : JSON.stringify(entries)));
    return readPackage(asFile(blob));
  }

  it("por defecto se OMITE (aunque el paquete lo traiga); con `replace` se escribe con el formato del almacen", async () => {
    const source = fill(new MemoryStorage(), { ...USER_SETTINGS, ...FOREIGN });
    const { read } = await packaged(source, true);
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    expect(plan.valueHistory).toMatchObject({ status: "new", labels: 1, values: 1, dropped: 0 });
    expect(defaultSettingsDecisions(plan).valueHistory).toBe("omit");
    await applySettingsImport(plan, defaultSettingsDecisions(plan), { storage: target });
    expect(target.keys()).not.toContain("optimuspdf.valueHistory");
    const result = await applySettingsImport(plan, { settings: "omit", valueHistory: "replace" }, { storage: target });
    expect(result).toMatchObject({ ok: true, written: 0, valueHistory: true, reloadRequired: true });
    expect(JSON.parse(target.getItem("optimuspdf.valueHistory") as string)).toEqual({
      version: 1,
      entries: { nombre: [{ value: "Maria Lopez", lastUsedAt: "2026-10-01T00:00:00.000Z" }] },
    });
  });

  it("estados: idéntico / distinto frente al historial local; `changed` si cambio", async () => {
    const source = fill(new MemoryStorage(), { ...FOREIGN });
    const { read } = await packaged(source, true);
    expect(planSettingsImport(read, { storage: fill(new MemoryStorage(), FOREIGN) }).valueHistory.status).toBe("identical");
    const different = fill(new MemoryStorage(), { "optimuspdf.valueHistory": history({ otra: [{ value: "Otro", lastUsedAt: iso }] }) });
    const plan = planSettingsImport(read, { storage: different });
    expect(plan.valueHistory.status).toBe("different");
    different.setItem("optimuspdf.valueHistory", history({ otra: [{ value: "Cambiado", lastUsedAt: iso }] }));
    expect(await applySettingsImport(plan, { settings: "omit", valueHistory: "replace" }, { storage: different })).toEqual({ ok: false, reason: "changed" });
  });

  it("hostil: etiquetas `__proto__`/`constructor`, controles, valores enormes o de 1 caracter se descartan", async () => {
    const proto = JSON.parse(`{"__proto__":[{"value":"pwn","lastUsedAt":"${iso}"}],"constructor":[{"value":"pwn2","lastUsedAt":"${iso}"}],"bueno":[{"value":"ok ok","lastUsedAt":"${iso}"},{"value":"x","lastUsedAt":"${iso}"},{"value":"${"y".repeat(900)}","lastUsedAt":"${iso}"},{"value":"fecha mala","lastUsedAt":"ayer"},{"value":"con\\u0007control\\u202e","lastUsedAt":"${iso}"}]}`);
    const checked = checkValueHistory({ version: 1, entries: proto });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(Object.keys(checked.entries)).toEqual(["bueno"]);
    expect(checked.entries.bueno.map((e) => e.value)).toEqual(["ok ok", "con control"]);
    expect(checked.dropped).toBeGreaterThanOrEqual(5);
    const read = await withHistory(history(proto));
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    await applySettingsImport(plan, { settings: "omit", valueHistory: "replace" }, { storage: target });
    const stored = JSON.parse(target.getItem("optimuspdf.valueHistory") as string);
    expect(Object.keys(stored.entries)).toEqual(["bueno"]);
    expect(Object.getPrototypeOf(stored.entries)).toBe(Object.prototype);
  });

  it("topes del almacen: > 200 etiquetas o > 5 valores por etiqueta invalida el archivo; version o forma distinta, tambien", async () => {
    const many = Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`e${i}`, [{ value: "valor", lastUsedAt: iso }]]));
    expect(checkValueHistory({ version: 1, entries: many })).toEqual({ ok: false });
    const crowded = { a: Array.from({ length: 6 }, (_, i) => ({ value: `valor ${i}`, lastUsedAt: iso })) };
    expect(checkValueHistory({ version: 1, entries: crowded })).toEqual({ ok: false });
    expect(checkValueHistory({ version: 2, entries: {} })).toEqual({ ok: false });
    expect(checkValueHistory({ version: 1, entries: [] })).toEqual({ ok: false });
    expect(checkValueHistory(null)).toEqual({ ok: false });
    expect((planSettingsImport(await withHistory(history(many))).valueHistory)).toMatchObject({ status: "invalid" });
    expect((planSettingsImport(await withHistory("{no json")).valueHistory)).toMatchObject({ status: "invalid" });
  });

  it("`replace` sobre un historial invalido o ausente no escribe nada", async () => {
    const read = await withHistory("{no json");
    const target = new MemoryStorage();
    const plan = planSettingsImport(read, { storage: target });
    expect(await applySettingsImport(plan, { settings: "omit", valueHistory: "replace" }, { storage: target })).toMatchObject({ ok: true, written: 0, valueHistory: false });
    expect(target.writes).toEqual([]);
  });

  beforeEach(() => {
    // ningun estado compartido entre pruebas: cada una crea sus almacenes
  });
});
