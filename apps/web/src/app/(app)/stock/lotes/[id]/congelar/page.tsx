import type { Metadata } from "next";
import { LotOperationForm } from "@/components/lots/lot-pages";

export const metadata: Metadata = { title: "Congelar · Inventario" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LotOperationForm id={id} kind="freeze" />;
}
