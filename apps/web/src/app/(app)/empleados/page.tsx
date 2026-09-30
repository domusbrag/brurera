import type { Metadata } from "next";
import { EmployeeList } from "@/components/masters/employees";

export const metadata: Metadata = { title: "Empleados" };

export default function Page() {
  return <EmployeeList />;
}
