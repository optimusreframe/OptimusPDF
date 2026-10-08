import type { Metadata, Viewport } from "next";
import { Caveat, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/layout/Providers";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { Footer } from "@/components/layout/Footer";
import { MobileTabBar } from "@/components/layout/MobileTabBar";

/*
 * La fuente de texto es la del sistema (SF Pro en Apple, Segoe UI en
 * Windows, Roboto en Android): la define --font-sans en globals.css y no
 * requiere descarga. Solo se autoalojan la mono (codigos, hashes) y la
 * manuscrita (firmas).
 */
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
  // Desde W1-D ninguna etiqueta usa la fuente mono (la tipografia HUD ya no
  // existe): queda para datos puntuales, asi que no se precarga en cada
  // pagina; el navegador la baja solo si algo la pide.
  preload: false,
});

/** Cursiva manuscrita para firmas (la consume /sign-pdf). */
const caveat = Caveat({
  variable: "--font-caveat",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://optimuspdf.app"),
  title: {
    default: "OptimusPDF — Herramientas PDF sin subir archivos",
    template: "%s · OptimusPDF",
  },
  description:
    "Suite completa de herramientas PDF que se ejecuta entera en tu navegador: unir, dividir, comprimir, convertir, firmar y proteger sin subir un solo archivo.",
  applicationName: "OptimusPDF",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "OptimusPDF",
    statusBarStyle: "black-translucent",
  },
  formatDetection: { telephone: false },
  openGraph: {
    type: "website",
    siteName: "OptimusPDF",
    title: "OptimusPDF — Herramientas PDF sin subir archivos",
    description:
      "Procesa tus PDF sin que salgan del dispositivo. Sin cuentas, sin servidores, sin límites diarios.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "OptimusPDF",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "OptimusPDF — Herramientas PDF sin subir archivos",
    description:
      "Procesa tus PDF sin que salgan del dispositivo. Sin cuentas, sin servidores, sin límites diarios.",
    images: ["/og-image.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    // Deben coincidir con --color-background de cada tema en globals.css.
    { media: "(prefers-color-scheme: light)", color: "#f5f5f5" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${jetbrainsMono.variable} ${caveat.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col bg-background text-foreground antialiased">
        <Providers>
          <div className="flex flex-1">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <Header />
              <main id="content" className="flex-1">
                {children}
              </main>
              <Footer />
              {/* Reserva del alto de la tab bar fija en movil. */}
              <div
                aria-hidden="true"
                className="md:hidden"
                style={{
                  height: "calc(4.5rem + env(safe-area-inset-bottom, 0px))",
                }}
              />
            </div>
          </div>
          <MobileTabBar />
        </Providers>
      </body>
    </html>
  );
}
