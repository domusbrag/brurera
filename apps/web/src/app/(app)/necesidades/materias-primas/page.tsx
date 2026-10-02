import type { Metadata } from "next";
import { MaterialNeeds } from "@/components/orders/planning-pages";

export const metadata: Metadata = { title: "Materias primas · Necesidades" };

export default function Page() {
  return <MaterialNeeds />;
}
