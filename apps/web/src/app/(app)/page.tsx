import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard/dashboard";

export const metadata: Metadata = { title: "Inicio" };

/** Inicio operativo: el layout ya exige sesión; el contenido depende de los permisos. */
export default function HomePage() {
  return <Dashboard />;
}
