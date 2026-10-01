import type { Metadata } from "next";
import { LotDetail } from "@/components/lots/lot-pages";

export const metadata: Metadata = { title: "Lote · Inventario" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LotDetail id={id} />;
}
