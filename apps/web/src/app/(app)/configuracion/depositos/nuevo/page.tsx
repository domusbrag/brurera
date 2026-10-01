import type { Metadata } from "next";
import { WarehouseForm } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Nuevo depósito · Depósitos" };

export default function Page() {
  return <WarehouseForm />;
}
