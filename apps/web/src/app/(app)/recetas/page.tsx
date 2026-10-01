import type { Metadata } from "next";
import { RecipeList } from "@/components/recipes/recipe-pages";

export const metadata: Metadata = { title: "Recetas" };

export default function Page() {
  return <RecipeList />;
}
