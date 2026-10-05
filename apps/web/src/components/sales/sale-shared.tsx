"use client";

import {
  NEGATIVE_MARGIN_WARNING,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  SALE_PAYMENT_STATUS_LABELS,
  SALE_STATUS_LABELS,
  type MarginDto,
  type PaymentMethodDto,
  type PaymentResultDto,
  type SalePaymentStatusDto,
  type SaleStatusDto,
} from "@bakery/shared";
import { D } from "@bakery/domain";
import { useId, useRef, useState, type ReactNode } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import { isPositive, toDecimal } from "@/lib/decimal-input";
import { describeError, localizeNumbers } from "@/lib/errors";
import { formatMoney, formatPercent } from "@/lib/format";
import { PAYMENT_STATUS_TONE, SALE_STATUS_TONE } from "@/lib/status";
import { StatusBadge } from "../ui/status";

/*
 * Piezas comunes de ventas, cobros y cuenta corriente (Fase 5B).
 */

export const SALES_BASE = "/ventas";
export const PRICE_LISTS_BASE = "/listas-de-precios";
export const RECEIVABLES_BASE = "/cuentas-a-cobrar";

export function SaleStatusBadge({ status }: { status: SaleStatusDto }) {
  return <StatusBadge tone={SALE_STATUS_TONE[status]}>{SALE_STATUS_LABELS[status]}</StatusBadge>;
}

export function PaymentStatusBadge({ status }: { status: SalePaymentStatusDto }) {
  return (
    <StatusBadge tone={PAYMENT_STATUS_TONE[status]}>
      {SALE_PAYMENT_STATUS_LABELS[status]}
    </StatusBadge>
  );
}

const negative = (m: MarginDto | null) => m !== null && new D(m.amount).lt(0);

/** "Margen sobre materiales": monto y porcentaje; en rojo y con aviso si es negativo. */
export function MarginText({ margin, currency }: { margin: MarginDto | null; currency: string }) {
  if (!margin) return <>—</>;
  return (
    <span className={negative(margin) ? "text-negative" : ""}>
      {formatMoney(margin.amount, currency)}
      {margin.percentage !== null && (
        <span className="small"> ({formatPercent(margin.percentage)})</span>
      )}
    </span>
  );
}

export function NegativeMarginNotice({ margin }: { margin: MarginDto | null }) {
  if (!negative(margin)) return null;
  return (
    <p className="alert alert--warn" role="status">
      {NEGATIVE_MARGIN_WARNING}
    </p>
  );
}

/** Un `operationId` por intento: reintentar el mismo diálogo no duplica el cobro. */
export function useOperationId(): [string, () => void] {
  const [id, setId] = useState(() => crypto.randomUUID());
  return [id, () => setId(crypto.randomUUID())];
}

/**
 * Diálogo de cobro (cobro de una venta, seña o cobro a cuenta). Valida el
 * monto contra el máximo (si lo hay) antes de llamar a la API, que igual lo
 * vuelve a validar.
 */
export function PaymentDialog({
  label,
  title,
  description,
  endpoint,
  currency,
  max,
  maxMessage,
  defaultAmount,
  primary,
  small,
  onDone,
}: {
  label: string;
  title: string;
  description?: ReactNode;
  endpoint: string;
  currency: string;
  /** Monto máximo (pendiente de la venta). */
  max?: string;
  maxMessage?: string;
  defaultAmount?: string;
  /** Es el paso principal de la pantalla (p. ej. cobrar una venta pendiente). */
  primary?: boolean;
  small?: boolean;
  onDone: (result: PaymentResultDto) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [operationId, renew] = useOperationId();
  const [amount, setAmount] = useState(defaultAmount ?? "");
  const [method, setMethod] = useState<PaymentMethodDto>("CASH");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const tooMuch = max !== undefined && isPositive(amount) && new D(toDecimal(amount)).gt(max);
  const id = useId();
  const openerRef = useRef<HTMLButtonElement>(null);
  const remaining =
    max !== undefined && isPositive(amount) && !tooMuch
      ? new D(max).minus(toDecimal(amount)).toFixed(2)
      : null;

  async function submit() {
    setError(null);
    setFieldErrors({});
    if (!isPositive(amount)) {
      setFieldErrors({ amount: "Ingresá un monto mayor a cero" });
      return;
    }
    if (tooMuch) return;
    setPending(true);
    try {
      const result = await apiFetch<PaymentResultDto>(endpoint, {
        method: "POST",
        body: {
          amount: toDecimal(amount),
          paymentMethod: method,
          reference: reference.trim() || null,
          notes: notes.trim() || null,
          operationId,
        },
      });
      renew();
      setAmount("");
      setReference("");
      setNotes("");
      dialogRef.current?.close();
      onDone(result);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(describeError(err));
        setFieldErrors(err.fieldErrors);
      } else setError("No se pudo registrar el cobro.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={openerRef}
        className={`button ${primary ? "button--primary" : ""} ${small ? "button--small" : ""}`}
        onClick={() => {
          // Cada apertura empieza limpia, con el monto sugerido.
          setError(null);
          setFieldErrors({});
          setAmount(defaultAmount ?? "");
          setReference("");
          setNotes("");
          dialogRef.current?.showModal();
        }}
      >
        {label}
      </button>
      <dialog
        ref={dialogRef}
        className="dialog"
        aria-labelledby={`${id}-title`}
        onClose={() => openerRef.current?.focus()}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        {description && <div className="muted">{description}</div>}
        <div className="form-grid">
          <div className="form__field">
            <label htmlFor={`${id}-amount`}>Monto</label>
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              value={amount}
              placeholder="Ej.: 15000"
              aria-invalid={fieldErrors.amount || tooMuch ? true : undefined}
              onChange={(e) => setAmount(e.target.value)}
            />
            {max !== undefined && (
              <span className="form__hint" id={`${id}-hint`}>
                Pendiente: {formatMoney(max, currency)}
                {remaining !== null && <> · queda {formatMoney(remaining, currency)} después</>}
              </span>
            )}
            {tooMuch && (
              <span className="form__error" role="alert">
                {maxMessage ?? `Supera el pendiente de ${formatMoney(max, currency)}.`}
              </span>
            )}
            {fieldErrors.amount && (
              <span className="form__error" role="alert">
                {fieldErrors.amount}
              </span>
            )}
          </div>
          <div className="form__field">
            <label htmlFor={`${id}-method`}>Medio de pago</label>
            <select
              id={`${id}-method`}
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethodDto)}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="form__field">
            <label htmlFor={`${id}-reference`}>Referencia</label>
            <input
              id={`${id}-reference`}
              value={reference}
              maxLength={120}
              placeholder="N.º de operación, cheque…"
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="form__field">
            <label htmlFor={`${id}-notes`}>Notas</label>
            <input
              id={`${id}-notes`}
              value={notes}
              maxLength={1000}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
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
            disabled={pending || tooMuch}
            aria-busy={pending || undefined}
          >
            {pending ? "Registrando…" : "Registrar cobro"}
          </button>
        </div>
      </dialog>
    </>
  );
}

/** Avisos de una operación (límite de crédito, crédito a favor…). */
export function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="alert alert--warn" role="status" data-testid="operation-warnings">
      <ul className="plain-list">
        {warnings.map((w) => (
          <li key={w}>{localizeNumbers(w)}</li>
        ))}
      </ul>
    </div>
  );
}
