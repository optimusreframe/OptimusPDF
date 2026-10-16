import "fake-indexeddb/auto";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { encryptWithPassword } from "@/lib/crypto/passwordBox";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { DEFAULT_MODULE_REGISTRY } from "@/lib/backup/registry";
import { forgeZip, type ForgeEntry } from "@/lib/backup/__fixtures__/zipForge";
import { editManifest, rewriteZip, timed } from "@/lib/backup/__fixtures__/testKit";
import type { ModuleRegistry, PackageErrorCode } from "@/lib/backup/types";

/**
 * Contenedor del respaldo (`package.ts`): ida y vuelta y, sobre todo, el
 * corpus de zips HOSTILES. Cada uno se arma a mano (JSZip no escribe
 * directorios centrales que mientan) y tiene que rechazarse o aislarse en
 * menos de 2 s, sin colgar y sin tocar ningun almacen.
 */

const REGISTRY: ModuleRegistry = {
  ...DEFAULT_MODULE_REGISTRY,
  demo: {
    name: "demo",
    schemaVersion: 2,
    folders: ["templates", "documents"],
    maxFileBytes: 5000,
    maxJsonBytes: 5000,
  },
};

/** `documents/*.bin` hasta 100 KB: para forjar entradas que mienten sin que el tope del modulo las descarte antes. */
function bigRegistry(): ModuleRegistry {
  return {
    ...REGISTRY,
    demo: { ...REGISTRY.demo, maxFileBytes: 100_000, maxJsonBytes: 100_000 },
  };
}

const enc = new TextEncoder();
const json = (value: unknown) => enc.encode(JSON.stringify(value));
const blobOf = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: "application/zip" });

async function demoPackage(password?: string): Promise<Blob> {
  return buildPackage({
    registry: REGISTRY,
    password,
    modules: [
      {
        name: "demo",
        schemaVersion: 2,
        meta: { count: 2 },
        files: [
          { path: "templates/a.json", data: json({ a: 1 }), type: "application/json" },
          { path: "documents/b.pdf", data: new Uint8Array([1, 2, 3]), type: "application/pdf" },
        ],
      },
    ],
  });
}

/**
 * Cuenta los bytes que JSZip llega a EMITIR al leer una entrada: prueba de
 * que la lectura se corta en el tamaño declarado y no infla de mas.
 */
function streamProbe() {
  const probe = new JSZip();
  probe.file("p", "x");
  const proto = Object.getPrototypeOf(probe.file("p")) as {
    internalStream: (this: unknown, type: string) => {
      on: (event: string, cb: (chunk: Uint8Array) => void) => unknown;
    };
  };
  const original = proto.internalStream;
  let emitted = 0;
  proto.internalStream = function (this: unknown, type: string) {
    const stream = original.call(this, type);
    const on = stream.on.bind(stream);
    stream.on = (event, cb) =>
      on(event, event === "data" ? (chunk) => { emitted += chunk.length; cb(chunk); } : cb);
    return stream;
  };
  return {
    emitted: () => emitted,
    restore: () => {
      proto.internalStream = original;
    },
  };
}

async function rejectionCode(run: () => Promise<unknown>): Promise<PackageErrorCode | "no-error"> {
  try {
    await run();
    return "no-error";
  } catch (error) {
    return (error as { code?: PackageErrorCode }).code ?? ("otro" as never);
  }
}

/** Zip FORJADO con un manifiesto razonable alrededor de `entries`. */
async function forgedPackage(
  entries: ForgeEntry[],
  manifestExtra: Record<string, unknown> = {},
  listed: { path: string; data: Uint8Array }[] = [],
): Promise<Uint8Array> {
  const manifest = {
    format: "optimuspdf.package",
    formatVersion: 1,
    createdAt: "2026-10-15T00:00:00.000Z",
    app: { version: "t", build: "t" },
    modules: { demo: { schemaVersion: 1 } },
    files: await Promise.all(
      listed.map(async (f) => ({
        path: f.path,
        sha256: await sha256Hex(f.data),
        bytes: f.data.length,
        type: "application/json",
      })),
    ),
    ...manifestExtra,
  };
  return forgeZip([{ name: "manifest.json", data: json(manifest) }, ...entries]);
}

describe("buildPackage / readPackage — ida y vuelta — src/lib/backup/package.ts", () => {
  it("escribe manifest.json con formato, version, modulos y files[] con sha256/bytes/type", async () => {
    const blob = await demoPackage();
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["documents/b.pdf", "manifest.json", "templates/a.json"]);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("text"));
    expect(manifest).toMatchObject({
      format: "optimuspdf.package",
      formatVersion: 1,
      modules: { demo: { schemaVersion: 2, count: 2 } },
    });
    expect(manifest.files).toEqual([
      {
        path: "templates/a.json",
        sha256: await sha256Hex(json({ a: 1 })),
        bytes: json({ a: 1 }).length,
        type: "application/json",
      },
      { path: "documents/b.pdf", sha256: await sha256Hex(new Uint8Array([1, 2, 3])), bytes: 3, type: "application/pdf" },
    ]);
    expect(typeof manifest.createdAt).toBe("string");
  });

  it("lee de vuelta lo escrito, con todos los archivos `ok`, y sin avisos", async () => {
    const read = await readPackage(await demoPackage(), undefined, { registry: REGISTRY });
    expect(read).toMatchObject({ formatVersion: 1, encrypted: false, warnings: [] });
    const [demo] = read.modules;
    expect(demo).toMatchObject({ name: "demo", declaredSchemaVersion: 2, status: "ok", meta: { count: 2 } });
    expect([...demo.files.values()].map((f) => [f.path, f.status])).toEqual([
      ["templates/a.json", "ok"],
      ["documents/b.pdf", "ok"],
    ]);
    expect(Array.from(demo.files.get("documents/b.pdf")!.bytes!)).toEqual([1, 2, 3]);
  });

  it("cifrado: ida y vuelta con contraseña; sin ella needsPassword; mala wrongPassword; el zip exterior solo trae envelope.json + payload.bin", async () => {
    const blob = await demoPackage("clave ñ");
    const outer = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(outer.files).sort()).toEqual(["envelope.json", "payload.bin"]);
    const header = JSON.parse(await outer.file("envelope.json")!.async("text"));
    expect(header).toMatchObject({
      version: 1,
      kind: "optimuspdf.package-encrypted",
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000 },
    });
    const ok = await readPackage(blob, "clave ñ", { registry: REGISTRY });
    expect(ok.encrypted).toBe(true);
    expect(ok.modules[0].files.size).toBe(2);
    expect(await rejectionCode(() => readPackage(blob, undefined, { registry: REGISTRY }))).toBe("needsPassword");
    expect(await rejectionCode(() => readPackage(blob, "", { registry: REGISTRY }))).toBe("needsPassword");
    expect(await rejectionCode(() => readPackage(blob, "mala", { registry: REGISTRY }))).toBe("wrongPassword");
  });

  it("buildPackage rechaza lo que no se puede empaquetar con `invalidModule`/`tooLarge` (nunca escribe lo que luego no se leeria)", async () => {
    const file = (path: string, data = new Uint8Array([1]), type = "application/json") => ({ path, data, type });
    const base = { name: "demo", schemaVersion: 2 };
    const cases: [string, Parameters<typeof buildPackage>[0], PackageErrorCode][] = [
      ["sin modulos", { registry: REGISTRY, modules: [] }, "invalidModule"],
      ["modulo desconocido", { registry: REGISTRY, modules: [{ name: "raro", schemaVersion: 1, files: [] }] }, "invalidModule"],
      ["nombre malo", { registry: REGISTRY, modules: [{ name: "../x", schemaVersion: 1, files: [] }] }, "invalidModule"],
      ["version mayor que la soportada", { registry: REGISTRY, modules: [{ ...base, schemaVersion: 3, files: [] }] }, "invalidModule"],
      ["version 0", { registry: REGISTRY, modules: [{ ...base, schemaVersion: 0, files: [] }] }, "invalidModule"],
      ["ruta con ..", { registry: REGISTRY, modules: [{ ...base, files: [file("templates/../x.json")] }] }, "invalidModule"],
      ["ruta absoluta", { registry: REGISTRY, modules: [{ ...base, files: [file("/templates/x.json")] }] }, "invalidModule"],
      ["carpeta ajena al modulo", { registry: REGISTRY, modules: [{ ...base, files: [file("signatures/x.json")] }] }, "invalidModule"],
      ["ruta anidada", { registry: REGISTRY, modules: [{ ...base, files: [file("templates/a/b.json")] }] }, "invalidModule"],
      ["ruta repetida (sin distinguir mayusculas)", { registry: REGISTRY, modules: [{ ...base, files: [file("templates/a.json"), file("templates/A.json")] }] }, "invalidModule"],
      ["modulo repetido", { registry: REGISTRY, modules: [{ ...base, files: [] }, { ...base, files: [] }] }, "invalidModule"],
      ["tipo MIME raro", { registry: REGISTRY, modules: [{ ...base, files: [file("templates/a.json", new Uint8Array([1]), "<script>")] }] }, "invalidModule"],
      ["datos que no son bytes", { registry: REGISTRY, modules: [{ ...base, files: [{ path: "templates/a.json", data: "texto" as never, type: "application/json" }] }] }, "invalidModule"],
      ["meta con objeto", { registry: REGISTRY, modules: [{ ...base, meta: { x: {} as never }, files: [] }] }, "invalidModule"],
      ["contraseña vacia", { registry: REGISTRY, password: "", modules: [{ ...base, files: [] }] }, "invalidModule"],
      ["json de mas del tope del modulo", { registry: REGISTRY, modules: [{ ...base, files: [file("templates/a.json", new Uint8Array(5001))] }] }, "tooLarge"],
      ["archivo de mas del tope del modulo", { registry: REGISTRY, modules: [{ ...base, files: [file("documents/a.pdf", new Uint8Array(5001), "application/pdf")] }] }, "tooLarge"],
    ];
    for (const [label, opts, code] of cases) {
      expect([label, await rejectionCode(() => buildPackage(opts))]).toEqual([label, code]);
    }
    // justo en el tope si cabe
    await expect(
      buildPackage({ registry: REGISTRY, modules: [{ ...base, files: [file("templates/a.json", new Uint8Array(5000))] }] }),
    ).resolves.toBeInstanceOf(Blob);
  });

  it("buildPackage sin crypto.subtle y con contraseña da `unavailable`; sin contraseña funciona", async () => {
    vi.stubGlobal("crypto", {});
    try {
      expect(
        await rejectionCode(() =>
          buildPackage({ registry: REGISTRY, password: "x", modules: [{ name: "demo", schemaVersion: 2, files: [] }] }),
        ),
      ).toBe("unavailable");
      // el SHA-256 sigue funcionando con el respaldo puro
      const blob = await demoPackage();
      expect((await readPackage(blob, undefined, { registry: REGISTRY })).modules[0].files.size).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("integridad y aislamiento de archivos sueltos", () => {
  it("un archivo cuyo SHA-256 no coincide queda `sha256Mismatch` (bytes anulados) y los demas siguen `ok`", async () => {
    const blob = await rewriteZip(await demoPackage(), (zip) => {
      zip.file("templates/a.json", json({ a: 2 })); // mismo tamaño, otro contenido
    });
    const read = await readPackage(blob, undefined, { registry: REGISTRY });
    const files = read.modules[0].files;
    expect(files.get("templates/a.json")).toMatchObject({ status: "sha256Mismatch", bytes: null });
    expect(files.get("documents/b.pdf")?.status).toBe("ok");
  });

  it("tamaño distinto al que declara el manifiesto -> `sizeMismatch`; archivo listado pero ausente -> `missing`", async () => {
    const blob = await rewriteZip(await demoPackage(), (zip) => {
      zip.file("templates/a.json", json({ a: 1, extra: "mas" }));
      zip.remove("documents/b.pdf");
    });
    const files = (await readPackage(blob, undefined, { registry: REGISTRY })).modules[0].files;
    expect(files.get("templates/a.json")?.status).toBe("sizeMismatch");
    expect(files.get("documents/b.pdf")?.status).toBe("missing");
  });

  it("un archivo de mas del tope del modulo se marca `tooLarge` sin inflarlo", async () => {
    const big = new Uint8Array(6000).map((_, i) => (i * 31) & 0xff);
    const bytes = await forgedPackage(
      [{ name: "templates/big.json", data: big }],
      { modules: { demo: { schemaVersion: 1 } } },
      [{ path: "templates/big.json", data: big }],
    );
    const read = await readPackage(blobOf(bytes), undefined, { registry: REGISTRY });
    expect(read.modules[0].files.get("templates/big.json")).toMatchObject({ status: "tooLarge", bytes: null });
  });

  it("archivos sin listar en el manifiesto, carpetas desconocidas y modulos desconocidos: se IGNORAN con aviso", async () => {
    const a = json({ a: 1 });
    const bytes = await forgedPackage(
      [
        { name: "templates/a.json", data: a },
        { name: "templates/suelto.json", data: a },
        { name: "otra/x.json", data: a },
        { name: "__MACOSX/._a", data: a },
        { name: "carpeta/", data: new Uint8Array(), method: 0 },
      ],
      { modules: Object.defineProperty({ demo: { schemaVersion: 1 }, extranio: { schemaVersion: 7 } }, "__proto__", { value: { schemaVersion: 1 }, enumerable: true }) },
      [
        { path: "templates/a.json", data: a },
        { path: "otra/x.json", data: a },
      ],
    );
    const read = await readPackage(blobOf(bytes), undefined, { registry: REGISTRY });
    expect(read.modules.map((m) => m.name)).toEqual(["demo"]);
    expect(read.modules[0].files.get("templates/a.json")?.status).toBe("ok");
    expect(read.warnings).toEqual(
      expect.arrayContaining([
        { code: "unknownModule", module: "extranio" },
        { code: "unknownModule", module: "__proto__" },
        { code: "ignoredFile", path: "otra/x.json" },
        { code: "unlistedFile", path: "templates/suelto.json" },
        { code: "unlistedFile", path: "otra/x.json".replace("otra/x.json", "__MACOSX/._a") },
      ]),
    );
    expect(({} as Record<string, unknown>).schemaVersion).toBeUndefined();
  });

  it("D1: un modulo con nombre de propiedad de Object.prototype (`constructor`, `toString`, `hasOwnProperty`, `valueOf`...) es un modulo DESCONOCIDO con aviso: readPackage no lanza otra cosa que PackageError", async () => {
    const a = json({ a: 1 });
    const names = ["constructor", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString"];
    for (const name of names) {
      // las carpetas del zip son siempre en minusculas (`FILE_PATH`)
      const folder = name.toLowerCase();
      const bytes = await forgedPackage(
        [
          { name: "templates/a.json", data: a },
          { name: `${folder}/x.json`, data: a },
          // un archivo de la raiz del zip con ese nombre tampoco puede confundirse con una propiedad heredada
          { name, data: a },
        ],
        { modules: { demo: { schemaVersion: 1 }, [name]: { schemaVersion: 1 } } },
        [
          { path: "templates/a.json", data: a },
          { path: `${folder}/x.json`, data: a },
        ],
      );
      for (const registry of [REGISTRY, DEFAULT_MODULE_REGISTRY]) {
        const outcome = await readPackage(blobOf(bytes), undefined, { registry }).then(
          (read) => ({ read }),
          (error: unknown) => ({ error }),
        );
        expect([name, "error" in outcome ? String(outcome.error) : "sin error"]).toEqual([name, "sin error"]);
        const { read } = outcome as { read: Awaited<ReturnType<typeof readPackage>> };
        expect(read.modules.map((m) => m.name)).toEqual(registry === REGISTRY ? ["demo"] : []);
        expect(read.warnings).toEqual(
          expect.arrayContaining([
            { code: "unknownModule", module: name },
            { code: "ignoredFile", path: `${folder}/x.json` },
            { code: "unlistedFile", path: name },
          ]),
        );
      }
    }
    // `__proto__` como CLAVE PROPIA del JSON (JSON.parse la crea como propiedad normal)
    const proto = await forgedPackage([{ name: "templates/a.json", data: a }], {
      modules: Object.defineProperty({ demo: { schemaVersion: 1 } }, "__proto__", { value: { schemaVersion: 1 }, enumerable: true }),
    }, [{ path: "templates/a.json", data: a }]);
    const read = await readPackage(blobOf(proto), undefined, { registry: REGISTRY });
    expect(read.modules.map((m) => m.name)).toEqual(["demo"]);
    expect(read.warnings).toContainEqual({ code: "unknownModule", module: "__proto__" });
    // buildPackage tampoco confunde un nombre heredado con un modulo registrado
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      expect(
        await rejectionCode(() =>
          buildPackage({ registry: REGISTRY, modules: [{ name, schemaVersion: 1, files: [] }] }),
        ),
      ).toBe("invalidModule");
    }
  });

  it("un modulo de esquema mayor: `newerVersion` con mensaje y SIN leer sus archivos; el resto del paquete se importa", async () => {
    const blob = await editManifest(await demoPackage(), (m) => {
      m.modules.demo.schemaVersion = 3;
    });
    const read = await readPackage(blob, undefined, { registry: REGISTRY });
    expect(read.modules[0]).toMatchObject({
      status: "newerVersion",
      declaredSchemaVersion: 3,
      message: "Creado con una versión más nueva de OptimusPDF; actualiza la página.",
    });
    expect(read.modules[0].files.size).toBe(0);
    // el limite es `>`: la version igual a la soportada si se lee
    const same = await editManifest(await demoPackage(), (m) => {
      m.modules.demo.schemaVersion = 2;
    });
    expect((await readPackage(same, undefined, { registry: REGISTRY })).modules[0].status).toBe("ok");
  });
});

describe("manifiesto invalido o hostil", () => {
  async function withManifest(change: (m: Record<string, unknown>) => void): Promise<Blob> {
    return editManifest(await demoPackage(), (m) => change(m));
  }
  const rejects = async (blob: Blob) => rejectionCode(() => readPackage(blob, undefined, { registry: REGISTRY }));

  it("sin `files`, con `files` que no es lista o con elementos mal formados -> invalidManifest", async () => {
    expect(await rejects(await withManifest((m) => delete m.files))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.files = "x")))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.files = [null])))).toBe("invalidManifest");
    for (const bad of [
      { sha256: "zz" },
      { sha256: "A".repeat(64) },
      { bytes: -1 },
      { bytes: 1.5 },
      { bytes: "3" },
      { type: "<x>" },
      { type: 5 },
    ]) {
      const blob = await withManifest((m) => {
        (m.files as Record<string, unknown>[])[0] = { ...(m.files as Record<string, unknown>[])[0], ...bad };
      });
      expect([JSON.stringify(bad), await rejects(blob)]).toEqual([JSON.stringify(bad), "invalidManifest"]);
    }
  });

  it("format, formatVersion, createdAt y modules invalidos -> invalidManifest; contenedor MAS NUEVO -> newerFormat", async () => {
    expect(await rejects(await withManifest((m) => (m.format = "otra.cosa")))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => delete m.formatVersion))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.formatVersion = "1")))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.formatVersion = 0)))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.formatVersion = 1.5)))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.formatVersion = 2)))).toBe("newerFormat");
    expect(await rejects(await withManifest((m) => (m.createdAt = "ayer")))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.modules = []) ))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.modules = { demo: { schemaVersion: 0 } })))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.modules = { demo: { schemaVersion: "1" } })))).toBe("invalidManifest");
    expect(await rejects(await withManifest((m) => (m.modules = { demo: [] })))).toBe("invalidManifest");
  });

  it("rutas peligrosas o repetidas dentro de `files[]` -> unsafePath / duplicateEntry", async () => {
    for (const path of ["../x.json", "/etc/passwd", "templates/../../x", "templates\\x.json", "a.json", "templates/.hidden/../x"]) {
      const blob = await withManifest((m) => {
        (m.files as { path: string }[])[0].path = path;
      });
      expect([path, await rejects(blob)]).toEqual([path, "unsafePath"]);
    }
    const dup = await withManifest((m) => {
      (m.files as unknown[]).push({ ...(m.files as Record<string, unknown>[])[0], path: "templates/A.json" });
    });
    expect(await rejects(dup)).toBe("duplicateEntry");
  });

  it("manifest.json ausente, que no es JSON, demasiado profundo o demasiado grande", async () => {
    expect(await rejects(await rewriteZip(await demoPackage(), (z) => void z.remove("manifest.json")))).toBe("badZip");
    expect(await rejects(await rewriteZip(await demoPackage(), (z) => void z.file("manifest.json", "no json")))).toBe("invalidJson");
    expect(await rejects(await rewriteZip(await demoPackage(), (z) => void z.file("manifest.json", "[".repeat(50000) + "]".repeat(50000))))).toBe("invalidJson");
    expect(await rejects(await rewriteZip(await demoPackage(), (z) => void z.file("manifest.json", "\ufeff{}")))).toBe("invalidJson");
    // 17 niveles > 16
    const deep = "{\"a\":".repeat(17) + "1" + "}".repeat(17);
    expect(await rejects(await rewriteZip(await demoPackage(), (z) => void z.file("manifest.json", deep)))).toBe("invalidJson");
  });
});

describe("corpus de zips HOSTILES — se rechazan o se aislan, < 2 s, sin escribir nada", () => {
  const read = (bytes: Uint8Array, password?: string) => readPackage(blobOf(bytes), password, { registry: REGISTRY });
  const code = (bytes: Uint8Array, password?: string) => timed(() => rejectionCode(() => read(bytes, password)));

  it("no es un zip: vacio, texto, aleatorio, cortado, sin EOCD", async () => {
    expect(await code(new Uint8Array())).toBe("badZip");
    expect(await code(enc.encode("hola, esto no es un zip, pero es largo largo largo"))).toBe("badZip");
    const noise = new Uint8Array(5000).map((_, i) => (i * 131 + 7) & 0xff);
    expect(await code(noise)).toBe("badZip");
    const valid = new Uint8Array(await (await demoPackage()).arrayBuffer());
    expect(await code(valid.slice(0, Math.floor(valid.length / 2)))).toBe("badZip");
    expect(await code(valid.slice(0, valid.length - 1))).toBe("badZip");
  });

  it("zip-bomb por RATIO: 20 MB de ceros declarados contra ~20 KB comprimidos -> bomb, sin inflar", async () => {
    const zeros = new Uint8Array(20 * 1024 * 1024);
    const bytes = forgeZip([{ name: "manifest.json", data: zeros, crc: 0 }]);
    expect(bytes.length).toBeLessThan(100 * 1024);
    expect(await code(bytes)).toBe("bomb");
  });

  it("el ratio se mide con `>`: justo 100:1 por encima del suelo de 1 MiB pasa a la fase siguiente, 101:1 es bomb", async () => {
    const size = 2 * 1024 * 1024;
    const at100 = forgeZip([{ name: "x.bin", data: new Uint8Array(10), declaredUncompressed: size, declaredCompressed: Math.ceil(size / 100) }]);
    expect(await code(at100)).not.toBe("bomb");
    const over = forgeZip([{ name: "x.bin", data: new Uint8Array(10), declaredUncompressed: size, declaredCompressed: Math.floor(size / 101) }]);
    expect(await code(over)).toBe("bomb");
    // 100,5:1 ya es bomb (el tope es 100, no 101)
    const barely = forgeZip([{ name: "x.bin", data: new Uint8Array(10), declaredUncompressed: size, declaredCompressed: Math.floor(size / 100.5) }]);
    expect(await code(barely)).toBe("bomb");
  });

  it("el ratio se vigila POR ENTRADA aunque el conjunto parezca sano (una bomba escondida junto a un archivo grande poco comprimible)", async () => {
    const bomb = { name: "a.bin", data: new Uint8Array(10), declaredUncompressed: 2 * 1024 * 1024, declaredCompressed: 10_000 };
    const big = { name: "b.bin", data: new Uint8Array(10), method: 0 as const, declaredUncompressed: 3_000_000, declaredCompressed: 3_000_000 };
    // el total (~5 MB / ~3 MB) esta muy por debajo de 100:1: solo la entrada `a.bin` lo delata
    expect(await code(forgeZip([bomb, big]))).toBe("bomb");
    expect(await code(forgeZip([{ ...bomb, declaredCompressed: 30_000 }, big]))).not.toBe("bomb");
  });

  it("directorio central que declara > 250 MB descomprimidos (aunque cada entrada cumpla el ratio) -> tooLarge", async () => {
    const bytes = forgeZip([
      { name: "a.bin", data: new Uint8Array(4), declaredUncompressed: 140_000_000, declaredCompressed: 1_400_000 },
      { name: "b.bin", data: new Uint8Array(4), declaredUncompressed: 140_000_000, declaredCompressed: 1_400_000 },
    ]);
    expect(await code(bytes)).toBe("tooLarge");
    const justUnder = forgeZip([
      { name: "a.bin", data: new Uint8Array(4), declaredUncompressed: 130_000_000, declaredCompressed: 1_300_000 },
      { name: "b.bin", data: new Uint8Array(4), declaredUncompressed: 130_000_000, declaredCompressed: 1_300_000 },
    ]);
    expect(await code(justUnder)).not.toBe("tooLarge");
  });

  it("5 000 entradas -> tooManyEntries, rapido; 2 001 tambien; 2 000 pasa el limite", async () => {
    const make = (n: number) =>
      forgeZip(Array.from({ length: n }, (_, i) => ({ name: `templates/f${i}.json`, data: enc.encode("{}") })));
    expect(await code(make(5000))).toBe("tooManyEntries");
    expect(await code(make(2001))).toBe("tooManyEntries");
    expect(await code(make(2000))).not.toBe("tooManyEntries");
  });

  it("el EOCD que MIENTE sobre el numero de entradas no esquiva el limite", async () => {
    const bytes = forgeZip([{ name: "manifest.json", data: enc.encode("{}") }], { eocdEntries: 5000 });
    expect(await code(bytes)).toBe("tooManyEntries");
    const fewer = forgeZip(
      [{ name: "manifest.json", data: enc.encode("{}") }, { name: "a", data: enc.encode("{}") }],
      { eocdEntries: 1 },
    );
    // declara 1 de 2: JSZip ve 2 y no coincide con lo que leyo el directorio propio
    expect(await code(fewer)).toBe("badZip");
  });

  it("rutas con ../, absolutas, con barra invertida, unidad, segmentos vacios, controles o marcas bidi -> unsafePath", async () => {
    const hostile = [
      "../evil.png",
      "signatures/../../evil.png",
      "/etc/passwd",
      "\\windows\\x",
      "signatures\\..\\x",
      "C:/x.png",
      "c:x.png",
      "a//b.png",
      "./x.png",
      "signatures/./x.png",
      "x.png/..",
      "nul\u0000.png",
      "ctl\u0007.png",
      "del\u007f.png",
      "c1\u0085.png",
      "rlo\u202Egnp.exe",
      "lrm\u200e.png",
      "a".repeat(201),
    ];
    for (const name of hostile) {
      const bytes = forgeZip([{ name: "manifest.json", data: enc.encode("{}") }, { name, data: enc.encode("x") }]);
      expect([JSON.stringify(name).slice(0, 30), await code(bytes)]).toEqual([JSON.stringify(name).slice(0, 30), "unsafePath"]);
    }
  });

  it("nombres duplicados (exactos o solo por mayusculas) -> duplicateEntry", async () => {
    const dup = forgeZip([
      { name: "manifest.json", data: enc.encode("{}") },
      { name: "templates/a.json", data: enc.encode("{}") },
      { name: "templates/a.json", data: enc.encode("{\"x\":1}") },
    ]);
    expect(await code(dup)).toBe("duplicateEntry");
    const caseDup = forgeZip([
      { name: "manifest.json", data: enc.encode("{}") },
      { name: "templates/a.json", data: enc.encode("{}") },
      { name: "templates/A.JSON", data: enc.encode("{}") },
    ]);
    expect(await code(caseDup)).toBe("duplicateEntry");
  });

  it("directorio central MENTIROSO: declara 40 000 bytes pero la entrada infla 40 MB -> la lectura se corta en el primer trozo, se aisla y no se cuelga", async () => {
    const real = new Uint8Array(40 * 1000 * 1000);
    const liar = { name: "documents/a.bin", data: real, crc: 0, declaredUncompressed: 40_000 };
    const registry = bigRegistry();
    const bytes = await forgedPackage([liar], {}, []);
    const listed = await forgedPackage(
      [liar],
      { files: [{ path: "documents/a.bin", sha256: "0".repeat(64), bytes: 40_000, type: "application/octet-stream" }] },
      [],
    );
    const probe = streamProbe();
    let result;
    try {
      result = await timed(() => readPackage(blobOf(listed), undefined, { registry }));
    } finally {
      probe.restore();
    }
    // 1) como archivo listado: el elemento queda aislado, el resto se lee
    expect(result.modules[0].files.get("documents/a.bin")).toMatchObject({ status: "sizeMismatch", bytes: null });
    // la lectura se CORTO: se emitio un trozo (~16 MB), no los 40 MB
    expect(probe.emitted()).toBeLessThan(20_000_000);
    expect(probe.emitted()).toBeGreaterThan(0);
    // 2) sin listar: ni se lee
    expect((await timed(() => read(bytes))).warnings).toEqual([{ code: "unlistedFile", path: "documents/a.bin" }]);
  });

  it("MILES de entradas que mienten: el presupuesto global de bytes inflados corta el paquete entero (bomb) en < 2 s", async () => {
    const real = new Uint8Array(40 * 1000 * 1000);
    const { deflateRawSync } = await import("node:zlib");
    const rawPayload = new Uint8Array(deflateRawSync(real));
    const names = Array.from({ length: 60 }, (_, i) => `documents/x${i}.bin`);
    const bytes = await forgedPackage(
      names.map((name) => ({ name, data: real, rawPayload, crc: 0, declaredUncompressed: 40_000, declaredCompressed: rawPayload.length })),
      { files: names.map((path) => ({ path, sha256: "0".repeat(64), bytes: 40_000, type: "application/octet-stream" })) },
      [],
    );
    const probe = streamProbe();
    try {
      const started = performance.now();
      expect(await rejectionCode(() => readPackage(blobOf(bytes), undefined, { registry: bigRegistry() }))).toBe("bomb");
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      probe.restore();
    }
    // se paro con el presupuesto (250 MiB) + el rabo de un par de trozos, no tras las 60 entradas (~1 GB)
    expect(probe.emitted()).toBeLessThan(320_000_000);
    expect(probe.emitted()).toBeGreaterThan(200 * 1024 * 1024);
  });

  it("un comprimido MUY mayor de lo que declara descomprimir (directorio que miente al reves) -> bomb sin inflar", async () => {
    const real = new Uint8Array(30 * 1000 * 1000);
    const bytes = forgeZip([{ name: "manifest.json", data: real, crc: 0, declaredUncompressed: 1000 }]);
    const probe = streamProbe();
    try {
      expect(await code(bytes)).toBe("bomb");
    } finally {
      probe.restore();
    }
    expect(probe.emitted()).toBe(0);
  });

  it("directorio central mentiroso en el PROPIO manifest.json (infla de mas) -> el paquete se rechaza sin colgarse", async () => {
    const real = new Uint8Array(40 * 1000 * 1000);
    const bytes = forgeZip([{ name: "manifest.json", data: real, crc: 0, declaredUncompressed: 40_000 }]);
    const probe = streamProbe();
    try {
      expect(await code(bytes)).toBe("badZip");
    } finally {
      probe.restore();
    }
    expect(probe.emitted()).toBeLessThan(20_000_000);
  });

  it("directorio central que declara MAS de lo real -> el elemento se aisla (tamaño no coincide)", async () => {
    const a = enc.encode("{\"a\":1}");
    const bytes = await forgedPackage(
      [{ name: "templates/a.json", data: a, declaredUncompressed: a.length + 100 }],
      { files: [{ path: "templates/a.json", sha256: await sha256Hex(a), bytes: a.length + 100, type: "application/json" }] },
    );
    const result = await timed(() => read(bytes));
    expect(result.modules[0].files.get("templates/a.json")?.status).toBe("unreadable");
  });

  it("registros con cifrado de zip, metodo de compresion desconocido, sentinelas ZIP64 o carpetas con contenido -> badZip", async () => {
    const manifest = { name: "manifest.json", data: enc.encode("{}") };
    const variants: ForgeEntry[] = [
      { name: "x.bin", data: enc.encode("x"), flags: 0x801 },
      { name: "x.bin", data: enc.encode("x"), method: 9 as never },
      { name: "x.bin", data: enc.encode("x"), declaredUncompressed: 0xffffffff },
      { name: "x.bin", data: enc.encode("x"), declaredCompressed: 0xffffffff },
      { name: "d/", data: enc.encode("x"), method: 0, declaredCompressed: 1, declaredUncompressed: 1 },
    ];
    for (const entry of variants) {
      expect([entry.name, entry.flags, await code(forgeZip([manifest, entry]))]).toEqual([entry.name, entry.flags, "badZip"]);
    }
    // metodo 0 con tamaños distintos = bomba disfrazada
    expect(await code(forgeZip([manifest, { name: "x.bin", data: enc.encode("x"), method: 0, declaredUncompressed: 99 }]))).toBe("bomb");
    // deflate que declara datos con 0 bytes comprimidos
    expect(await code(forgeZip([manifest, { name: "x.bin", data: enc.encode("x"), declaredCompressed: 0, declaredUncompressed: 10 }]))).toBe("bomb");
  });

  it("offset del directorio central fuera del archivo, EOCD de varios discos o registros truncados -> badZip", async () => {
    const entries = [{ name: "manifest.json", data: enc.encode("{}") }];
    expect(await code(forgeZip(entries, { eocdCdOffset: 100000 }))).toBe("badZip");
    const valid = forgeZip(entries);
    const multi = valid.slice();
    new DataView(multi.buffer).setUint16(multi.length - 22 + 4, 1, true); // disco 1
    expect(await code(multi)).toBe("badZip");
    const badSig = valid.slice();
    const cdOffset = new DataView(badSig.buffer).getUint32(badSig.length - 22 + 16, true);
    badSig[cdOffset] ^= 0xff; // rompe la firma del primer registro central
    expect(await code(badSig)).toBe("badZip");
  });

  it("campo «Unicode path» que renombra una entrada a ../evil (JSZip lo aplica si no hay bandera UTF-8): el directorio propio no coincide -> badZip", async () => {
    const name = enc.encode("templates/a.json");
    const upath = enc.encode("../../evil.json");
    const extra = new Uint8Array(4 + 5 + upath.length);
    const view = new DataView(extra.buffer);
    view.setUint16(0, 0x7075, true);
    view.setUint16(2, 5 + upath.length, true);
    extra[4] = 1;
    // CRC del nombre original, como exige el campo para que se aplique
    const { crc32 } = await import("@/app/sign-pdf/signVault");
    view.setUint32(5, crc32(name), true);
    extra.set(upath, 9);
    const bytes = await forgedPackage([{ name: "templates/a.json", data: enc.encode("{}"), extra, flags: 0 }]);
    expect(await code(bytes)).toBe("badZip");
    // sin el campo extra, el mismo zip es aceptable (la unica diferencia es el renombrado)
    const clean = await forgedPackage([{ name: "templates/a.json", data: enc.encode("{}"), flags: 0 }]);
    expect(await timed(() => read(clean))).toMatchObject({ formatVersion: 1 });
  });

  it("archivo recibido de mas de 250 MB: se rechaza SIN leerlo", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const fake = { size: 250 * 1024 * 1024 + 1, arrayBuffer } as unknown as Blob;
    expect(await rejectionCode(() => readPackage(fake))).toBe("tooLarge");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(await rejectionCode(() => readPackage({} as Blob))).toBe("badZip");
    expect(await rejectionCode(() => readPackage(null as never))).toBe("badZip");
  });

  it("JSON enorme (manifest de > 1 MiB poco comprimible) -> tooLarge", async () => {
    let state = 1;
    const noise = new Uint8Array(1024 * 1024 + 100).map(() => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return 97 + (state % 26);
    });
    const bytes = forgeZip([{ name: "manifest.json", data: noise }]);
    expect(await code(bytes)).toBe("tooLarge");
  });

  it("JSON profundo (100 000 niveles) -> invalidJson sin construir nada", async () => {
    const deep = enc.encode("[".repeat(100_000) + "]".repeat(100_000));
    expect(await code(forgeZip([{ name: "manifest.json", data: deep }]))).toBe("invalidJson");
  });

  describe("paquete cifrado con envoltura danada", () => {
    async function outerParts(password = "pw") {
      const blob = await demoPackage(password);
      const zip = await JSZip.loadAsync(await blob.arrayBuffer());
      return {
        header: new Uint8Array(await zip.file("envelope.json")!.async("uint8array")),
        payload: new Uint8Array(await zip.file("payload.bin")!.async("uint8array")),
      };
    }
    const outerZip = (header: Uint8Array, payload: Uint8Array, extra: ForgeEntry[] = []) =>
      forgeZip([
        { name: "envelope.json", data: header, method: 0 },
        { name: "payload.bin", data: payload, method: 0 },
        ...extra,
      ]);

    it("envelope.json truncado o con JSON roto -> corrupt; sin derivar clave (rapido)", async () => {
      const { header, payload } = await outerParts();
      expect(await code(outerZip(header.slice(0, header.length - 30), payload), "pw")).toBe("corrupt");
      expect(await code(outerZip(enc.encode("{"), payload), "pw")).toBe("corrupt");
      expect(await code(outerZip(new Uint8Array(), payload), "pw")).toBe("corrupt");
    });

    it("payload.bin mas corto que la etiqueta GCM -> corrupt; truncado a medias -> wrongPassword (indistinguible a proposito)", async () => {
      const { header, payload } = await outerParts();
      expect(await code(outerZip(header, payload.slice(0, 10)), "pw")).toBe("corrupt");
      expect(await code(outerZip(header, payload.slice(0, 15)), "pw")).toBe("corrupt");
      expect(await code(outerZip(header, payload.slice(0, 16)), "pw")).toBe("wrongPassword");
      expect(await code(outerZip(header, payload.slice(0, Math.floor(payload.length / 2))), "pw")).toBe("wrongPassword");
      const flipped = payload.slice();
      flipped[Math.floor(flipped.length / 2)] ^= 1;
      expect(await code(outerZip(header, flipped), "pw")).toBe("wrongPassword");
    });

    it("parametros del KDF ajenos (iteraciones 2 000 000 000), `kind` distinto o version mayor: se rechazan SIN derivar la clave", async () => {
      const { header, payload } = await outerParts();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const edit = (change: (h: Record<string, any>) => void) => {
        const parsed = JSON.parse(new TextDecoder().decode(header));
        change(parsed);
        return json(parsed);
      };
      expect(await code(outerZip(edit((h) => (h.kdf.iterations = 2_000_000_000)), payload), "pw")).toBe("corrupt");
      expect(await code(outerZip(edit((h) => (h.kdf.hash = "SHA-1")), payload), "pw")).toBe("corrupt");
      expect(await code(outerZip(edit((h) => (h.kind = "signature-vault-encrypted")), payload), "pw")).toBe("corrupt");
      expect(await code(outerZip(edit((h) => (h.version = 2)), payload), "pw")).toBe("newerFormat");
      expect(await code(outerZip(edit((h) => (h.iv = "AAAA")), payload), "pw")).toBe("corrupt");
    });

    it("el envelope.json re-serializado (otros bytes = otro AAD) no descifra", async () => {
      const { header, payload } = await outerParts();
      const pretty = enc.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(header)), null, 2));
      expect(await code(outerZip(pretty, payload), "pw")).toBe("wrongPassword");
    });

    it("entradas de mas junto a la caja, o caja que falta una de sus dos piezas -> badZip", async () => {
      const { header, payload } = await outerParts();
      expect(await code(outerZip(header, payload, [{ name: "manifest.json", data: enc.encode("{}") }]), "pw")).toBe("badZip");
      expect(await code(forgeZip([{ name: "envelope.json", data: header, method: 0 }]), "pw")).toBe("badZip");
    });

    it("caja dentro de caja: el zip interior no puede ser otro paquete cifrado", async () => {
      const innerEncrypted = new Uint8Array(await (await demoPackage("otra")).arrayBuffer());
      const box = await encryptWithPassword(innerEncrypted, "pw", { kind: "optimuspdf.package-encrypted", version: 1 });
      expect(await code(outerZip(box.header, box.payload), "pw")).toBe("badZip");
    });

    it("el zip interior pasa las MISMAS validaciones (cifrado «legitimo» con contenido hostil)", async () => {
      const hostileInner = forgeZip([{ name: "manifest.json", data: enc.encode("{}") }, { name: "../evil", data: enc.encode("x") }]);
      const box = await encryptWithPassword(hostileInner, "pw", { kind: "optimuspdf.package-encrypted", version: 1 });
      expect(await code(outerZip(box.header, box.payload), "pw")).toBe("unsafePath");
      const noFiles = forgeZip([{ name: "manifest.json", data: json({ format: "optimuspdf.package", formatVersion: 1, createdAt: "2026-01-01T00:00:00Z", modules: {} }) }]);
      const box2 = await encryptWithPassword(noFiles, "pw", { kind: "optimuspdf.package-encrypted", version: 1 });
      expect(await code(outerZip(box2.header, box2.payload), "pw")).toBe("invalidManifest");
    });

    it("sin crypto.subtle un paquete cifrado da `unavailable` (antes de pedir contraseña)", async () => {
      const blob = await demoPackage("pw");
      const real = globalThis.crypto;
      vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
      try {
        expect(await rejectionCode(() => readPackage(blob, "pw", { registry: REGISTRY }))).toBe("unavailable");
        expect(await rejectionCode(() => readPackage(blob, undefined, { registry: REGISTRY }))).toBe("unavailable");
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  it("ningun zip hostil toca IndexedDB ni nada persistente", async () => {
    const open = vi.spyOn(indexedDB, "open");
    const zeros = new Uint8Array(20 * 1024 * 1024);
    const samples = [
      forgeZip([{ name: "manifest.json", data: zeros, crc: 0 }]),
      forgeZip([{ name: "../x", data: enc.encode("x") }]),
      forgeZip(Array.from({ length: 3000 }, (_, i) => ({ name: `a${i}`, data: enc.encode("x") }))),
    ];
    for (const sample of samples) {
      await rejectionCode(() => read(sample));
    }
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
