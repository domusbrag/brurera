import type { Metadata } from "next";
import { NewSale } from "@/components/sales/sale-form";

export const metadata: Metadata = { title: "Nueva venta · Ventas" };

export default function Page() {
  return <NewSale />;
}
