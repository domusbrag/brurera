import type { Metadata } from "next";
import { StockDetail } from "@/components/inventory/inventory-pages";

export const metadata: Metadata = { title: "Stock de materia prima · Inventario" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StockDetail id={id} />;
}
