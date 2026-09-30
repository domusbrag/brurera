import type { Metadata } from "next";
import { ProductForm } from "@/components/masters/items";

export const metadata: Metadata = { title: "Nuevo producto · Productos" };

export default function Page() {
  return <ProductForm />;
}
