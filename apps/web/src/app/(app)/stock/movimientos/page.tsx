import type { Metadata } from "next";
import { MovementList } from "@/components/inventory/inventory-pages";

export const metadata: Metadata = { title: "Movimientos · Inventario" };

export default function Page() {
  return <MovementList />;
}
