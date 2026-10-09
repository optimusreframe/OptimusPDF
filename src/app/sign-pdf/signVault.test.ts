import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_VAULT_ENTRIES,
  MAX_VAULT_IMAGE_BYTES,
  MAX_VAULT_TOTAL_BYTES,
  clearVault,
  dataUrlToVaultImage,
  deleteVaultEntry,
  getVaultEntry,
  listVault,
  normalizeSignerKey,
  readPngSize,
  saveVaultEntry,
  subscribeToVault,
  touchVaultEntry,
  updateVaultEntry,
  vaultImageToDataUrl,
  vaultSupported,
  type VaultEntryInput,
  type VaultImage,
} from "@/app/sign-pdf/signVault";

/**
 * `fake-indexeddb/auto` instala un `indexedDB` global real (mismo motor
 * que un navegador, sin mocks a mano): unico modo honesto de probar
 * transacciones, indices y `onupgradeneeded`. Las rutas "sin IndexedDB" se
 * simulan quitando o rompiendo el global.
 */

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_END = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/**
 * PNG minimo con IHDR correcto. `pad` rellena entre el IHDR y el IEND hasta
 * un tamaño total concreto (para los limites de bytes); `seed` hace
 * distintos los bytes de dos PNG del mismo tamaño.
 */
function makePng(
  opts: { width?: number; height?: number; seed?: number; totalBytes?: number } = {},
): Uint8Array {
  const { width = 40, height = 20, seed = 0, totalBytes } = opts;
  const ihdr = new Uint8Array(25);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 13);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4);
  view.setUint32(8, width);
  view.setUint32(12, height);
  ihdr.set([8, 6, 0, 0, 0], 16);
  const base = PNG_HEAD.length + ihdr.length + PNG_END.length;
  const pad = Math.max(1, (totalBytes ?? base + 1) - base);
  const filler = new Uint8Array(pad).fill(seed & 0xff);
  filler[0] = seed & 0xff;
  const out = new Uint8Array(base + pad);
  out.set(PNG_HEAD, 0);
  out.set(ihdr, PNG_HEAD.length);
  out.set(filler, PNG_HEAD.length + ihdr.length);
  out.set(PNG_END, out.length - PNG_END.length);
  return out;
}

function makeImage(
  opts: { width?: number; height?: number; seed?: number; totalBytes?: number } = {},
): VaultImage {
  const { width = 40, height = 20 } = opts;
  return { png: makePng(opts), ratio: height / width, width, height };
}

function input(
  name = "Ana Pérez",
  overrides: Partial<VaultEntryInput> = {},
): VaultEntryInput {
  return {
    signerName: name,
    role: "Directora",
    sourceDocument: "contrato.pdf",
    signature: makeImage({ seed: 1 }),
    initials: makeImage({ width: 20, height: 20, seed: 2 }),
    ...overrides,
  };
}

beforeEach(async () => {
  await clearVault();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("saveVaultEntry / listVault / getVaultEntry — src/app/sign-pdf/signVault.ts", () => {
  it("ida y vuelta: conserva bytes, ratio, firmante y calcula la clave", async () => {
    const source = input();
    const saved = await saveVaultEntry(source);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.duplicate).toBe(false);
    expect(saved.entry.id).toMatch(/^vault-[0-9a-f]{32}$/);
    expect(saved.entry.schema).toBe(1);
    expect(saved.entry.signerKey).toBe("ana perez");

    const list = await listVault();
    expect(list.ok).toBe(true);
    expect(list.entries).toHaveLength(1);
    const [entry] = list.entries;
    expect(entry.signerName).toBe("Ana Pérez");
    expect(entry.role).toBe("Directora");
    expect(entry.sourceDocument).toBe("contrato.pdf");
    expect(entry.signature?.png).toEqual(source.signature!.png);
    expect(entry.signature?.ratio).toBe(0.5);
    expect(entry.initials?.width).toBe(20);

    const fetched = await getVaultEntry(saved.entry.id);
    expect(fetched).toEqual(entry);
  });

  it("acepta solo firma o solo iniciales", async () => {
    const onlyInitials = await saveVaultEntry(input("Luis", { signature: null }));
    const onlySignature = await saveVaultEntry(
      input("Marta", { initials: null, role: undefined }),
    );
    expect(onlyInitials.ok && onlySignature.ok).toBe(true);
    const { entries } = await listVault();
    const luis = entries.find((e) => e.signerName === "Luis");
    expect(luis?.signature).toBeNull();
    expect(luis?.initials).not.toBeNull();
    expect(entries.find((e) => e.signerName === "Marta")?.role).toBeUndefined();
  });

  it("crea la base propia con el almacen y los indices acordados", async () => {
    await saveVaultEntry(input());
    const names = await new Promise<{ stores: string[]; indexes: string[] }>(
      (resolve, reject) => {
        const request = indexedDB.open("optimuspdf-signature-vault", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const store = db.transaction("signatures").objectStore("signatures");
          const result = {
            stores: Array.from(db.objectStoreNames),
            indexes: Array.from(store.indexNames),
          };
          db.close();
          resolve(result);
        };
      },
    );
    expect(names.stores).toEqual(["signatures"]);
    expect(names.indexes.sort()).toEqual(["byLastUsedAt", "bySignerKey"]);
  });

  it("listVault ordena por ultimo uso y touchVaultEntry sube la entrada", async () => {
    const a = await saveVaultEntry(input("Ana"));
    await new Promise((r) => setTimeout(r, 3));
    await saveVaultEntry(input("Beto", { signature: makeImage({ seed: 9 }) }));
    expect((await listVault()).entries.map((e) => e.signerName)).toEqual([
      "Beto",
      "Ana",
    ]);

    await new Promise((r) => setTimeout(r, 3));
    expect(a.ok && (await touchVaultEntry(a.entry.id))).toEqual({ ok: true });
    expect((await listVault()).entries.map((e) => e.signerName)).toEqual([
      "Ana",
      "Beto",
    ]);
  });

  it("getVaultEntry de un id inexistente devuelve null", async () => {
    expect(await getVaultEntry("no-existe")).toBeNull();
  });

  it("los ids no dependen de crypto.randomUUID ni de crypto en absoluto", async () => {
    vi.stubGlobal("crypto", undefined);
    const first = await saveVaultEntry(input("Ana"));
    const second = await saveVaultEntry(
      input("Beto", { signature: makeImage({ seed: 7 }) }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.entry.id).toMatch(/^vault-[0-9a-f]{32}$/);
      expect(first.entry.id).not.toBe(second.entry.id);
    }
  });
});

describe("limites — src/app/sign-pdf/signVault.ts", () => {
  it(`al llegar a ${MAX_VAULT_ENTRIES} entradas RECHAZA con "limit" y no expulsa nada`, async () => {
    for (let i = 0; i < MAX_VAULT_ENTRIES; i += 1) {
      const result = await saveVaultEntry(
        input(`Firmante ${i}`, { initials: null, signature: makeImage({ seed: i }) }),
      );
      expect(result.ok).toBe(true);
    }
    const overflow = await saveVaultEntry(
      input("Uno de mas", { initials: null, signature: makeImage({ seed: 200 }) }),
    );
    expect(overflow).toEqual({ ok: false, reason: "limit" });

    const { entries } = await listVault();
    expect(entries).toHaveLength(MAX_VAULT_ENTRIES);
    expect(entries.some((e) => e.signerName === "Firmante 0")).toBe(true);
  });

  it("con el baul lleno, un duplicado sigue aceptandose (no ocupa sitio)", async () => {
    for (let i = 0; i < MAX_VAULT_ENTRIES; i += 1) {
      await saveVaultEntry(
        input(`Firmante ${i}`, { initials: null, signature: makeImage({ seed: i }) }),
      );
    }
    const again = await saveVaultEntry(
      input("Firmante 3", { initials: null, signature: makeImage({ seed: 3 }) }),
    );
    expect(again.ok && again.duplicate).toBe(true);
  });

  it("un PNG de 600 KB exactos entra; uno de 600 KB + 1 byte da tooLarge", async () => {
    const exact = makeImage({ totalBytes: MAX_VAULT_IMAGE_BYTES });
    expect(exact.png.byteLength).toBe(MAX_VAULT_IMAGE_BYTES);
    expect((await saveVaultEntry(input("Ana", { signature: exact, initials: null }))).ok).toBe(
      true,
    );

    const over = makeImage({ totalBytes: MAX_VAULT_IMAGE_BYTES + 1, seed: 5 });
    expect(await saveVaultEntry(input("Beto", { signature: over, initials: null }))).toEqual({
      ok: false,
      reason: "tooLarge",
    });
    // Tambien en las iniciales.
    expect(await saveVaultEntry(input("Beto", { signature: null, initials: over }))).toEqual({
      ok: false,
      reason: "tooLarge",
    });
  });

  it("rechaza con 'limit' al superar el total de bytes del baul (~20 MB)", async () => {
    const perEntry = MAX_VAULT_IMAGE_BYTES * 2;
    const fits = Math.floor(MAX_VAULT_TOTAL_BYTES / perEntry);
    for (let i = 0; i < fits; i += 1) {
      const result = await saveVaultEntry(
        input(`Grande ${i}`, {
          signature: makeImage({ totalBytes: MAX_VAULT_IMAGE_BYTES, seed: i }),
          initials: makeImage({ totalBytes: MAX_VAULT_IMAGE_BYTES, seed: i + 100 }),
        }),
      );
      expect(result.ok).toBe(true);
    }
    const overflow = await saveVaultEntry(
      input("Grande de mas", {
        signature: makeImage({ totalBytes: MAX_VAULT_IMAGE_BYTES, seed: 250 }),
        initials: makeImage({ totalBytes: MAX_VAULT_IMAGE_BYTES, seed: 251 }),
      }),
    );
    expect(overflow).toEqual({ ok: false, reason: "limit" });
    expect((await listVault()).entries).toHaveLength(fits);
  });
});

describe("entradas invalidas — src/app/sign-pdf/signVault.ts", () => {
  it.each([
    ["nombre vacio", { signerName: "   " }],
    ["nombre de 201 caracteres", { signerName: "x".repeat(201) }],
    ["sin firma ni iniciales", { signature: null, initials: null }],
    [
      "PNG falso",
      {
        signature: {
          png: new TextEncoder().encode("esto no es un png, ni de lejos"),
          ratio: 0.5,
          width: 40,
          height: 20,
        },
      },
    ],
    ["ratio no finito", { signature: { ...makeImage(), ratio: Number.NaN } }],
    ["ratio cero", { signature: { ...makeImage(), ratio: 0 } }],
    ["ancho que no coincide con el IHDR", { signature: { ...makeImage(), width: 99 } }],
    ["PNG de mas de 4096 px", { signature: makeImage({ width: 5000, height: 10 }) }],
  ] as const)("%s -> invalid", async (_label, override) => {
    const result = await saveVaultEntry({ ...input(), ...override } as VaultEntryInput);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("no lanza con una entrada que ni siquiera es un objeto", async () => {
    const result = await saveVaultEntry(null as unknown as VaultEntryInput);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("recorta el cargo y el documento largos en lugar de rechazar", async () => {
    const saved = await saveVaultEntry(
      input("Ana", { role: "r".repeat(500), sourceDocument: "d".repeat(500) }),
    );
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.entry.role).toHaveLength(200);
      expect(saved.entry.sourceDocument).toHaveLength(200);
    }
  });
});

describe("duplicados — src/app/sign-pdf/signVault.ts", () => {
  it("mismo firmante (sin importar acentos/mayusculas) y mismos bytes: actualiza en vez de duplicar", async () => {
    const first = await saveVaultEntry(input("Ana Pérez"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await new Promise((r) => setTimeout(r, 3));

    const second = await saveVaultEntry(
      input("ana perez", { sourceDocument: "otro.pdf" }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.sourceDocument).toBe("otro.pdf");
    expect(second.entry.lastUsedAt > first.entry.lastUsedAt).toBe(true);
    // Conserva el nombre original y la fecha de creacion.
    expect(second.entry.signerName).toBe("Ana Pérez");
    expect(second.entry.createdAt).toBe(first.entry.createdAt);

    expect((await listVault()).entries).toHaveLength(1);
  });

  it("mismos bytes pero otro firmante, o mismo firmante con otros bytes: NO es duplicado", async () => {
    await saveVaultEntry(input("Ana"));
    const otherSigner = await saveVaultEntry(input("Beto"));
    const otherBytes = await saveVaultEntry(
      input("Ana", { signature: makeImage({ seed: 77 }) }),
    );
    expect(otherSigner.ok && !otherSigner.duplicate).toBe(true);
    expect(otherBytes.ok && !otherBytes.duplicate).toBe(true);
    expect((await listVault()).entries).toHaveLength(3);
  });
});

describe("updateVaultEntry / deleteVaultEntry / clearVault — src/app/sign-pdf/signVault.ts", () => {
  it("renombra, recalcula la clave y cambia/quita el cargo", async () => {
    const saved = await saveVaultEntry(input("Ana"));
    if (!saved.ok) throw new Error("no se guardo");

    const renamed = await updateVaultEntry(saved.entry.id, {
      signerName: "  Ánge  Ruiz ",
      role: "Gerente",
    });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.entry.signerName).toBe("Ánge  Ruiz");
      expect(renamed.entry.signerKey).toBe("ange ruiz");
      expect(renamed.entry.role).toBe("Gerente");
      // Lo demas no se toca.
      expect(renamed.entry.signature).toEqual(saved.entry.signature);
    }

    const cleared = await updateVaultEntry(saved.entry.id, { role: "" });
    expect(cleared.ok && cleared.entry.role).toBeUndefined();
    const stored = await getVaultEntry(saved.entry.id);
    expect(stored?.role).toBeUndefined();
    expect(stored?.signerName).toBe("Ánge  Ruiz");
  });

  it("update de un id inexistente da notFound; con nombre vacio, invalid", async () => {
    expect(await updateVaultEntry("no-existe", { signerName: "X" })).toEqual({
      ok: false,
      reason: "notFound",
    });
    const saved = await saveVaultEntry(input("Ana"));
    if (!saved.ok) throw new Error("no se guardo");
    expect(await updateVaultEntry(saved.entry.id, { signerName: "  " })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(
      await updateVaultEntry(saved.entry.id, { signerName: "y".repeat(201) }),
    ).toEqual({ ok: false, reason: "invalid" });
    expect((await getVaultEntry(saved.entry.id))?.signerName).toBe("Ana");
  });

  it("touch de un id inexistente da notFound", async () => {
    expect(await touchVaultEntry("no-existe")).toEqual({
      ok: false,
      reason: "notFound",
    });
  });

  it("deleteVaultEntry borra una y es idempotente", async () => {
    const a = await saveVaultEntry(input("Ana"));
    await saveVaultEntry(input("Beto", { signature: makeImage({ seed: 9 }) }));
    if (!a.ok) throw new Error("no se guardo");

    expect(await deleteVaultEntry(a.entry.id)).toEqual({ ok: true });
    expect(await deleteVaultEntry(a.entry.id)).toEqual({ ok: true });
    expect((await listVault()).entries.map((e) => e.signerName)).toEqual(["Beto"]);
    expect(await getVaultEntry(a.entry.id)).toBeNull();
  });

  it("clearVault vacia el baul", async () => {
    await saveVaultEntry(input("Ana"));
    await saveVaultEntry(input("Beto", { signature: makeImage({ seed: 9 }) }));
    expect(await clearVault()).toEqual({ ok: true });
    expect(await listVault()).toEqual({ ok: true, entries: [] });
  });
});

describe("subscribeToVault — src/app/sign-pdf/signVault.ts", () => {
  it("avisa tras cada escritura exitosa y deja de avisar al desuscribirse", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToVault(listener);

    const saved = await saveVaultEntry(input("Ana"));
    expect(listener).toHaveBeenCalledTimes(1);
    if (!saved.ok) throw new Error("no se guardo");

    await touchVaultEntry(saved.entry.id);
    expect(listener).toHaveBeenCalledTimes(2);
    await updateVaultEntry(saved.entry.id, { role: "Jefa" });
    expect(listener).toHaveBeenCalledTimes(3);
    await deleteVaultEntry(saved.entry.id);
    expect(listener).toHaveBeenCalledTimes(4);
    await clearVault();
    expect(listener).toHaveBeenCalledTimes(5);

    // Un guardado rechazado no cambia nada: no avisa.
    await saveVaultEntry(input("   "));
    expect(listener).toHaveBeenCalledTimes(5);

    unsubscribe();
    await saveVaultEntry(input("Beto"));
    expect(listener).toHaveBeenCalledTimes(5);
  });
});

describe("IndexedDB ausente o bloqueado (REGLA DURA: nunca lanza) — src/app/sign-pdf/signVault.ts", () => {
  async function expectAllUnavailable() {
    expect(await listVault()).toEqual({
      ok: false,
      reason: "unavailable",
      entries: [],
    });
    expect(await getVaultEntry("x")).toBeNull();
    expect(await saveVaultEntry(input())).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await touchVaultEntry("x")).toEqual({ ok: false, reason: "unavailable" });
    expect(await updateVaultEntry("x", { role: "r" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(await deleteVaultEntry("x")).toEqual({ ok: false, reason: "unavailable" });
    expect(await clearVault()).toEqual({ ok: false, reason: "unavailable" });
  }

  it("indexedDB indefinido (modo privado de algunos navegadores)", async () => {
    vi.stubGlobal("indexedDB", undefined);
    expect(vaultSupported()).toBe(false);
    await expectAllUnavailable();
  });

  it("indexedDB.open lanza de forma sincrona (SecurityError)", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new DOMException("bloqueado", "SecurityError");
    });
    await expectAllUnavailable();
  });

  it("indexedDB.open dispara el evento error", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      const request = { error: new DOMException("fallo", "UnknownError") } as {
        onerror?: () => void;
        error: DOMException;
      };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    });
    await expectAllUnavailable();
  });

  it("una transaccion abortada por cuota se informa como 'limit', sin lanzar", async () => {
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(() => {
      const tx = {
        error: new DOMException("cuota", "QuotaExceededError"),
        objectStore: () => ({ getAll: () => ({}), put: () => ({}) }),
      } as { error: DOMException; onabort?: () => void };
      queueMicrotask(() => tx.onabort?.());
      return tx as unknown as IDBTransaction;
    });
    expect(await saveVaultEntry(input())).toEqual({ ok: false, reason: "limit" });
  });

  it("vaultSupported es true con IndexedDB disponible", () => {
    expect(vaultSupported()).toBe(true);
  });
});

describe("normalizeSignerKey / readPngSize / data URL — src/app/sign-pdf/signVault.ts", () => {
  it("normalizeSignerKey quita acentos, mayusculas y espacios repetidos, pero conserva letras no latinas", () => {
    expect(normalizeSignerKey("  María   José PÉREZ ")).toBe("maria jose perez");
    expect(normalizeSignerKey("李雷")).toBe("李雷");
    expect(normalizeSignerKey("")).toBe("");
  });

  it("readPngSize lee ancho y alto del IHDR; null si no es un PNG", () => {
    expect(readPngSize(makePng({ width: 300, height: 120 }))).toEqual({
      width: 300,
      height: 120,
    });
    expect(readPngSize(new Uint8Array(40))).toBeNull();
    expect(readPngSize(makePng().subarray(0, 20))).toBeNull();
    const badHeader = makePng();
    badHeader[1] = 0x51;
    expect(readPngSize(badHeader)).toBeNull();
  });

  it("vaultImageToDataUrl y dataUrlToVaultImage hacen ida y vuelta", () => {
    const image = makeImage({ width: 300, height: 120, seed: 4 });
    const url = vaultImageToDataUrl(image);
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(dataUrlToVaultImage(url, 0.4)).toEqual({
      png: image.png,
      ratio: 0.4,
      width: 300,
      height: 120,
    });
  });

  it("dataUrlToVaultImage deriva el ratio de las dimensiones si el dado no sirve", () => {
    const url = vaultImageToDataUrl(makeImage({ width: 100, height: 25 }));
    expect(dataUrlToVaultImage(url, Number.NaN)?.ratio).toBe(0.25);
    expect(dataUrlToVaultImage(url, -3)?.ratio).toBe(0.25);
  });

  it("dataUrlToVaultImage devuelve null (sin lanzar) ante basura", () => {
    expect(dataUrlToVaultImage("", 1)).toBeNull();
    expect(dataUrlToVaultImage("data:image/jpeg;base64,AAAA", 1)).toBeNull();
    expect(dataUrlToVaultImage("data:image/png;base64,@@@", 1)).toBeNull();
    // base64 valido, pero no es un PNG.
    expect(
      dataUrlToVaultImage(`data:image/png;base64,${btoa("hola mundo, esto no es un png")}`, 1),
    ).toBeNull();
    expect(dataUrlToVaultImage(undefined as unknown as string, 1)).toBeNull();
  });

  it("vaultImageToDataUrl soporta imagenes grandes sin desbordar la pila", () => {
    const big = makeImage({ totalBytes: MAX_VAULT_IMAGE_BYTES });
    const back = dataUrlToVaultImage(vaultImageToDataUrl(big), big.ratio);
    expect(back?.png).toEqual(big.png);
  });
});

describe("fusion de firma + iniciales y texto limpio (W3 r2) — src/app/sign-pdf/signVault.ts", () => {
  const sig = () => makeImage({ seed: 11 });
  const ini = () => makeImage({ width: 20, height: 20, seed: 12 });

  it("guardar firma+iniciales despues de la firma sola REEMPLAZA la entrada (misma id), no la duplica", async () => {
    const first = await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: null }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: ini() }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.duplicate).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(second.entry.createdAt).toBe(first.entry.createdAt);
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signature?.png).toEqual(sig().png);
    expect(entries[0].initials?.png).toEqual(ini().png);
  });

  it("lo mismo al reves: iniciales solas y luego firma+iniciales", async () => {
    await saveVaultEntry(input("Ana Pérez", { signature: null, initials: ini() }));
    await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: ini() }));
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signature).not.toBeNull();
  });

  it("una firma sola y unas iniciales solas del mismo firmante se funden en UNA al guardar ambas juntas", async () => {
    await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: null }));
    await saveVaultEntry(input("Ana Pérez", { signature: null, initials: ini() }));
    expect((await listVault()).entries).toHaveLength(2);
    const merged = await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: ini() }));
    expect(merged.ok).toBe(true);
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("guardar la firma sola cuando ya hay firma+iniciales es un duplicado (no crea otra)", async () => {
    const full = await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: ini() }));
    const again = await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: null }));
    expect(again.ok && again.duplicate).toBe(true);
    if (full.ok && again.ok) expect(again.entry.id).toBe(full.entry.id);
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("no funde a firmantes distintos ni firmas distintas", async () => {
    await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: null }));
    await saveVaultEntry(input("Luis Gómez", { signature: sig(), initials: ini() }));
    await saveVaultEntry(
      input("Ana Pérez", { signature: makeImage({ seed: 99 }), initials: ini() }),
    );
    expect((await listVault()).entries).toHaveLength(3);
  });

  it("fusionar no consume hueco del limite de entradas", async () => {
    for (let index = 0; index < MAX_VAULT_ENTRIES - 1; index += 1) {
      await saveVaultEntry(
        input(`Firmante ${index}`, { signature: makeImage({ seed: index + 20 }), initials: null }),
      );
    }
    await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: null }));
    expect((await listVault()).entries).toHaveLength(MAX_VAULT_ENTRIES);
    const merged = await saveVaultEntry(input("Ana Pérez", { signature: sig(), initials: ini() }));
    expect(merged.ok).toBe(true);
    expect((await listVault()).entries).toHaveLength(MAX_VAULT_ENTRIES);
  });

  it("readPngSize rechaza un IHDR de longitud distinta de 13", () => {
    const png = makePng();
    expect(readPngSize(png)).not.toBeNull();
    new DataView(png.buffer).setUint32(8, 14);
    expect(readPngSize(png)).toBeNull();
  });

  it("quita las marcas bidireccionales de nombre, cargo y documento al guardar", async () => {
    const saved = await saveVaultEntry(
      input("An\u202Ea Pérez\u200F", { role: "Dir\u2066ectora", sourceDocument: "con\u202Atrato.pdf" }),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.entry.signerName).toBe("Ana Pérez");
    expect(saved.entry.signerKey).toBe("ana perez");
    expect(saved.entry.role).toBe("Directora");
    expect(saved.entry.sourceDocument).toBe("contrato.pdf");
  });
});
