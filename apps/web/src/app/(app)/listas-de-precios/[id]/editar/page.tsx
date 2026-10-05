import type { Metadata } from "next";
import { PriceListForm } from "@/components/sales/price-list-pages";

export const metadata: Metadata = { title: "Editar lista · Listas de precios" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PriceListForm id={id} />;
}
