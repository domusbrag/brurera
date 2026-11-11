import type { Metadata } from "next";
import { ProductSetup } from "@/components/masters/product-setup";

export const metadata: Metadata = { title: "Nuevo producto · Productos" };

export default function Page() {
  return <ProductSetup />;
}
