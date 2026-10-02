import type { Metadata } from "next";
import { OrderReplan } from "@/components/orders/order-replan";

export const metadata: Metadata = { title: "Modificar pedido · Pedidos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderReplan id={id} />;
}
