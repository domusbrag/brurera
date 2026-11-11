import type { Metadata } from "next";
import { CategoryForm } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Nueva categoría · Categorías" };

export default function Page() {
  return <CategoryForm />;
}
