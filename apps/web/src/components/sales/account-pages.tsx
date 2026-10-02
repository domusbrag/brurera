"use client";

import {
  ACCOUNT_MOVEMENT_TYPE_LABELS,
  PAYMENT_KIND_LABELS,
  type CustomerAccountDto,
  type ReceivableDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { isPositive, toDecimal } from "@/lib/decimal-input";
import { formatDateTime, formatMoney } from "@/lib/format";
import { MasterList } from "../masters/master-list";
import {
  AuditHistory,
  ConfirmAction,
  ErrorState,
  Loading,
  PageHeader,
  useResource,
} from "../masters/ui";
import { formatWallClock } from "../orders/order-shared";
import { useCurrentUser } from "../user-context";
import {
  PaymentDialog,
  RECEIVABLES_BASE,
  SALES_BASE,
  Warnings,
  useOperationId,
} from "./sale-shared";

/*
 * Cuentas a cobrar y cuenta corriente del cliente (Fase 5B). El saldo es la
 * suma de los movimientos: Debe (ventas, ajustes a cargo) − Haber (cobros,
 * ajustes a favor). Un cobro mal cargado no se anula: se corrige con un ajuste
 * con motivo, que queda en la cuenta y en la auditoría.
 */

function BalanceText({
  kind,
  amount,
  currency,
}: {
  kind: ReceivableDto["balanceKind"];
  amount: string;
  currency: string;
}) {
  if (kind === "NONE") return <span className="muted">Sin saldo</span>;
  return kind === "DEBT" ? (
    <span>Debe {formatMoney(amount, currency)}</span>
  ) : (
    <span className="text-positive">A favor {formatMoney(amount, currency)}</span>
  );
}

export function ReceivableList() {
  const currency = useCurrentUser().company.currencyCode;
  return (
    <MasterList<ReceivableDto>
      title="Cuentas a cobrar"
      subtitle="Saldo de cada cliente: lo que debe por ventas entregadas o lo que tiene a favor por señas y cobros."
      endpoint="/api/customer-accounts"
      basePath={RECEIVABLES_BASE}
      searchPlaceholder="Buscar cliente"
      emptyText="Ningún cliente con saldo en este filtro."
      statusParam="balance"
      defaultStatus="debt"
      statusOptions={[
        { value: "debt", label: "Clientes que deben" },
        { value: "credit", label: "Con saldo a favor" },
        { value: "all", label: "Todos con movimientos" },
      ]}
      columns={[
        {
          header: "Cliente",
          cell: (r) => (
            <Link href={`${RECEIVABLES_BASE}/${r.customer.id}`}>
              {r.customer.name} <span className="muted small code">{r.customer.code}</span>
            </Link>
          ),
        },
        {
          header: "Saldo",
          cell: (r) => (
            <BalanceText kind={r.balanceKind} amount={r.balanceAmount} currency={currency} />
          ),
          className: "num",
        },
        {
          header: "Ventas pendientes",
          cell: (r) => (r.pendingSales > 0 ? r.pendingSales : "—"),
          className: "num hide-sm",
        },
        {
          header: "Límite de crédito",
          cell: (r) =>
            r.creditLimit ? (
              <span className={r.creditLimitExceeded ? "text-negative" : ""}>
                {formatMoney(r.creditLimit, currency)}
                {r.creditLimitExceeded && " · superado"}
              </span>
            ) : (
              "—"
            ),
          className: "num hide-md",
        },
      ]}
    />
  );
}

export function CustomerAccount({ customerId }: { customerId: string }) {
  const user = useCurrentUser();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useResource<CustomerAccountDto>(
    `/api/customers/${customerId}/account?page=${page}`,
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const tz = user.company.timezone;
  const currency = data.currency;
  const refresh = (w: string[] = []) => {
    setWarnings(w);
    reload();
    setVersion((v) => v + 1);
  };
  const pages = Math.max(1, Math.ceil(data.movements.total / data.movements.pageSize));

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: RECEIVABLES_BASE, label: "Cuentas a cobrar" }}
        title={`Cuenta corriente · ${data.customer.name}`}
        subtitle={
          data.customer.creditLimit
            ? `Límite de crédito: ${formatMoney(data.customer.creditLimit, currency)} (sólo aviso: no bloquea ventas).`
            : "Sin límite de crédito."
        }
        actions={
          <>
            {data.canRegisterPayment && (
              <PaymentDialog
                label="Registrar cobro a cuenta"
                title={`Cobro a cuenta de ${data.customer.name}`}
                description="Queda como crédito del cliente. Después lo imputás a las ventas pendientes que corresponda."
                endpoint={`/api/customers/${customerId}/payments`}
                currency={currency}
                onDone={(r) => refresh(r.warnings)}
              />
            )}
            {data.canAdjust && (
              <AdjustAccount customerId={customerId} currency={currency} onDone={() => refresh()} />
            )}
          </>
        }
      />
      <Warnings warnings={warnings} />
      <dl className="cost-summary" aria-label="Saldo">
        <div>
          <dt>Saldo</dt>
          <dd data-testid="account-balance">
            <BalanceText kind={data.balanceKind} amount={data.balanceAmount} currency={currency} />
          </dd>
        </div>
        <div>
          <dt>Ventas pendientes</dt>
          <dd>{data.pendingSales.length}</dd>
        </div>
        <div>
          <dt>Crédito sin imputar</dt>
          <dd>{formatMoney(data.unappliedCredit, currency)}</dd>
        </div>
      </dl>

      {data.pendingSales.length > 0 && (
        <section className="panel" aria-labelledby="acc-pending">
          <h2 id="acc-pending">Ventas pendientes de cobro</h2>
          <div className="table-wrap">
            <table className="table" aria-label="Ventas pendientes">
              <thead>
                <tr>
                  <th scope="col">Venta</th>
                  <th scope="col">Fecha</th>
                  <th scope="col" className="num">
                    Total
                  </th>
                  <th scope="col" className="num hide-sm">
                    Cobrado
                  </th>
                  <th scope="col" className="num">
                    Pendiente
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.pendingSales.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link className="code" href={`${SALES_BASE}/${s.id}`}>
                        {s.code}
                      </Link>
                    </td>
                    <td>{formatDateTime(s.saleDate, tz)}</td>
                    <td className="num">{formatMoney(s.total, currency)}</td>
                    <td className="num hide-sm">{formatMoney(s.paid, currency)}</td>
                    <td className="num">{formatMoney(s.pending, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.unappliedPayments.length > 0 && (
        <section className="panel" aria-labelledby="acc-unapplied">
          <h2 id="acc-unapplied">Cobros con crédito sin imputar</h2>
          <div className="table-wrap">
            <table className="table" aria-label="Cobros sin imputar">
              <thead>
                <tr>
                  <th scope="col">Cobro</th>
                  <th scope="col">Tipo</th>
                  <th scope="col" className="num">
                    Sin imputar
                  </th>
                  <th scope="col">
                    <span className="sr-only">Acción</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.unappliedPayments.map((p) => (
                  <tr key={p.id}>
                    <td className="code">{p.code}</td>
                    <td>{PAYMENT_KIND_LABELS[p.kind]}</td>
                    <td className="num">{formatMoney(p.unapplied, currency)}</td>
                    <td>
                      {data.canRegisterPayment && data.pendingSales.length > 0 && (
                        <ApplyPayment
                          payment={p}
                          sales={data.pendingSales}
                          currency={currency}
                          onDone={() => refresh()}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="panel" aria-labelledby="acc-movements">
        <h2 id="acc-movements">Movimientos</h2>
        {data.movements.items.length === 0 ? (
          <p className="muted">Todavía no hay movimientos.</p>
        ) : (
          <div className="table-wrap">
            <table className="table" aria-label="Movimientos de la cuenta corriente">
              <thead>
                <tr>
                  <th scope="col">Fecha</th>
                  <th scope="col">Concepto</th>
                  <th scope="col" className="num">
                    Debe
                  </th>
                  <th scope="col" className="num">
                    Haber
                  </th>
                  <th scope="col" className="num">
                    Saldo
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.movements.items.map((m) => (
                  <tr key={m.id}>
                    <td>{formatWallClock(m.occurredAtLocal)}</td>
                    <td>
                      {ACCOUNT_MOVEMENT_TYPE_LABELS[m.type]}{" "}
                      {m.sale && (
                        <Link className="code" href={`${SALES_BASE}/${m.sale.id}`}>
                          {m.sale.code}
                        </Link>
                      )}
                      {m.payment && <span className="code"> {m.payment.code}</span>}
                      {(m.reason ??
                        (m.description !== ACCOUNT_MOVEMENT_TYPE_LABELS[m.type]
                          ? m.description
                          : null)) && (
                        <span className="muted small"> · {m.reason ?? m.description}</span>
                      )}
                    </td>
                    <td className="num">{m.debit ? formatMoney(m.debit, currency) : ""}</td>
                    <td className="num">{m.credit ? formatMoney(m.credit, currency) : ""}</td>
                    <td className={`num ${new D(m.balanceAfter).lt(0) ? "text-positive" : ""}`}>
                      {formatMoney(m.balanceAfter, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav className="pagination" aria-label="Páginas de movimientos">
            <button
              type="button"
              className="button button--small"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Anteriores
            </button>
            <span className="muted small">
              Página {page} de {pages}
            </span>
            <button
              type="button"
              className="button button--small"
              disabled={page >= pages}
              onClick={() => setPage((p) => p + 1)}
            >
              Siguientes
            </button>
          </nav>
        )}
        <p className="muted small">Saldo negativo: crédito a favor del cliente.</p>
      </section>
      <AuditHistory entityType="customer" entityId={customerId} version={version} />
    </div>
  );
}

function ApplyPayment({
  payment,
  sales,
  currency,
  onDone,
}: {
  payment: CustomerAccountDto["unappliedPayments"][number];
  sales: CustomerAccountDto["pendingSales"];
  currency: string;
  onDone: () => void;
}) {
  const [saleId, setSaleId] = useState(sales[0]?.id ?? "");
  const sale = sales.find((s) => s.id === saleId);
  const suggested = sale ? D.min(new D(sale.pending), new D(payment.unapplied)).toFixed(2) : "";
  const [amount, setAmount] = useState(suggested);
  // Un id por intento: un reintento (red, doble envío) no imputa dos veces.
  const [operationId, renew] = useOperationId();
  return (
    <ConfirmAction
      label="Imputar"
      title={`Imputar ${payment.code} a una venta`}
      message={`Disponible: ${formatMoney(payment.unapplied, currency)}. Imputar no cambia el saldo de la cuenta: sólo indica qué venta se cobró.`}
      confirmLabel="Imputar"
      onConfirm={async () => {
        await apiFetch(`/api/payments/${payment.id}/applications`, {
          method: "POST",
          body: { saleId, amount: toDecimal(amount), operationId },
        });
        renew();
        onDone();
      }}
    >
      <div className="form-grid">
        <div className="form__field">
          <label htmlFor={`apply-sale-${payment.id}`}>Venta</label>
          <select
            id={`apply-sale-${payment.id}`}
            value={saleId}
            onChange={(e) => {
              setSaleId(e.target.value);
              const s = sales.find((x) => x.id === e.target.value);
              if (s) setAmount(D.min(new D(s.pending), new D(payment.unapplied)).toFixed(2));
            }}
          >
            {sales.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} · pendiente {formatMoney(s.pending, currency)}
              </option>
            ))}
          </select>
        </div>
        <div className="form__field">
          <label htmlFor={`apply-amount-${payment.id}`}>Monto</label>
          <input
            id={`apply-amount-${payment.id}`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>
    </ConfirmAction>
  );
}

function AdjustAccount({
  customerId,
  currency,
  onDone,
}: {
  customerId: string;
  currency: string;
  onDone: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [direction, setDirection] = useState<"DEBIT" | "CREDIT">("CREDIT");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un id por intento: un reintento (red, doble envío) no duplica el ajuste.
  const [operationId, renew] = useOperationId();

  async function submit() {
    setError(null);
    if (!isPositive(amount)) {
      setError("Ingresá un monto mayor a cero.");
      return;
    }
    if (!reason.trim()) {
      setError("El motivo es obligatorio.");
      return;
    }
    setPending(true);
    try {
      await apiFetch(`/api/customers/${customerId}/account/adjustments`, {
        method: "POST",
        body: { direction, amount: toDecimal(amount), reason: reason.trim(), operationId },
      });
      renew();
      setAmount("");
      setReason("");
      dialogRef.current?.close();
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo registrar el ajuste.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" className="button" onClick={() => dialogRef.current?.showModal()}>
        Ajustar saldo
      </button>
      <dialog ref={dialogRef} className="dialog" aria-labelledby="adjust-title">
        <h2 id="adjust-title">Ajuste de cuenta corriente</h2>
        <p className="muted">
          Para corregir un error (por ejemplo, un cobro mal cargado). Queda registrado con su
          motivo; no borra ni modifica movimientos anteriores.
        </p>
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="adjust-direction">Tipo</label>
            <select
              id="adjust-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "DEBIT" | "CREDIT")}
            >
              <option value="CREDIT">A favor del cliente (Haber)</option>
              <option value="DEBIT">A cargo del cliente (Debe)</option>
            </select>
          </div>
          <div className="form__field">
            <label htmlFor="adjust-amount">Monto ({currency})</label>
            <input
              id="adjust-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>
        <div className="form__field">
          <label htmlFor="adjust-reason">Motivo</label>
          <textarea
            id="adjust-reason"
            value={reason}
            rows={2}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        {error && (
          <p className="form__error" role="alert">
            {error}
          </p>
        )}
        <div className="form__footer">
          <button
            type="button"
            className="button button--primary"
            onClick={submit}
            disabled={pending}
          >
            {pending ? "Registrando…" : "Registrar ajuste"}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => dialogRef.current?.close()}
            disabled={pending}
          >
            Cancelar
          </button>
        </div>
      </dialog>
    </>
  );
}
