import type { Metadata } from "next";
import { WordToPdfClient } from "@/app/word-to-pdf/WordToPdfClient";

export const metadata: Metadata = {
  title: "Word a PDF",
  description:
    "Convierte documentos DOCX a PDF conservando el formato, con texto seleccionable y buscable.",
  alternates: { canonical: "/word-to-pdf" },
};

export default function WordToPdfPage() {
  return <WordToPdfClient />;
}
