# Producto

## Visión

Un ERP vertical especializado en panificadoras. Empieza como un MVP controlado con una arquitectura
sólida para evolucionar a un producto comercial utilizable por distintas panificadoras.

El núcleo conecta:

```
PROVEEDORES → COMPRAS → MATERIAS PRIMAS → STOCK → RECETAS → PRODUCCIÓN
  → PRODUCTOS TERMINADOS → VENTAS → CLIENTES → COBROS / FACTURACIÓN
```

Alrededor del núcleo: empleados, usuarios, roles y permisos, caja, gastos, cuentas corrientes,
costos, precios, reportes, auditoría y configuración empresarial.

## Preguntas que el sistema debe responder

- ¿Cuánta harina tengo? ¿Qué materias primas necesito comprar?
- ¿Cuánto puedo producir con el stock actual? ¿Qué se produjo hoy?
- ¿Cuánto cuesta producir 1 kg de pan? ¿Cuánto aumentó desde la última compra?
- ¿Qué productos generan mayor margen? ¿Qué precio debería tener un producto según su costo?
- ¿Qué clientes deben dinero? ¿Cuánto debemos a proveedores?
- ¿Cuánto vendimos y gastamos hoy?
- ¿Qué stock debería existir y qué stock existe realmente?

## Principios

1. **Profesional pero incremental.** Base bien modelada primero; funcionalidad encima después.
2. **Una única fuente de verdad.** El stock no se edita: se deriva de movimientos. Todo cambio de
   stock tiene un `StockMovement`.
3. **Trazabilidad.** Quién, cuándo, qué documento originó la operación, qué cambió y por qué.
4. **Información histórica.** No se sobrescribe historia relevante (p. ej., producciones apuntan a
   una versión inmutable de receta).
5. **Transacciones de negocio atómicas.** Confirmar compra, confirmar producción, finalizar venta,
   registrar cobro: todo o nada.
6. **Nada de FLOAT para dinero ni cantidades comerciales.** `numeric` en base, decimal en código.
7. **Maestros separados de transacciones.** Los documentos confirmados no se eliminan
   silenciosamente; se corrigen con operaciones explícitas (cancelación, reversión).

## Alcance del MVP (resumen)

| Módulo                  | Contenido                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Empresa y configuración | Razón social, nombre comercial, CUIT, contacto, logo, moneda, zona horaria. Una empresa operativa, sin bloquear multiempresa.             |
| Usuarios y empleados    | Empleado (persona) separado de Usuario (identidad de acceso). Sin liquidación de sueldos.                                                 |
| Roles y permisos        | ADMIN, DUEÑO, ADMINISTRACIÓN, VENTAS, COMPRAS, PRODUCCIÓN, DEPÓSITO. Permisos explícitos; roles como datos.                               |
| Clientes                | Datos comerciales, tipo, lista de precios, límite de crédito, historial y cuenta corriente.                                               |
| Proveedores             | Datos, condición de pago, compras, pagos, deuda, evolución de precios.                                                                    |
| Unidades de medida      | kg, g, litro, ml, unidad, docena, bolsa, caja. Conversiones explícitas y testeables.                                                      |
| Materias primas         | Código, categoría, unidad base, costo actual, stock derivado del ledger, stock mínimo.                                                    |
| Productos terminados    | Unidad de venta, precio, costo calculado, margen, control de stock opcional, receta opcional.                                             |
| Recetas                 | Recipe → RecipeVersion → RecipeIngredient. Versiones inmutables una vez usadas. Costo teórico.                                            |
| Inventario              | `StockMovement` con tipo, origen, referencia, usuario. Depósitos (`Warehouse`) modelados desde el inicio.                                 |
| Compras                 | Borrador → Recibida → Pendiente/Parcial/Pagada. Recepción genera stock y actualiza costo (promedio ponderado móvil).                      |
| Producción              | `ProductionOrder` (DRAFT/PLANNED/IN_PROGRESS/COMPLETED/CANCELLED). Completar = consumo + salida + snapshot de costos, en una transacción. |
| Mermas                  | Materia prima o producto, motivo, cantidad, responsable. Genera movimientos.                                                              |
| Ventas                  | DRAFT/CONFIRMED/PARTIALLY_PAID/PAID/CANCELLED. Confirmar descuenta stock una sola vez. Corrección por cancelación controlada.             |
| Listas de precios       | Modelo preparado para varias listas; MVP con una principal.                                                                               |
| Cuentas corrientes      | Ledger de clientes (`CustomerAccountMovement`) y de proveedores (`SupplierAccountMovement`).                                              |
| Caja                    | `CashAccount`, `CashMovement`, medios de pago, resumen diario.                                                                            |
| Gastos                  | Categorías, registro y reporte.                                                                                                           |
| Facturación             | `Invoice` + interfaz `TaxInvoiceProvider`; primera implementación `InternalInvoiceProvider`. Sin integración fiscal real en el MVP.       |
| Auditoría               | `AuditLog` para operaciones críticas, sin secretos.                                                                                       |
| Dashboard del dueño     | Indicadores de hoy, stock bajo mínimo, deudores, producción. Solo métricas respaldadas por datos reales.                                  |
| Reportes                | Ventas, compras, stock, producción, mermas, saldos, caja, costos. Filtros por fecha, cliente, proveedor, producto, categoría.             |
| Catálogo                | Catálogo interno administrable. El catálogo público es una evolución posterior.                                                           |

## Fuera del MVP

Ecommerce público, app móvil nativa, delivery y rutas, OCR, IA, predicción de demanda,
múltiples sucursales operativas, multiempresa completo, sueldos y liquidación laboral, control
horario avanzado, contabilidad formal completa, integración bancaria, integración fiscal real,
WhatsApp, fidelización y planificación avanzada de producción.

La arquitectura permite estas extensiones pero no se construyen preventivamente.

## Definición de MVP terminado

Una persona sin intervención técnica puede: ingresar; crear proveedor y materia prima; comprar y
confirmar recepción; verificar stock; crear producto y receta; producir; verificar consumo y
producto terminado; crear cliente; vender; registrar pago; consultar caja, deuda, costo y reportes;
y reconstruir qué usuario realizó cada operación. Además: tests verdes, sin errores de consola,
migraciones reproducibles, instalación documentada, permisos verificados y datos consistentes.

## UX

Desktop-first para administración y usable desde tablet. Menú:

- **Inicio**
- **Operaciones:** Ventas, Compras, Producción
- **Inventario:** Stock, Materias primas, Productos, Recetas
- **Comercial:** Clientes, Proveedores
- **Finanzas:** Caja, Cuentas a cobrar, Cuentas a pagar, Gastos, Facturación
- **Equipo:** Empleados
- **Análisis:** Reportes
- **Configuración**

Lenguaje del negocio, sin conceptos técnicos en la interfaz.
