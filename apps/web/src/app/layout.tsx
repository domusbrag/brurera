import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/plus-jakarta-sans";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Panificadora ERP", template: "%s · Panificadora ERP" },
  description: "Gestión integral para panificadoras",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#121010",
};

/*
 * Tema: oscuro por defecto; el usuario puede pasar a claro desde la barra
 * superior (se guarda en este navegador). Se aplica antes de pintar para que no
 * parpadee.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem("tema");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-AR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
