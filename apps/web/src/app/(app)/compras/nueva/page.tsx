import type { Metadata } from "next";
import { PurchaseForm } from "@/components/purchases/purchase-form";

export const metadata: Metadata = { title: "Nueva compra · Compras" };

export default function Page() {
  return <PurchaseForm />;
}
