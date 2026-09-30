import type { Metadata } from "next";
import { CompanySettings } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Empresa · Configuración" };

export default function Page() {
  return <CompanySettings />;
}
