"use client";

import {
  MIN_USER_PASSWORD_LENGTH,
  PERMISSION_CATALOG,
  PERMISSION_MODULE_LABELS,
  PERMISSIONS as P,
  type EmployeeDto,
  type RoleDto,
  type UserDetailDto,
  type UserDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { describeError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { StatusBadge as UiStatusBadge } from "../ui/status";
import { useCan, useCurrentUser } from "../user-context";
import { MasterList } from "./master-list";
import {
  AuditHistory,
  ConfirmAction,
  Details,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  useResource,
} from "./ui";

/*
 * "Usuario" = acceso de una persona al sistema en esta empresa (membresía).
 * La contraseña nunca vuelve de la API; solo se ve al crearla.
 */

const BASE = "/usuarios";
const API = "/api/users";

export function UserList() {
  const can = useCan();
  return (
    <MasterList<UserDto>
      title="Usuarios"
      subtitle="Personas con acceso al sistema y sus roles."
      endpoint={API}
      basePath={BASE}
      searchPlaceholder="Buscar por nombre o email"
      createLabel="Nuevo usuario"
      canCreate={can(P.USERS_CREATE, P.USERS_ASSIGN_ROLES)}
      emptyText="Nadie tiene acceso en este filtro."
      statusLabels={{ active: "Con acceso", inactive: "Desactivados" }}
      columns={[
        { header: "Usuario", cell: (u) => <Link href={`${BASE}/${u.id}`}>{u.displayName}</Link> },
        { header: "Email", cell: (u) => u.email, className: "hide-md" },
        { header: "Empleado", cell: (u) => u.employee?.fullName ?? "", className: "hide-md" },
        { header: "Roles", cell: (u) => u.roles.map((r) => r.name).join(", ") },
        {
          header: "Último ingreso",
          cell: (u) => <LastLogin iso={u.lastLoginAt} />,
          className: "hide-md",
        },
        {
          header: "Estado",
          cell: (u) => (
            <StatusBadge active={u.status === "ACTIVE"} on="Con acceso" off="Desactivado" />
          ),
        },
      ]}
    />
  );
}

function LastLogin({ iso }: { iso: string | null }) {
  const tz = useCurrentUser().company.timezone;
  return iso ? <>{formatDateTime(iso, tz)}</> : <span className="muted">Nunca</span>;
}

/** Roles que dan acceso total: se avisa al asignarlos. */
const FULL_ACCESS_ROLES = new Set(["ADMIN", "OWNER"]);

/** Contraseña inicial aleatoria (criptográficamente segura), sin caracteres ambiguos. */
function generatePassword(length = 16): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function useRoles() {
  return useResource<RoleDto[]>("/api/roles");
}

function RoleChecklist({
  roles,
  selected,
  onChange,
  disabled,
  error,
}: {
  roles: RoleDto[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  error?: string;
}) {
  const fullAccess = roles.filter((r) => FULL_ACCESS_ROLES.has(r.code) && selected.includes(r.id));
  return (
    <fieldset
      className="form__field form__field--full mx-fieldset"
      aria-describedby={error ? "field-roleIds-error" : undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="form__label">
        Roles{" "}
        <span className="form__required" aria-hidden="true">
          *
        </span>
        <span className="sr-only"> (elegí al menos uno)</span>
      </legend>
      <div className="check-list">
        {roles.map((r) => (
          <div key={r.id}>
            <label className="form__field--check">
              <input
                type="checkbox"
                name="roles"
                value={r.code}
                disabled={disabled}
                checked={selected.includes(r.id)}
                aria-describedby={r.description ? `role-desc-${r.code}` : undefined}
                onChange={(e) =>
                  onChange(
                    e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                  )
                }
              />
              <span>{r.name}</span>
            </label>
            {r.description && (
              <span className="form__hint" id={`role-desc-${r.code}`}>
                {r.description}
              </span>
            )}
          </div>
        ))}
      </div>
      {fullAccess.length > 0 && (
        <p className="alert alert--warn" role="status">
          {fullAccess.map((r) => r.name).join(" y ")} {fullAccess.length === 1 ? "da" : "dan"}{" "}
          acceso total al sistema: todos los permisos, incluidos usuarios, roles y costos.
        </p>
      )}
      {error && (
        <span className="form__error" id="field-roleIds-error">
          {error}
        </span>
      )}
      <Link className="small" href="/configuracion/roles">
        Ver qué puede hacer cada rol
      </Link>
    </fieldset>
  );
}

export function UserCreateForm() {
  return (
    <Suspense fallback={<Loading />}>
      <UserCreateFormInner />
    </Suspense>
  );
}

function UserCreateFormInner() {
  const router = useRouter();
  const params = useSearchParams();
  const presetEmployee = params.get("empleado") ?? "";
  const roles = useRoles();
  const [employees, setEmployees] = useState<EmployeeDto[] | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [employeeId, setEmployeeId] = useState(presetEmployee);
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchOptions<EmployeeDto>("/api/employees")
      .then((items) => {
        const available = items.filter((e) => !e.access);
        setEmployees(available);
        // Si se llegó desde "Crear acceso", se propone el email del empleado.
        const preset = available.find((e) => e.id === presetEmployee);
        if (preset?.email) setEmail((current) => current || preset.email || "");
      })
      .catch(() => setEmployees([]));
  }, [presetEmployee]);

  function chooseEmployee(id: string) {
    setEmployeeId(id);
    const employee = employees?.find((e) => e.id === id);
    if (employee?.email && !email) setEmail(employee.email);
  }

  if (roles.error) return <ErrorState error={roles.error} />;
  if (!roles.data || !employees) return <Loading />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setErrors({});
    setError(null);
    const missing: Record<string, string> = {};
    if (!email.trim()) missing.email = "Completá el email con el que va a ingresar.";
    if (password.length < MIN_USER_PASSWORD_LENGTH)
      missing.password = `La contraseña necesita al menos ${MIN_USER_PASSWORD_LENGTH} caracteres. Usá «Generar».`;
    if (roleIds.length === 0) missing.roleIds = "Elegí al menos un rol.";
    if (Object.keys(missing).length > 0) {
      setErrors(missing);
      setError("Revisá los datos marcados.");
      const first = ["email", "password"].find((k) => missing[k]);
      document
        .querySelector<HTMLElement>(first ? `#field-${first}` : 'input[name="roles"]')
        ?.focus();
      return;
    }
    setPending(true);
    try {
      const created = await apiFetch<UserDto>(API, {
        method: "POST",
        body: {
          email,
          displayName: displayName || null,
          password,
          employeeId: employeeId || null,
          roleIds,
        },
      });
      router.push(`${BASE}/${created.id}?creado=1`);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        setError(describeError(err));
      } else setError("No se pudo crear el usuario.");
      setPending(false);
    }
  }

  const field = (name: string, hint?: boolean) => ({
    id: `field-${name}`,
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby":
      [hint ? `field-${name}-hint` : null, errors[name] ? `field-${name}-error` : null]
        .filter(Boolean)
        .join(" ") || undefined,
  });
  const fieldError = (name: string) =>
    errors[name] ? (
      <span className="form__error" id={`field-${name}-error`}>
        {errors[name]}
      </span>
    ) : null;

  return (
    <div className="page">
      <PageHeader
        title="Nuevo usuario"
        breadcrumb={{ href: BASE, label: "Usuarios" }}
        subtitle="Da acceso al sistema a una persona: email de ingreso, contraseña inicial y roles."
      />
      <form className="panel" onSubmit={submit} noValidate>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <p className="form__hint">
          Los campos con <span className="form__required">*</span> son obligatorios.
        </p>
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="field-employeeId">Empleado vinculado</label>
            <select
              {...field("employeeId", true)}
              value={employeeId}
              onChange={(e) => chooseEmployee(e.target.value)}
            >
              <option value="">Sin empleado (p. ej. contador externo)</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName}
                </option>
              ))}
            </select>
            <span className="form__hint" id="field-employeeId-hint">
              Solo se listan empleados activos que todavía no tienen acceso.
            </span>
            {fieldError("employeeId")}
          </div>
          <div className="form__field">
            <label htmlFor="field-displayName">Nombre visible</label>
            <input
              {...field("displayName", true)}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
            <span className="form__hint" id="field-displayName-hint">
              Opcional: si lo dejás vacío se usa el nombre del empleado.
            </span>
            {fieldError("displayName")}
          </div>
          <div className="form__field">
            <label htmlFor="field-email">
              Email de ingreso{" "}
              <span className="form__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              {...field("email")}
              aria-required
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {fieldError("email")}
          </div>
          <div className="form__field">
            <label htmlFor="field-password">
              Contraseña inicial{" "}
              <span className="form__required" aria-hidden="true">
                *
              </span>
            </label>
            <div className="input-group">
              <input
                {...field("password", true)}
                aria-required
                type="text"
                className="code"
                autoComplete="new-password"
                spellCheck={false}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setCopied(false);
                }}
              />
              <button
                type="button"
                className="button"
                onClick={() => {
                  setPassword(generatePassword());
                  setCopied(false);
                }}
              >
                Generar
              </button>
              {password && (
                <button
                  type="button"
                  className="button"
                  aria-label={copied ? "Copiada" : "Copiar la clave"}
                  onClick={() => {
                    void navigator.clipboard?.writeText(password).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copiada" : "Copiar"}
                </button>
              )}
            </div>
            <span className="form__hint" id="field-password-hint">
              Mínimo {MIN_USER_PASSWORD_LENGTH} caracteres. Copiala ahora y entregala en persona: no
              se vuelve a mostrar.
            </span>
            {fieldError("password")}
          </div>
          <RoleChecklist
            roles={roles.data}
            selected={roleIds}
            onChange={setRoleIds}
            error={errors.roleIds}
          />
        </div>
        <div className="form__footer">
          <button
            type="submit"
            className="button button--primary"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Creando…" : "Crear usuario"}
          </button>
          <Link className="button" href={BASE}>
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}

function PermissionList({ codes }: { codes: string[] }) {
  const granted = new Set(codes);
  const byModule = new Map<string, string[]>();
  for (const p of PERMISSION_CATALOG) {
    if (!granted.has(p.code)) continue;
    const list = byModule.get(p.module) ?? [];
    list.push(p.description);
    byModule.set(p.module, list);
  }
  if (byModule.size === 0) return <p className="muted">Sin permisos.</p>;
  const total = [...byModule.values()].reduce((n, d) => n + d.length, 0);
  return (
    <details>
      <summary>
        Ver {total} {total === 1 ? "permiso" : "permisos"} en {byModule.size}{" "}
        {byModule.size === 1 ? "módulo" : "módulos"}
      </summary>
      <dl className="details">
        {[...byModule].map(([module, descriptions]) => (
          <div key={module}>
            <dt>{PERMISSION_MODULE_LABELS[module] ?? "Otros"}</dt>
            <dd>
              <ul className="plain-list">
                {descriptions.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function UserDetail({ id }: { id: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <UserDetailInner id={id} />
    </Suspense>
  );
}

function UserDetailInner({ id }: { id: string }) {
  const can = useCan();
  const router = useRouter();
  const params = useSearchParams();
  const justCreated = params.get("creado") === "1";
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [savingName, setSavingName] = useState(false);
  const me = useCurrentUser();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<UserDetailDto>(`${API}/${id}`);
  const roles = useRoles();
  const [editingRoles, setEditingRoles] = useState<string[] | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [savingRoles, setSavingRoles] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Cargando el usuario…" />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  const isSelf = me.id === data.id;
  const roleNames = (ids: string[]) =>
    ids.map((rid) => roles.data?.find((r) => r.id === rid)?.name ?? "").filter(Boolean);
  const currentIds = data.roles.map((r) => r.id);
  const added = editingRoles ? roleNames(editingRoles.filter((r) => !currentIds.includes(r))) : [];
  const removed = editingRoles
    ? roleNames(currentIds.filter((r) => !editingRoles.includes(r)))
    : [];
  const active = data.status === "ACTIVE";

  async function saveRoles() {
    setSavingRoles(true);
    setRoleError(null);
    try {
      await apiFetch(`${API}/${id}/roles`, { method: "PUT", body: { roleIds: editingRoles } });
      setEditingRoles(null);
      refresh();
    } catch (err) {
      setRoleError(
        err instanceof ApiError
          ? (err.fieldErrors.roleIds ?? describeError(err))
          : "No se pudieron guardar los roles.",
      );
    } finally {
      setSavingRoles(false);
    }
  }

  async function saveName() {
    setNameError(null);
    if (!editingName?.trim()) {
      setNameError("Completá el nombre.");
      nameInputRef.current?.focus();
      return;
    }
    setSavingName(true);
    try {
      await apiFetch(`${API}/${id}`, { method: "PATCH", body: { displayName: editingName } });
      setEditingName(null);
      refresh();
    } catch (err) {
      setNameError(
        err instanceof ApiError
          ? (err.fieldErrors.displayName ?? describeError(err))
          : "No se pudo guardar.",
      );
    } finally {
      setSavingName(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Usuarios" }}
        title={data.displayName}
        status={<StatusBadge active={active} on="Con acceso" off="Desactivado" />}
        subtitle={isSelf ? "Sos vos" : undefined}
        actions={
          <>
            {can(P.USERS_UPDATE) && editingName === null && (
              <button
                type="button"
                className="button"
                onClick={() => {
                  setEditingName(data.displayName);
                  requestAnimationFrame(() => nameInputRef.current?.focus());
                }}
              >
                Editar nombre
              </button>
            )}
            {can(P.USERS_DEACTIVATE) &&
              !isSelf &&
              (active ? (
                <ConfirmAction
                  label="Desactivar acceso"
                  title="¿Desactivar el acceso?"
                  message="La persona no podrá ingresar y se cierran sus sesiones abiertas. Se puede reactivar."
                  confirmLabel="Desactivar"
                  danger
                  onConfirm={async () => {
                    await apiFetch(`${API}/${id}/deactivate`, { method: "POST" });
                    refresh();
                  }}
                />
              ) : (
                <ConfirmAction
                  label="Reactivar acceso"
                  title="¿Reactivar el acceso?"
                  message="La persona vuelve a poder ingresar con su contraseña."
                  confirmLabel="Reactivar"
                  onConfirm={async () => {
                    await apiFetch(`${API}/${id}/activate`, { method: "POST" });
                    refresh();
                  }}
                />
              ))}
          </>
        }
      />

      {justCreated && (
        <div className="alert alert--success" role="status">
          <p>
            <strong>Acceso creado.</strong> Entregale a {data.displayName} su email de ingreso (
            <span className="code">{data.email}</span>) y la contraseña inicial que generaste, en
            persona o por un canal privado. Por seguridad la contraseña no se vuelve a mostrar: si
            no la copiaste, desactivá este acceso y creá uno nuevo.
          </p>
          <div className="alert__actions">
            <button
              type="button"
              className="button button--small"
              onClick={() => router.replace(`${BASE}/${id}`, { scroll: false })}
            >
              Entendido
            </button>
          </div>
        </div>
      )}

      {editingName !== null && (
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
          noValidate
        >
          <div className="form__field">
            <label htmlFor="field-displayName">Nombre visible</label>
            <input
              id="field-displayName"
              ref={nameInputRef}
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? "field-displayName-error" : undefined}
            />
            {nameError && (
              <span className="form__error" id="field-displayName-error" role="alert">
                {nameError}
              </span>
            )}
          </div>
          <div className="form__footer">
            <button
              type="submit"
              className="button button--primary"
              disabled={savingName}
              aria-busy={savingName || undefined}
            >
              {savingName ? "Guardando…" : "Guardar"}
            </button>
            <button type="button" className="button" onClick={() => setEditingName(null)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      <section className="panel">
        <Details
          items={[
            ["Email de ingreso", data.email],
            [
              "Empleado vinculado",
              data.employee ? (
                can(P.EMPLOYEES_READ) ? (
                  <Link href={`/empleados/${data.employee.id}`}>{data.employee.fullName}</Link>
                ) : (
                  data.employee.fullName
                )
              ) : (
                "No es empleado"
              ),
            ],
            [
              "Último ingreso",
              data.lastLoginAt ? formatDateTime(data.lastLoginAt, me.company.timezone) : "Nunca",
            ],
          ]}
        />
      </section>

      <section className="panel" aria-labelledby="roles-title">
        <div className="page__header">
          <h2 id="roles-title">Roles</h2>
          {can(P.USERS_ASSIGN_ROLES) && !isSelf && editingRoles === null && (
            <button
              type="button"
              className="button button--small"
              onClick={() => setEditingRoles(data.roles.map((r) => r.id))}
            >
              Cambiar roles
            </button>
          )}
        </div>
        {editingRoles !== null && roles.data ? (
          <>
            <RoleChecklist roles={roles.data} selected={editingRoles} onChange={setEditingRoles} />
            {(added.length > 0 || removed.length > 0) && (
              <p className="form__hint" role="status">
                {added.length > 0 && <>Agrega: {added.join(", ")}. </>}
                {removed.length > 0 && <>Quita: {removed.join(", ")}. </>}
                Rige desde la próxima acción de la persona.
              </p>
            )}
            {roleError && (
              <p className="form__error" role="alert">
                {roleError}
              </p>
            )}
            <div className="form__footer">
              <button
                type="button"
                className="button button--primary"
                onClick={saveRoles}
                disabled={savingRoles || editingRoles.length === 0}
                aria-busy={savingRoles || undefined}
              >
                {savingRoles ? "Guardando…" : "Guardar roles"}
              </button>
              <button type="button" className="button" onClick={() => setEditingRoles(null)}>
                Cancelar
              </button>
            </div>
          </>
        ) : (
          <div className="chips">
            {data.roles.map((r) => (
              <UiStatusBadge key={r.id} tone="tag">
                {r.name}
              </UiStatusBadge>
            ))}
          </div>
        )}
        {isSelf && (
          <p className="form__hint">No podés cambiar tus propios roles ni desactivarte.</p>
        )}
      </section>

      <section className="panel" aria-labelledby="perm-title">
        <h2 id="perm-title">Permisos efectivos</h2>
        <p className="muted">Lo que esta persona puede hacer, según la suma de sus roles.</p>
        <PermissionList codes={data.permissions} />
      </section>

      <AuditHistory entityType="user" entityId={id} version={version} />
    </div>
  );
}
