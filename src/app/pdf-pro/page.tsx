import type { Metadata } from "next";
import dynamic from "next/dynamic";

/*
 * La suite es un componente de cliente pesado (documento de trabajo, IndexedDB, motores PDF): se
 * carga con `next/dynamic` para que su codigo viaje en un trozo propio y el resto del sitio no lo
 * pague. SIN `ssr: false` (no se admite en componentes de servidor): todo lo que toca el navegador
 * (IndexedDB, File, atajos) vive en efectos y manejadores, asi que el prerenderizado es seguro.
 */
const ProToolClient = dynamic(() =>
  import("@/app/pdf-pro/ProToolClient").then((module) => module.ProToolClient),
);

const DESCRIPTION =
  "Todo en uno: organiza, edita, firma, protege y convierte tu PDF sin salir de la página. Varias tareas sobre el mismo documento, con deshacer y borrador automático, todo en tu navegador y sin subir nada.";

// `og:title` propio: el del sitio habla de «herramientas PDF» en general y esta es la suite todo en uno. La
// metadata del servidor es una sola (en español, como la del resto del sitio); la interfaz si cambia de idioma.
export const metadata: Metadata = {
  title: "PDF Pro",
  description: DESCRIPTION,
  alternates: { canonical: "/pdf-pro" },
  openGraph: {
    type: "website",
    siteName: "OptimusPDF",
    title: "PDF Pro · OptimusPDF",
    description: DESCRIPTION,
    url: "/pdf-pro",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "PDF Pro · OptimusPDF" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "PDF Pro · OptimusPDF",
    description: DESCRIPTION,
    images: ["/og-image.png"],
  },
};

export default function PdfProPage() {
  return <ProToolClient />;
}
