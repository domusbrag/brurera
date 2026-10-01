"use client";

import {
  COST_STATUS_LABELS,
  PERMISSIONS as P,
  type RecipeDto,
  type RecipeListItemDto,
  type RecipeVersionCostDto,
  type RecipeVersionDiffDto,
  type RecipeVersionDto,
  type RecipeVersionSummaryDto,
} from "@bakery/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { formatDateTime, formatDecimal, formatQuantity, formatUnitCost } from "@/lib/format";
import { useCan, useCurrentUser } from "../user-context";
import { MasterList } from "../masters/master-list";
import {
  ActiveToggle,
  AuditHistory,
  ConfirmAction,
  Details,
  ErrorState,
  Loading,
  PageHeader,
  StatusBadge,
  useResource,
} from "../masters/ui";
import {
  CostSummary,
  DiffView,
  IngredientCostTable,
  PublishVersionButton,
  SnapshotTable,
  VersionStatusBadge,
} from "./cost-views";

const BASE = "/recetas";

/* ---------- Listado ---------- */

export function RecipeList() {
  const can = useCan();
  const user = useCurrentUser();
  return (
    <MasterList<RecipeListItemDto>
      title="Recetas"
      subtitle="Qué lleva cada producto, cuánto rinde y cuánto cuesta producirlo."
      endpoint="/api/recipes"
      basePath={BASE}
      searchPlaceholder="Buscar por producto o receta"
      createLabel="Nueva receta"
      canCreate={can(P.RECIPES_CREATE)}
      emptyText="Todavía no hay recetas cargadas."
      statusLabels={{ active: "Activas", inactive: "Inactivas" }}
      columns={[
        { header: "Producto", cell: (r) => <Link href={`${BASE}/${r.id}`}>{r.product.name}</Link> },
        { header: "Receta", cell: (r) => r.name, className: "hide-md" },
        {
          header: "Versión vigente",
          cell: (r) =>
            r.activeVersion ? (
              `v${r.activeVersion.versionNumber}`
            ) : (
              <span className="badge badge--off">Sin vigente</span>
            ),
        },
        {
          header: "Rendimiento",
          cell: (r) =>
            r.activeVersion
              ? formatQuantity(r.activeVersion.yieldQuantity, r.activeVersion.yieldUnit.symbol)
              : "—",
          className: "num hide-md",
        },
        {
          header: "Costo teórico actual",
          cell: (r) =>
            r.currentCost?.unitCost
              ? formatUnitCost(
                  r.currentCost.unitCost,
                  r.currentCost.currency,
                  r.product.saleUnit.symbol,
                )
              : "—",
          className: "num",
        },
        {
          header: "Estado del costo",
          cell: (r) =>
            !r.currentCost ? (
              "—"
            ) : r.currentCost.status === "COMPLETE" ? (
              <span className="badge">{COST_STATUS_LABELS.COMPLETE}</span>
            ) : (
              <span className="badge badge--warn">{COST_STATUS_LABELS.INCOMPLETE}</span>
            ),
        },
        {
          header: "Actualización",
          cell: (r) => (
            <>
              {formatDateTime(r.updatedAt, user.company.timezone)}
              {r.draftVersion && (
                <>
                  {" "}
                  <span className="badge badge--draft">
                    Borrador v{r.draftVersion.versionNumber}
                  </span>
                </>
              )}
            </>
          ),
          className: "hide-sm",
        },
      ]}
    />
  );
}

/* ---------- Detalle de receta ---------- */

export function RecipeDetail({ id }: { id: string }) {
  const can = useCan();
  const user = useCurrentUser();
  const formatDate = (iso: string) => formatDateTime(iso, user.company.timezone);
  const router = useRouter();
  const [version, setVersion] = useState(0);
  const { data, error, reload } = useResource<RecipeDto>(`/api/recipes/${id}?v=${version}`);
  const activeCost = useResource<RecipeVersionCostDto>(
    data?.activeVersionId ? `/api/recipe-versions/${data.activeVersionId}/cost?v=${version}` : null,
  );
  const draftCost = useResource<RecipeVersionCostDto>(
    data?.draftVersionId ? `/api/recipe-versions/${data.draftVersionId}/cost?v=${version}` : null,
  );
  const activeVersion = useResource<RecipeVersionDto>(
    data?.activeVersionId ? `/api/recipe-versions/${data.activeVersionId}?v=${version}` : null,
  );
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const refresh = () => {
    reload();
    setVersion((v) => v + 1);
  };
  const active = data.versions.find((v) => v.id === data.activeVersionId);
  const draft = data.versions.find((v) => v.id === data.draftVersionId);
  const latest = data.versions[0];

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: BASE, label: "Recetas" }}
        title={data.name}
        subtitle={
          <>
            Producto: <Link href={`/productos/${data.product.id}`}>{data.product.name}</Link> ·{" "}
            <StatusBadge active={data.active} on="Activa" off="Inactiva" />
          </>
        }
        actions={
          <>
            {data.active && draft && can(P.RECIPES_UPDATE) && (
              <Link className="button" href={`${BASE}/${id}/versiones/${draft.id}/editar`}>
                Editar borrador
              </Link>
            )}
            {data.active && draft && can(P.RECIPES_PUBLISH) && (
              <PublishVersionButton
                versionId={draft.id}
                versionNumber={draft.versionNumber}
                cost={draftCost.data?.current ?? null}
                onDone={refresh}
              />
            )}
            {data.active && !draft && latest && can(P.RECIPES_CREATE) && (
              <ConfirmAction
                label="Nueva versión"
                title="¿Crear una nueva versión?"
                confirmLabel="Crear borrador"
                message={`Se copia la versión ${(active ?? latest).versionNumber} (ingredientes, cantidades, rendimiento, merma e instrucciones) a un borrador que podés editar. La versión vigente no cambia hasta que publiques el borrador.`}
                onConfirm={async () => {
                  const created = await apiFetch<RecipeVersionDto>(
                    `/api/recipe-versions/${(active ?? latest).id}/duplicate`,
                    { method: "POST" },
                  );
                  router.push(`${BASE}/${id}/versiones/${created.id}/editar`);
                }}
              />
            )}
            {can(P.RECIPES_ARCHIVE) && (
              <ActiveToggle
                active={data.active}
                endpoint={`/api/recipes/${id}`}
                noun="esta receta"
                onChange={refresh}
                deactivateMessage="La receta deja de usarse para el producto. No se borra: sus versiones y costos quedan en el historial y se puede reactivar."
              />
            )}
          </>
        }
      />

      {draft && (
        <section className="panel" aria-labelledby="draft-title">
          <div className="panel__header">
            <h2 id="draft-title">
              Borrador · versión {draft.versionNumber} <VersionStatusBadge status="DRAFT" />
            </h2>
            <Link href={`${BASE}/${id}/versiones/${draft.id}`}>Ver borrador</Link>
          </div>
          <p className="muted">
            Creado el {formatDate(draft.createdAt)} por {draft.createdBy?.displayName ?? "—"}.
            Todavía no está vigente: se aplica al publicarlo.
          </p>
          {draftCost.data && (
            <CostSummary cost={draftCost.data.current} currentLabel="con costos de hoy" />
          )}
        </section>
      )}

      <section className="panel" aria-labelledby="active-title">
        <div className="panel__header">
          <h2 id="active-title">
            {active ? (
              <>
                Versión vigente · v{active.versionNumber} <VersionStatusBadge status="ACTIVE" />
              </>
            ) : (
              "Sin versión vigente"
            )}
          </h2>
          {active && <Link href={`${BASE}/${id}/versiones/${active.id}`}>Ver versión</Link>}
        </div>
        {!active ? (
          <p className="muted">
            {draft
              ? "Publicá el borrador para que la receta quede vigente."
              : "La receta no tiene una versión vigente."}
          </p>
        ) : (
          <>
            <Details
              items={[
                ["Vigente desde", active.effectiveFrom ? formatDate(active.effectiveFrom) : null],
                ["Publicada por", active.publishedBy?.displayName],
                ["Rendimiento", formatQuantity(active.yieldQuantity, active.yieldUnit.symbol)],
                [
                  "Merma teórica",
                  active.wastePercentage === null
                    ? null
                    : `${formatDecimal(active.wastePercentage)} %`,
                ],
              ]}
            />
            {activeCost.data && (
              <>
                <h3>Ingredientes (costos de referencia de hoy)</h3>
                <IngredientCostTable cost={activeCost.data.current} />
                <CostSummary
                  cost={activeCost.data.current}
                  snapshot={activeCost.data.snapshot}
                  variation={activeCost.data.unitCostVariation}
                />
              </>
            )}
            {activeVersion.data?.instructions && (
              <>
                <h3>Instrucciones</h3>
                <p className="prewrap">{activeVersion.data.instructions}</p>
              </>
            )}
          </>
        )}
      </section>

      <VersionHistory recipeId={id} versions={data.versions} />
      <AuditHistory entityType="recipe" entityId={id} version={version} />
    </div>
  );
}

function VersionHistory({
  recipeId,
  versions,
}: {
  recipeId: string;
  versions: RecipeVersionSummaryDto[];
}) {
  const user = useCurrentUser();
  const tz = user.company.timezone;
  return (
    <section className="panel" aria-labelledby="versions-title">
      <h2 id="versions-title">Historial de versiones</h2>
      {versions.length === 0 ? (
        <p className="muted">Sin versiones.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Versión</th>
                <th scope="col">Estado</th>
                <th scope="col" className="hide-sm">
                  Creada
                </th>
                <th scope="col">Publicada</th>
                <th scope="col" className="num hide-sm">
                  Rendimiento
                </th>
                <th scope="col" className="num">
                  Costo al publicar
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td>
                    <Link href={`${BASE}/${recipeId}/versiones/${v.id}`}>v{v.versionNumber}</Link>
                  </td>
                  <td>
                    <VersionStatusBadge status={v.status} />
                  </td>
                  <td className="hide-sm">
                    {formatDateTime(v.createdAt, tz)} · {v.createdBy?.displayName ?? "—"}
                  </td>
                  <td>
                    {v.publishedAt
                      ? `${formatDateTime(v.publishedAt, tz)} · ${v.publishedBy?.displayName ?? "—"}`
                      : "—"}
                  </td>
                  <td className="num hide-sm">
                    {formatQuantity(v.yieldQuantity, v.yieldUnit.symbol)}
                  </td>
                  <td className="num">
                    {!v.snapshot ? (
                      "—"
                    ) : v.snapshot.unitCost === null ? (
                      <span className="badge badge--warn">Incompleto</span>
                    ) : (
                      formatUnitCost(
                        v.snapshot.unitCost,
                        v.snapshot.currency,
                        v.snapshot.saleUnitSymbol,
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------- Detalle de una versión (sólo lectura) ---------- */

export function VersionDetail({ recipeId, versionId }: { recipeId: string; versionId: string }) {
  const can = useCan();
  const router = useRouter();
  const user = useCurrentUser();
  const [tick, setTick] = useState(0);
  const { data, error, reload } = useResource<RecipeVersionDto>(
    `/api/recipe-versions/${versionId}?v=${tick}`,
  );
  const cost = useResource<RecipeVersionCostDto>(
    `/api/recipe-versions/${versionId}/cost?v=${tick}`,
  );
  const diff = useResource<RecipeVersionDiffDto>(`/api/recipe-versions/${versionId}/diff`);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  if (data.recipe.id !== recipeId) {
    return (
      <ErrorState error={new ApiError(404, "NOT_FOUND", "La versión no es de esta receta.")} />
    );
  }
  const refresh = () => {
    reload();
    setTick((t) => t + 1);
  };
  const tz = user.company.timezone;
  const isDraft = data.status === "DRAFT";
  const editable = isDraft && data.recipe.active;

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: `${BASE}/${recipeId}`, label: data.recipe.name }}
        title={
          <>
            {data.recipe.name} · versión {data.versionNumber}{" "}
            <VersionStatusBadge status={data.status} />
          </>
        }
        subtitle={
          isDraft
            ? "Borrador: todavía no está vigente."
            : "Versión publicada: sólo lectura. Para cambiarla, creá una nueva versión."
        }
        actions={
          <>
            {editable && can(P.RECIPES_UPDATE) && (
              <Link className="button" href={`${BASE}/${recipeId}/versiones/${versionId}/editar`}>
                Editar borrador
              </Link>
            )}
            {editable && can(P.RECIPES_PUBLISH) && (
              <PublishVersionButton
                versionId={versionId}
                versionNumber={data.versionNumber}
                cost={cost.data?.current ?? null}
                onDone={refresh}
              />
            )}
            {isDraft && can(P.RECIPES_UPDATE) && (
              <ConfirmAction
                label="Descartar borrador"
                title="¿Descartar el borrador?"
                confirmLabel="Descartar"
                danger
                message="El borrador nunca se publicó: se elimina con sus ingredientes. Queda registrado en la auditoría."
                onConfirm={async () => {
                  await apiFetch(`/api/recipe-versions/${versionId}/discard`, { method: "POST" });
                  router.push(`${BASE}/${recipeId}`);
                }}
              />
            )}
            {data.status === "ACTIVE" && can(P.RECIPES_ARCHIVE) && (
              <ConfirmAction
                label="Archivar"
                title="¿Archivar la versión vigente?"
                confirmLabel="Archivar"
                danger
                message="La receta queda sin versión vigente hasta que publiques otra. La versión se conserva en el historial."
                onConfirm={async () => {
                  await apiFetch(`/api/recipe-versions/${versionId}/archive`, { method: "POST" });
                  refresh();
                }}
              />
            )}
          </>
        }
      />
      <section className="panel">
        <Details
          items={[
            ["Producto", data.product.name],
            ["Rendimiento", formatQuantity(data.yieldQuantity, data.yieldUnit.symbol)],
            [
              "Merma teórica",
              data.wastePercentage === null ? null : `${formatDecimal(data.wastePercentage)} %`,
            ],
            [
              "Creada",
              `${formatDateTime(data.createdAt, tz)} · ${data.createdBy?.displayName ?? "—"}`,
            ],
            [
              "Publicada",
              data.publishedAt
                ? `${formatDateTime(data.publishedAt, tz)} · ${data.publishedBy?.displayName ?? "—"}`
                : null,
            ],
            ["Archivada", data.archivedAt ? formatDateTime(data.archivedAt, tz) : null],
          ]}
        />
      </section>

      {cost.data?.snapshot && (
        <section className="panel" aria-labelledby="snapshot-title">
          <h2 id="snapshot-title">Costo al publicar</h2>
          <p className="muted">
            Calculado el {formatDateTime(cost.data.snapshot.calculatedAt, tz)} con los costos de
            referencia de ese momento. No cambia aunque cambien los costos.
          </p>
          <SnapshotTable snapshot={cost.data.snapshot} />
          <p className="muted small">
            Costo por {cost.data.snapshot.saleUnit.symbol} al publicar:{" "}
            <strong>
              {cost.data.snapshot.unitCost === null
                ? "Incompleto"
                : formatUnitCost(
                    cost.data.snapshot.unitCost,
                    cost.data.snapshot.currency,
                    cost.data.snapshot.saleUnit.symbol,
                  )}
            </strong>
          </p>
        </section>
      )}

      {cost.data && (
        <section className="panel" aria-labelledby="current-title">
          <h2 id="current-title">
            {isDraft ? "Costo teórico (costos de hoy)" : "Costo teórico actual"}
          </h2>
          <IngredientCostTable cost={cost.data.current} />
          <CostSummary
            cost={cost.data.current}
            snapshot={cost.data.snapshot}
            variation={cost.data.unitCostVariation}
          />
        </section>
      )}

      <section className="panel" aria-labelledby="diff-title">
        <h2 id="diff-title">
          Cambios{diff.data?.from ? ` respecto de la versión ${diff.data.from.versionNumber}` : ""}
        </h2>
        {diff.data ? <DiffView diff={diff.data} /> : <Loading />}
      </section>

      {data.instructions && (
        <section className="panel" aria-labelledby="instructions-title">
          <h2 id="instructions-title">Instrucciones</h2>
          <p className="prewrap">{data.instructions}</p>
        </section>
      )}
    </div>
  );
}
