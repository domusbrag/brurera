import type { Metadata } from "next";
import { ProductionForm } from "@/components/production/production-form";

export const metadata: Metadata = { title: "Nueva orden · Producción" };

export default function Page() {
  return <ProductionForm />;
}
