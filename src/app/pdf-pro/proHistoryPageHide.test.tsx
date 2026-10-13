import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { ProWorkingDocProvider } from "@/app/pdf-pro/useProWorkingDoc";
import { createProHistoryStore, PRO_HISTORY_DB_PREFIX } from "@/app/pdf-pro/proHistoryStore";
import { HistoryJanitor } from "@/components/layout/HistoryJanitor";
import { LanguageProvider } from "@/lib/i18n";
import { fakeBytes } from "@/app/pdf-pro/proTestUtils";

/**
 * Wave 8 · F2 menor 5 (privacidad): al cerrar la pestana (`pagehide` NO persistido) se borra la base de historial de
 * esta sesion sin cerrar el documento; con bfcache (`persisted`) se conserva; y el componente ligero del layout barre
 * las bases de sesiones muertas al cargar cualquier pagina.
 */

const dbNames = async () =>
  (await indexedDB.databases()).map((info) => info.name ?? "").filter((name) => name.startsWith(PRO_HISTORY_DB_PREFIX));

function pageHide(persisted: boolean) {
  const event = new Event("pagehide") as Event & { persisted: boolean };
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

afterEach(async () => {
  Reflect.deleteProperty(globalThis, "navigator");
  vi.useRealTimers();
});

describe("pagehide borra la base de historial de la pestana", () => {
  it("cierre real: la base desaparece y el documento sigue abierto (su borrador no se toca)", async () => {
    const store = createProHistoryStore({ sessionId: "pestana-1", openTimeoutMs: 2000 })!;
    await store.put("snap", fakeBytes(2000));
    expect(await dbNames()).toContain(store.name);
    const view = render(
      <LanguageProvider>
        <ProWorkingDocProvider options={{ historyStore: store }} shortcuts={false}>
          <span>suite</span>
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    await act(async () => {
      pageHide(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await dbNames()).not.toContain(store.name);
    view.unmount();
  });

  it("pagehide persistido (bfcache): la pagina puede volver, asi que la base se conserva", async () => {
    const store = createProHistoryStore({ sessionId: "pestana-2", openTimeoutMs: 2000 })!;
    await store.put("snap", fakeBytes(2000));
    const view = render(
      <LanguageProvider>
        <ProWorkingDocProvider options={{ historyStore: store }} shortcuts={false}>
          <span>suite</span>
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    await act(async () => {
      pageHide(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await dbNames()).toContain(store.name);
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await dbNames()).not.toContain(store.name); // el desmontaje normal si la borra
  });

  it("tras desmontar la suite el listener ya no esta (otra pestana no se ve afectada)", async () => {
    const other = createProHistoryStore({ sessionId: "otra", openTimeoutMs: 2000 })!;
    await other.put("snap", fakeBytes(100));
    const store = createProHistoryStore({ sessionId: "pestana-3", openTimeoutMs: 2000 })!;
    const view = render(
      <LanguageProvider>
        <ProWorkingDocProvider options={{ historyStore: store }} shortcuts={false}>
          <span>suite</span>
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    view.unmount();
    await act(async () => {
      pageHide(false);
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await dbNames()).toContain(other.name);
    await other.dispose();
  });
});

describe("HistoryJanitor (layout)", () => {
  it("al cargar cualquier pagina barre la base de una sesion muerta y respeta la viva", async () => {
    const dead = createProHistoryStore({ sessionId: "muerta", openTimeoutMs: 2000 })!;
    const alive = createProHistoryStore({ sessionId: "viva", openTimeoutMs: 2000 })!;
    await dead.put("a", fakeBytes(100));
    await alive.put("a", fakeBytes(100));
    const held = new Set([alive.name]);
    Object.defineProperty(globalThis, "navigator", {
      value: {
        locks: {
          request: async (name: string, options: unknown, callback?: (lock: unknown) => Promise<void>) => {
            const cb = typeof options === "function" ? (options as (lock: unknown) => Promise<void>) : callback;
            await cb!(held.has(name) ? null : { name });
          },
        },
      },
      configurable: true,
    });
    const view = render(<HistoryJanitor />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1800));
    });
    const left = await dbNames();
    expect(left).toContain(alive.name);
    expect(left).not.toContain(dead.name);
    view.unmount();
    await alive.dispose();
  });
});
