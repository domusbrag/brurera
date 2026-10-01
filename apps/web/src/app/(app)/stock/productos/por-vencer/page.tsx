import type { Metadata } from "next";
import { ExpiringList } from "@/components/lots/lot-pages";

export const metadata: Metadata = { title: "Próximos a vencer · Inventario" };

export default function Page() {
  return <ExpiringList />;
}
