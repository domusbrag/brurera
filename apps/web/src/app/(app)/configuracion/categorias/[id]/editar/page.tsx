import type { Metadata } from "next";
import { CategoryForm } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Editar categoría · Categorías" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CategoryForm id={id} />;
}
