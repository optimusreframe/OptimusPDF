import type { Metadata } from "next";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";

export const metadata: Metadata = {
  title: "Firmar PDF",
  description:
    "Dibuja, escribe o sube tu firma y colócala donde la necesites sobre el documento. La firma y el PDF nunca salen de tu navegador.",
  alternates: { canonical: "/sign-pdf" },
};

export default function SignPdfPage() {
  return <SignToolClient />;
}
