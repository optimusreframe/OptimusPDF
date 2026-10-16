import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex, sha256Pure } from "@/lib/crypto/sha256";

const node = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

afterEach(() => vi.unstubAllGlobals());

describe("sha256 — src/lib/crypto/sha256.ts", () => {
  it("vectores conocidos (vacio, abc, 448 bits)", () => {
    expect(hex(sha256Pure(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(hex(sha256Pure(new TextEncoder().encode("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      hex(
        sha256Pure(
          new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        ),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("la version pura coincide con node en todas las longitudes de relleno (0..200) y con 1 MB", () => {
    for (let n = 0; n <= 200; n += 1) {
      const data = new Uint8Array(n).map((_, i) => (i * 13 + n) & 0xff);
      expect(hex(sha256Pure(data))).toBe(node(data));
    }
    const big = new Uint8Array(1_000_000).map((_, i) => (i * 7) & 0xff);
    expect(hex(sha256Pure(big))).toBe(node(big));
  });

  it("sha256Hex usa WebCrypto y, sin crypto.subtle, el respaldo puro con el mismo resultado", async () => {
    const data = new TextEncoder().encode("optimus");
    const withSubtle = await sha256Hex(data);
    vi.stubGlobal("crypto", {});
    expect(await sha256Hex(data)).toBe(withSubtle);
    expect(withSubtle).toBe(node(data));
  });
});
