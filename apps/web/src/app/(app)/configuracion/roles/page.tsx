import type { Metadata } from "next";
import { RolesMatrix } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Roles y permisos · Configuración" };

export default function Page() {
  return <RolesMatrix />;
}
