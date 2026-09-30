import type { Metadata } from "next";
import { UserDetail } from "@/components/masters/users";

export const metadata: Metadata = { title: "Usuarios" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetail id={id} />;
}
