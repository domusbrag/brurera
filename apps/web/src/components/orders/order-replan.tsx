"use client";

import {
  COVERAGE_STATUS_LABELS,
  PERMISSIONS as P,
  type OrderDetailDto,
  type OrderOperationResultDto,
  type ReplanPreviewDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { formatQuantity } from "@/lib/format";
import { ErrorState, Loading, PageHeader, useResource } from "../masters/ui";
import { useCan, useCurrentUser } from "../user-context";
import {
  LinesEditor,
  lineReady,
  linePayload,
  linesFromOrder,
  useOrderCatalog,
  type LineDraft,
  type OrderCatalog,
} from "./order-form";
import {
  CoverageBadge,
  LineCoverage,
  MaterialProjection,
  ORDERS_BASE,
  WallClockInput,
  formatWallClock,
  isCompleteWallClock,
} from "./order-shared";

/*
 * Modificar un pedido confirmado (REPLAN explícito): se cambia fecha y/o
 * productos, la API muestra el antes y el después (qué reservas se liberan,
 * cuáles se toman, cómo cambian producción y materias primas) y recién al
 * aplicar se crea una revisión nueva del plan. La anterior queda en el historial.
 */

export function OrderReplan({ id }: { id: string }) {
  const catalog = useOrderCatalog();
  const { data, error } = useResource<OrderDetailDto>(`/api/orders/${id}`);
  if (error) return <ErrorState error={error} />;
  if (!catalog || !data) return <Loading />;
  if (!data.actions.canReplan) {
    return (
      <section className="panel panel--empty">
        <p className="upcoming">Este pedido no se puede modificar</p>
        <p className="muted">
          Sólo se modifican pedidos confirmados, en preparación o listos.{" "}
          <Link href={`${ORDERS_BASE}/${id}`}>Volver al pedido</Link>
        </p>
      </section>
    );
  }
  return <ReplanEditor order={data} catalog={catalog} />;
}

function ReplanEditor({ order, catalog }: { order: OrderDetailDto; catalog: OrderCatalog }) {
  const router = useRouter();
  const can = useCan();
  const tz = useCurrentUser().company.timezone;
  const [requestedAt, setRequestedAt] = useState(order.requestedAtLocal);
  const [lines, setLines] = useState<LineDraft[]>(() => linesFromOrder(order));
  const [operationId] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<{
    key: string;
    data: ReplanPreviewDto | null;
    error: ApiError | null;
  } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const ready = isCompleteWallClock(requestedAt) && lines.length > 0 && lines.every(lineReady);
  const body = ready ? { requestedAt, lines: linePayload(lines, catalog) } : null;
  const key = body ? JSON.stringify(body) : "";

  useEffect(() => {
    if (!body) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      apiFetch<ReplanPreviewDto>(`/api/orders/${order.id}/replan-preview`, {
        method: "POST",
        body,
      })
        .then((data) => !cancelled && setPreview({ key, data, error: null }))
        .catch(
          (err: unknown) =>
            !cancelled &&
            setPreview({
              key,
              data: null,
              error: err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Sin vista previa"),
            }),
        );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const current = preview?.key === key ? preview : null;

  async function apply() {
    if (!body) return;
    setPending(true);
    setApplyError(null);
    try {
      await apiFetch<OrderOperationResultDto>(`/api/orders/${order.id}/replan`, {
        method: "POST",
        body: { ...body, operationId },
      });
      router.push(`${ORDERS_BASE}/${order.id}`);
    } catch (err) {
      setApplyError(err instanceof ApiError ? err.message : "No se pudo modificar el pedido.");
      setPending(false);
    }
  }

  const fieldErrors = current?.error?.fieldErrors ?? {};
  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: `${ORDERS_BASE}/${order.id}`, label: `Pedido ${order.code}` }}
        title={`Modificar pedido ${order.code}`}
        subtitle="Cambiá fecha o productos y revisá cómo queda antes de aplicar. Nada cambia hasta que apliques."
      />
      <section className="panel">
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="r-requestedAt">Entrega o retiro</label>
            <WallClockInput
              id="r-requestedAt"
              value={requestedAt}
              timeZone={tz}
              invalid={!!fieldErrors.requestedAt}
              onChange={setRequestedAt}
            />
            <span className="muted small">Antes: {formatWallClock(order.requestedAtLocal)}</span>
          </div>
        </div>
      </section>
      <section className="panel" aria-labelledby="replan-lines">
        <h2 id="replan-lines">Productos</h2>
        <LinesEditor
          lines={lines}
          onChange={setLines}
          catalog={catalog}
          errors={fieldErrors}
          lockedProducts
        />
      </section>

      {!ready ? (
        <p className="muted">Completá fecha y productos para ver el resultado.</p>
      ) : current?.error ? (
        <p className="notice">{current.error.message}</p>
      ) : !current?.data ? (
        <Loading />
      ) : (
        <ReplanComparison preview={current.data} />
      )}

      {applyError && (
        <p className="form__error" role="alert">
          {applyError}
        </p>
      )}
      <div className="form__footer">
        <button
          type="button"
          className="button button--primary"
          disabled={!current?.data || pending || !can(P.ORDERS_REPLAN)}
          onClick={apply}
        >
          {pending ? "Aplicando…" : "Aplicar cambios"}
        </button>
        <Link href={`${ORDERS_BASE}/${order.id}`} className="button">
          Cancelar
        </Link>
      </div>
    </div>
  );
}

type Change = { label: string; unit: string; before: string; after: string };

function ChangeTable({ title, rows }: { title: string; rows: Change[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="table-wrap">
      <table className="table" aria-label={title}>
        <thead>
          <tr>
            <th scope="col">{title}</th>
            <th scope="col" className="num">
              Antes
            </th>
            <th scope="col" className="num">
              Después
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td className="num">{formatQuantity(r.before, r.unit)}</td>
              <td className="num">
                <strong>{formatQuantity(r.after, r.unit)}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LotList({
  title,
  lots,
  empty,
}: {
  title: string;
  lots: ReplanPreviewDto["releasedLots"];
  empty: string;
}) {
  return (
    <div>
      <h3 className="section-title">{title}</h3>
      {lots.length === 0 ? (
        <p className="muted small">{empty}</p>
      ) : (
        <ul>
          {lots.map((l, i) => (
            <li key={`${l.code}-${i}`}>
              {l.code}: {formatQuantity(l.quantity, l.unit)} de {l.product}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

type LotRow = ReplanPreviewDto["releasedLots"][number];

/**
 * El replan libera todas las reservas y vuelve a reservar: para leerlo, lo que
 * se libera y se vuelve a tomar del mismo lote se muestra como "se mantiene" y
 * sólo la diferencia como liberada o nueva.
 */
function netLots(released: LotRow[], taken: LotRow[]) {
  const key = (l: LotRow) => `${l.code}|${l.product}`;
  const sum = (rows: LotRow[]) => {
    const m = new Map<string, LotRow>();
    for (const r of rows) {
      const prev = m.get(key(r));
      m.set(
        key(r),
        prev ? { ...r, quantity: new D(prev.quantity).plus(r.quantity).toString() } : r,
      );
    }
    return m;
  };
  const before = sum(released);
  const after = sum(taken);
  const kept: LotRow[] = [];
  const freed: LotRow[] = [];
  const added: LotRow[] = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(k);
    const a = after.get(k);
    const qb = new D(b?.quantity ?? 0);
    const qa = new D(a?.quantity ?? 0);
    const base = (a ?? b)!;
    const common = D.min(qb, qa);
    if (common.gt(0)) kept.push({ ...base, quantity: common.toString() });
    if (qb.gt(qa)) freed.push({ ...base, quantity: qb.minus(qa).toString() });
    if (qa.gt(qb)) added.push({ ...base, quantity: qa.minus(qb).toString() });
  }
  return { kept, freed, added };
}

export function ReplanComparison({ preview }: { preview: ReplanPreviewDto }) {
  const p = preview.proposed;
  const lots = netLots(preview.releasedLots, preview.newLots);
  return (
    <section className="panel" aria-labelledby="compare-title" data-testid="replan-comparison">
      <h2 id="compare-title">Antes y después</h2>
      <dl className="cost-summary">
        <div>
          <dt>Cobertura actual (revisión {preview.revisionFrom})</dt>
          <dd>
            {preview.currentCoverage ? (
              COVERAGE_STATUS_LABELS[preview.currentCoverage]
            ) : (
              <span className="muted">—</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Cobertura nueva (revisión {preview.revisionTo})</dt>
          <dd>
            <CoverageBadge coverage={p.coverageStatus} />
          </dd>
        </div>
        <div>
          <dt>Entrega</dt>
          <dd>{formatWallClock(p.requestedAtLocal)}</dd>
        </div>
      </dl>
      <div className="form-grid">
        <LotList title="Reservas que se mantienen" lots={lots.kept} empty="Ninguna." />
        <LotList
          title="Reservas que se liberan"
          lots={lots.freed}
          empty="No se libera ninguna reserva."
        />
        <LotList
          title="Reservas nuevas"
          lots={lots.added}
          empty="No se toma ninguna reserva nueva."
        />
      </div>
      <ChangeTable
        title="Producción"
        rows={preview.productionChange.map((c) => ({ ...c, label: c.product }))}
      />
      <ChangeTable
        title="Materia prima"
        rows={preview.materialChange.map((c) => ({ ...c, label: c.rawMaterial }))}
      />
      <h3 className="section-title">Cobertura propuesta por producto</h3>
      <div className="cards">
        {p.lines.map((line, i) => (
          <LineCoverage key={`${line.product.id}-${i}`} line={line} />
        ))}
      </div>
      <h3 className="section-title">Materias primas</h3>
      <MaterialProjection materials={p.materials} />
    </section>
  );
}
