import type { Metadata } from "next";
import { StockOperationForm } from "@/components/inventory/stock-operation";

export const metadata: Metadata = { title: "Ajustar stock · Inventario" };

export default function Page() {
  return <StockOperationForm kind="adjust" />;
}
