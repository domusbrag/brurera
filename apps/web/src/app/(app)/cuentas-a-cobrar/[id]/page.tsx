import type { Metadata } from "next";
import { CustomerAccount } from "@/components/sales/account-pages";

export const metadata: Metadata = { title: "Cuenta corriente · Cuentas a cobrar" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerAccount customerId={id} />;
}
