import type { Metadata } from "next";
import { ProductStockDetail } from "@/components/inventory/product-stock-pages";

export const metadata: Metadata = { title: "Stock de producto · Inventario" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductStockDetail id={id} />;
}
