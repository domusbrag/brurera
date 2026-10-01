import type { Metadata } from "next";
import { ProductionList } from "@/components/production/production-pages";

export const metadata: Metadata = { title: "Órdenes · Producción" };

export default function Page() {
  return <ProductionList />;
}
