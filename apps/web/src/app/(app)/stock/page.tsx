import type { Metadata } from "next";
import { StockList } from "@/components/inventory/inventory-pages";

export const metadata: Metadata = { title: "Stock · Inventario" };

export default function Page() {
  return <StockList />;
}
