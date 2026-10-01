import type { Metadata } from "next";
import { ProductList } from "@/components/masters/items";

export const metadata: Metadata = { title: "Productos" };

export default function Page() {
  return <ProductList />;
}
