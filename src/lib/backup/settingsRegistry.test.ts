import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EDIT_PRIVACY_NOTICE_SEEN_KEY } from "@/app/edit-pdf/EditPrivacyNotice";
import { EDIT_PDF_FEATURE_FLAGS, EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY } from "@/app/edit-pdf/editFeatureFlags";
import { PRO_FEATURE_FLAGS, PRO_FEATURE_FLAGS_STORAGE_KEY } from "@/app/pdf-pro/proFeatureFlags";
import { PRO_LAYOUT_STORAGE_KEY } from "@/app/pdf-pro/shell/proLayout";
import {
  SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  SIGN_PDF_FEATURE_FLAGS_VERSION,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
  SIGN_TEMPLATE_FLAGS,
} from "@/app/sign-pdf/signFeatureFlags";
import { REMEMBERED_SIGNERS_KEY } from "@/app/sign-pdf/templatePrefs";
import { DEFAULT_LANGUAGE, LANGUAGES, LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { DEFAULT_THEME, THEME_CHOICES, THEME_STORAGE_KEY } from "@/lib/theme";
import {
  SETTINGS_KEYS,
  SETTINGS_NEVER_EXPORTED_KEYS,
  SETTINGS_REGISTRY,
  SETTINGS_WRITABLE_KEYS,
  settingDef,
  settingValuesEqual,
} from "@/lib/backup/settingsRegistry";

/**
 * La lista blanca de ajustes: cada clave con su validador, y las guardas contra el olvido (que sigue igual que su dueno y
 * que ninguna clave de `localStorage` de la app queda sin clasificar).
 */

const def = (key: string) => {
  const found = settingDef(key);
  if (!found) throw new Error(`falta ${key}`);
  return found;
};

describe("la lista blanca sigue siendo la de sus duenos", () => {
  it("claves, enumerados y valores por defecto de tema e idioma", () => {
    expect(def(THEME_STORAGE_KEY).defaultValue).toBe(DEFAULT_THEME);
    for (const theme of THEME_CHOICES) expect(def(THEME_STORAGE_KEY).validate(theme)).toBe(theme);
    expect(def(THEME_STORAGE_KEY).validate("sepia")).toBeUndefined();
    expect(def(LANGUAGE_STORAGE_KEY).defaultValue).toBe(DEFAULT_LANGUAGE);
    for (const language of LANGUAGES) expect(def(LANGUAGE_STORAGE_KEY).validate(language)).toBe(language);
    expect(def(LANGUAGE_STORAGE_KEY).validate("fr")).toBeUndefined();
    // un idioma o tema nuevo del dueno que no este en la lista falla aqui
    expect(THEME_CHOICES).toHaveLength(3);
    expect(LANGUAGES).toHaveLength(2);
  });

  it("los interruptores de Firmar (incluidos «aplicar plantillas» y «detectar campos») estan todos", () => {
    const flags = def(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY);
    const all = [...SIGN_PDF_FEATURE_FLAGS, ...SIGN_TEMPLATE_FLAGS];
    expect(all).toContain("autoApplyTemplates");
    expect(all).toContain("autoDetectFields");
    const value = Object.fromEntries(all.map((name) => [name, true]));
    expect(flags.validate(value)).toEqual(value);
    expect(Object.keys(flags.defaultValue as object).sort()).toEqual([...all].sort());
  });

  it("claves de editar, PDF Pro, diseno de Pro y sus interruptores", () => {
    expect(EDIT_PDF_FEATURE_FLAGS).toEqual(["editExistingText"]);
    expect(def(EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY).validate({ editExistingText: false })).toEqual({ editExistingText: false });
    expect(PRO_FEATURE_FLAGS).toEqual(["proAutosave"]);
    expect(def(PRO_FEATURE_FLAGS_STORAGE_KEY).validate({ proAutosave: false })).toEqual({ proAutosave: false });
    expect(PRO_LAYOUT_STORAGE_KEY).toBe("optimuspdf.pro.layout.v1");
    expect(def(PRO_LAYOUT_STORAGE_KEY).validate({ thumbsWidth: 176, contextWidth: 340, thumbsOpen: true, contextOpen: false })).toEqual({
      thumbsWidth: 176,
      contextWidth: 340,
      thumbsOpen: true,
      contextOpen: false,
    });
  });

  it("los avisos «ya visto» y la barra lateral usan las claves de sus duenos", () => {
    expect(def(EDIT_PRIVACY_NOTICE_SEEN_KEY).group).toBe("notices");
    const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
    expect(read("app/sign-pdf/PrivacyNotice.tsx")).toContain('const PRIVACY_NOTICE_SEEN_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen"');
    expect(def("optimuspdf.sign-pdf.privacyNoticeSeen").group).toBe("notices");
    expect(read("components/layout/Sidebar.tsx")).toContain('const SIDEBAR_STORAGE_KEY = "optimuspdf.sidebarCollapsed"');
    expect(def("optimuspdf.sidebarCollapsed").group).toBe("appearance");
    expect(def(REMEMBERED_SIGNERS_KEY).group).toBe("sign");
  });

  it("todo valor por defecto pasa su propio validador y se escribe con claves de la lista", () => {
    for (const entry of SETTINGS_REGISTRY) {
      const valid = entry.validate(entry.defaultValue);
      // «aviso visto = false» no existe como valor (la ausencia de la clave es «no visto»)
      if (entry.group === "notices") {
        expect(valid).toBeUndefined();
        continue;
      }
      expect(valid, entry.key).toBeDefined();
      for (const [key, text] of entry.toStorage(valid as never)) {
        expect(SETTINGS_WRITABLE_KEYS).toContain(key);
        expect(typeof text).toBe("string");
      }
    }
  });

  it("lo que se escribe se lee igual (toStorage -> fromStorage) para valores no por defecto", () => {
    const samples: Record<string, unknown> = {
      [THEME_STORAGE_KEY]: "dark",
      [LANGUAGE_STORAGE_KEY]: "en",
      "optimuspdf.sidebarCollapsed": true,
      [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY]: { completionCertificate: true, autoApplyTemplates: false },
      [REMEMBERED_SIGNERS_KEY]: 2,
      [EDIT_PDF_FEATURE_FLAGS_STORAGE_KEY]: { editExistingText: false },
      [PRO_FEATURE_FLAGS_STORAGE_KEY]: { proAutosave: false },
      [PRO_LAYOUT_STORAGE_KEY]: { thumbsWidth: 200, contextWidth: 400, thumbsOpen: false, contextOpen: true },
      "optimuspdf.sign-pdf.privacyNoticeSeen": true,
      [EDIT_PRIVACY_NOTICE_SEEN_KEY]: true,
    };
    expect(Object.keys(samples).sort()).toEqual([...SETTINGS_KEYS].sort());
    for (const entry of SETTINGS_REGISTRY) {
      const value = entry.validate(samples[entry.key]);
      expect(value, entry.key).toBeDefined();
      const pairs = entry.toStorage(value as never);
      const own = pairs.find(([key]) => key === entry.key)!;
      const back = entry.fromStorage(own[1]);
      expect(back, entry.key).toBeDefined();
      expect(settingValuesEqual(back as never, value as never)).toBe(true);
    }
  });

  it("los ajustes de Firmar escriben tambien la version, para que no se vuelva a apagar el registro de firmas", () => {
    const pairs = def(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY).toStorage({ completionCertificate: true });
    expect(pairs).toEqual([
      [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, '{"completionCertificate":true}'],
      [SIGN_PDF_FEATURE_FLAGS_VERSION_KEY, String(SIGN_PDF_FEATURE_FLAGS_VERSION)],
    ]);
    expect(SETTINGS_WRITABLE_KEYS).toContain(SIGN_PDF_FEATURE_FLAGS_VERSION_KEY);
    expect(SETTINGS_KEYS).not.toContain(SIGN_PDF_FEATURE_FLAGS_VERSION_KEY);
  });
});

describe("validadores: tipo, enumerado, rango y longitud", () => {
  const sign = () => def(SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY);
  it("un tipo cambiado invalida SOLO ese ajuste", () => {
    expect(sign().validate({ keyboardNav: "true" })).toBeUndefined();
    expect(sign().validate({ keyboardNav: 1 })).toBeUndefined();
    expect(sign().validate([true])).toBeUndefined();
    expect(sign().validate("keyboardNav")).toBeUndefined();
    expect(sign().validate(null)).toBeUndefined();
    expect(sign().validate({})).toBeUndefined();
  });
  it("nombres desconocidos se ignoran; los conocidos se conservan; `__proto__` no llega al valor", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"keyboardNav":false,"constructor":1,"evil":true}');
    const out = sign().validate(hostile) as Record<string, unknown>;
    expect(out).toEqual({ keyboardNav: false });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("un objeto con muchisimas claves se rechaza sin recorrerlo", () => {
    const big: Record<string, boolean> = {};
    for (let i = 0; i < 5000; i += 1) big[`k${i}`] = true;
    expect(sign().validate({ ...big, keyboardNav: true })).toBeUndefined();
  });
  it("el diseno de Pro exige enteros dentro de rango y los cuatro campos", () => {
    const layout = def(PRO_LAYOUT_STORAGE_KEY);
    const ok = { thumbsWidth: 176, contextWidth: 340, thumbsOpen: true, contextOpen: true };
    expect(layout.validate(ok)).toEqual(ok);
    expect(layout.validate({ ...ok, thumbsWidth: 1e9 })).toBeUndefined();
    expect(layout.validate({ ...ok, thumbsWidth: 100 })).toBeUndefined();
    expect(layout.validate({ ...ok, contextWidth: 340.5 })).toBeUndefined();
    expect(layout.validate({ ...ok, contextWidth: "340" })).toBeUndefined();
    expect(layout.validate({ ...ok, thumbsOpen: "si" })).toBeUndefined();
    expect(layout.validate({ thumbsWidth: 176 })).toBeUndefined();
    expect(layout.validate({ ...ok, thumbsWidth: Number.NaN })).toBeUndefined();
  });
  it("firmantes recordados: solo 1 o 2; sidebar solo booleano; avisos solo `true`", () => {
    expect(def(REMEMBERED_SIGNERS_KEY).validate(3)).toBeUndefined();
    expect(def(REMEMBERED_SIGNERS_KEY).validate("2")).toBeUndefined();
    expect(def("optimuspdf.sidebarCollapsed").validate("1")).toBeUndefined();
    expect(def("optimuspdf.sign-pdf.privacyNoticeSeen").validate(false)).toBeUndefined();
    expect(def("optimuspdf.sign-pdf.privacyNoticeSeen").validate("1")).toBeUndefined();
  });
  it("lo leido de localStorage tambien se valida y tiene tope de longitud", () => {
    expect(def(THEME_STORAGE_KEY).fromStorage("dark")).toBe("dark");
    expect(def(THEME_STORAGE_KEY).fromStorage("<script>")).toBeUndefined();
    expect(def(THEME_STORAGE_KEY).fromStorage(null)).toBeUndefined();
    expect(sign().fromStorage("{not json")).toBeUndefined();
    expect(sign().fromStorage(`{"keyboardNav":true,"pad":"${"x".repeat(5000)}"}`)).toBeUndefined();
    expect(def("optimuspdf.sidebarCollapsed").fromStorage("1")).toBe(true);
    expect(def("optimuspdf.sidebarCollapsed").fromStorage("0")).toBe(false);
    expect(def("optimuspdf.sidebarCollapsed").fromStorage("2")).toBeUndefined();
  });
  it("settingDef busca en un Map: `__proto__`, `constructor` y compania no existen", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "optimuspdf.lastBackup", "optimuspdf.recent"]) {
      expect(settingDef(name), name).toBeUndefined();
    }
  });
});

describe("ninguna clave de localStorage de la app queda sin clasificar", () => {
  it("cada `optimuspdf.*` de un archivo que usa localStorage esta en la lista blanca, en la de excluidas o es una senal/canal", () => {
    // Claves de archivos que usan `localStorage` pero NO son ajustes de este modulo (canales, senales, sessionStorage).
    const NOT_SETTINGS = new Set([
      "optimuspdf.sign-drafts", // nombre del BroadcastChannel / base de borradores
      "optimuspdf:sign-fill:declinedReuse", // sessionStorage
    ]);
    const known = new Set([...SETTINGS_WRITABLE_KEYS, ...SETTINGS_NEVER_EXPORTED_KEYS, ...NOT_SETTINGS]);
    const root = path.resolve(__dirname, "..", "..");
    const unknown: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules" && name !== "__fixtures__") walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name) || full.includes(`${path.sep}lib${path.sep}backup${path.sep}`)) continue;
        const text = readFileSync(full, "utf8");
        if (!text.includes("localStorage")) continue;
        for (const match of text.matchAll(/"(optimuspdf[.:][A-Za-z0-9._:-]*)"/g)) {
          const key = match[1];
          // senales entre pestanas: `<algo>.signal` (no son ajustes ni datos)
          if (!known.has(key) && !key.endsWith(".signal")) unknown.push(`${path.relative(root, full)}: ${key}`);
        }
      }
    };
    walk(root);
    expect(unknown).toEqual([]);
  });

  it("`optimuspdf.lastBackup` y el historial/recientes NUNCA estan en la lista de claves exportables", () => {
    for (const never of SETTINGS_NEVER_EXPORTED_KEYS) {
      expect(SETTINGS_KEYS, never).not.toContain(never);
      expect(SETTINGS_WRITABLE_KEYS, never).not.toContain(never);
    }
    expect(SETTINGS_NEVER_EXPORTED_KEYS).toContain("optimuspdf.lastBackup");
  });
});
