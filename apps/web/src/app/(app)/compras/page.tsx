import type { Metadata } from "next";
import { PurchaseList } from "@/components/purchases/purchase-pages";

export const metadata: Metadata = { title: "Compras" };

export default function Page() {
  return <PurchaseList />;
}
