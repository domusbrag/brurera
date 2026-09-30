import {
  companies,
  companyMemberships,
  membershipRoles,
  permissions,
  rolePermissions,
  roles,
  sessions,
  users,
  type Database,
} from "@bakery/database";
import type { CurrentUser } from "@bakery/shared";
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../audit/audit.service.js";
import { getDummyHash, verifyPassword } from "./password.js";
import { generateSessionToken, hashSessionToken } from "./session-token.js";

export interface RequestMeta {
  requestId: string;
  ipAddress: string;
  userAgent: string | undefined;
}

export interface AuthContext {
  sessionId: string;
  membershipId: string;
  companyTimezone: string;
  user: CurrentUser;
  permissions: Set<string>;
}

/** Intervalo mínimo entre actualizaciones de last_seen_at, para no escribir en cada request. */
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

type LoginFailureReason =
  "UNKNOWN_USER" | "BAD_PASSWORD" | "USER_DISABLED" | "NO_ACTIVE_MEMBERSHIP";

/**
 * Autenticación y resolución de autoridad:
 *   usuario (identidad global) → membresía activa en la empresa de la sesión
 *   → roles de esa membresía → permisos.
 */
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessionTtlMs: number,
  ) {}

  /**
   * Verifica credenciales y crea una sesión en la empresa de la primera membresía
   * activa del usuario (el MVP no ofrece selector de empresa). Devuelve null ante
   * cualquier fallo sin distinguir el motivo hacia afuera.
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

    const [membership] = user
      ? await this.db
          .select({ id: companyMemberships.id, companyId: companyMemberships.companyId })
          .from(companyMemberships)
          .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
          .where(
            and(
              eq(companyMemberships.userId, user.id),
              eq(companyMemberships.status, "ACTIVE"),
              eq(companies.active, true),
            ),
          )
          .orderBy(asc(companyMemberships.createdAt))
          .limit(1)
      : [];

    let failure: LoginFailureReason | null = null;
    if (!user) failure = "UNKNOWN_USER";
    else if (!passwordOk) failure = "BAD_PASSWORD";
    else if (user.status !== "ACTIVE") failure = "USER_DISABLED";
    else if (!membership) failure = "NO_ACTIVE_MEMBERSHIP";

    if (failure || !user || !membership) {
      await recordAudit(this.db, {
        companyId: membership?.companyId ?? null,
        actorUserId: null,
        action: "AUTH_LOGIN_FAILED",
        entityType: "user",
        entityId: user?.id ?? null,
        metadata: { email, reason: failure },
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
          companyId: membership.companyId,
          tokenHash: hashSessionToken(token),
          expiresAt,
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent?.slice(0, 500),
        })
        .returning({ id: sessions.id });
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
      await recordAudit(tx, {
        companyId: membership.companyId,
        actorUserId: user.id,
        action: "AUTH_LOGIN_SUCCEEDED",
        entityType: "session",
        entityId: session?.id ?? null,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
      });
    });

    const context = await this.loadContext(user.id, membership.companyId);
    if (!context) throw new Error(`Membresía ${membership.id} desapareció durante el login`);
    return { token, expiresAt, user: context.user };
  }

  /**
   * Resuelve la sesión a partir del token de la cookie. Es válida solo si no
   * expiró ni fue revocada, el usuario está activo y su membresía en la empresa
   * de la sesión sigue activa. Null si no.
   */
  async authenticate(token: string): Promise<AuthContext | null> {
    const now = new Date();
    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        companyId: sessions.companyId,
        lastSeenAt: sessions.lastSeenAt,
      })
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

    const context = await this.loadContext(row.userId, row.companyId);
    if (!context) return null;

    if (now.getTime() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
      await this.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
    }
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
        action: "AUTH_LOGOUT",
        entityType: "session",
        entityId: auth.sessionId,
        requestId: meta.requestId,
        ipAddress: meta.ipAddress,
      });
    });
  }

  /**
   * Autoridad del usuario en una empresa: membresía activa (en empresa activa),
   * sus roles y la unión de sus permisos. Dos consultas, sin N+1.
   */
  private async loadContext(
    userId: string,
    companyId: string,
  ): Promise<Omit<AuthContext, "sessionId"> | null> {
    const [base] = await this.db
      .select({
        membershipId: companyMemberships.id,
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        companyId: companies.id,
        tradeName: companies.tradeName,
        timezone: companies.timezone,
      })
      .from(companyMemberships)
      .innerJoin(users, eq(users.id, companyMemberships.userId))
      .innerJoin(companies, eq(companies.id, companyMemberships.companyId))
      .where(
        and(
          eq(companyMemberships.userId, userId),
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.status, "ACTIVE"),
          eq(companies.active, true),
        ),
      )
      .limit(1);
    if (!base) return null;

    const grants = await this.db
      .select({ roleCode: roles.code, roleName: roles.name, permissionCode: permissions.code })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(membershipRoles.membershipId, base.membershipId));

    const roleMap = new Map<string, string>();
    const permissionSet = new Set<string>();
    for (const g of grants) {
      roleMap.set(g.roleCode, g.roleName);
      if (g.permissionCode) permissionSet.add(g.permissionCode);
    }

    return {
      membershipId: base.membershipId,
      companyTimezone: base.timezone,
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
