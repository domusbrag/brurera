import type { Metadata } from "next";
import { OrdersAtRisk } from "@/components/orders/planning-pages";

export const metadata: Metadata = { title: "Pedidos en riesgo · Necesidades" };

export default function Page() {
  return <OrdersAtRisk />;
}
