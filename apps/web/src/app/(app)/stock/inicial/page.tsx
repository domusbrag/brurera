import type { Metadata } from "next";
import { StockOperationForm } from "@/components/inventory/stock-operation";

export const metadata: Metadata = { title: "Cargar stock inicial · Inventario" };

export default function Page() {
  return <StockOperationForm kind="initial" />;
}
