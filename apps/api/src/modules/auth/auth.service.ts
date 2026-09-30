import {
  companies,
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
  type Database,
} from "@bakery/database";
import type { CurrentUser } from "@bakery/shared";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { AUDIT_ACTIONS, recordAudit } from "../audit/audit.service.js";
import { getDummyHash, verifyPassword } from "./password.js";
import { generateSessionToken, hashSessionToken } from "./session-token.js";

export interface RequestMeta {
  requestId: string;
  ipAddress: string;
  userAgent: string | undefined;
}

export interface AuthContext {
  sessionId: string;
  user: CurrentUser;
  permissions: Set<string>;
}

/** Intervalo mínimo entre actualizaciones de last_seen_at, para no escribir en cada request. */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessionTtlMs: number,
  ) {}

  /**
   * Verifica credenciales y crea una sesión. Devuelve null ante cualquier fallo
   * (usuario inexistente, deshabilitado o contraseña incorrecta) sin distinguir
   * el motivo hacia afuera, para no permitir enumeración de usuarios.
   */
  async login(
    email: string,
    password: string,
    meta: RequestMeta,
  ): Promise<{ token: string; expiresAt: Date; user: CurrentUser } | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);

    const passwordOk = user
      ? await verifyPassword(user.passwordHash, password)
      : await verifyPassword(await getDummyHash(), password).then(() => false);

    if (!user || !passwordOk || user.status !== "ACTIVE") {
      await recordAudit(this.db, {
        companyId: user?.companyId ?? null,
        actorUserId: null,
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        entityType: "user",
        entityId: user?.id ?? null,
        metadata: {
          email,
          reason: !user ? "UNKNOWN_USER" : !passwordOk ? "BAD_PASSWORD" : "USER_DISABLED",
        },
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
      });
      return null;
    }

    const token = generateSessionToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);

    await this.db.transaction(async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({
          userId: user.id,
          tokenHash: hashSessionToken(token),
          expiresAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent?.slice(0, 500),
        })
        .returning({ id: sessions.id });
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      await recordAudit(tx, {
        companyId: user.companyId,
        actorUserId: user.id,
        action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
        entityType: "session",
        entityId: session?.id ?? null,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
      });
    });

    const context = await this.loadUserContext(user.id);
    if (!context) throw new Error(`Usuario ${user.id} sin empresa válida`);
    return { token, expiresAt, user: context.user };
  }

  /** Resuelve la sesión a partir del token de la cookie. Null si no es válida. */
  async authenticate(token: string): Promise<AuthContext | null> {
    const now = new Date();
    const [row] = await this.db
      .select({ sessionId: sessions.id, userId: sessions.userId, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(users.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!row) return null;

    if (now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
    }

    const context = await this.loadUserContext(row.userId);
    if (!context) return null;
    return { sessionId: row.sessionId, ...context };
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, auth.sessionId), isNull(sessions.revokedAt)));
      await recordAudit(tx, {
        companyId: auth.user.company.id,
        actorUserId: auth.user.id,
        action: AUDIT_ACTIONS.AUTH_LOGOUT,
        entityType: "session",
        entityId: auth.sessionId,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
      });
    });
  }

  /** Carga usuario, empresa, roles y permisos efectivos en dos consultas. */
  private async loadUserContext(
    userId: string,
  ): Promise<{ user: CurrentUser; permissions: Set<string> } | null> {
    const [base] = await this.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        companyId: companies.id,
        tradeName: companies.tradeName,
      })
      .from(users)
      .innerJoin(companies, eq(companies.id, users.companyId))
      .where(eq(users.id, userId))
      .limit(1);
    if (!base) return null;

    const grants = await this.db
      .select({ roleCode: roles.code, roleName: roles.name, permissionCode: permissions.code })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(userRoles.userId, userId));

    const roleMap = new Map<string, string>();
    const permissionSet = new Set<string>();
    for (const g of grants) {
      roleMap.set(g.roleCode, g.roleName);
      if (g.permissionCode) permissionSet.add(g.permissionCode);
    }

    return {
      permissions: permissionSet,
      user: {
        id: base.id,
        email: base.email,
        displayName: base.displayName,
        company: { id: base.companyId, tradeName: base.tradeName },
        roles: [...roleMap]
          .map(([code, name]) => ({ code, name }))
          .sort((a, b) => a.code.localeCompare(b.code)),
        permissions: [...permissionSet].sort(),
      },
    };
  }
}
