import { beforeEach, describe, expect, it } from "vitest";
import {
  resetSignHandoffForTests,
  setSignHandoff,
  SIGN_HANDOFF_KEY,
  SIGN_HANDOFF_MAX_DOCUMENTS,
  SIGN_HANDOFF_TTL_MS,
  takeSignHandoff,
} from "./signHandoff";

describe("signHandoff", () => {
  beforeEach(() => resetSignHandoffForTests());

  it("se recoge una sola vez", () => {
    expect(setSignHandoff({ documentIds: ["doc-1", "doc-2"], mode: "sign" }, 1_000)).toBe(true);
    expect(takeSignHandoff(1_500)).toEqual({ documentIds: ["doc-1", "doc-2"], mode: "sign", createdAt: 1_000 });
    expect(takeSignHandoff(1_600)).toBeNull();
  });

  it("caduca", () => {
    setSignHandoff({ documentIds: ["a"], mode: "configure" }, 10);
    expect(takeSignHandoff(10 + SIGN_HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it("rechaza ids invalidos, listas vacias o demasiado largas y modos desconocidos", () => {
    expect(setSignHandoff({ documentIds: [], mode: "sign" })).toBe(false);
    expect(setSignHandoff({ documentIds: ["../x"], mode: "sign" })).toBe(false);
    expect(setSignHandoff({ documentIds: ["<script>"], mode: "sign" })).toBe(false);
    expect(setSignHandoff({ documentIds: Array.from({ length: SIGN_HANDOFF_MAX_DOCUMENTS + 1 }, (_, i) => `d${i}`), mode: "sign" })).toBe(false);
    expect(setSignHandoff({ documentIds: ["a"], mode: "otro" as never })).toBe(false);
    expect(takeSignHandoff()).toBeNull();
  });

  it("se recupera de sessionStorage si la memoria se perdio (recarga) y descarta JSON corrupto o manipulado", () => {
    sessionStorage.setItem(SIGN_HANDOFF_KEY, JSON.stringify({ documentIds: ["z9"], mode: "sign", createdAt: Date.now() }));
    expect(takeSignHandoff()?.documentIds).toEqual(["z9"]);
    sessionStorage.setItem(SIGN_HANDOFF_KEY, "{no json");
    expect(takeSignHandoff()).toBeNull();
    sessionStorage.setItem(SIGN_HANDOFF_KEY, JSON.stringify({ documentIds: ["__proto__/x"], mode: "sign", createdAt: Date.now() }));
    expect(takeSignHandoff()).toBeNull();
    expect(sessionStorage.getItem(SIGN_HANDOFF_KEY)).toBeNull();
  });
});
