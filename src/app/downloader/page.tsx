import type { Metadata } from "next";
import { DownloaderView } from "@/app/downloader/DownloaderView";

export const metadata: Metadata = {
  title: "Downloader",
  description:
    "Downloader de OptimusTOOLS: descargar de redes sociales necesita un servidor, por eso aún no está disponible. Qué puedes hacer mientras tanto, en tu dispositivo.",
  alternates: { canonical: "/downloader" },
};

export default function DownloaderPage() {
  return <DownloaderView />;
}
