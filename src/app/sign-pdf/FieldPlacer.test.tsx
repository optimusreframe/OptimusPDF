import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FieldPlacer } from "@/app/sign-pdf/FieldPlacer";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { SignatureField, SignatureFieldType, Signer } from "@/lib/pdf/sign";

/**
 * El lienzo solo acepta interacciones cuando ya tiene la pagina pintada,
 * y esa parte es pdf.js con su worker: fuera del navegador no arranca. Se
 * sustituyen las tres funciones de render de `core.ts` por el minimo que
 * el componente necesita; lo que se comprueba aqui es la manipulacion de
 * los campos, no el rasterizado.
 */
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({
      numPages: 2,
      getPage: async () => ({ cleanup: () => {} }),
    }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
  };
});

const strings = SIGN_STRINGS.es;

const HOST_WIDTH = 600;
const HOST_HEIGHT = 800;

beforeAll(() => {
  // jsdom no hace layout: sin caja medible el lienzo no sabe traducir
  // pixeles a fracciones de pagina.
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return {
      width: HOST_WIDTH,
      height: HOST_HEIGHT,
      top: 0,
      left: 0,
      right: HOST_WIDTH,
      bottom: HOST_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

/** Una sola instancia: `FieldPlacer` se remonta si cambia la identidad del archivo. */
const FILE = new File([new Uint8Array([1, 2, 3])], "contrato.pdf", {
  type: "application/pdf",
});

type HarnessProps = {
  onFieldsChange: (fields: SignatureField[]) => void;
  initialFields?: SignatureField[];
  activeSignerId?: string | null;
};

function Harness({
  onFieldsChange,
  initialFields = [],
  activeSignerId = ANA.id,
}: HarnessProps) {
  const [fields, setFields] = useState<SignatureField[]>(initialFields);
  const [type, setType] = useState<SignatureFieldType>("signature");
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <FieldPlacer
      file={FILE}
      signers={[ANA, LUIS]}
      activeSignerId={activeSignerId}
      fields={fields}
      onFieldsChange={(next) => {
        setFields(next);
        onFieldsChange(next);
      }}
      activeType={type}
      onActiveTypeChange={setType}
      pageIndex={pageIndex}
      onPageIndexChange={setPageIndex}
      selectedId={selectedId}
      onSelectedIdChange={setSelectedId}
      strings={strings}
    />
  );
}

/** Espera a que la vista previa simulada este montada. */
async function waitForPreview() {
  await waitFor(() =>
    expect(screen.getByAltText(strings.fieldsTitle)).toBeTruthy(),
  );
}

const signatureLabel = strings.fieldOwnerLabel(ANA.name, strings.fieldSignature);
const initialsLabel = strings.fieldOwnerLabel(ANA.name, strings.fieldInitials);

describe("FieldPlacer — src/app/sign-pdf/FieldPlacer.tsx", () => {
  it("crear un campo lo añade al array con el firmante y el tipo activos", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );

    expect(last).toHaveLength(1);
    expect(last[0].signerId).toBe(ANA.id);
    expect(last[0].type).toBe("signature");
    expect(last[0].pageIndex).toBe(0);
    expect(last[0].rect.width).toBeGreaterThan(0);
    expect(last[0].rect.height).toBeGreaterThan(0);
    expect(screen.getByRole("group", { name: signatureLabel })).toBeTruthy();
  });

  it("el tipo activo manda sobre el campo siguiente", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("radio", { name: strings.fieldInitials }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );

    expect(last[0].type).toBe("initials");
    expect(screen.getByRole("group", { name: initialsLabel })).toBeTruthy();
  });

  it("arrastrar un campo actualiza su rectangulo sin tocar los demas", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );
    const before = last[0].rect;

    const box = screen.getByRole("group", { name: signatureLabel });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 300, clientY: 600 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 240, clientY: 520 });
    fireEvent.pointerUp(box, { pointerId: 1 });

    expect(last).toHaveLength(1);
    expect(last[0].rect.x).toBeCloseTo(before.x - 60 / HOST_WIDTH, 5);
    expect(last[0].rect.y).toBeCloseTo(before.y - 80 / HOST_HEIGHT, 5);
    // Mover no redimensiona.
    expect(last[0].rect.width).toBeCloseTo(before.width, 6);
    expect(last[0].rect.height).toBeCloseTo(before.height, 6);
  });

  it("un campo no se sale de la pagina al arrastrarlo", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );

    const box = screen.getByRole("group", { name: signatureLabel });
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 300, clientY: 600 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: -5000, clientY: -5000 });
    fireEvent.pointerUp(box, { pointerId: 1 });

    expect(last[0].rect.x).toBe(0);
    expect(last[0].rect.y).toBe(0);
  });

  it("arrastrar sobre la pagina dibuja un campo con el rectangulo recorrido", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    const host = screen.getByAltText(strings.fieldsTitle).parentElement!;
    fireEvent.pointerDown(host, { pointerId: 2, clientX: 60, clientY: 80 });
    fireEvent.pointerMove(host, { pointerId: 2, clientX: 360, clientY: 240 });
    fireEvent.pointerUp(host, { pointerId: 2, clientX: 360, clientY: 240 });

    expect(last).toHaveLength(1);
    expect(last[0].rect.x).toBeCloseTo(60 / HOST_WIDTH, 5);
    expect(last[0].rect.y).toBeCloseTo(80 / HOST_HEIGHT, 5);
    expect(last[0].rect.width).toBeCloseTo(300 / HOST_WIDTH, 5);
    expect(last[0].rect.height).toBeCloseTo(160 / HOST_HEIGHT, 5);
  });

  it("borrar el campo seleccionado lo saca del array", async () => {
    let last: SignatureField[] = [];
    render(<Harness onFieldsChange={(fields) => (last = fields)} />);
    await waitForPreview();

    fireEvent.click(
      screen.getByRole("button", { name: strings.addFieldHere }),
    );
    expect(last).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: strings.removeField }));

    expect(last).toHaveLength(0);
    expect(screen.queryByRole("group", { name: signatureLabel })).toBeNull();
  });

  it("sin firmante activo no se puede reservar nada", async () => {
    render(<Harness onFieldsChange={() => {}} activeSignerId={null} />);
    await waitForPreview();

    const button = screen.getByRole("button", {
      name: strings.addFieldHere,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(strings.needSigner)).toBeTruthy();
  });
});
