"use client";

import { AUDIT_ACTION_LABELS, type AuditLogItemDto, type Page } from "@bakery/shared";
import { useState } from "react";
import { listPath } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { useCurrentUser } from "../user-context";
import { ErrorState, Loading, PageHeader, useResource } from "./ui";

const ENTITY_LABELS: Record<string, string> = {
  session: "Sesiones",
  company: "Empresa",
  employee: "Empleados",
  user: "Usuarios",
  customer: "Clientes",
  supplier: "Proveedores",
  unit: "Unidades",
  category: "Categorías",
  raw_material: "Materias primas",
  product: "Productos",
  warehouse: "Depósitos",
  recipe: "Recetas",
};

/** Registro de auditoría de la empresa (solo lectura, más reciente primero). */
export function AuditLog() {
  const user = useCurrentUser();
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);
  const { data, error } = useResource<Page<AuditLogItemDto>>(
    listPath("/api/audit-logs", { entityType: entityType || undefined, page, pageSize: 25 }),
  );
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <div className="page">
      <PageHeader
        title="Auditoría"
        subtitle="Quién hizo qué y cuándo. Los registros no se pueden modificar ni borrar."
      />
      <section className="panel">
        <div className="filters">
          <select
            aria-label="Módulo"
            value={entityType}
            onChange={(e) => {
              setEntityType(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos los módulos</option>
            {Object.entries(ENTITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <ErrorState error={error} />
        ) : !data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <p className="muted">Sin registros.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Acción</th>
                    <th scope="col" className="hide-sm">
                      Módulo
                    </th>
                    <th scope="col">Usuario</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr key={item.id}>
                      <td>{formatDateTime(item.createdAt, user.company.timezone)}</td>
                      <td>
                        {AUDIT_ACTION_LABELS[item.action as keyof typeof AUDIT_ACTION_LABELS] ??
                          item.action}
                      </td>
                      <td className="hide-sm">
                        {ENTITY_LABELS[item.entityType] ?? item.entityType}
                      </td>
                      <td>{item.actor?.displayName ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {data.total} registros · página {data.page} de {totalPages}
              </span>
              <div className="actions">
                <button
                  type="button"
                  className="button button--small"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="button button--small"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  Siguiente
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
