import type { Metadata } from "next";
import { ExtractPagesToolClient } from "@/app/extract-pages/ExtractPagesToolClient";

export const metadata: Metadata = {
  title: "Extraer páginas de un PDF",
  description:
    "Saca las páginas que necesitas en un PDF nuevo, o una por documento en un ZIP. Todo el proceso ocurre en tu navegador.",
  alternates: { canonical: "/extract-pages" },
};

export default function ExtractPagesPage() {
  return <ExtractPagesToolClient />;
}
