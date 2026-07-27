import type { Metadata } from "next";
import { ProtectToolClient } from "@/app/protect-pdf/ProtectToolClient";

export const metadata: Metadata = {
  title: "Proteger PDF",
  description:
    "Cifra un PDF con contraseña sin salir de tu navegador. El archivo no se sube a ningún servidor y la contraseña no se guarda en ninguna parte.",
  alternates: { canonical: "/protect-pdf" },
};

export default function ProtectPdfPage() {
  return <ProtectToolClient />;
}
