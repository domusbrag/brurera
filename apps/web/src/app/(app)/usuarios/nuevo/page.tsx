import type { Metadata } from "next";
import { UserCreateForm } from "@/components/masters/users";

export const metadata: Metadata = { title: "Nuevo usuario · Usuarios" };

export default function Page() {
  return <UserCreateForm />;
}
