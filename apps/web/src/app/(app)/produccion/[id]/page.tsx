import type { Metadata } from "next";
import { ProductionDetail } from "@/components/production/production-pages";

export const metadata: Metadata = { title: "Orden de producción · Producción" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductionDetail id={id} />;
}
