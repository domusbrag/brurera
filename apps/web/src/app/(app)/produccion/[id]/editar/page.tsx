import type { Metadata } from "next";
import { ProductionForm } from "@/components/production/production-form";

export const metadata: Metadata = { title: "Editar orden · Producción" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductionForm id={id} />;
}
