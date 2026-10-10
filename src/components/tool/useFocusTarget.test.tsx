import { useLayoutEffect, useRef, useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { firstControl, useFocusTarget } from "@/components/tool/useFocusTarget";

/**
 * `useFocusTarget` (Wave 6 · V-F): el foco llega a su destino en el MISMO commit que desmonta el control que
 * lo tenia (sin pasar por <body> en ningun momento observable), mejora un control de reserva, se recupera si
 * se pierde justo despues y no le quita el foco a quien ya lo tiene.
 */

beforeAll(() => {
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

type Target = "next" | "ideal" | "respect";

/** El elemento activo que ve un efecto de LAYOUT del llamador, declarado DESPUES del hook (mismo commit, antes de pintar). */
const seenAtLayout: (Element | null)[] = [];

function Harness({ initialReady = true, withOwner = false }: { initialReady?: boolean; withOwner?: boolean }) {
  const [removed, setRemoved] = useState(false);
  const [ready, setReady] = useState(initialReady);
  const nextRef = useRef<HTMLButtonElement>(null);
  const idealRef = useRef<HTMLButtonElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const { request } = useFocusTarget<Target>((target) => {
    if (target === "ideal") {
      return {
        settling: !ready,
        respectFocus: true,
        candidates: [idealRef.current, firstControl(areaRef.current)],
      };
    }
    if (target === "respect") return { respectFocus: true, candidates: [nextRef.current] };
    return { candidates: [nextRef.current] };
  });
  useLayoutEffect(() => {
    seenAtLayout.push(document.activeElement);
  });
  return (
    <div>
      <div ref={areaRef}>
        {removed ? null : (
          <button
            type="button"
            onClick={() => {
              request("next");
              setRemoved(true);
            }}
          >
            quitar
          </button>
        )}
        <button type="button" ref={nextRef}>
          siguiente
        </button>
      </div>
      <button type="button" ref={idealRef} disabled={!ready}>
        ideal
      </button>
      <button type="button" onClick={() => request("ideal")}>
        pedir ideal
      </button>
      <button type="button" onClick={() => request("respect")}>
        pedir respetuoso
      </button>
      <button type="button" onClick={() => setReady(true)}>
        listo
      </button>
      {withOwner ? <input aria-label="campo" /> : null}
    </div>
  );
}

/** Registra el elemento activo tras cada lote de cambios del DOM (microtarea): nunca debe ser <body>. */
function watchBody(): { frames: () => number; stop: () => void } {
  let frames = 0;
  const observer = new MutationObserver(() => {
    if (document.activeElement === document.body) frames += 1;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { frames: () => frames, stop: () => observer.disconnect() };
}

describe("useFocusTarget", () => {
  it("al desmontarse el control enfocado, el foco pasa al destino EN EL MISMO commit (sin <body>)", async () => {
    render(<Harness />);
    const remove = screen.getByRole("button", { name: "quitar" });
    remove.focus();
    const watcher = watchBody();
    seenAtLayout.length = 0;
    fireEvent.click(remove);
    // En la fase de LAYOUT del propio commit (antes de pintar) el foco ya esta en el destino.
    expect(seenAtLayout.at(-1)?.textContent).toBe("siguiente");
    // Sincrono: tras el commit del clic el foco ya esta en el destino, sin esperar a un temporizador.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "siguiente" }));
    await act(async () => {});
    expect(watcher.frames()).toBe(0);
    watcher.stop();
  });

  it("un destino desactivado se espera (reintento) y se enfoca en cuanto se puede; entre tanto, un control de reserva", async () => {
    render(<Harness initialReady={false} />);
    fireEvent.click(screen.getByRole("button", { name: "pedir ideal" }));
    // Reserva: el primer control util de la zona (nunca <body>).
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toBe("quitar");
    fireEvent.click(screen.getByRole("button", { name: "listo" }));
    // Mejora al destino ideal cuando ya se puede.
    await waitFor(() => expect(document.activeElement?.textContent).toBe("ideal"));
  });

  it("no le quita el foco a un control util que ya lo tiene (respectFocus)", async () => {
    render(<Harness withOwner />);
    const field = screen.getByLabelText("campo");
    field.focus();
    fireEvent.click(screen.getByRole("button", { name: "pedir respetuoso" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(document.activeElement).toBe(field);
  });

  it("sin respectFocus el destino SI toma el foco aunque lo tenga otro control", async () => {
    render(<Harness withOwner />);
    screen.getByLabelText("campo").focus();
    fireEvent.click(screen.getByRole("button", { name: "quitar" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "siguiente" }));
  });

  it("si el foco recien dado se pierde despues (algo lo suelta a <body>), se recupera", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "pedir ideal" }));
    await waitFor(() => expect(document.activeElement?.textContent).toBe("ideal"));
    // Algo (una hoja que termina de salir) suelta el foco a <body>.
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
  });

  it("firstControl devuelve el primer control util y salta lo desactivado", () => {
    const { container } = render(
      <div>
        <button type="button" disabled>
          no
        </button>
        <button type="button">si</button>
      </div>,
    );
    expect(firstControl(container.firstElementChild as HTMLElement)?.textContent).toBe("si");
    expect(firstControl(null)).toBeNull();
  });
});
