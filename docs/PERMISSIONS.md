# Permisos y roles

## Modelo

```
users (identidad global) ──< company_memberships (empresa, empleado?, estado)
                                   └──< membership_roles >── roles (por empresa) ──< role_permissions >── permissions (catálogo global)
```

- **Permiso**: código `modulo.accion` (p. ej. `customers.create`). El catálogo vive en
  `packages/shared/src/permissions.ts` y se sincroniza a la tabla `permissions`.
- **Rol**: conjunto de permisos, guardado como datos por empresa. Los 7 roles de sistema se
  definen en `packages/shared/src/roles.ts` y se crean al aprovisionar cada empresa.
- **Permisos efectivos** de un usuario en una empresa = unión de los permisos de todos los roles
  de su membresía en esa empresa. Se recalculan en cada request: un cambio de roles rige desde el
  request siguiente, sin cerrar sesión.
- **Autorización**: la API decide siempre por permiso (`requirePermission(...)`, exige todos los
  indicados), nunca comparando el código de rol. Un test recorre el código de la API para
  asegurarlo.
- La interfaz oculta lo que el usuario no puede usar, pero eso es solo comodidad: la barrera real
  es la API (401 sin sesión, 403 sin permiso).

## Endpoints por permiso

| Endpoint | Permiso requerido |
| --- | --- |
| `GET /api/company` · `PATCH /api/company` | `company.read` · `company.update` |
| `GET /api/employees[/:id]` | `employees.read` |
| `POST /api/employees` · `PATCH /api/employees/:id` | `employees.create` · `employees.update` |
| `POST /api/employees/:id/deactivate` · `/activate` | `employees.deactivate` |
| `GET /api/users[/:id]` | `users.read` |
| `POST /api/users` | `users.create` **y** `users.assign_roles` (el alta incluye el rol inicial) |
| `PATCH /api/users/:id` | `users.update` |
| `PUT /api/users/:id/roles` | `users.assign_roles` |
| `POST /api/users/:id/deactivate` · `/activate` | `users.deactivate` |
| `GET /api/roles` | `roles.read` |
| `GET/POST/PATCH /api/customers…`, `…/deactivate`, `…/activate` | `customers.read` / `.create` / `.update` / `.deactivate` |
| `GET/POST/PATCH /api/suppliers…`, `…/deactivate`, `…/activate` | `suppliers.read` / `.create` / `.update` / `.deactivate` |
| `GET/POST/PATCH /api/raw-materials…`, `…/deactivate`, `…/activate` | `raw_materials.read` / `.create` / `.update` / `.deactivate` |
| `GET/POST/PATCH /api/products…`, `…/deactivate`, `…/activate` | `products.read` / `.create` / `.update` / `.deactivate` |
| `GET /api/units[/:id]`, `GET /api/units/convert` | `units.read` |
| `POST /api/units` · `PATCH /api/units/:id` | `units.manage` |
| `GET /api/categories[/:id]` · `POST` · `PATCH` | `categories.read` · `categories.manage` |
| `GET /api/warehouses[/:id]` · `POST` · `PATCH` · `deactivate`/`activate` | `warehouses.read` · `warehouses.manage` |
| `GET /api/audit-logs` | `audit.read` |

Restricciones adicionales, independientes del permiso: un usuario no puede cambiar sus propios
roles ni desactivarse a sí mismo (`409 CANNOT_MODIFY_SELF`), para no dejar la empresa sin
administrador por error.

## Matriz permiso → rol

Generada desde `SYSTEM_ROLES`; no se edita a mano. Para regenerarla: `pnpm docs:permissions`.
El test `packages/shared/test/permissions-doc.test.ts` falla si esta tabla no coincide con el
código, y `apps/api/test/integration/authorization.test.ts` verifica contra la API real que cada
rol recibe 403 exactamente en los endpoints cuyo permiso no tiene.

<!-- permission-matrix:start -->

| Módulo | Permiso | Descripción | ADMIN | OWNER | ADMINISTRATION | SALES | PURCHASING | PRODUCTION | WAREHOUSE |
| --- | --- | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Inicio | `dashboard.view` | Ver el panel de inicio | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auditoría | `audit.read` | Consultar el registro de auditoría | ✅ | ✅ | ✅ | — | — | — | — |
| Empresa | `company.read` | Ver los datos de la empresa | ✅ | ✅ | ✅ | — | — | — | — |
| Empresa | `company.update` | Modificar los datos de la empresa | ✅ | ✅ | — | — | — | — | — |
| Empleados | `employees.read` | Ver empleados | ✅ | ✅ | ✅ | — | — | — | — |
| Empleados | `employees.create` | Dar de alta empleados | ✅ | ✅ | ✅ | — | — | — | — |
| Empleados | `employees.update` | Modificar empleados | ✅ | ✅ | ✅ | — | — | — | — |
| Empleados | `employees.deactivate` | Dar de baja y reactivar empleados | ✅ | ✅ | ✅ | — | — | — | — |
| Usuarios | `users.read` | Ver usuarios y sus permisos | ✅ | ✅ | ✅ | — | — | — | — |
| Usuarios | `users.create` | Crear accesos al sistema | ✅ | ✅ | — | — | — | — | — |
| Usuarios | `users.update` | Modificar usuarios | ✅ | ✅ | — | — | — | — | — |
| Usuarios | `users.deactivate` | Desactivar y reactivar accesos | ✅ | ✅ | — | — | — | — | — |
| Usuarios | `users.assign_roles` | Asignar roles a usuarios | ✅ | ✅ | — | — | — | — | — |
| Roles | `roles.read` | Ver roles y su matriz de permisos | ✅ | ✅ | ✅ | — | — | — | — |
| Clientes | `customers.read` | Ver clientes | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Clientes | `customers.create` | Dar de alta clientes | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Clientes | `customers.update` | Modificar clientes | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Clientes | `customers.deactivate` | Desactivar y reactivar clientes | ✅ | ✅ | ✅ | — | — | — | — |
| Proveedores | `suppliers.read` | Ver proveedores | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Proveedores | `suppliers.create` | Dar de alta proveedores | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Proveedores | `suppliers.update` | Modificar proveedores | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Proveedores | `suppliers.deactivate` | Desactivar y reactivar proveedores | ✅ | ✅ | ✅ | — | — | — | — |
| Unidades de medida | `units.read` | Ver unidades de medida | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Unidades de medida | `units.manage` | Crear y modificar unidades de medida | ✅ | ✅ | — | — | — | — | — |
| Categorías | `categories.read` | Ver categorías | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Categorías | `categories.manage` | Crear y modificar categorías | ✅ | ✅ | ✅ | — | — | — | — |
| Materias primas | `raw_materials.read` | Ver materias primas | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Materias primas | `raw_materials.create` | Dar de alta materias primas | ✅ | ✅ | — | — | ✅ | — | — |
| Materias primas | `raw_materials.update` | Modificar materias primas | ✅ | ✅ | — | — | ✅ | — | — |
| Materias primas | `raw_materials.deactivate` | Desactivar y reactivar materias primas | ✅ | ✅ | — | — | — | — | — |
| Materias primas | `raw_materials.update_cost` | Cargar y cambiar el costo de referencia de materias primas | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Productos | `products.read` | Ver productos | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| Productos | `products.create` | Dar de alta productos | ✅ | ✅ | — | — | — | — | — |
| Productos | `products.update` | Modificar productos y precios | ✅ | ✅ | ✅ | — | — | — | — |
| Productos | `products.deactivate` | Desactivar y reactivar productos | ✅ | ✅ | — | — | — | — | — |
| Depósitos | `warehouses.read` | Ver depósitos | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Depósitos | `warehouses.manage` | Crear, modificar y desactivar depósitos | ✅ | ✅ | — | — | — | — | — |
| Recetas | `recipes.read` | Ver recetas, versiones y costo teórico | ✅ | ✅ | ✅ | — | — | ✅ | — |
| Recetas | `recipes.create` | Crear recetas y nuevas versiones | ✅ | ✅ | — | — | — | ✅ | — |
| Recetas | `recipes.update` | Editar recetas y borradores de versiones (y descartarlos) | ✅ | ✅ | — | — | — | ✅ | — |
| Recetas | `recipes.publish` | Publicar una versión (la vuelve vigente y archiva la anterior) | ✅ | ✅ | — | — | — | — | — |
| Recetas | `recipes.archive` | Archivar versiones vigentes y desactivar o reactivar recetas | ✅ | ✅ | — | — | — | — | — |
| Compras | `purchases.read` | Ver compras y sus recepciones | ✅ | ✅ | ✅ | — | ✅ | — | ✅ |
| Compras | `purchases.create` | Crear compras (borrador) | ✅ | ✅ | — | — | ✅ | — | — |
| Compras | `purchases.update` | Editar compras en borrador y datos administrativos | ✅ | ✅ | — | — | ✅ | — | — |
| Compras | `purchases.order` | Confirmar el pedido de una compra al proveedor | ✅ | ✅ | — | — | ✅ | — | — |
| Compras | `purchases.receive` | Registrar y confirmar recepciones de mercadería (mueven stock y costo) | ✅ | ✅ | — | — | ✅ | — | ✅ |
| Compras | `purchases.cancel` | Cancelar compras sin mercadería recibida | ✅ | ✅ | — | — | ✅ | — | — |
| Inventario | `inventory.read` | Ver stock y movimientos | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Inventario | `inventory.adjust` | Ajustar stock (positivo o negativo) con motivo | ✅ | ✅ | — | — | — | — | ✅ |
| Inventario | `inventory.waste` | Registrar mermas | ✅ | ✅ | — | — | — | — | ✅ |
| Inventario | `inventory.initial_stock` | Cargar stock inicial valorizado | ✅ | ✅ | ✅ | — | — | — | — |
| Inventario | `inventory.cost.read` | Ver costo promedio, valorización e historial de costos del inventario | ✅ | ✅ | ✅ | — | ✅ | — | — |
| Presentaciones de compra | `presentations.read` | Ver presentaciones de compra de materias primas | ✅ | ✅ | ✅ | — | ✅ | — | ✅ |
| Presentaciones de compra | `presentations.manage` | Crear, modificar y desactivar presentaciones de compra | ✅ | ✅ | — | — | ✅ | — | — |
| production | `production_orders.read` | Ver órdenes de producción, consumos y disponibilidad | ✅ | ✅ | ✅ | — | — | ✅ | — |
| production | `production_orders.create` | Crear órdenes de producción (borrador) | ✅ | ✅ | — | — | — | ✅ | — |
| production | `production_orders.update` | Editar órdenes en borrador y registrar consumos y salida reales | ✅ | ✅ | — | — | — | ✅ | — |
| production | `production_orders.plan` | Planificar una orden (fija receta, cantidades y costo esperado) | ✅ | ✅ | — | — | — | ✅ | — |
| production | `production_orders.start` | Iniciar la producción (revalida el stock de materias primas) | ✅ | ✅ | — | — | — | ✅ | — |
| production | `production_orders.complete` | Completar la producción (consume materias primas e ingresa producto terminado) | ✅ | ✅ | — | — | — | ✅ | — |
| production | `production_orders.cancel` | Cancelar órdenes de producción no completadas | ✅ | ✅ | — | — | — | ✅ | — |
| production | `production_orders.add_extra_material` | Agregar y quitar consumos extra durante la producción | ✅ | ✅ | — | — | — | ✅ | — |
| production | `production.cost.read` | Ver costos esperados y reales de producción | ✅ | ✅ | ✅ | — | — | — | — |
| product_lots | `product_lots.read` | Ver lotes de producto terminado, su trazabilidad y disponibilidad a una fecha | ✅ | ✅ | ✅ | — | — | ✅ | ✅ |
| product_lots | `product_lots.transform` | Congelar y descongelar lotes (transformación de conservación) | ✅ | ✅ | — | — | — | ✅ | ✅ |
| product_lots | `product_lots.waste` | Registrar mermas de producto terminado sobre un lote | ✅ | ✅ | — | — | — | — | ✅ |
| product_lots | `product_lots.quality` | Bloquear y desbloquear lotes por calidad | ✅ | ✅ | — | — | — | — | ✅ |
| product_conservation | `product_conservation.read` | Ver la conservación y vida útil configuradas de los productos | ✅ | ✅ | ✅ | — | — | ✅ | ✅ |
| product_conservation | `product_conservation.manage` | Configurar conservación, vida útil y estado inicial de los productos | ✅ | ✅ | — | — | — | — | — |
| Inventario | `inventory.expiry.read` | Ver productos terminados próximos a vencer | ✅ | ✅ | ✅ | — | — | ✅ | ✅ |
| orders | `orders.read` | Ver pedidos de clientes, su cobertura, reservas y necesidades | ✅ | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| orders | `orders.create` | Crear pedidos (borrador) | ✅ | ✅ | — | ✅ | — | — | — |
| orders | `orders.update` | Editar borradores y datos no planificados de pedidos (contacto, notas) | ✅ | ✅ | — | ✅ | — | — | — |
| orders | `orders.confirm` | Confirmar pedidos (reserva lotes y genera necesidades de producción) | ✅ | ✅ | — | ✅ | — | — | — |
| orders | `orders.replan` | Modificar pedidos confirmados y recalcular su cobertura | ✅ | ✅ | ✅ | ✅ | — | — | — |
| orders | `orders.cancel` | Cancelar pedidos (libera sus reservas) | ✅ | ✅ | — | ✅ | — | — | — |
| orders | `orders.prepare` | Pasar pedidos a preparación | ✅ | ✅ | — | — | — | ✅ | — |
| orders | `orders.ready` | Marcar pedidos como listos (sólo con cobertura completa) | ✅ | ✅ | — | — | — | — | ✅ |
| order_planning | `order_planning.read` | Ver necesidades: producción y materias primas de pedidos, pedidos en riesgo | ✅ | ✅ | ✅ | — | — | ✅ | — |
| order_planning | `order_production.create` | Crear órdenes de producción desde la necesidad de un pedido | ✅ | ✅ | — | — | — | ✅ | — |
| Ventas | `sales.read` | Ver ventas y entregas (precios sólo con price_lists.read) | ✅ | ✅ | ✅ | ✅ | — | — | ✅ |
| Ventas | `sales.create` | Crear ventas (borrador) | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Ventas | `sales.update` | Editar y descartar borradores de venta | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Ventas | `sales.post` | Confirmar entregas y ventas (sale el producto y se genera la deuda) | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Ventas | `sales.price_override` | Cambiar el precio o aplicar descuentos distintos de lo acordado (con motivo) | ✅ | ✅ | ✅ | — | — | — | — |
| Ventas | `sales.cost.read` | Ver el costo material de las ventas y de los lotes vendidos | ✅ | ✅ | ✅ | — | — | — | — |
| Ventas | `sales.margin.read` | Ver el margen sobre materiales de las ventas | ✅ | ✅ | ✅ | — | — | — | — |
| Listas de precios | `price_lists.read` | Ver listas de precios y precios de venta | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Listas de precios | `price_lists.manage` | Crear y modificar listas de precios y sus precios | ✅ | ✅ | ✅ | — | — | — | — |
| Cobros | `payments.read` | Ver cobros y señas | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Cobros | `payments.create` | Cargar cobros | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Cobros | `payments.post` | Registrar cobros y aplicarlos a ventas (mueve la cuenta corriente) | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Cuenta corriente | `customer_accounts.read` | Ver la cuenta corriente y el saldo de los clientes | ✅ | ✅ | ✅ | ✅ | — | — | — |
| Cuenta corriente | `customer_accounts.adjust` | Registrar ajustes de cuenta corriente (con motivo) | ✅ | ✅ | ✅ | — | — | — | — |
| Cobros | `order_advances.create` | Registrar señas (anticipos) de pedidos | ✅ | ✅ | ✅ | ✅ | — | — | — |

- **ADMIN** — Administrador del sistema: Acceso global, incluida la administración técnica.
- **OWNER** — Dueño: Acceso global al negocio.
- **ADMINISTRATION** — Administración: Gestión administrativa y comercial.
- **SALES** — Ventas: Clientes, ventas y cobros.
- **PURCHASING** — Compras: Proveedores y compras.
- **PRODUCTION** — Producción: Recetas y órdenes de producción.
- **WAREHOUSE** — Depósito: Stock, recepción y ajustes autorizados.

<!-- permission-matrix:end -->

## Criterios de la matriz inicial

- **ADMIN** y **OWNER** tienen todos los permisos. La diferencia entre ambos es de negocio
  (quién administra la parte técnica), no de acceso en esta fase.
- **ADMINISTRACIÓN** gestiona personal (sin crear accesos ni asignar roles), clientes,
  proveedores y categorías, y puede ajustar precios de productos. No modifica la empresa, las
  unidades ni los depósitos.
- **VENTAS** gestiona clientes (sin desactivarlos) y consulta productos.
- **COMPRAS** gestiona proveedores y materias primas (sin desactivarlos).
- **PRODUCCIÓN** y **DEPÓSITO** solo consultan catálogos en esta fase; sus permisos operativos
  llegan con recetas/producción (Fases 2 y 4) e inventario (Fase 3).
- Nadie salvo ADMIN y OWNER ve usuarios con permisos de alta, roles o auditoría completa;
  ADMINISTRACIÓN puede leer usuarios, roles y auditoría.
- **Pedidos (Fase 5A):** VENTAS carga, edita, confirma, replanifica y cancela pedidos (no los
  marca listos ni ve Necesidades). ADMINISTRACIÓN ve pedidos, los replanifica y consulta
  Necesidades. PRODUCCIÓN ve pedidos y Necesidades, pasa pedidos a preparación y crea órdenes de
  producción desde una necesidad (`order_production.create`, además de
  `production_orders.create`). DEPÓSITO ve pedidos (reservas y lotes comprometidos) y los marca
  listos. Nadie recibe permisos financieros: no existen todavía.
- **Visibilidad mínima:** sin `customers.read` el detalle del pedido no muestra teléfono,
  contacto ni direcciones, y el detalle de lote no muestra el cliente de cada reserva; sin
  `orders.read` el lote sólo muestra sus totales comprometido y libre.
- Empresas existentes reciben los permisos nuevos con `pnpm db:sync-reference` (o `pnpm
  bootstrap` en desarrollo).
