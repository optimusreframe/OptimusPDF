import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResumeKind, ResumeTarget } from "@/lib/resumeLinks";
import { clearResumeFromUrl, useResumeLink, type ResumeOutcome } from "@/lib/useResumeLink";

/**
 * `useResumeLink`: lee `?resume=` UNA vez al montar, restaura solo trabajos validos de ESTA herramienta, limpia la URL
 * con `replaceState` (sin entradas de historial) y avisa si el trabajo ya no existe.
 */

const HEX = "0123456789abcdef".repeat(4);

function setUrl(path: string) {
  window.history.replaceState(null, "", path);
}

type Restore = (target: ResumeTarget) => Promise<ResumeOutcome> | ResumeOutcome;

function Harness({ kinds, restore }: { kinds: readonly ResumeKind[]; restore: Restore }) {
  const state = useResumeLink(kinds, restore);
  return (
    <div>
      <output data-testid="gone">{String(state.gone)}</output>
      <button type="button" onClick={state.dismiss}>
        dismiss
      </button>
      <input type="file" aria-label="archivo" />
    </div>
  );
}

beforeEach(() => setUrl("/edit-pdf"));
afterEach(() => {
  cleanup();
  setUrl("/");
});

describe("useResumeLink", () => {
  it("restaura el trabajo valido UNA vez y limpia la URL despues (sin entrada de historial nueva)", async () => {
    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    const historyBefore = window.history.length;
    let seenDuringRestore = "";
    const restore = vi.fn(async () => {
      seenDuringRestore = window.location.search;
      return "restored" as const;
    });
    render(<Harness kinds={["edit"]} restore={restore} />);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledWith({ kind: "edit", id: HEX });
    // La URL se limpia DESPUES de restaurar, no antes.
    expect(seenDuringRestore).toBe(`?resume=edit:${HEX}`);
    expect(window.location.pathname).toBe("/edit-pdf");
    expect(window.history.length).toBe(historyBefore);
    expect(screen.getByTestId("gone").textContent).toBe("false");
  });

  it("el doble efecto de StrictMode no restaura dos veces", async () => {
    setUrl(`/pdf-pro?resume=pro:${HEX}`);
    const restore = vi.fn(async () => "restored" as const);
    render(
      <StrictMode>
        <Harness kinds={["pro"]} restore={restore} />
      </StrictMode>,
    );
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("un trabajo que ya no existe levanta el aviso, y «dismiss» lo retira", async () => {
    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    render(<Harness kinds={["edit"]} restore={() => "gone"} />);
    await waitFor(() => expect(screen.getByTestId("gone").textContent).toBe("true"));
    expect(window.location.search).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(screen.getByTestId("gone").textContent).toBe("false");
  });

  it("el aviso se retira solo al elegir un archivo o al soltar uno", async () => {
    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    const { unmount } = render(<Harness kinds={["edit"]} restore={() => "gone"} />);
    await waitFor(() => expect(screen.getByTestId("gone").textContent).toBe("true"));
    fireEvent.change(screen.getByLabelText("archivo"));
    await waitFor(() => expect(screen.getByTestId("gone").textContent).toBe("false"));
    unmount();

    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    render(<Harness kinds={["edit"]} restore={() => "gone"} />);
    await waitFor(() => expect(screen.getByTestId("gone").textContent).toBe("true"));
    act(() => {
      window.dispatchEvent(new Event("drop"));
    });
    await waitFor(() => expect(screen.getByTestId("gone").textContent).toBe("false"));
  });

  it("«failed» o una excepcion no levantan el aviso de «ya no existe» ni rompen la pagina", async () => {
    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    const { unmount } = render(<Harness kinds={["edit"]} restore={() => "failed"} />);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByTestId("gone").textContent).toBe("false");
    unmount();

    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    render(
      <Harness
        kinds={["edit"]}
        restore={async () => {
          throw new Error("IndexedDB reventada");
        }}
      />,
    );
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByTestId("gone").textContent).toBe("false");
  });

  it.each([
    ["tipo fuera de la lista blanca", "/edit-pdf?resume=delete:" + HEX],
    ["prototipo", "/edit-pdf?resume=__proto__:" + HEX],
    ["id manipulado", "/edit-pdf?resume=edit:../../x"],
    ["etiqueta", "/edit-pdf?resume=%3Cscript%3Ealert(1)%3C/script%3E"],
    ["id corto", `/edit-pdf?resume=edit:${HEX.slice(1)}`],
    ["trabajo de OTRA herramienta", `/edit-pdf?resume=pro:${HEX}`],
    ["varios resume", `/edit-pdf?resume=edit:${HEX}&resume=edit:${HEX}`],
    ["vacio", "/edit-pdf?resume="],
  ])("%s: no restaura nada, no avisa y limpia la URL", async (_label, url) => {
    setUrl(url);
    const restore = vi.fn(async () => "restored" as const);
    render(<Harness kinds={["edit"]} restore={restore} />);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(restore).not.toHaveBeenCalled();
    expect(screen.getByTestId("gone").textContent).toBe("false");
  });

  it("sin ?resume= no hace nada ni toca la URL (conserva el resto de parametros y el hash)", async () => {
    setUrl("/edit-pdf?otro=1#seccion");
    const restore = vi.fn(async () => "restored" as const);
    render(<Harness kinds={["edit"]} restore={restore} />);
    await act(async () => {});
    expect(restore).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?otro=1");
    expect(window.location.hash).toBe("#seccion");
  });

  it("al limpiar conserva los demas parametros y el hash", async () => {
    setUrl(`/edit-pdf?a=1&resume=edit:${HEX}&b=2#top`);
    render(<Harness kinds={["edit"]} restore={() => "restored"} />);
    await waitFor(() => expect(window.location.search).toBe("?a=1&b=2"));
    expect(window.location.hash).toBe("#top");
  });

  it("solo lee la URL al montar: un cambio posterior no vuelve a restaurar", async () => {
    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    const restore = vi.fn(async () => "restored" as const);
    const { rerender } = render(<Harness kinds={["edit"]} restore={restore} />);
    await waitFor(() => expect(window.location.search).toBe(""));
    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    rerender(<Harness kinds={["edit"]} restore={restore} />);
    await act(async () => {});
    expect(restore).toHaveBeenCalledTimes(1);
  });
});

describe("clearResumeFromUrl", () => {
  it("no hace nada si la URL ya esta limpia", () => {
    setUrl("/edit-pdf?x=1");
    const spy = vi.spyOn(window.history, "replaceState");
    clearResumeFromUrl();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("no usa pushState: nunca anade una entrada al historial", () => {
    setUrl(`/edit-pdf?resume=edit:${HEX}`);
    const push = vi.spyOn(window.history, "pushState");
    clearResumeFromUrl();
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    push.mockRestore();
  });
});
