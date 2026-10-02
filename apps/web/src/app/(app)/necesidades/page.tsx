import type { Metadata } from "next";
import { ProductionNeeds } from "@/components/orders/planning-pages";

export const metadata: Metadata = { title: "Producción · Necesidades" };

export default function Page() {
  return <ProductionNeeds />;
}
