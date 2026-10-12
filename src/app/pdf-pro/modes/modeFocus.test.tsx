import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { useBeforeUnloadGuard, useEntryFocus, useFocusReturn } from "@/app/pdf-pro/modes/modeFocus";
import { ModeHeader } from "@/app/sign-pdf/embeddedChrome";

/** Foco de entrada y aviso de recarga de los modos (Wave 7 · U7). */

function Entry({ selector = "[data-target]" }: { selector?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEntryFocus(ref, selector);
  return (
    <div ref={ref}>
      <button data-target="">objetivo</button>
      <button data-other="">otro</button>
    </div>
  );
}

const frames = async (count = 4) => {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
  }
};

describe("useEntryFocus", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("con el foco en <body> (se entro con S o F desde el visor) lo lleva al primer control del modo", async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    const view = render(<Entry />);
    await frames();
    expect(document.activeElement).toBe(view.getByText("objetivo"));
  });

  it("si la persona entro pulsando una pestana, respeta su foco", async () => {
    const tabs = document.createElement("div");
    tabs.setAttribute("data-pro-region", "tabs");
    const tab = document.createElement("button");
    tabs.append(tab);
    document.body.append(tabs);
    tab.focus();
    render(<Entry />);
    await frames();
    expect(document.activeElement).toBe(tab);
  });

  it("si el foco ya esta dentro del modo no lo mueve", async () => {
    const view = render(<Entry />);
    view.getByText("otro").focus();
    await frames();
    expect(document.activeElement).toBe(view.getByText("otro"));
  });

  it("con una hoja abierta espera a que se cierre y despues coloca el foco", async () => {
    const sheet = document.createElement("div");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    document.body.append(sheet);
    const view = render(<Entry />);
    await frames(3);
    expect(document.activeElement).toBe(document.body);
    sheet.remove();
    await frames(3);
    expect(document.activeElement).toBe(view.getByText("objetivo"));
  });

  it("si el control aun no existe lo busca en los siguientes fotogramas", async () => {
    function Late() {
      const ref = useRef<HTMLDivElement>(null);
      useEntryFocus(ref, "[data-late]");
      return <div ref={ref} />;
    }
    const view = render(<Late />);
    await frames(2);
    const late = document.createElement("button");
    late.setAttribute("data-late", "");
    view.container.firstElementChild!.append(late);
    await frames(3);
    expect(document.activeElement).toBe(late);
  });
});

describe("useBeforeUnloadGuard", () => {
  function Guard({ active }: { active: boolean }) {
    useBeforeUnloadGuard(active);
    return null;
  }
  const fire = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };

  it("con trabajo sin aplicar cancela la salida (el navegador pregunta)", () => {
    render(<Guard active />);
    expect(fire().defaultPrevented).toBe(true);
  });

  it("sin trabajo no interviene", () => {
    render(<Guard active={false} />);
    expect(fire().defaultPrevented).toBe(false);
  });

  it("se retira al quedar limpio (aplicar o descartar) y al desmontar", () => {
    const view = render(<Guard active />);
    view.rerender(<Guard active={false} />);
    expect(fire().defaultPrevented).toBe(false);
    view.rerender(<Guard active />);
    expect(fire().defaultPrevented).toBe(true);
    view.unmount();
    expect(fire().defaultPrevented).toBe(false);
  });

  it("no apila oyentes al repintar", () => {
    const view = render(<Guard active />);
    view.rerender(<Guard active />);
    view.rerender(<Guard active />);
    view.rerender(<Guard active={false} />);
    expect(fire().defaultPrevented).toBe(false);
  });
});

describe("ModeHeader", () => {
  it("plega las notas en un desplegable cerrado y deja los avisos en una lista de una linea cada uno", () => {
    const view = render(
      <ModeHeader
        notesLabel="Que debes saber"
        notes={["nota uno", "nota dos"]}
        warningsLabel="Avisos"
        warnings={[
          { code: "a", short: "Corto A", full: "Texto completo A" },
          { code: "b", short: "Corto B", full: "Texto completo B" },
        ]}
      />,
    );
    const details = view.container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Que debes saber");
    expect(view.container.querySelectorAll("[data-pro-mode-warnings] li")).toHaveLength(2);
    // Lo corto se ve; el texto completo es para lectores de pantalla y para el `title`.
    expect(view.getByText("Texto completo A").className).toContain("sr-only");
    expect(view.container.querySelector("li")?.getAttribute("title")).toBe("Texto completo A");
  });

  it("sin avisos no pinta la lista", () => {
    const view = render(<ModeHeader notesLabel="x" notes={["n"]} warningsLabel="Avisos" warnings={[]} />);
    expect(view.container.querySelector("[data-pro-mode-warnings]")).toBeNull();
  });
});


describe("useFocusReturn", () => {
  function Mode({ show }: { show: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    return (
      <div>
        {/* En movil el visor va ANTES del dock en el DOM y no admite foco: no debe ganarle al dock. */}
        <div data-pro-region="viewer">visor</div>
        <button data-dock="home">inicio</button>
        <button data-dock="sign" aria-current="page">
          firmar
        </button>
        {show ? <Inner rootRef={ref} /> : null}
      </div>
    );
  }
  function Inner({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
    useFocusReturn(rootRef);
    return (
      <div ref={rootRef}>
        <button>descartar</button>
      </div>
    );
  }

  it("en movil el foco vuelve al boton del dock de la pestana activa, no al visor (que no lo admite)", () => {
    const view = render(<Mode show />);
    view.getByText("descartar").focus();
    view.rerender(<Mode show={false} />);
    expect(document.activeElement).toBe(view.getByText("firmar"));
  });

  it("si el foco estaba fuera del modo no lo toca", () => {
    const view = render(<Mode show />);
    view.getByText("inicio").focus();
    view.rerender(<Mode show={false} />);
    expect(document.activeElement).toBe(view.getByText("inicio"));
  });
});
