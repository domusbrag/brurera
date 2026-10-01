import type { Metadata } from "next";
import { DraftEdit } from "@/components/recipes/recipe-editor";

export const metadata: Metadata = { title: "Editar borrador · Recetas" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; versionId: string }>;
}) {
  const { id, versionId } = await params;
  return <DraftEdit recipeId={id} versionId={versionId} />;
}
