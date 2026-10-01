import type { Metadata } from "next";
import { ReceiptDetail } from "@/components/purchases/purchase-pages";

export const metadata: Metadata = { title: "Recepción · Compras" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; receiptId: string }>;
}) {
  const { id, receiptId } = await params;
  return <ReceiptDetail purchaseId={id} receiptId={receiptId} />;
}
