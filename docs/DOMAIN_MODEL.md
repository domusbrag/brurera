# Modelo de dominio

Este documento describe las entidades del sistema y sus relaciones. **Las de las Fases 0 y 1
existen hoy en la base.** El resto es diseño de referencia y se implementará (y podrá ajustarse) en
la fase indicada, cada una con su propia migración.

Convenciones:

- Todas las entidades de negocio tienen `company_id`, y las referencias entre ellas usan FKs
  compuestas `(company_id, id)`: la base misma impide apuntar a un registro de otra empresa.
- Identificadores UUID. Marcas de tiempo `timestamptz`. Dinero y cantidades `numeric`.
- **Maestros** (se editan, se activan/desactivan, nunca se borran) vs **transacciones**
  (documentos con estados; una vez confirmados no se borran ni editan: se cancelan o revierten con
  operaciones explícitas).
- Estados de documentos como enums con transiciones validadas; nunca banderas booleanas sueltas.

## Diagrama ER — Fases 0 y 1 (implementado)

```mermaid
erDiagram
    USER ||--o{ COMPANY_MEMBERSHIP : "pertenece a"
    COMPANY ||--o{ COMPANY_MEMBERSHIP : ""
    EMPLOYEE |o--o| COMPANY_MEMBERSHIP : "acceso del empleado"
    COMPANY_MEMBERSHIP ||--o{ MEMBERSHIP_ROLE : ""
    ROLE ||--o{ MEMBERSHIP_ROLE : ""
    ROLE ||--o{ ROLE_PERMISSION : ""
    PERMISSION ||--o{ ROLE_PERMISSION : ""
    COMPANY ||--o{ ROLE : define
    COMPANY ||--o{ EMPLOYEE : emplea
    USER ||--o{ SESSION : ""
    COMPANY ||--o{ SESSION : "trabaja en"
    USER |o--o{ AUDIT_LOG : "actor de"

    COMPANY ||--o{ CODE_SEQUENCE : ""
    COMPANY ||--o{ CUSTOMER : ""
    COMPANY ||--o{ SUPPLIER : ""
    COMPANY ||--o{ WAREHOUSE : ""
    COMPANY ||--o{ UNIT_OF_MEASURE : ""
    UNIT_OF_MEASURE |o--o{ UNIT_OF_MEASURE : "base de"
    COMPANY ||--o{ CATEGORY : ""
    CATEGORY ||--o{ RAW_MATERIAL : "tipo RAW_MATERIAL"
    CATEGORY ||--o{ PRODUCT : "tipo PRODUCT"
    UNIT_OF_MEASURE ||--o{ RAW_MATERIAL : "unidad base (raíz)"
    UNIT_OF_MEASURE ||--o{ PRODUCT : "unidad de venta"
    SUPPLIER |o--o{ RAW_MATERIAL : "preferido"
```

## Diagrama ER — fases futuras (previsto)

```mermaid
erDiagram
    PRODUCT ||--o{ RECIPE : ""
    RECIPE ||--|{ RECIPE_VERSION : ""
    RECIPE_VERSION ||--|{ RECIPE_INGREDIENT : ""
    RAW_MATERIAL ||--o{ RECIPE_INGREDIENT : ""

    SUPPLIER ||--o{ PURCHASE : ""
    PURCHASE ||--|{ PURCHASE_ITEM : ""
    RAW_MATERIAL ||--o{ PURCHASE_ITEM : ""

    RECIPE_VERSION ||--o{ PRODUCTION_ORDER : "usada en"
    PRODUCTION_ORDER ||--o{ PRODUCTION_COST_SNAPSHOT : ""

    WAREHOUSE ||--o{ STOCK_MOVEMENT : ""
    STOCK_MOVEMENT }o--|| STOCK_ITEM : "materia prima o producto"

    CUSTOMER ||--o{ SALE : ""
    PRICE_LIST ||--o{ CUSTOMER : "predeterminada"
    PRICE_LIST ||--o{ PRICE_LIST_ITEM : ""
    SALE ||--|{ SALE_ITEM : ""
    PRODUCT ||--o{ SALE_ITEM : ""
    SALE ||--o| INVOICE : ""

    CUSTOMER ||--o{ CUSTOMER_ACCOUNT_MOVEMENT : ""
    SUPPLIER ||--o{ SUPPLIER_ACCOUNT_MOVEMENT : ""
    CASH_ACCOUNT ||--o{ CASH_MOVEMENT : ""
    EXPENSE_CATEGORY ||--o{ EXPENSE : ""
```

## Identidad, empresa y autoridad (Fases 0 y 1)

| Entidad             | Descripción                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Company`           | Empresa: razón social, nombre comercial, CUIT, dirección, localidad, provincia, CP, contacto, logo, moneda (ARS), zona horaria (Buenos Aires), `active`. |
| `User`              | Identidad **global** de acceso: email único (sin distinguir mayúsculas), hash Argon2id, bloqueo global `ACTIVE`/`DISABLED`. No pertenece a una empresa.  |
| `CompanyMembership` | Pertenencia de un usuario a una empresa: estado `ACTIVE`/`DISABLED`, empleado vinculado opcional. Única por (empresa, usuario) y por empleado.           |
| `MembershipRole`    | Roles de una membresía (N:M). Lleva `company_id` para que la FK compuesta impida asignar roles de otra empresa.                                          |
| `Role`              | Rol por empresa (`code` único por empresa). `is_system` marca los 7 roles iniciales. Roles como datos.                                                   |
| `Permission`        | Catálogo global de permisos `modulo.accion`, sincronizado desde `@bakery/shared`.                                                                        |
| `RolePermission`    | N:M rol ↔ permiso.                                                                                                                                       |
| `Session`           | Sesión de servidor ligada a **una** empresa: hash del token, expiración, revocación, IP, user-agent.                                                     |
| `Employee`          | Persona que trabaja en la empresa: legajo (`EMP-0001`), documento, contacto, puesto, ingreso/egreso, estado `ACTIVE`/`INACTIVE`. Puede no tener usuario. |
| `AuditLog`          | Registro solo-inserción: actor, acción, entidad, id, metadata (sin secretos), request id, IP, timestamp.                                                 |

**Usuario ≠ empleado.** Un empleado puede no tener acceso (panadero sin usuario) y un usuario puede
no ser empleado (contador externo). Cuando existen ambos, el vínculo vive en la membresía.

**Autoridad.** Permisos efectivos de un usuario en una empresa = unión de los permisos de los roles
de su membresía activa. Login exige identidad activa y al menos una membresía activa en una empresa
activa; en el MVP la sesión toma la primera y no hay selector de empresa. "Desactivar usuario"
desactiva la membresía en esa empresa y revoca sus sesiones allí; dar de baja al empleado hace lo
mismo con su acceso. Detalle en [PERMISSIONS.md](PERMISSIONS.md).

## Maestros (Fase 1, implementado)

| Entidad         | Campos principales / notas                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CodeSequence`  | Próximo número por (empresa, tipo de código). Se incrementa con bloqueo de fila en la transacción del alta.                                                                                                                                                                                                                      |
| `Customer`      | `CLI-0001`, tipo (consumidor final, comercio, mayorista, distribuidor, otro), razón social, nombre comercial, CUIT opcional, contacto, dirección, condición comercial (contado / cuenta corriente), límite de crédito opcional, observaciones, activo. Lista de precios: Fase 5.                                                 |
| `Supplier`      | `PROV-0001`, razón social, nombre comercial, CUIT, persona de contacto, contacto, dirección, condiciones de pago, observaciones, activo.                                                                                                                                                                                         |
| `UnitOfMeasure` | Por empresa. Código, nombre, símbolo, dimensión (masa, volumen, cantidad, envase, otra), decimales. Una unidad raíz no tiene base; una derivada declara `1 u = factor × base` con base raíz de la misma dimensión. Dimensión, base y factor son inmutables. Estándar al aprovisionar: kg, g, l, ml, unidad, docena, bolsa, caja. |
| `Category`      | Una tabla con `type` `RAW_MATERIAL` / `PRODUCT`; nombre único por empresa y tipo; orden; activo.                                                                                                                                                                                                                                 |
| `RawMaterial`   | `MP-0001`, nombre, categoría (tipo materia prima), unidad base **raíz**, stock mínimo, proveedor preferido, costo de referencia por unidad base (manual hasta Fase 3), activo. **Sin columna de stock.**                                                                                                                         |
| `Product`       | `PROD-0001`, nombre, categoría (tipo producto), unidad de venta, precio de venta, controla stock, imagen, descripción, activo. **Sin costo**: saldrá de la receta (Fase 2).                                                                                                                                                      |
| `Warehouse`     | `DEP-0001`, nombre, dirección, descripción, activo. Cada empresa nace con "Depósito Principal". Sin stock hasta Fase 3.                                                                                                                                                                                                          |

Códigos: se generan por empresa y tipo si el usuario no los indica; también se aceptan manuales.
Se guardan en mayúsculas con `UNIQUE (company_id, código)`. Los nombres y el CUIT no son únicos.

## Recetas (Fase 2)

- `Recipe` (producto, nombre) → `RecipeVersion` (número, rendimiento esperado y unidad, merma %
  opcional, instrucciones, activa desde, estado `DRAFT`/`ACTIVE`/`ARCHIVED`) →
  `RecipeIngredient` (materia prima, cantidad, unidad).
- Una versión usada en producción es **inmutable**. Cambiar la receta = nueva versión; la anterior
  se archiva. Las órdenes históricas conservan su referencia.
- Costo teórico = Σ (cantidad convertida a unidad base × costo actual) / rendimiento.

## Inventario (Fase 3)

`StockMovement`: depósito, tipo de ítem (`RAW_MATERIAL`/`PRODUCT`), ítem, cantidad con signo,
unidad, fecha, tipo (`PURCHASE_RECEIPT`, `PRODUCTION_CONSUMPTION`, `PRODUCTION_OUTPUT`, `SALE`,
`ADJUSTMENT_POSITIVE`, `ADJUSTMENT_NEGATIVE`, `WASTE`, `RETURN`, `INITIAL_STOCK`),
`reference_type`/`reference_id` (documento origen), usuario, observación, costo unitario.

- **El stock es la suma de movimientos.** Si por rendimiento se agrega un saldo cacheado, se
  actualiza en la misma transacción que el movimiento y existe un proceso de reconciliación.
- Idempotencia: restricción única sobre (`reference_type`, `reference_id`, línea, tipo) para que un
  documento no genere movimientos dos veces.
- Mermas (`WASTE`) con motivo: `VENCIMIENTO`, `ERROR_PRODUCCION`, `ROTURA`, `CALIDAD`, `AJUSTE`, `OTRO`.

## Compras (Fase 3)

`Purchase` (proveedor, fecha, comprobante, estado `DRAFT` → `RECEIVED`; estado de pago
`PENDING`/`PARTIAL`/`PAID`, subtotal, impuestos, total) + `PurchaseItem`. Recibir la compra en una
transacción: movimientos positivos, recálculo de costo por **promedio ponderado móvil** (función de
dominio única), movimiento en cuenta del proveedor, auditoría.

## Producción (Fase 4)

`ProductionOrder` (producto, versión de receta, cantidad planificada/real, fecha, responsable,
estado `DRAFT`/`PLANNED`/`IN_PROGRESS`/`COMPLETED`/`CANCELLED`). Completar, en una transacción:
validar disponibilidad → consumos negativos → costo real y teórico → `ProductionCostSnapshot` →
salida positiva de producto → rendimiento real y merma.

## Ventas y cuentas (Fases 5–6)

- `Sale` (`DRAFT`/`CONFIRMED`/`PARTIALLY_PAID`/`PAID`/`CANCELLED`) + `SaleItem`. Confirmar descuenta
  stock una sola vez; cancelar genera movimientos inversos.
- `PriceList` + `PriceListItem`; cada cliente con lista predeterminada.
- `CustomerAccountMovement` (`SALE`, `PAYMENT`, `CREDIT_NOTE`, `ADJUSTMENT`) y
  `SupplierAccountMovement` (`PURCHASE`, `PAYMENT`, `DEBIT`, `CREDIT`, `ADJUSTMENT`): el saldo es la
  suma del ledger.
- `CashAccount` + `CashMovement` (`SALE_INCOME`, `CUSTOMER_PAYMENT`, `SUPPLIER_PAYMENT`, `EXPENSE`,
  `ADJUSTMENT`, `OTHER_INCOME`, `OTHER_EXPENSE`), medios de pago (efectivo, transferencia, débito,
  crédito, cuenta corriente, otro). Resumen diario.
- `Expense` + `ExpenseCategory`.

## Facturación (Fase 7)

`Invoice` (venta, cliente, tipo, número, fecha, subtotal, impuestos, total, estado). Emisión a
través de la interfaz `TaxInvoiceProvider`; implementación inicial `InternalInvoiceProvider`. La
integración fiscal argentina (`ArgentinaFiscalInvoiceProvider`) es un milestone aparte.

## Invariantes críticas

| Área       | Invariante                                                                  | Cómo se garantiza / testea                                                                                                                      |
| ---------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Auditoría  | Las operaciones sensibles registran actor y timestamp. El log no se altera. | **Fase 0:** trigger que rechaza UPDATE/DELETE. **Fase 1:** cada alta/cambio/baja de maestro audita en la misma transacción (tests por entidad). |
| Seguridad  | Autorización validada en backend por permiso.                               | **Fase 0/1:** matriz rol × endpoint verificada contra la API (`authorization.test.ts`).                                                         |
| Tenancy    | Ningún dato cruza empresas.                                                 | **Fase 1:** empresa tomada solo de la sesión; FKs compuestas; tests Empresa A/B (leer, modificar, inferir, referenciar).                        |
| Maestros   | Nada se borra; se desactiva. Usuario ≠ empleado.                            | **Fase 1:** sin endpoints DELETE; tests de desactivación y de baja de empleado con acceso.                                                      |
| Unidades   | Solo se convierte dentro de la misma raíz; masa ↔ volumen se rechaza.       | **Fase 1:** `@bakery/domain` con decimal.js; tests unitarios e integración (422 `INCOMPATIBLE_UNITS`).                                          |
| Inventario | Todo cambio de stock tiene un `StockMovement`.                              | Fase 3: sin columna de stock editable; tests de integración.                                                                                    |
| Producción | Completar genera consumo + salida en una única transacción.                 | Fase 4: test de rollback provocando falla.                                                                                                      |
| Recetas    | Una producción referencia una versión inmutable.                            | Fase 2: test v1 intacta tras crear v2.                                                                                                          |
| Compras    | Una compra recibida afecta stock una sola vez.                              | Fase 3: transición de estado + restricción única + test de doble ejecución.                                                                     |
| Ventas     | Una venta confirmada afecta stock una sola vez.                             | Fase 5: ídem.                                                                                                                                   |
| Costos     | Producciones históricas conservan snapshot de costos.                       | Fase 4.                                                                                                                                         |
| Caja       | Todo movimiento financiero relevante es trazable a su origen.               | Fase 6: referencia obligatoria salvo movimientos manuales con motivo.                                                                           |
