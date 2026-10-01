import type { Metadata } from "next";
import { EmployeeForm } from "@/components/masters/employees";

export const metadata: Metadata = { title: "Nuevo empleado · Empleados" };

export default function Page() {
  return <EmployeeForm />;
}
