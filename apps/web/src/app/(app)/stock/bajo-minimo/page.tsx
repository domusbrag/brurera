import type { Metadata } from "next";
import { LowStockList } from "@/components/inventory/inventory-pages";

export const metadata: Metadata = { title: "Stock bajo mínimo · Inventario" };

export default function Page() {
  return <LowStockList />;
}
