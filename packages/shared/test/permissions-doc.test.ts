import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { permissionMatrixMarkdown } from "../src/permission-matrix";

const DOC = join(import.meta.dirname, "../../../docs/PERMISSIONS.md");
const START = "<!-- permission-matrix:start -->";
const END = "<!-- permission-matrix:end -->";

describe("docs/PERMISSIONS.md", () => {
  it("contiene la matriz generada desde SYSTEM_ROLES (regenerar con pnpm docs:permissions)", () => {
    const doc = readFileSync(DOC, "utf8");
    const start = doc.indexOf(START);
    const end = doc.indexOf(END);
    expect(start, "faltan los marcadores de la matriz").toBeGreaterThanOrEqual(0);
    const expected = `${START}\n\n${permissionMatrixMarkdown()}\n\n${END}`;
    const current = doc.slice(start, end + END.length);
    if (process.env.UPDATE_PERMISSIONS_DOC === "1" && current !== expected) {
      writeFileSync(DOC, doc.slice(0, start) + expected + doc.slice(end + END.length));
      return;
    }
    expect(current).toBe(expected);
  });
});
