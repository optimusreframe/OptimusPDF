import type { Metadata } from "next";
import { RedactToolClient } from "@/app/redact-pdf/RedactToolClient";

export const metadata: Metadata = {
  title: "Censurar PDF",
  description:
    "Tapa datos sensibles dibujando zonas sobre la página y aplana el resultado para que lo censurado desaparezca del archivo. Todo en tu navegador.",
  alternates: { canonical: "/redact-pdf" },
};

export default function RedactPdfPage() {
  return <RedactToolClient />;
}
