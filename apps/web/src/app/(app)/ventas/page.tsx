import type { Metadata } from "next";
import { SaleList } from "@/components/sales/sale-pages";

export const metadata: Metadata = { title: "Ventas" };

export default function Page() {
  return <SaleList />;
}
