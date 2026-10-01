import type { Metadata } from "next";
import { ProductDetail } from "@/components/masters/items";

export const metadata: Metadata = { title: "Productos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProductDetail id={id} />;
}
