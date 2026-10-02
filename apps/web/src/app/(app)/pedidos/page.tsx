import type { Metadata } from "next";
import { OrderList } from "@/components/orders/order-pages";

export const metadata: Metadata = { title: "Pedidos" };

export default function Page() {
  return <OrderList />;
}
