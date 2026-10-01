import type { Metadata } from "next";
import { ConservationForm } from "@/components/lots/conservation";

export const metadata: Metadata = { title: "Conservación · Productos" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ConservationForm productId={id} />;
}
