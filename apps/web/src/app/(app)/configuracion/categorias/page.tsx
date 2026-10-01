import type { Metadata } from "next";
import { CategoryList } from "@/components/masters/settings";

export const metadata: Metadata = { title: "Categorías" };

export default function Page() {
  return <CategoryList />;
}
