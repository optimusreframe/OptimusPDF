import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditWorkspace } from "@/app/edit-pdf/EditWorkspace";
import { useEditSession } from "@/app/edit-pdf/useEditSession";
import { EDIT_FLOW_STRINGS } from "@/app/edit-pdf/flowStrings";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";

/** Un PDF con cabecera valida pero contenido danado: estado de error claro, sin spinner perpetuo (W5-U5). */

vi.mock("@/app/edit-pdf/useEditDocument", () => ({
  useEditDocument: () => ({ doc: null, pageCount: 0, error: "corrupt" }),
  usePageText: () => ({ status: "idle", analysis: null }),
}));

const flow = EDIT_FLOW_STRINGS.es;
afterEach(cleanup);

function Harness({ onChooseAnother }: { onChooseAnother?: () => void }) {
  const session = useEditSession({ shortcuts: false });
  return (
    <EditWorkspace
      file={new File(["%PDF"], "roto.pdf")}
      session={session}
      strings={EDIT_STRINGS.es}
      flow={flow}
      onChooseAnother={onChooseAnother}
    />
  );
}

describe("EditWorkspace con un documento que no se puede leer", () => {
  it("no monta el lienzo ni deja un spinner: dice que esta danado", () => {
    render(<Harness onChooseAnother={vi.fn()} />);
    expect(screen.getByText(flow.documentFailed)).toBeTruthy();
    expect(document.querySelector("[data-render-state]")).toBeNull();
    expect(document.querySelector('[role="progressbar"], [data-edit-canvas]')).toBeNull();
    expect(document.querySelector("[data-edit-failed]")).not.toBeNull();
  });

  it("ofrece «Elegir otro archivo» y lo ejecuta", () => {
    const onChooseAnother = vi.fn();
    render(<Harness onChooseAnother={onChooseAnother} />);
    fireEvent.click(screen.getByRole("button", { name: "Elegir otro archivo" }));
    expect(onChooseAnother).toHaveBeenCalledTimes(1);
  });
});
