import type { Metadata } from "next";
import { OrderDetail } from "@/components/orders/order-pages";

export const metadata: Metadata = { title: "Pedido · Pedidos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderDetail id={id} />;
}
