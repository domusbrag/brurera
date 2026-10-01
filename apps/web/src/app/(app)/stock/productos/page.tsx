import type { Metadata } from "next";
import { ProductStockList } from "@/components/inventory/product-stock-pages";

export const metadata: Metadata = { title: "Productos terminados · Inventario" };

export default function Page() {
  return <ProductStockList />;
}
