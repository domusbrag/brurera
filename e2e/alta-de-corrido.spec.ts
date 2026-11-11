import { expect, test, type Page } from "@playwright/test";
import { openSection, selectByText } from "./support";

/*
 * Rediseño: alta de producto de corrido. Desde Inicio, en una sola pantalla:
 * categoría nueva, insumo nuevo con su costo, receta lista para producir y
 * precio en una lista, viendo el costo y la ganancia mientras se carga.
 */

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@panificadora.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "admin1234";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN_EMAIL);
  await page.getByLabel("Contraseña").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Ingresar" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Inicio" })).toBeVisible();
}

async function createOption(page: Page, combobox: string, text: string, create: RegExp) {
  const input = page.getByRole("combobox", { name: combobox });
  await input.click();
  await input.fill(text);
  await page.getByRole("option", { name: create }).click();
}

test("Rediseño: producto vendible con receta y precio en una sola pantalla", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const run = `${Date.now().toString(36)}${testInfo.project.name[0]}`;
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await login(page);

  // Lista de precios para el paso 3 y un insumo existente con costo.
  const list = `Revendedores ${run}`;
  await page.evaluate(
    async ({ list, run }) => {
      const post = (url: string, body: unknown) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());
      await post("/api/price-lists", { name: list });
      const cat = await post("/api/categories", { type: "RAW_MATERIAL", name: `Harinas ${run}` });
      const units = await fetch("/api/units?pageSize=100").then((r) => r.json());
      const kg = units.items.find((u: { code: string }) => u.code === "kg");
      await post("/api/raw-materials", {
        name: `Harina ${run}`,
        categoryId: cat.id,
        baseUnitId: kg.id,
        referenceCost: "1000",
      });
    },
    { list, run },
  );
  await page.goto("/");

  await page
    .getByRole("navigation", { name: "Acciones rápidas" })
    .getByRole("link", { name: /Nuevo producto/ })
    .click();
  await expect(page.getByRole("heading", { level: 1, name: "Nuevo producto" })).toBeVisible();

  const name = `Chipá ${run}`;
  await page.getByLabel("Nombre").fill(name);
  await createOption(page, "Categoría", `Salados ${run}`, /Crear la categoría/);
  await expect(page.getByText(`Categoría nueva: Salados ${run}`)).toBeVisible();
  await selectByText(page.getByRole("combobox", { name: "Unidad de venta" }), "Unidad");
  await page.getByLabel("Precio de venta").fill("200");

  // Receta: 2 kg de harina (existente) + 1 kg de queso (nuevo, $5.000/kg) → 40 unidades.
  await page.getByLabel("Con esta receta salen").fill("40");
  await selectByText(page.getByRole("combobox", { name: "Insumo 1" }), `Harina ${run}`);
  await page.getByLabel("Cantidad 1").fill("2");
  await createOption(page, "Insumo 2", `Queso ${run}`, /Crear el insumo/);
  await page.getByLabel("Cantidad 2").fill("1");
  await page.getByLabel(`Costo de Queso ${run} por kg`).fill("5000");

  // Costo (2.000 + 5.000) / 40 = 175; ganancia 25 por unidad.
  const summary = page.getByRole("complementary", { name: "Resumen" });
  await expect(summary).toContainText("$175,00");
  await expect(summary).toContainText("$25,00");
  await expect(summary).toContainText(`la categoría «Salados ${run}»`);

  await page.getByRole("checkbox", { name: list }).check();
  await page.getByLabel(`Precio en ${list}`).fill("180");
  await page.getByRole("button", { name: "Crear producto" }).click();

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(/creado con receta lista para producir/)).toBeVisible();
  await expect(page.getByText("$175,00 / u", { exact: true })).toBeVisible();

  // La receta quedó vigente y el precio en la lista.
  await openSection(page, "Listas de precios");
  await page.getByRole("link", { name: list }).click();
  // Precio propio en la lista: 180 (10 % menos que el precio de venta).
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row.locator("input").first()).toHaveValue(/^180([.,]00)?$/);
  await expect(row).toContainText("-10 %");
  expect(errors).toEqual([]);
});
