import { expect, test, type Page } from "@playwright/test";

/*
 * Flujo completo de Fase 1 (19 pasos) contra la aplicación construida y la base
 * de desarrollo con seed. Cada corrida usa nombres únicos, así puede repetirse.
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

async function openSection(page: Page, name: string) {
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
}

/** Elige en un select la opción cuyo texto contiene `text`. */
async function selectByText(page: Page, label: string, text: string) {
  const select = page.getByRole("combobox", { name: label });
  const value = await select.locator("option", { hasText: text }).first().getAttribute("value");
  await select.selectOption(value ?? "");
}

test("Fase 1: alta y gestión de maestros de punta a punta", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    // Única excepción: el navegador registra como error de red el 422 de la
    // conversión kg → l que el paso 8 provoca a propósito (la UI lo muestra).
    const expectedRejection =
      (msg.location().url.includes("/api/units/convert") && msg.text().includes("422")) ||
      // …y el 403 de /api/users cuando la usuaria sin permiso abre esa URL a mano.
      (msg.location().url.includes("/api/users") && msg.text().includes("403"));
    if (!expectedRejection) consoleErrors.push(`${msg.location().url}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  // 1. Login admin
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();

  // 2. Empresa: editar teléfono
  await openSection(page, "Configuración");
  await page.getByRole("link", { name: /Empresa/ }).click();
  await expect(page.getByRole("heading", { name: "Empresa" })).toBeVisible();
  await page.getByLabel("Teléfono").fill(`341-${run}`);
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("Cambios guardados.")).toBeVisible();

  // 3. Empleado
  await openSection(page, "Empleados");
  await page.getByRole("link", { name: "Nuevo empleado" }).click();
  await page.getByRole("textbox", { name: "Nombre", exact: true }).fill("Marta");
  await page.getByLabel("Apellido").fill(`Horno ${run}`);
  await page.getByLabel("Puesto").fill("Panadera");
  await page.getByRole("button", { name: "Crear empleado" }).click();
  await expect(page.getByRole("heading", { name: `Marta Horno ${run}` })).toBeVisible();
  const accessPanel = page.locator("section", {
    has: page.getByRole("heading", { name: "Acceso al sistema" }),
  });
  await expect(accessPanel.getByText("Usuario del sistema")).toBeVisible();
  await expect(accessPanel.locator("dd").nth(1)).toHaveText("No");

  // 4. Usuario vinculado al empleado ("Crear acceso")
  await page.getByRole("link", { name: "Crear acceso" }).click();
  await expect(page.getByRole("heading", { name: "Nuevo usuario" })).toBeVisible();
  await expect(page.getByLabel("Empleado vinculado")).toHaveValue(/.+/);
  await page.getByLabel("Email de ingreso").fill(`marta.${run}@panificadora.local`);
  await page.getByRole("button", { name: "Generar" }).click();
  await expect(page.getByLabel("Contraseña inicial")).toHaveValue(/.{16}/);
  const martaPassword = await page.getByLabel("Contraseña inicial").inputValue();
  await page.getByRole("checkbox", { name: "Ventas" }).check();
  await page.getByRole("button", { name: "Crear usuario" }).click();
  await expect(page.getByRole("heading", { name: `Marta Horno ${run}` })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Permisos efectivos" })).toBeVisible();

  // 5. Rol: agregar Producción
  await page.getByRole("button", { name: "Cambiar roles" }).click();
  await page.getByRole("checkbox", { name: "Producción" }).check();
  await page.getByRole("button", { name: "Guardar roles" }).click();
  const roles = page.locator("section", { has: page.getByRole("heading", { name: "Roles" }) });
  await expect(roles.getByText("Producción")).toBeVisible();
  await expect(roles.getByText("Ventas")).toBeVisible();

  // 6. Cliente
  await openSection(page, "Clientes");
  await page.getByRole("link", { name: "Nuevo cliente" }).click();
  await page.getByLabel("Razón social / Nombre").fill(`Almacén ${run} S.R.L.`);
  await page.getByLabel("Límite de crédito").fill("150000,50");
  await page.getByRole("button", { name: "Crear cliente" }).click();
  await expect(page.getByRole("heading", { name: `Almacén ${run} S.R.L.` })).toBeVisible();
  await expect(page.getByText("$150.000,50")).toBeVisible();
  await expect(
    page.getByText("Ventas y cuenta corriente estarán disponibles en una fase posterior."),
  ).toBeVisible();
  await expect(page.getByText(/^CLI-\d{4}$/)).toBeVisible();

  // 7. Proveedor
  await openSection(page, "Proveedores");
  await page.getByRole("link", { name: "Nuevo proveedor" }).click();
  await page.getByLabel("Razón social").fill(`Molino ${run} S.A.`);
  await page.getByRole("button", { name: "Crear proveedor" }).click();
  await expect(page.getByRole("heading", { name: `Molino ${run} S.A.` })).toBeVisible();
  await expect(
    page.getByText("Compras y cuenta corriente estarán disponibles en una fase posterior."),
  ).toBeVisible();

  // 8. Unidad derivada: bolsa de 25 kg, y prueba de conversión
  await page.goto("/configuracion/unidades/nuevo");
  await page.getByLabel("Código").fill(`b25${run}`);
  await page.getByLabel("Nombre").fill(`Bolsa 25 kg ${run}`);
  await page.getByLabel("Símbolo").fill("b25");
  await page.getByLabel("Magnitud").selectOption("MASS");
  await selectByText(page, "Equivale a", "Kilogramo");
  await page.getByLabel("Factor").fill("25");
  await page.getByRole("button", { name: "Crear unidad" }).click();
  await expect(page.getByRole("heading", { name: `Bolsa 25 kg ${run} (b25)` })).toBeVisible();
  await page.getByLabel("Cantidad").fill("2");
  await selectByText(page, "Unidad de destino", "Gramo");
  await page.getByRole("button", { name: "Convertir" }).click();
  await expect(page.getByTestId("conversion-result")).toHaveText("2 b25 = 50.000 g");
  await selectByText(page, "Unidad de destino", "Litro");
  await page.getByRole("button", { name: "Convertir" }).click();
  await expect(page.getByTestId("conversion-result")).toContainText("incompatibles");

  // 9. Categoría de materias primas
  await page.goto("/configuracion/categorias/nuevo");
  await page.getByLabel("Tipo").selectOption("RAW_MATERIAL");
  await page.getByLabel("Nombre").fill(`Harinas ${run}`);
  await page.getByRole("button", { name: "Crear categoría" }).click();
  await expect(page.getByRole("heading", { name: `Harinas ${run}` })).toBeVisible();

  // 10. Materia prima
  await openSection(page, "Materias primas");
  await page.getByRole("link", { name: "Nueva materia prima" }).click();
  await page.getByLabel("Nombre").fill(`Harina 0000 ${run}`);
  await selectByText(page, "Categoría", `Harinas ${run}`);
  await selectByText(page, "Unidad base", "Kilogramo");
  await selectByText(page, "Proveedor preferido", `Molino ${run}`);
  await page.getByLabel("Costo de referencia (ARS por unidad base)").fill("850,125");
  await page.getByRole("button", { name: "Crear materia prima" }).click();
  await expect(page.getByRole("heading", { name: `Harina 0000 ${run}` })).toBeVisible();
  await expect(page.getByText("Materia prima", { exact: true })).toBeVisible();
  await expect(page.getByText("$850,125 / kg")).toBeVisible();

  // 11. Categoría de productos
  await page.goto("/configuracion/categorias/nuevo");
  await page.getByLabel("Tipo").selectOption("PRODUCT");
  await page.getByLabel("Nombre").fill(`Panes ${run}`);
  await page.getByRole("button", { name: "Crear categoría" }).click();
  await expect(page.getByRole("heading", { name: `Panes ${run}` })).toBeVisible();

  // 12. Producto
  await openSection(page, "Productos");
  await page.getByRole("link", { name: "Nuevo producto" }).click();
  await expect(
    page.getByText("El costo no se carga a mano: se calcula desde la receta del producto."),
  ).toBeVisible();
  await page.getByLabel("Nombre").fill(`Pan de campo ${run}`);
  await selectByText(page, "Categoría", `Panes ${run}`);
  await selectByText(page, "Unidad de venta", "Kilogramo");
  await page.getByLabel("Precio de venta").fill("3200");
  await page.getByRole("button", { name: "Crear producto" }).click();
  await expect(page.getByRole("heading", { name: `Pan de campo ${run}` })).toBeVisible();
  await expect(page.getByText("Producto terminado")).toBeVisible();
  await expect(page.getByText("$3.200,00")).toBeVisible();

  // 13. Depósito
  await page.goto("/configuracion/depositos/nuevo");
  await page.getByLabel("Nombre").fill(`Cámara de frío ${run}`);
  await page.getByRole("button", { name: "Crear depósito" }).click();
  await expect(page.getByRole("heading", { name: `Cámara de frío ${run}` })).toBeVisible();
  await expect(page.getByText(/^DEP-\d{4}$/)).toBeVisible();

  // 14. Buscar el cliente
  await openSection(page, "Clientes");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(run);
  await expect(page.getByText("1 resultado")).toBeVisible();
  await page.getByRole("link", { name: `Almacén ${run} S.R.L.` }).click();

  // 15. Editar
  await page.getByRole("link", { name: "Editar" }).click();
  await page.getByLabel("Teléfono").fill("0341-4445555");
  await page.getByRole("button", { name: "Guardar cambios" }).click();
  await expect(page.getByText("0341-4445555")).toBeVisible();

  // 16. Desactivar (con confirmación) y comprobar que sale del listado de activos
  await page.getByRole("button", { name: "Desactivar" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Desactivar" }).click();
  await expect(page.getByText("Inactivo", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Cliente desactivado" })).toBeVisible();
  await openSection(page, "Clientes");
  await page.getByRole("searchbox", { name: "Buscar" }).fill(run);
  await expect(page.getByText(`Sin resultados para “${run}”.`)).toBeVisible();
  await page.getByLabel("Estado").selectOption("inactive");
  await expect(page.getByText("1 resultado")).toBeVisible();

  // 17. Auditoría
  await openSection(page, "Auditoría");
  await page.getByLabel("Módulo").selectOption("customer");
  await expect(page.getByRole("cell", { name: "Cliente desactivado" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Cliente modificado" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Cliente creado" }).first()).toBeVisible();

  // 18. Logout
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/clientes");
  await expect(page).toHaveURL(/\/login/);

  // El acceso creado funciona y el menú refleja sus roles (Ventas + Producción).
  await page.getByLabel("Email").fill(`marta.${run}@panificadora.local`);
  await page.getByLabel("Contraseña").fill(martaPassword);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByTestId("current-user")).toContainText(`Marta Horno ${run}`);
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  const nav = page.getByRole("navigation", { name: undefined }).first();
  await expect(nav.getByRole("link", { name: "Clientes", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Usuarios", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Proveedores", exact: true })).toHaveCount(0);
  await page.goto("/usuarios");
  await expect(page.getByText("No tenés permiso para esta operación.")).toBeVisible();
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL(/\/login$/);

  // 19. Sin errores de consola en todo el recorrido
  expect(consoleErrors).toEqual([]);
});

test("la interfaz nunca muestra identificadores internos", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const path of [
    "/clientes",
    "/materias-primas",
    "/productos",
    "/empleados",
    "/usuarios",
    "/configuracion/roles",
    "/recetas",
    "/recetas/nuevo",
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    expect(await page.locator("main").innerText(), path).not.toMatch(uuid);
  }
  await page.goto("/usuarios");
  await page.locator("table tbody a").first().click();
  await expect(page.getByRole("heading", { name: "Permisos efectivos" })).toBeVisible();
  expect(await page.locator("main").innerText()).not.toMatch(uuid);
  // Detalle de receta y de una versión (si la base ya tiene recetas de otra corrida)
  await page.goto("/recetas");
  await page.waitForLoadState("networkidle");
  const recipeLink = page.locator("table tbody a").first();
  if (await recipeLink.count()) {
    await recipeLink.click();
    await expect(page.getByRole("heading", { name: "Historial de versiones" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await page.locator("main").innerText()).not.toMatch(uuid);
    await page
      .getByRole("link", { name: /^v\d+$/ })
      .first()
      .click();
    await page.waitForLoadState("networkidle");
    expect(await page.locator("main").innerText()).not.toMatch(uuid);
  }
});
