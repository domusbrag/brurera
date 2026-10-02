import type { Metadata } from "next";
import { OrderForm } from "@/components/orders/order-form";

export const metadata: Metadata = { title: "Editar pedido · Pedidos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderForm id={id} />;
}
