import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "site",
  base: "/omp-orca-dispatch/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
