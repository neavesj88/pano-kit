import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The page only: the server runs from source (node desk/server.ts).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
