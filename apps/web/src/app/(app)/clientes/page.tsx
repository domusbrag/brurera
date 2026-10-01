import type { Metadata } from "next";
import { CustomerList } from "@/components/masters/customers";

export const metadata: Metadata = { title: "Clientes" };

export default function Page() {
  return <CustomerList />;
}
