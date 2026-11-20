import { expect, type Locator, type Page } from "@playwright/test";

/*
 * Ayudas compartidas por las suites E2E.
 */

/**
 * Abre una sección desde el menú principal: en escritorio, desde la pestaña de
 * su área; en tablet, desde el cajón.
 */
export async function openSection(page: Page, name: string) {
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  const nav = page.getByRole("navigation", { name: "Menú principal" });
  await expect(nav.getByRole("link", { name: "Inicio", exact: true })).toBeVisible();
  const link = nav.getByRole("link", { name, exact: true, includeHidden: true });
  if (!(await link.isVisible())) {
    // Escritorio: la pantalla está dentro de la lista de su pestaña.
    const id = await link.locator("xpath=..").getAttribute("id");
    await nav.locator(`[aria-controls="${id}"]`).click();
  }
  await link.click();
}

/** Textos de todos los enlaces del menú principal (incluye los de pestañas cerradas). */
export async function menuLabels(page: Page): Promise<string[]> {
  const menuButton = page.getByRole("button", { name: "Abrir menú" });
  if (await menuButton.isVisible()) await menuButton.click();
  const nav = page.getByRole("navigation", { name: "Menú principal" });
  await expect(nav.getByRole("link", { name: "Inicio", exact: true })).toBeVisible();
  const labels = await nav.getByRole("link", { includeHidden: true }).allTextContents();
  return labels.map((l) => l.trim());
}

/**
 * Elige la opción cuyo texto contiene `text`, sea un `<select>` o un selector
 * con búsqueda (combobox ARIA): en ese caso escribe y elige de la lista.
 */
export async function selectByText(control: Locator, text: string) {
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === "select") {
    await expect(control.locator("option", { hasText: text }).first()).toBeAttached();
    const value = await control.locator("option", { hasText: text }).first().getAttribute("value");
    await control.selectOption(value ?? "");
    return;
  }
  await control.click();
  await control.fill(text);
  const listId = await control.getAttribute("aria-controls");
  const list = listId ? control.page().locator(`[id="${listId}"]`) : control.page();
  await list.getByRole("option").filter({ hasText: text }).first().click();
  await expect(control).not.toHaveAttribute("aria-expanded", "true");
}

/** Valor de un resumen (`dl` de métricas) por rótulo. */
export function summaryValue(scope: Locator, label: string | RegExp): Locator {
  return scope
    .locator("dl.cost-summary > div, dl.metrics > div")
    .filter({ has: scope.page().locator("dt", { hasText: label }) })
    .locator("dd");
}

/** Enlace de la miga de pan (ubicación) del encabezado de la página. */
export function crumb(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Ubicación" })
    .getByRole("link", { name, exact: true });
}
