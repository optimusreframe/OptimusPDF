import type { Metadata } from "next";
import { PageNumbersToolClient } from "@/app/add-page-numbers/PageNumbersToolClient";

export const metadata: Metadata = {
  title: "Numerar páginas de un PDF",
  description:
    "Añade números de página a tu PDF eligiendo posición, margen, formato, tipografía y desde qué número empezar. Sin subir el archivo a ningún servidor.",
  alternates: { canonical: "/add-page-numbers" },
};

export default function AddPageNumbersPage() {
  return <PageNumbersToolClient />;
}
