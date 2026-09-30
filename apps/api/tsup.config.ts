import { defineConfig } from "tsup";

// Empaqueta la API en un único artefacto ejecutable con Node. Los paquetes
// internos del monorepo (@bakery/*) se incluyen en el bundle; las dependencias
// de npm quedan externas y se resuelven desde node_modules.
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  sourcemap: true,
  clean: true,
  noExternal: [/^@bakery\//],
});
