import type { Metadata } from "next";
import { EmployeeForm } from "@/components/masters/employees";

export const metadata: Metadata = { title: "Editar empleado · Empleados" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EmployeeForm id={id} />;
}
