import type { Metadata } from "next";
import { UserList } from "@/components/masters/users";

export const metadata: Metadata = { title: "Usuarios" };

export default function Page() {
  return <UserList />;
}
