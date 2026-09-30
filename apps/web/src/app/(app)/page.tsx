import type { Metadata } from "next";
import { PERMISSIONS } from "@bakery/shared";
import { redirect } from "next/navigation";
import { getCurrentUser, getRecentAudit } from "@/lib/api.server";

export const metadata: Metadata = { title: "Inicio" };

const ACTION_LABELS: Record<string, string> = {
  AUTH_LOGIN_SUCCEEDED: "Ingreso al sistema",
  AUTH_LOGIN_FAILED: "Intento de ingreso fallido",
  AUTH_LOGOUT: "Salida del sistema",
};

const dateFormat = new Intl.DateTimeFormat("es-AR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Argentina/Buenos_Aires",
});

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const canReadAudit = user.permissions.includes(PERMISSIONS.AUDIT_READ);
  const activity = canReadAudit ? await getRecentAudit(8) : [];

  return (
    <div className="page">
      <header className="page__header">
        <h1>Inicio</h1>
        <p className="muted">
          Hola, {user.displayName}. Estás trabajando en <strong>{user.company.tradeName}</strong>.
        </p>
      </header>

      <section className="panel" aria-labelledby="indicators-title">
        <h2 id="indicators-title">Indicadores del negocio</h2>
        <p className="muted">
          Ventas, cobros, stock y producción del día aparecerán aquí a medida que se habiliten los
          módulos correspondientes. No se muestran cifras sin datos reales que las respalden.
        </p>
      </section>

      {canReadAudit && (
        <section className="panel" aria-labelledby="activity-title">
          <h2 id="activity-title">Actividad reciente</h2>
          {activity.length === 0 ? (
            <p className="muted">Sin actividad registrada.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Acción</th>
                  <th scope="col">Usuario</th>
                </tr>
              </thead>
              <tbody>
                {activity.map((a) => (
                  <tr key={a.id}>
                    <td>{dateFormat.format(new Date(a.createdAt))}</td>
                    <td>{ACTION_LABELS[a.action] ?? a.action}</td>
                    <td>{a.actor?.displayName ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}
