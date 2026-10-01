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

## Estado

Fases 0 (fundación), 1 (maestros), 2 (recetas + costo teórico), 3 (compras + inventario) y 4
(producción) aceptadas; Fase 4.5 (lotes, conservación y vida útil) implementada y esperando gate
humano. Ver [ROADMAP](ROADMAP.md).

### Lotes, conservación y vida útil (Fase 4.5)

- **Configurar la conservación de un producto** (Productos → producto → Conservación →
  Configurar): qué estados admite (fresco, refrigerado, congelado, descongelado), cuánto dura en
  cada uno (en horas o días), en cuáles puede nacer al producirse, el estado inicial por defecto y
  con cuánta anticipación avisar "próximo a vencer". Cambiarla vale para lotes nuevos: los
  existentes conservan su vencimiento. Sin configurar, los lotes nacen frescos y sin vencimiento.
- **Cada producción completada crea un lote** con el código de lote de la orden, su estado inicial
  (el por defecto o, si el producto admite varios, el elegido al confirmar) y su "utilizable hasta".
  La orden completada enlaza a su lote.
- **Ver los lotes de un producto** (Stock → Productos terminados → producto): stock físico,
  utilizable ahora, próximo a vencer, cantidades por conservación, lotes ordenados por vencimiento
  (primero el que hay que usar antes) y **disponibilidad a una fecha**: cuánto habrá utilizable,
  por ejemplo, el sábado, y por qué el resto no (vencido o bloqueado).
- **Congelar** parte o todo un lote fresco o refrigerado y **descongelar** parte de uno congelado:
  se crea un lote nuevo con su propio vencimiento, el stock total y su valor no cambian. Antes de
  confirmar se ve el resumen; al descongelar se avisa que no se puede volver a congelar.
- **Registrar merma de un lote** (vencimiento, daño, calidad, otro): sale al costo del lote, sin
  cambiar el costo promedio.
- **Bloquear o desbloquear un lote** por calidad: un lote bloqueado no se cuenta como disponible.
- **Próximos a vencer** (Stock → Próximos a vencer): lotes vencidos o que vencen dentro del aviso
  de cada producto o de una ventana elegida.
- En el listado de productos terminados: físico, fresco, refrigerado, congelado, utilizable ahora
  y próximo a vencer. Los movimientos muestran su lote.

Fuera de esta fase: reservas de stock, ventas que consuman lotes (Fase 5), transferir lotes entre
depósitos y vencimiento automático con tareas programadas (el estado se calcula en cada consulta).

### Producción (Fase 4)

Una persona con los permisos correspondientes puede, sin intervención técnica:

- **Crear una orden de producción** (Producción → Órdenes → Nueva orden): producto, fecha,
  cantidad (en la unidad de venta u otra compatible), depósito de materias primas, depósito de
  producto terminado y responsable. Mientras completa el formulario ve la receta sugerida (la
  vigente para esa fecha), cuánto rinde, la escala, qué materias primas necesita, cuánto hay y
  cuánto falta, y (con permiso) el costo esperado. Se guarda como borrador; no mueve stock.
- **Planificar**: se fijan la versión de receta, las cantidades y el costo esperado y se asigna un
  lote (`LOT-AAAAMMDD-NNN`). Se puede planificar aunque falte materia prima, para producir más
  adelante; la orden muestra el faltante con un acceso a "Comprar".
- **Iniciar** sólo con stock suficiente en el depósito de materias primas; si falta, el botón está
  deshabilitado y se ve qué falta. Después de una recepción de compra, "Volver a verificar" habilita
  el inicio.
- **Cargar lo real**: cuánto se usó de cada materia prima (arranca con lo planificado; acepta otra
  unidad compatible, p. ej. gramos), **consumos extra** con motivo (sin tocar la receta) y la
  **cantidad obtenida**. Puede guardar el avance.
- **Revisar y confirmar**: un resumen con plan contra real, rendimiento, faltantes y (con permiso)
  el costo estimado; "Confirmar producción" descuenta las materias primas y suma el producto
  terminado en una sola operación. Si mientras tanto alguien consumió el stock, se rechaza con el
  detalle de lo que falta y no se mueve nada.
- **Ver la producción completada**: plan contra real por materia prima, rendimiento, costo esperado
  contra costo material real (total y por unidad) y su diferencia, los movimientos de stock y el
  historial. Una producción completada no se modifica ni se borra.
- **Cancelar** una orden antes de completarla, con motivo opcional; no mueve stock.
- **Ver el stock de productos terminados** (Stock → Productos terminados) y la ficha de cada
  producto: stock por depósito, costo promedio material, valor, producciones recientes,
  movimientos, historial de costo, receta vigente, precio de venta y margen teórico.

Cuatro costos distintos, siempre con su nombre: **costo teórico** (receta), **costo esperado**
(fijado al planificar), **costo material real** (fijado al completar, suma de lo consumido al costo
promedio de cada materia prima) y **costo promedio material** del producto en inventario. Todos son
sólo materias primas: no incluyen mano de obra, energía ni indirectos. Quien no tiene
`production.cost.read` ve cantidades, diferencias y stock, pero ningún importe de producción.

Fuera de esta fase: reservar stock al iniciar, revertir una producción completada, stock por lote,
vencimientos y FIFO (Fase 4.5), mano de obra y gastos en el costo, planificación automática (MRP).

### Compras e inventario (Fase 3)

Una persona con los permisos correspondientes puede, sin intervención técnica:

- **Crear una presentación de compra** para una materia prima: "Bolsa 25 kg" de _esta_ harina,
  "Paquete 500 g" de _esta_ levadura. Cada presentación pertenece a una sola materia prima; no
  existe una "bolsa" universal.
- **Crear una compra** a un proveedor (borrador), con líneas en presentaciones o en unidades
  compatibles (kg, g…), precio, descuento e impuestos; ver el subtotal, el total y la equivalencia
  ("4 bolsas = 100 kg") en vivo. Después **confirmar el pedido**. Crear una compra no mueve stock.
- **Registrar una recepción parcial** (llegaron 2 de 4 bolsas): la compra queda "Recibida en
  parte" con lo pendiente a la vista. **Completarla** con otra recepción la deja "Recibida". No se
  puede recibir más de lo pendiente, y una recepción confirmada no se vuelve a aplicar ni se
  modifica.
- **Ver el stock** por materia prima y por depósito, con filtros (búsqueda, depósito, bajo mínimo,
  sin stock), y el detalle de cada materia prima con sus existencias, última compra, presentaciones
  y movimientos.
- **Ver los movimientos de stock**: qué entró y salió, cuándo, por qué documento o motivo, quién lo
  hizo y el saldo después de cada uno.
- **Ver el costo promedio** (promedio ponderado móvil de lo comprado) y la valorización del
  inventario, con el historial de cada cambio de costo, si tiene el permiso de ver costos.
- **Ver cómo cambia solo el costo teórico de las recetas**: en cuanto una materia prima tiene costo
  promedio, las recetas pasan a usarlo en lugar del costo de referencia manual (que se conserva).
  En la ficha de stock se ven los tres costos separados: promedio de inventario, referencia manual
  y costo usado por recetas con su origen.
- **Confiar en los snapshots**: el costo guardado al publicar una versión de receta no cambia con
  las compras; las versiones nuevas guardan el promedio como origen del costo.
- **Cargar el stock inicial** de una materia prima en un depósito, con su costo, una sola vez.
- **Ajustar el stock** (positivo o negativo) con motivo: recuento físico, corrección de datos,
  rotura, otro.
- **Registrar una merma** con motivo: vencimiento, daño, pérdida en producción, calidad, otro. Ni
  una merma ni un ajuste pueden dejar stock negativo.
- **Ver las alertas de stock mínimo**: qué materias primas están bajo mínimo o sin stock, cuánto
  falta y a qué proveedor preferido pedirlo.
- **Reconstruir quién hizo qué**: cada compra, pedido, recepción, cancelación, ajuste, merma,
  stock inicial y cambio de costo promedio queda en la auditoría con su autor.

Fuera de esta fase: cuentas a pagar y pagos a proveedores (Fase 6), devoluciones a proveedor,
cerrar una compra con faltante y transferencias entre depósitos. El stock de producto terminado
llegó en Fase 4.

### Recetas y costo teórico (Fase 2)

- **Receta**: qué lleva un producto, cuánto rinde un lote y cuánto cuesta. Una receta por
  producto; cambia por **versiones**. Sólo una versión está **vigente**; las anteriores quedan
  **archivadas** y se pueden consultar, pero no modificar.
- **Costo del lote** = suma de (cantidad × costo de referencia) de cada ingrediente. **Costo por kg
  / por unidad** = costo del lote ÷ rendimiento expresado en la unidad de venta.
- **Margen bruto teórico** = precio de venta − costo de ingredientes por unidad de venta. No
  incluye mano de obra, energía, alquiler, impuestos ni mermas reales: no es ganancia.
- **Costo de referencia**: lo carga a mano quien tiene permiso para hacerlo. Es una referencia,
  no el costo real de compra. Desde Fase 3, cuando hay costo promedio de compras, las recetas usan
  ese promedio y la referencia queda como respaldo.
- Al **publicar** una versión se guarda el costo de ese momento; después se ve junto al costo
  actual y su variación.
- Si a un ingrediente le falta el costo, la receta muestra **Costo incompleto**, nunca $0 ni un
  margen inventado. Publicar así requiere confirmarlo explícitamente.

## Alcance del MVP (resumen)

| Módulo                  | Contenido                                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empresa y configuración | Razón social, nombre comercial, CUIT, contacto, logo, moneda, zona horaria. Una empresa operativa, sin bloquear multiempresa.                                                     |
| Usuarios y empleados    | Empleado (persona) separado de Usuario (identidad de acceso). Un usuario pertenece a una o más empresas por membresía, con roles propios en cada una. Sin liquidación de sueldos. |
| Roles y permisos        | ADMIN, DUEÑO, ADMINISTRACIÓN, VENTAS, COMPRAS, PRODUCCIÓN, DEPÓSITO. Permisos explícitos; roles como datos.                                                                       |
| Clientes                | Datos comerciales, tipo, lista de precios, límite de crédito, historial y cuenta corriente.                                                                                       |
| Proveedores             | Datos, condición de pago, compras, pagos, deuda, evolución de precios.                                                                                                            |
| Unidades de medida      | kg, g, litro, ml, unidad, docena, bolsa, caja. Conversiones explícitas y testeables.                                                                                              |
| Materias primas         | Código, categoría, unidad base, costo actual, stock derivado del ledger, stock mínimo.                                                                                            |
| Productos terminados    | Unidad de venta, precio, costo calculado, margen, control de stock opcional, receta opcional.                                                                                     |
| Recetas                 | Recipe → RecipeVersion → RecipeIngredient. Versiones inmutables una vez usadas. Costo teórico.                                                                                    |
| Inventario              | `StockMovement` con tipo, origen, referencia, usuario. Depósitos (`Warehouse`) modelados desde el inicio.                                                                         |
| Compras                 | Borrador → Recibida → Pendiente/Parcial/Pagada. Recepción genera stock y actualiza costo (promedio ponderado móvil).                                                              |
| Producción              | `ProductionOrder` (DRAFT/PLANNED/IN_PROGRESS/COMPLETED/CANCELLED). Completar = consumo + salida + snapshot de costos, en una transacción.                                         |
| Mermas                  | Materia prima o producto, motivo, cantidad, responsable. Genera movimientos.                                                                                                      |
| Ventas                  | DRAFT/CONFIRMED/PARTIALLY_PAID/PAID/CANCELLED. Confirmar descuenta stock una sola vez. Corrección por cancelación controlada.                                                     |
| Listas de precios       | Modelo preparado para varias listas; MVP con una principal.                                                                                                                       |
| Cuentas corrientes      | Ledger de clientes (`CustomerAccountMovement`) y de proveedores (`SupplierAccountMovement`).                                                                                      |
| Caja                    | `CashAccount`, `CashMovement`, medios de pago, resumen diario.                                                                                                                    |
| Gastos                  | Categorías, registro y reporte.                                                                                                                                                   |
| Facturación             | `Invoice` + interfaz `TaxInvoiceProvider`; primera implementación `InternalInvoiceProvider`. Sin integración fiscal real en el MVP.                                               |
| Auditoría               | `AuditLog` para operaciones críticas, sin secretos.                                                                                                                               |
| Dashboard del dueño     | Indicadores de hoy, stock bajo mínimo, deudores, producción. Solo métricas respaldadas por datos reales.                                                                          |
| Reportes                | Ventas, compras, stock, producción, mermas, saldos, caja, costos. Filtros por fecha, cliente, proveedor, producto, categoría.                                                     |
| Catálogo                | Catálogo interno administrable. El catálogo público es una evolución posterior.                                                                                                   |

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
- **Equipo:** Empleados, Usuarios
- **Análisis:** Reportes
- **Sistema:** Configuración (Empresa, Unidades, Categorías, Depósitos, Roles y permisos), Auditoría

Los módulos ya implementados se muestran solo a quien tiene permiso para usarlos; los de fases
futuras se muestran siempre, marcados "Disponible en próxima etapa".

Lenguaje del negocio, sin conceptos técnicos en la interfaz.

Durante cada fase se corrigen los problemas de uso evidentes; los hallazgos que piden una revisión
de conjunto (navegación, jerarquía visual, densidad, patrones de subnavegación) se registran en
[UX_BACKLOG](UX_BACKLOG.md) y se resuelven en el sprint **UX/DESIGN OPTIMIZATION**, previsto
después de la Fase 5.
