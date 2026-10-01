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
| Depósitos | `warehouses.read` | Ver depósitos | ✅ | ✅ | ✅ | — | ✅ | ✅ | ✅ |
| Depósitos | `warehouses.manage` | Crear, modificar y desactivar depósitos | ✅ | ✅ | — | — | — | — | — |
| Recetas | `recipes.read` | Ver recetas, versiones y costo teórico | ✅ | ✅ | ✅ | — | — | ✅ | — |
| Recetas | `recipes.create` | Crear recetas y nuevas versiones | ✅ | ✅ | — | — | — | ✅ | — |
| Recetas | `recipes.update` | Editar recetas y borradores de versiones (y descartarlos) | ✅ | ✅ | — | — | — | ✅ | — |
| Recetas | `recipes.publish` | Publicar una versión (la vuelve vigente y archiva la anterior) | ✅ | ✅ | — | — | — | — | — |
| Recetas | `recipes.archive` | Archivar versiones vigentes y desactivar o reactivar recetas | ✅ | ✅ | — | — | — | — | — |

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
