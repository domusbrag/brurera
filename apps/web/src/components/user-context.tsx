"use client";

import type { CurrentUser, PermissionCode } from "@bakery/shared";
import { createContext, useContext, type ReactNode } from "react";

const UserContext = createContext<CurrentUser | null>(null);

export function UserProvider({ user, children }: { user: CurrentUser; children: ReactNode }) {
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

export function useCurrentUser(): CurrentUser {
  const user = useContext(UserContext);
  if (!user) throw new Error("useCurrentUser fuera de UserProvider");
  return user;
}

/**
 * Permisos del usuario para mostrar u ocultar acciones. Es solo comodidad de UI:
 * la API vuelve a autorizar cada request.
 */
export function useCan() {
  const user = useCurrentUser();
  const set = new Set(user.permissions);
  return (...codes: PermissionCode[]) => codes.every((c) => set.has(c));
}
