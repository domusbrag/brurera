import type { Metadata } from "next";
import { PriceListList } from "@/components/sales/price-list-pages";

export const metadata: Metadata = { title: "Listas de precios" };

export default function Page() {
  return <PriceListList />;
}
