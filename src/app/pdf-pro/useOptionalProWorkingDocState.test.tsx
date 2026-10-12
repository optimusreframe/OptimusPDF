import { describe, expect, it } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { ProWorkingDocProvider, useOptionalProWorkingDocState } from "@/app/pdf-pro/useProWorkingDoc";
import { createProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";
import { LanguageProvider } from "@/lib/i18n";

/** `useOptionalProWorkingDocState` (Wave 7 · U7): el estado del documento de trabajo si hay proveedor, `null` sin lanzar si no. */

describe("useOptionalProWorkingDocState", () => {
  it("fuera de un proveedor devuelve null y no lanza", () => {
    const { result } = renderHook(() => useOptionalProWorkingDocState());
    expect(result.current).toBeNull();
  });

  it("con proveedor y sin documento abierto devuelve el estado vacio", () => {
    const doc = createProWorkingDoc();
    const { result } = renderHook(() => useOptionalProWorkingDocState(), {
      wrapper: ({ children }) => (
        <LanguageProvider>
          <ProWorkingDocProvider doc={doc} shortcuts={false}>
            {children}
          </ProWorkingDocProvider>
        </LanguageProvider>
      ),
    });
    expect(result.current?.document).toBeNull();
    expect(result.current?.dirty).toBe(false);
  });

  it("con documento abierto expone las firmas digitales y si estaba cifrado", async () => {
    const doc = fakeDoc({ inspectSignatures: async () => "active" });
    await doc.open(fakeFile(), { encrypted: true });
    const { result } = renderHook(() => useOptionalProWorkingDocState(), {
      wrapper: ({ children }) => (
        <LanguageProvider>
          <ProWorkingDocProvider doc={doc} shortcuts={false}>
            {children}
          </ProWorkingDocProvider>
        </LanguageProvider>
      ),
    });
    expect(result.current?.document?.signatures).toBe("active");
    expect(result.current?.document?.wasEncrypted).toBe(true);
  });

  it("se actualiza cuando el documento cambia (un snapshot nuevo)", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile());
    const { result } = renderHook(() => useOptionalProWorkingDocState(), {
      wrapper: ({ children }) => (
        <LanguageProvider>
          <ProWorkingDocProvider doc={doc} shortcuts={false}>
            {children}
          </ProWorkingDocProvider>
        </LanguageProvider>
      ),
    });
    expect(result.current?.canUndo).toBe(false);
    await act(async () => {
      await doc.commit(fakeBytes(80, 2), "Cambio", "operation");
    });
    expect(result.current?.canUndo).toBe(true);
    expect(result.current?.dirty).toBe(true);
  });

  it("un componente que lo usa se repinta al cerrar el documento", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(64, "a.pdf"));
    function Probe() {
      const state = useOptionalProWorkingDocState();
      return <p data-testid="nombre">{state?.document?.name ?? "sin documento"}</p>;
    }
    const view = render(
      <LanguageProvider>
        <ProWorkingDocProvider doc={doc} shortcuts={false}>
          <Probe />
        </ProWorkingDocProvider>
      </LanguageProvider>,
    );
    expect(view.getByTestId("nombre").textContent).toBe("a.pdf");
    act(() => doc.close());
    expect(view.getByTestId("nombre").textContent).toBe("sin documento");
  });
});
