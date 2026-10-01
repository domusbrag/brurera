import type { Metadata } from "next";
import { PurchaseForm } from "@/components/purchases/purchase-form";

export const metadata: Metadata = { title: "Editar compra · Compras" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PurchaseForm id={id} />;
}
