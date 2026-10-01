import type { Metadata } from "next";
import { RecipeDetail } from "@/components/recipes/recipe-pages";

export const metadata: Metadata = { title: "Receta · Recetas" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RecipeDetail id={id} />;
}
