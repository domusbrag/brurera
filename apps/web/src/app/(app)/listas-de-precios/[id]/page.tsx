import type { Metadata } from "next";
import { PriceListDetail } from "@/components/sales/price-list-pages";

export const metadata: Metadata = { title: "Lista de precios" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PriceListDetail id={id} />;
}
