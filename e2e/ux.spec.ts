import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openSection } from "./support";

/*
 * Sprint UX: navegación por rol, acción primaria, estados vacíos útiles,
 * errores traducidos y navegación en tablet. Los usuarios de cada rol se crean
 * por la API (lo que se prueba es lo que cada persona ve).
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";
const WEB_ORIGIN = "http://localhost:3000";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const PASSWORD = "clave-ux-1234";

function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning")
      errors.push(`${msg.type()} ${msg.location().url}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

async function login(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();
}

async function call<T = { id: string }>(
  request: APIRequestContext,
  method: "get" | "post",
  url: string,
  data?: unknown,
): Promise<T> {
  const res = await request[method](url, {
    headers: { origin: WEB_ORIGIN },
    ...(data === undefined ? {} : { data }),
  });
  if (!res.ok())
    throw new Error(`${method.toUpperCase()} ${url}: ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Crea (como admin) un usuario con un rol del sistema y devuelve su email. */
async function userWithRole(page: Page, roleCode: string, run: string): Promise<string> {
  const roles = await call<{ id: string; code: string }[]>(page.request, "get", "/api/roles");
  const role = roles.find((r) => r.code === roleCode)!;
  const email = `${roleCode.toLowerCase()}.${run}@ux.local`;
  await call(page.request, "post", "/api/users", {
    email,
    displayName: `${roleCode} ${run}`,
    password: PASSWORD,
    roleIds: [role.id],
  });
  return email;
}

async function menuLabels(page: Page): Promise<string[]> {
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  return page.getByRole("navigation", { name: "Menú principal" }).getByRole("link").allInnerTexts();
}

async function logout(page: Page) {
  const menuButton = page.getByRole("button", { name: "Cerrar menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test("UX: cada rol ve sólo lo que puede usar", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);
  const salesEmail = await userWithRole(page, "SALES", run);
  const warehouseEmail = await userWithRole(page, "WAREHOUSE", run);
  await logout(page);

  // Ventas / mostrador: comercial y cobranza; sin stock, producción, compras ni configuración.
  await login(page, salesEmail, PASSWORD);
  const sales = (await menuLabels(page)).map((l) => l.trim());
  expect(sales).toEqual([
    "Inicio",
    "Pedidos",
    "Ventas",
    "Clientes",
    "Listas de precios",
    "Cuentas a cobrar",
    "Productos",
  ]);
  await page.keyboard.press("Escape");
  // Accesos rápidos de su trabajo diario; ninguno de otro rol.
  const quick = page.getByRole("navigation", { name: "Acciones rápidas" });
  await expect(quick.getByRole("link", { name: "Nueva venta" })).toBeVisible();
  await expect(quick.getByRole("link", { name: "Nuevo pedido" })).toBeVisible();
  await expect(quick.getByRole("link", { name: "Nueva compra" })).toHaveCount(0);
  await expect(page.getByTestId("attention-receivables")).toBeVisible();
  await expect(page.getByTestId("attention-lots-near-expiry")).toHaveCount(0);
  // Sin permiso, la ruta directa no ofrece la acción.
  await page.goto("/compras");
  await expect(page.locator("main")).not.toContainText("Nueva compra");
  await logout(page);

  // Depósito: inventario y lotes; sin listas de precios ni finanzas.
  await login(page, warehouseEmail, PASSWORD);
  const warehouse = (await menuLabels(page)).map((l) => l.trim());
  expect(warehouse).toEqual(
    expect.arrayContaining([
      "Stock de materias primas",
      "Productos terminados",
      "Próximos a vencer",
    ]),
  );
  expect(warehouse).not.toContain("Listas de precios");
  expect(warehouse).not.toContain("Cuentas a cobrar");
  expect(warehouse).not.toContain("Configuración");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("attention-lots-near-expiry")).toBeVisible();
  await expect(page.getByTestId("attention-receivables")).toHaveCount(0);

  expect(consoleErrors).toEqual([]);
});

test("UX: una acción primaria, filtros visibles y estados vacíos con salida", async ({
  page,
}, testInfo) => {
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const consoleErrors = trackConsoleErrors(page);
  await login(page);

  for (const section of ["Pedidos", "Ventas", "Clientes"]) {
    await openSection(page, section);
    await expect(page.getByRole("heading", { level: 1, name: section })).toBeVisible();
    await expect(page.locator("main .button--primary")).toHaveCount(1);
  }

  // Búsqueda sin resultados: dice qué pasó, muestra el filtro y permite limpiarlo.
  await page.getByRole("searchbox", { name: "Buscar" }).fill(`nada-${run}`);
  await page.getByRole("searchbox", { name: "Buscar" }).press("Enter");
  await expect(page).toHaveURL(new RegExp(`q=nada-${run}`));
  await expect(page.getByText(`Sin resultados para “nada-${run}”.`)).toBeVisible();
  await expect(page.getByRole("button", { name: `Quitar filtro “nada-${run}”` })).toBeVisible();
  await page.getByRole("button", { name: "Limpiar filtros" }).first().click();
  await expect(page).not.toHaveURL(/q=/);
  await expect(page.getByRole("searchbox", { name: "Buscar" })).toHaveValue("");

  expect(consoleErrors).toEqual([]);
});

test("UX: errores en lenguaje humano, sin códigos internos", async ({ page }) => {
  await login(page);

  // Formulario incompleto: el error está en el campo, con texto y sin códigos.
  await page.goto("/clientes/nuevo");
  await page
    .getByRole("button", { name: /^(Guardar|Crear)/ })
    .first()
    .click();
  const main = page.locator("main");
  await expect(main.locator("[aria-invalid='true']").first()).toBeVisible();
  await expect(main).not.toContainText("VALIDATION_ERROR");

  // Registro inexistente: mensaje claro, salida, sin UUID ni código técnico.
  await page.goto("/ventas/00000000-0000-4000-8000-000000000000");
  await expect(main.getByRole("alert")).toBeVisible();
  await expect(main.getByRole("link", { name: "Ir al inicio" })).toBeVisible();
  await expect(main).not.toContainText(UUID);
  await expect(main).not.toContainText("NOT_FOUND");
});

test("UX: navegación por teclado y menú en tablet", async ({ page }, testInfo) => {
  await login(page);

  // Saltar al contenido es lo primero que se alcanza con Tab.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Saltar al contenido" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#contenido")).toBeFocused();

  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  const nav = page.getByRole("navigation", { name: "Menú principal" });
  if (testInfo.project.name !== "tablet") {
    // Escritorio: menú lateral fijo, sin botón para abrirlo.
    await expect(menuButton).toBeHidden();
    await expect(nav).toBeVisible();
    return;
  }
  // Tablet: el menú es un cajón que se abre, se cierra con Escape y devuelve el foco.
  await expect(nav).toBeHidden();
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await expect(nav).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(nav).toBeHidden();
  await expect(menuButton).toBeFocused();
  // Navegar cierra el cajón y marca la sección actual.
  await openSection(page, "Pedidos");
  await expect(page.getByRole("heading", { level: 1, name: "Pedidos" })).toBeVisible();
  await expect(nav).toBeHidden();
  await menuButton.click();
  await expect(nav.getByRole("link", { name: "Pedidos" })).toHaveAttribute("aria-current", "page");
});
