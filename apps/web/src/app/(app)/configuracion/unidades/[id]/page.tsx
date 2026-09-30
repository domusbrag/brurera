import type { Metadata } from "next";
import { UnitDetail } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Unidades de medida" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UnitDetail id={id} />;
}
