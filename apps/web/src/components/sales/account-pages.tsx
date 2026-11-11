"use client";

import {
  ACCOUNT_MOVEMENT_TYPE_LABELS,
  PAYMENT_KIND_LABELS,
  PERMISSIONS as P,
  type CustomerAccountDto,
  type ReceivableDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import Link from "next/link";
import { useRef, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { isPositive, toDecimal } from "@/lib/decimal-input";
import { describeError } from "@/lib/errors";
import { formatDate, formatDateTime, formatMoney } from "@/lib/format";
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
import { useCan, useCurrentUser } from "../user-context";
import {
  PaymentDialog,
  RECEIVABLES_BASE,
  SALES_BASE,
  Warnings,
  useOperationId,
} from "./sale-shared";

/*
 * Cuentas a cobrar y cuenta corriente del cliente. El saldo es la suma de los
 * movimientos: cargos (ventas, ajustes a cargo) − pagos (cobros, ajustes a
 * favor). Un cobro mal cargado no se anula: se corrige con un ajuste con
 * motivo, que queda en la cuenta y en la auditoría.
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

/** Fecha (dd/mm/aaaa) de un instante ISO o de una fecha de calendario. */
function dateOnly(value: string, tz: string): string {
  return value.length > 10 ? formatDateTime(value, tz).slice(0, 10) : formatDate(value);
}

export function ReceivableList() {
  const user = useCurrentUser();
  const currency = user.company.currencyCode;
  const tz = user.company.timezone;
  return (
    <MasterList<ReceivableDto>
      title="Cuentas a cobrar"
      subtitle="Quién te debe y quién tiene crédito a favor. Entrá al cliente para registrar un cobro o imputarlo a sus ventas."
      endpoint="/api/customer-accounts"
      basePath={RECEIVABLES_BASE}
      searchPlaceholder="Buscar cliente"
      emptyText="Ningún cliente con saldo en este filtro."
      statusParam="balance"
      defaultStatus="debt"
      statusOptions={[
        { value: "debt", label: "Clientes que deben" },
        { value: "credit", label: "Con crédito a favor" },
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
          header: "Ventas sin cobrar",
          cell: (r) => (r.pendingSales > 0 ? r.pendingSales : <span className="muted">0</span>),
          className: "num",
        },
        {
          header: "Desde",
          cell: (r) =>
            r.oldestPendingSaleDate ? (
              <span title="Fecha de la venta sin cobrar más antigua">
                {dateOnly(r.oldestPendingSaleDate, tz)}
              </span>
            ) : (
              ""
            ),
          className: "hide-md",
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
              <span className="muted">Sin límite</span>
            ),
          className: "num hide-md",
        },
      ]}
    />
  );
}

export function CustomerAccount({ customerId }: { customerId: string }) {
  const user = useCurrentUser();
  const can = useCan();
  const [page, setPage] = useState(1);
  const { data, error, reload } = useResource<CustomerAccountDto>(
    `/api/customers/${customerId}/account?page=${page}`,
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Loading label="Cargando la cuenta corriente…" />;
  const tz = user.company.timezone;
  const currency = data.currency;
  const refresh = (w: string[] = []) => {
    setWarnings(w);
    reload();
    setVersion((v) => v + 1);
  };
  const pages = Math.max(1, Math.ceil(data.movements.total / data.movements.pageSize));
  const debt = data.balanceKind === "DEBT";
  const oldest = data.pendingSales.reduce<string | null>(
    (min, s) => (min === null || s.saleDate < min ? s.saleDate : min),
    null,
  );
  const limitExceeded =
    data.customer.creditLimit !== null && new D(data.balance).gt(data.customer.creditLimit);
  const hasCredit = new D(data.unappliedCredit).gt(0);
  const canApply = data.canRegisterPayment && data.unappliedPayments.length > 0;
  // Cada cambio de la cuenta remonta los diálogos de imputación: nunca quedan
  // apuntando a una venta ya saldada ni con un monto viejo.
  const stamp = [
    ...data.pendingSales.map((s) => `${s.id}:${s.pending}`),
    ...data.unappliedPayments.map((p) => `${p.id}:${p.unapplied}`),
  ].join("|");

  return (
    <div className="page">
      <PageHeader
        breadcrumb={{ href: RECEIVABLES_BASE, label: "Cuentas a cobrar" }}
        title={`Cuenta corriente · ${data.customer.name}`}
        subtitle={<span className="code">{data.customer.code}</span>}
        actions={
          <>
            {data.canRegisterPayment && (
              <PaymentDialog
                label="Registrar cobro a cuenta"
                title={`Cobro a cuenta de ${data.customer.name}`}
                primary
                defaultAmount={debt ? data.balanceAmount : undefined}
                currentBalance={data.balance}
                description={
                  <>
                    <p>
                      {debt ? (
                        <>
                          Debe hoy <strong>{formatMoney(data.balanceAmount, currency)}</strong>. Si
                          cobrás ese monto queda sin saldo; si cobrás de más, el excedente queda
                          como crédito a favor.
                        </>
                      ) : (
                        "Hoy no debe nada: el cobro queda como crédito a favor del cliente."
                      )}
                    </p>
                    {data.pendingSales.length > 0 && (
                      <p>
                        Para saldar una venta puntual usá «Cobrar» en su fila. Un cobro a cuenta
                        queda sin imputar hasta que indiques qué venta paga.
                      </p>
                    )}
                  </>
                }
                endpoint={`/api/customers/${customerId}/payments`}
                currency={currency}
                onDone={(r) => refresh(r.warnings)}
              />
            )}
            {can(P.CUSTOMERS_READ) && (
              <Link className="button button--tertiary" href={`/clientes/${customerId}`}>
                Ficha del cliente
              </Link>
            )}
            {data.canAdjust && (
              <AdjustAccount
                customerId={customerId}
                currency={currency}
                balance={data.balance}
                onDone={() => refresh()}
              />
            )}
          </>
        }
      />
      <Warnings warnings={warnings} />
      <dl className="metrics" aria-label="Resumen de la cuenta">
        <div
          className={`metric ${debt ? "metric--danger" : data.balanceKind === "CREDIT" ? "metric--success" : ""}`}
        >
          <dt className="metric__label">Saldo</dt>
          <dd className="metric__value" data-testid="account-balance">
            <BalanceText kind={data.balanceKind} amount={data.balanceAmount} currency={currency} />
          </dd>
        </div>
        <div className={`metric ${data.pendingSales.length > 0 ? "metric--warning" : ""}`}>
          <dt className="metric__label">Ventas sin cobrar</dt>
          <dd className="metric__value">{data.pendingSales.length}</dd>
          {oldest && <dd className="metric__note">La más antigua: {dateOnly(oldest, tz)}</dd>}
        </div>
        <div className="metric">
          <dt className="metric__label">Crédito sin imputar</dt>
          <dd className="metric__value">{formatMoney(data.unappliedCredit, currency)}</dd>
          {hasCredit && (
            <dd className="metric__note">Cobrado pero todavía sin aplicar a una venta.</dd>
          )}
        </div>
        <div className={`metric ${limitExceeded ? "metric--danger" : ""}`}>
          <dt className="metric__label">Límite de crédito</dt>
          <dd className="metric__value">
            {data.customer.creditLimit
              ? formatMoney(data.customer.creditLimit, currency)
              : "Sin límite"}
          </dd>
          {data.customer.creditLimit && (
            <dd className="metric__note">
              {limitExceeded ? "Superado. " : ""}Sólo avisa: no bloquea ventas.
            </dd>
          )}
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
                  <th scope="col" className="num hide-md">
                    Total
                  </th>
                  <th scope="col" className="num hide-md">
                    Cobrado
                  </th>
                  <th scope="col" className="num">
                    Falta cobrar
                  </th>
                  {data.canRegisterPayment && (
                    <th scope="col">
                      <span className="sr-only">Acciones</span>
                    </th>
                  )}
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
                    <td className="num hide-md">{formatMoney(s.total, currency)}</td>
                    <td className="num hide-md">{formatMoney(s.paid, currency)}</td>
                    <td className="num">{formatMoney(s.pending, currency)}</td>
                    {data.canRegisterPayment && (
                      <td>
                        <div className="row-actions">
                          {canApply && (
                            <ApplyCredit
                              key={`${s.id}|${stamp}`}
                              label="Imputar crédito"
                              payments={data.unappliedPayments}
                              sales={data.pendingSales}
                              initialSaleId={s.id}
                              currency={currency}
                              onDone={() => refresh()}
                            />
                          )}
                          <PaymentDialog
                            label="Cobrar"
                            small
                            title={`Cobrar la venta ${s.code}`}
                            description="El cobro se aplica directamente a esta venta."
                            endpoint={`/api/sales/${s.id}/payments`}
                            currency={currency}
                            max={s.pending}
                            defaultAmount={s.pending}
                            onDone={(r) => refresh(r.warnings)}
                          />
                        </div>
                      </td>
                    )}
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
          <p className="muted small">
            Imputar es indicar qué venta paga cada cobro. No cambia el saldo: sólo marca la venta
            como cobrada.
          </p>
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
                        <ApplyCredit
                          key={`${p.id}|${stamp}`}
                          label="Imputar"
                          payments={data.unappliedPayments}
                          sales={data.pendingSales}
                          initialPaymentId={p.id}
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
          <>
            <p className="muted small">
              Cargos: ventas y ajustes que suman deuda. Pagos: cobros, señas y ajustes a favor.
              Saldo: lo que debe el cliente después de cada movimiento.
            </p>
            <div className="table-wrap">
              <table className="table" aria-label="Movimientos de la cuenta corriente">
                <thead>
                  <tr>
                    <th scope="col">Fecha</th>
                    <th scope="col">Concepto</th>
                    <th scope="col" className="num">
                      Cargo <span className="muted small">(Debe)</span>
                    </th>
                    <th scope="col" className="num">
                      Pago <span className="muted small">(Haber)</span>
                    </th>
                    <th scope="col" className="num">
                      Saldo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.movements.items.map((m) => {
                    const after = new D(m.balanceAfter);
                    return (
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
                        <td className={`num ${after.lt(0) ? "text-positive" : ""}`}>
                          {after.lt(0)
                            ? `${formatMoney(after.abs().toFixed(2), currency)} a favor`
                            : formatMoney(m.balanceAfter, currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
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
      </section>
      <AuditHistory entityType="customer" entityId={customerId} version={version} />
    </div>
  );
}

/**
 * Imputar crédito de un cobro a una venta pendiente. Se abre desde el cobro
 * (`initialPaymentId`) o desde la venta (`initialSaleId`); el otro extremo se
 * elige si hay más de uno. Muestra cómo quedan la venta y el cobro antes de
 * confirmar. El padre lo remonta (`key`) cada vez que cambia la cuenta.
 */
function ApplyCredit({
  label,
  payments,
  sales,
  initialPaymentId,
  initialSaleId,
  currency,
  onDone,
}: {
  label: string;
  payments: CustomerAccountDto["unappliedPayments"];
  sales: CustomerAccountDto["pendingSales"];
  initialPaymentId?: string;
  initialSaleId?: string;
  currency: string;
  onDone: () => void;
}) {
  const suggest = (
    p: CustomerAccountDto["unappliedPayments"][number] | undefined,
    s: CustomerAccountDto["pendingSales"][number] | undefined,
  ) => (p && s ? D.min(new D(s.pending), new D(p.unapplied)).toFixed(2) : "");
  const [paymentId, setPaymentId] = useState(initialPaymentId ?? payments[0]?.id ?? "");
  const [saleId, setSaleId] = useState(initialSaleId ?? sales[0]?.id ?? "");
  const payment = payments.find((p) => p.id === paymentId);
  const sale = sales.find((s) => s.id === saleId);
  const [amount, setAmount] = useState(() => suggest(payment, sale));
  // Un id por intento: un reintento (red, doble envío) no imputa dos veces.
  const [operationId, renew] = useOperationId();
  const fieldId = `apply-${initialPaymentId ?? "p"}-${initialSaleId ?? "s"}`;
  const max = payment && sale ? D.min(new D(sale.pending), new D(payment.unapplied)) : null;
  const valid = isPositive(amount);
  const value = valid ? new D(toDecimal(amount)) : null;
  const tooMuch = value !== null && max !== null && value.gt(max);
  if (!payment && !sale) return null;

  return (
    <ConfirmAction
      label={label}
      small={!!initialSaleId}
      title={payment ? `Imputar ${payment.code} a una venta` : "Imputar crédito a una venta"}
      message="Imputar no cambia el saldo de la cuenta: sólo indica qué venta se cobró."
      confirmLabel="Imputar"
      validate={() => {
        if (!payment || !sale) return "Elegí el cobro y la venta.";
        if (!valid) return "Ingresá un monto mayor a cero.";
        if (tooMuch) return `El máximo es ${formatMoney(max!.toFixed(2), currency)}.`;
        return null;
      }}
      onConfirm={async () => {
        await apiFetch(`/api/payments/${paymentId}/applications`, {
          method: "POST",
          body: { saleId, amount: toDecimal(amount), operationId },
        });
        renew();
        onDone();
      }}
    >
      <div className="form-grid">
        <div className="form__field">
          {initialPaymentId || payments.length === 1 ? (
            <p>
              <span className="form__label">Cobro</span>
              <br />
              <span className="code">{payment?.code}</span> · disponible{" "}
              {formatMoney(payment?.unapplied, currency)}
            </p>
          ) : (
            <>
              <label htmlFor={`${fieldId}-payment`}>Cobro</label>
              <select
                id={`${fieldId}-payment`}
                value={paymentId}
                onChange={(e) => {
                  setPaymentId(e.target.value);
                  setAmount(
                    suggest(
                      payments.find((x) => x.id === e.target.value),
                      sale,
                    ),
                  );
                }}
              >
                {payments.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} · disponible {formatMoney(p.unapplied, currency)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className="form__field">
          {initialSaleId || sales.length === 1 ? (
            <p>
              <span className="form__label">Venta</span>
              <br />
              <span className="code">{sale?.code}</span> · falta cobrar{" "}
              {formatMoney(sale?.pending, currency)}
            </p>
          ) : (
            <>
              <label htmlFor={`${fieldId}-sale`}>Venta</label>
              <select
                id={`${fieldId}-sale`}
                value={saleId}
                onChange={(e) => {
                  setSaleId(e.target.value);
                  setAmount(
                    suggest(
                      payment,
                      sales.find((x) => x.id === e.target.value),
                    ),
                  );
                }}
              >
                {sales.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · falta cobrar {formatMoney(s.pending, currency)}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className="form__field">
          <label htmlFor={`${fieldId}-amount`}>Monto</label>
          <input
            id={`${fieldId}-amount`}
            inputMode="decimal"
            value={amount}
            aria-invalid={tooMuch || undefined}
            aria-describedby={`${fieldId}-after`}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="form__hint" id={`${fieldId}-after`}>
            {value && sale && payment && !tooMuch ? (
              <>
                Después: a la venta le falta cobrar{" "}
                {formatMoney(new D(sale.pending).minus(value).toFixed(2), currency)}; al cobro le
                quedan {formatMoney(new D(payment.unapplied).minus(value).toFixed(2), currency)} sin
                imputar.
              </>
            ) : max ? (
              <>Máximo: {formatMoney(max.toFixed(2), currency)}.</>
            ) : null}
          </span>
          {tooMuch && (
            <span className="form__error" role="alert">
              Supera el máximo de {formatMoney(max!.toFixed(2), currency)}.
            </span>
          )}
        </div>
      </div>
    </ConfirmAction>
  );
}

function AdjustAccount({
  customerId,
  currency,
  balance,
  onDone,
}: {
  customerId: string;
  currency: string;
  /** Saldo actual con signo (positivo = debe). */
  balance: string;
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
  const openerRef = useRef<HTMLButtonElement>(null);
  const after = isPositive(amount)
    ? direction === "CREDIT"
      ? new D(balance).minus(toDecimal(amount))
      : new D(balance).plus(toDecimal(amount))
    : null;
  const describeBalance = (v: InstanceType<typeof D>) =>
    v.gt(0)
      ? `debe ${formatMoney(v.toFixed(2), currency)}`
      : v.lt(0)
        ? `${formatMoney(v.abs().toFixed(2), currency)} a favor`
        : "sin saldo";

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
      setError(err instanceof ApiError ? describeError(err) : "No se pudo registrar el ajuste.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={openerRef}
        className="button button--tertiary"
        onClick={() => {
          // Cada apertura empieza limpia.
          setError(null);
          setAmount("");
          setReason("");
          setDirection("CREDIT");
          dialogRef.current?.showModal();
        }}
      >
        Ajustar saldo
      </button>
      <dialog
        ref={dialogRef}
        className="dialog"
        aria-labelledby="adjust-title"
        onClose={() => openerRef.current?.focus()}
      >
        <h2 id="adjust-title">Ajuste de cuenta corriente</h2>
        <p className="muted">
          Sólo para corregir un error (por ejemplo, un cobro mal cargado). Para registrar un pago
          usá «Registrar cobro a cuenta». El ajuste queda con su motivo y no borra movimientos
          anteriores.
        </p>
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor="adjust-direction">Tipo</label>
            <select
              id="adjust-direction"
              value={direction}
              onChange={(e) => setDirection(e.target.value as "DEBIT" | "CREDIT")}
            >
              <option value="CREDIT">A favor del cliente (baja lo que debe)</option>
              <option value="DEBIT">A cargo del cliente (sube lo que debe)</option>
            </select>
          </div>
          <div className="form__field">
            <label htmlFor="adjust-amount">
              Monto ({currency}){" "}
              <span className="form__required" aria-hidden="true">
                *
              </span>
            </label>
            <input
              id="adjust-amount"
              inputMode="decimal"
              value={amount}
              aria-required
              aria-describedby="adjust-after"
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="form__hint" id="adjust-after">
              Saldo actual: {describeBalance(new D(balance))}
              {after && <> · después del ajuste: {describeBalance(after)}</>}
            </span>
          </div>
        </div>
        <div className="form__field">
          <label htmlFor="adjust-reason">
            Motivo{" "}
            <span className="form__required" aria-hidden="true">
              *
            </span>
          </label>
          <textarea
            id="adjust-reason"
            value={reason}
            rows={2}
            maxLength={500}
            aria-required
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
            className="button"
            onClick={() => dialogRef.current?.close()}
            disabled={pending}
          >
            Volver
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={submit}
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? "Registrando…" : "Registrar ajuste"}
          </button>
        </div>
      </dialog>
    </>
  );
}
