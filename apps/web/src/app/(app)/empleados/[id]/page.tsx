import type { Metadata } from "next";
import { EmployeeDetail } from "@/components/masters/employees";

export const metadata: Metadata = { title: "Empleados" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EmployeeDetail id={id} />;
}
