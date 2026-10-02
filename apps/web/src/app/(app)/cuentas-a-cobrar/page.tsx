import type { Metadata } from "next";
import { ReceivableList } from "@/components/sales/account-pages";

export const metadata: Metadata = { title: "Cuentas a cobrar" };

export default function Page() {
  return <ReceivableList />;
}
