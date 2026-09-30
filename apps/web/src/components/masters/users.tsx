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
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { ApiError, apiFetch, fetchOptions } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
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
      emptyText="No hay usuarios."
      statusLabels={{ active: "Con acceso", inactive: "Desactivados" }}
      columns={[
        { header: "Usuario", cell: (u) => <Link href={`${BASE}/${u.id}`}>{u.displayName}</Link> },
        { header: "Email", cell: (u) => u.email, className: "hide-sm" },
        { header: "Empleado", cell: (u) => u.employee?.fullName ?? "—", className: "hide-sm" },
        { header: "Roles", cell: (u) => u.roles.map((r) => r.name).join(", ") },
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
}: {
  roles: RoleDto[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      className="form__field form__field--full"
      style={{ border: 0, padding: 0, margin: 0 }}
    >
      <legend style={{ marginBottom: "0.4rem" }}>
        Roles <span className="form__required">*</span>
      </legend>
      <div className="check-list">
        {roles.map((r) => (
          <label key={r.id} className="form__field--check">
            <input
              type="checkbox"
              name="roles"
              value={r.code}
              disabled={disabled}
              checked={selected.includes(r.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked ? [...selected, r.id] : selected.filter((id) => id !== r.id),
                )
              }
            />
            <span>{r.name}</span>
          </label>
        ))}
      </div>
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
    setPending(true);
    setErrors({});
    setError(null);
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
        setError(err.message);
      } else setError("No se pudo crear el usuario.");
      setPending(false);
    }
  }

  const field = (name: string) => ({
    id: `field-${name}`,
    "aria-invalid": errors[name] ? true : undefined,
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
        subtitle="Da acceso al sistema a una persona."
      />
      <form className="panel" onSubmit={submit} noValidate>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="field-employeeId">Empleado vinculado</label>
            <select
              {...field("employeeId")}
              value={employeeId}
              onChange={(e) => chooseEmployee(e.target.value)}
            >
              <option value="">Sin empleado (p. ej. contador externo)</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.fullName} ({e.code})
                </option>
              ))}
            </select>
            <span className="form__hint">
              Solo se listan empleados activos que todavía no tienen acceso.
            </span>
            {fieldError("employeeId")}
          </div>
          <div className="form__field">
            <label htmlFor="field-displayName">Nombre visible</label>
            <input
              {...field("displayName")}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Si se deja vacío, se usa el nombre del empleado"
            />
            {fieldError("displayName")}
          </div>
          <div className="form__field">
            <label htmlFor="field-email">
              Email de ingreso <span className="form__required">*</span>
            </label>
            <input
              {...field("email")}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            {fieldError("email")}
          </div>
          <div className="form__field">
            <label htmlFor="field-password">
              Contraseña inicial <span className="form__required">*</span>
            </label>
            <div className="actions">
              <input
                {...field("password")}
                type="text"
                autoComplete="new-password"
                spellCheck={false}
                style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="button"
                onClick={() => setPassword(generatePassword())}
              >
                Generar
              </button>
            </div>
            <span className="form__hint">
              Mínimo {MIN_USER_PASSWORD_LENGTH} caracteres. Copiala ahora y entregala en persona: no
              se vuelve a mostrar.
            </span>
            {fieldError("password")}
          </div>
          <RoleChecklist roles={roles.data} selected={roleIds} onChange={setRoleIds} />
          {fieldError("roleIds")}
        </div>
        <div className="form__footer">
          <button type="submit" className="button button--primary" disabled={pending}>
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
  return (
    <dl className="details">
      {[...byModule].map(([module, descriptions]) => (
        <div key={module}>
          <dt>{PERMISSION_MODULE_LABELS[module] ?? module}</dt>
          <dd>
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {descriptions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function UserDetail({ id }: { id: string }) {
  const can = useCan();
  const me = useCurrentUser();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<UserDetailDto>(`${API}/${id}`);
  const roles = useRoles();
  const [editingRoles, setEditingRoles] = useState<string[] | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [savingRoles, setSavingRoles] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  const isSelf = me.id === data.id;
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
          ? (err.fieldErrors.roleIds ?? err.message)
          : "No se pudieron guardar los roles.",
      );
    } finally {
      setSavingRoles(false);
    }
  }

  async function saveName() {
    setNameError(null);
    try {
      await apiFetch(`${API}/${id}`, { method: "PATCH", body: { displayName: editingName } });
      setEditingName(null);
      refresh();
    } catch (err) {
      setNameError(
        err instanceof ApiError
          ? (err.fieldErrors.displayName ?? err.message)
          : "No se pudo guardar.",
      );
    }
  }

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Usuarios" }}
        title={data.displayName}
        subtitle={
          <>
            {data.email} · <StatusBadge active={active} on="Con acceso" off="Desactivado" />
            {isSelf && " · Sos vos"}
          </>
        }
        actions={
          <>
            {can(P.USERS_UPDATE) && editingName === null && (
              <button
                type="button"
                className="button"
                onClick={() => setEditingName(data.displayName)}
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

      {editingName !== null && (
        <section className="panel">
          <div className="form__field">
            <label htmlFor="field-displayName">Nombre visible</label>
            <input
              id="field-displayName"
              value={editingName}
              onChange={(e) => setEditingName(e.target.value)}
              aria-invalid={nameError ? true : undefined}
            />
            {nameError && <span className="form__error">{nameError}</span>}
          </div>
          <div className="form__footer">
            <button type="button" className="button button--primary" onClick={saveName}>
              Guardar
            </button>
            <button type="button" className="button" onClick={() => setEditingName(null)}>
              Cancelar
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <Details
          items={[
            ["Email de ingreso", data.email],
            [
              "Empleado vinculado",
              data.employee ? (
                can(P.EMPLOYEES_READ) ? (
                  <Link
                    href={`/empleados/${data.employee.id}`}
                  >{`${data.employee.fullName} (${data.employee.code})`}</Link>
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
                disabled={savingRoles}
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
              <span key={r.id} className="badge badge--info">
                {r.name}
              </span>
            ))}
          </div>
        )}
        {isSelf && (
          <p className="form__hint" style={{ marginTop: "0.5rem" }}>
            No podés cambiar tus propios roles ni desactivarte.
          </p>
        )}
      </section>

      <section className="panel" aria-labelledby="perm-title">
        <h2 id="perm-title">Permisos efectivos</h2>
        <p className="muted" style={{ marginBottom: "0.75rem" }}>
          Lo que esta persona puede hacer, según la suma de sus roles.
        </p>
        <PermissionList codes={data.permissions} />
      </section>

      <AuditHistory entityType="user" entityId={id} version={version} />
    </div>
  );
}
