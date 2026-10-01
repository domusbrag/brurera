import type { Metadata } from "next";
import { ReceiptForm } from "@/components/purchases/purchase-form";

export const metadata: Metadata = { title: "Registrar recepción · Compras" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReceiptForm purchaseId={id} />;
}
