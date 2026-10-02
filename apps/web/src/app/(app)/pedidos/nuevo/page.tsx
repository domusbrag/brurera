import type { Metadata } from "next";
import { OrderForm } from "@/components/orders/order-form";

export const metadata: Metadata = { title: "Nuevo pedido · Pedidos" };

export default function Page() {
  return <OrderForm />;
}
