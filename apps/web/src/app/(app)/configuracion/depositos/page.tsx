import type { Metadata } from "next";
import { WarehouseList } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Depósitos" };

export default function Page() {
  return <WarehouseList />;
}
