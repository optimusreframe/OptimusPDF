import type { Metadata } from "next";
import { UnlockToolClient } from "@/app/unlock-pdf/UnlockToolClient";

export const metadata: Metadata = {
  title: "Desbloquear PDF",
  description:
    "Quita la contraseña de un PDF que ya conoces, sin subir el archivo a ningún servidor. No rompe cifrados: necesitas la contraseña.",
  alternates: { canonical: "/unlock-pdf" },
};

export default function UnlockPdfPage() {
  return <UnlockToolClient />;
}
