import type { Metadata } from "next";
import { PurchaseDetail } from "@/components/purchases/purchase-pages";

export const metadata: Metadata = { title: "Compra · Compras" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PurchaseDetail id={id} />;
}
