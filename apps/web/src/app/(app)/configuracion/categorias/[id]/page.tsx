import type { Metadata } from "next";
import { CategoryDetail } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Categorías" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CategoryDetail id={id} />;
}
