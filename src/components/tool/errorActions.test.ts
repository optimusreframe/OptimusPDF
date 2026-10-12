import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";
import { errorActions } from "@/components/tool/errorCopy";

const reload = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock("@/lib/reloadPage", () => ({ reloadPage: () => reload.page() }));

beforeEach(() => reload.page.mockReset());

describe("errorActions", () => {
  it("`offline` ofrece una unica accion primaria «Recargar la página» que recarga", () => {
    const actions = errorActions(es, "offline");
    expect(actions).toHaveLength(1);
    expect(actions![0].label).toBe(es.tool.errors.reloadAction);
    expect(actions![0].primary).toBe(true);
    actions![0].onClick?.();
    expect(reload.page).toHaveBeenCalledTimes(1);
  });

  it("en ingles usa el texto en ingles", () => {
    expect(errorActions(en, "offline")![0].label).toBe("Reload the page");
  });

  it("el mensaje de `offline` dice que hay que recargar, en los dos idiomas", () => {
    expect(es.tool.errors.offline).toMatch(/recarga/i);
    expect(en.tool.errors.offline).toMatch(/reload/i);
    expect(es.tool.errors.offline).not.toMatch(/vuelve a intentarlo/i);
    expect(en.tool.errors.offline).not.toMatch(/try again/i);
  });

  it("los demas codigos (y la ausencia de codigo) no llevan accion", () => {
    for (const code of ["corrupt", "unknown", "ocrNetworkFailure", "encrypted", null, undefined] as const) {
      expect(errorActions(es, code as never)).toBeUndefined();
    }
  });
});
