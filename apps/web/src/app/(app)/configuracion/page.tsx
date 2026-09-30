import type { Metadata } from "next";
import { SettingsHub } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Configuración" };

export default function Page() {
  return <SettingsHub />;
}
