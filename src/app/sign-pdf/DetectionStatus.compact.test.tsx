import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DetectionStatus } from "@/app/sign-pdf/DocumentSessionParts";
import { CanvasCompactContext } from "@/app/sign-pdf/canvasCompact";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";

/**
 * B1: en el lienzo compacto de PDF Pro, «Buscando campos…» es UNA linea (no una tarjeta de ~60 px) para que, al
 * terminar la deteccion, la hoja no salte. Fuera del compacto es la tarjeta de siempre.
 */

afterEach(cleanup);

const strings = SIGN_STRINGS.es;

function renderStatus(compact: boolean, props: Partial<Parameters<typeof DetectionStatus>[0]> = {}) {
  return render(
    <CanvasCompactContext.Provider value={compact}>
      <DetectionStatus detecting failed={false} detectedCount={0} strings={strings} {...props} />
    </CanvasCompactContext.Provider>,
  );
}

describe("DetectionStatus · compacto", () => {
  it("detectando: una linea sin tarjeta", () => {
    renderStatus(true);
    const line = screen.getByText(strings.detectingFields);
    expect(line.tagName).toBe("P");
    expect(line.closest(".surface-card")).toBeNull();
    expect(line.hasAttribute("data-detecting")).toBe(true);
  });

  it("no compacto: la tarjeta de siempre", () => {
    renderStatus(false);
    const line = screen.getByText(strings.detectingFields);
    expect(line.closest(".surface-card")).not.toBeNull();
    expect(document.querySelector("[data-detecting]")).toBeNull();
  });

  it("el texto se anuncia una sola vez (una region viva) en los dos casos", () => {
    for (const compact of [true, false]) {
      renderStatus(compact);
      expect(screen.getAllByRole("status")).toHaveLength(1);
      expect(screen.getAllByText(strings.detectingFields).length).toBeGreaterThanOrEqual(1);
      cleanup();
    }
  });

  it("terminado: el resumen de campos detectados es el mismo en los dos", () => {
    for (const compact of [true, false]) {
      renderStatus(compact, { detecting: false, detectedCount: 3 });
      expect(screen.getByText(strings.detectedFieldsSummary(3))).toBeTruthy();
      expect(screen.queryByText(strings.detectingFields)).toBeNull();
      cleanup();
    }
  });
});
