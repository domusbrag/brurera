import type { Metadata } from "next";
import { RecipeCreate } from "@/components/recipes/recipe-editor";

export const metadata: Metadata = { title: "Nueva receta · Recetas" };

export default function Page() {
  return <RecipeCreate />;
}
