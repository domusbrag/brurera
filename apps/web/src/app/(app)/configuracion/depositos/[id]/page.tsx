import type { Metadata } from "next";
import { WarehouseDetail } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Depósitos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WarehouseDetail id={id} />;
}
