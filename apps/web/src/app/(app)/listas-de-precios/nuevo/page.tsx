import type { Metadata } from "next";
import { PriceListForm } from "@/components/sales/price-list-pages";

export const metadata: Metadata = { title: "Nueva lista · Listas de precios" };

export default function Page() {
  return <PriceListForm />;
}
