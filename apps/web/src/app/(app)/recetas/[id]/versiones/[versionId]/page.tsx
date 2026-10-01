import type { Metadata } from "next";
import { VersionDetail } from "@/components/recipes/recipe-pages";

export const metadata: Metadata = { title: "Versión · Recetas" };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; versionId: string }>;
}) {
  const { id, versionId } = await params;
  return <VersionDetail recipeId={id} versionId={versionId} />;
}
