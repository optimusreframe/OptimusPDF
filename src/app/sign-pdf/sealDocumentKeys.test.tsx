import { useCallback, useState } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { DocumentSessionHost } from "@/app/sign-pdf/DocumentSessionHost";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { EMPTY_DOC_STATE, docIdOf } from "@/app/sign-pdf/docSet";
import { DEFAULT_SESSION, type SignSession } from "@/app/sign-pdf/signSession";
import { useSessionBridge } from "@/app/sign-pdf/useSessionBridge";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/*
 * El anfitrion sella la huella de CADA documento (no solo la del activo) en
 * cuanto llega: la entrega conjunta (`canRun`, `process`) la lee de la sesion
 * y reacciona sola.
 */

const strings = SIGN_STRINGS.es;

function file(name: string, byte: number): File {
  return new File([new Uint8Array([byte, byte + 1, byte + 2])], name, {
    type: "application/pdf",
    lastModified: 1_700_000_000_000 + byte,
  });
}

const A = file("a.pdf", 1);
const B = file("b.pdf", 40);
const C = file("c.pdf", 90);

const keys: Record<string, string> = {};
beforeAll(async () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  for (const item of [A, B, C]) keys[docIdOf(item)] = await documentContentKey(item);
});

function Parent({
  files,
  initial = DEFAULT_SESSION,
  onSession,
}: {
  files: File[];
  initial?: SignSession;
  onSession: (session: SignSession) => void;
}) {
  const bridge = useSessionBridge();
  const [session, setSession] = useState<SignSession>(initial);
  const setShell = useCallback(
    (patch: Partial<SignSession>) => setSession((previous) => ({ ...previous, ...patch })),
    [],
  );
  onSession(session);
  return (
    <LanguageProvider>
      <DocumentSessionHost
        files={files}
        session={session}
        setShellOptions={setShell}
        bridge={bridge}
        strings={strings}
        holdMessage={null}
      >
        {() => null}
      </DocumentSessionHost>
    </LanguageProvider>
  );
}

describe("DocumentSessionHost — sella la huella de todos los documentos", () => {
  it("con varios documentos, cada uno queda sellado con SU huella (el activo y los demas)", async () => {
    let last = DEFAULT_SESSION;
    render(<Parent files={[A, B, C]} onSession={(s) => (last = s)} />);
    await waitFor(() => {
      for (const item of [A, B, C]) {
        expect(last.docs[docIdOf(item)]?.sealedKey).toBe(keys[docIdOf(item)]);
      }
    });
  });

  it("con un solo documento no se sella nada desde el anfitrion (lo hace el flujo, como siempre)", async () => {
    let last = DEFAULT_SESSION;
    render(<Parent files={[A]} onSession={(s) => (last = s)} />);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(last.docs[docIdOf(A)]?.sealedKey ?? "").toBe("");
  });

  it("no pisa una huella ya sellada (la gestiona el flujo del documento activo)", async () => {
    const sealed = { ...DEFAULT_SESSION, docs: { [docIdOf(A)]: { ...EMPTY_DOC_STATE, sealedKey: "huella-previa" } } };
    let last: SignSession = sealed;
    render(<Parent files={[A, B]} initial={sealed} onSession={(s) => (last = s)} />);
    await waitFor(() => expect(last.docs[docIdOf(B)]?.sealedKey).toBe(keys[docIdOf(B)]));
    expect(last.docs[docIdOf(A)].sealedKey).toBe("huella-previa");
  });

  it("un documento que sale de la cola antes de que llegue su huella no deja estado", async () => {
    let last = DEFAULT_SESSION;
    const { rerender } = render(<Parent files={[A, B, C]} onSession={(s) => (last = s)} />);
    rerender(<Parent files={[A, B]} onSession={(s) => (last = s)} />);
    await waitFor(() => expect(last.docs[docIdOf(B)]?.sealedKey).toBe(keys[docIdOf(B)]));
    expect(last.docs[docIdOf(C)]).toBeUndefined();
  });
});
