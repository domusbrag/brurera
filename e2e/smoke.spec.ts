import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

async function login(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Contraseña").fill(password);
  await page.getByRole("button", { name: "Ingresar" }).click();
}

test("health a través del proxy web: API y base OK", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ status: "ok", checks: { api: "ok", database: "ok" } });
});

test("ruta protegida sin sesión redirige al login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/ventas");
  await expect(page).toHaveURL(/\/login$/);
});

test("login inválido muestra error y no ingresa", async ({ page }) => {
  await login(page, ADMIN_EMAIL, "contraseña-incorrecta");
  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "Email o contraseña incorrectos.",
  );
  await expect(page).toHaveURL(/\/login$/);
});

test("admin ingresa, ve el shell, navega y sale", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(err.message));

  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();
  await expect(page.getByTestId("current-user")).toContainText("Administrador Demo");
  await expect(page.getByTestId("current-user")).toContainText("Administrador del sistema");
  await expect(page.getByRole("heading", { name: "Actividad reciente" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Ingreso al sistema" }).first()).toBeVisible();

  // En tablet el menú lateral se abre con el botón del header.
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  await page.getByRole("link", { name: "Ventas" }).click();
  await expect(page).toHaveURL(/\/ventas$/);
  await expect(page.getByRole("heading", { level: 1, name: "Ventas" })).toBeVisible();

  await page.getByRole("button", { name: "Salir" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  expect(consoleErrors).toEqual([]);
});

test("secciones inexistentes devuelven 404", async ({ page }) => {
  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/$/);
  const res = await page.goto("/no-existe");
  expect(res?.status()).toBe(404);
});
