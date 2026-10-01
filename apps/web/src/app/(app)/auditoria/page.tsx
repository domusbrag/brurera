import type { Metadata } from "next";
import { AuditLog } from "@/components/masters/audit";

export const metadata: Metadata = { title: "Auditoría" };

export default function Page() {
  return <AuditLog />;
}
