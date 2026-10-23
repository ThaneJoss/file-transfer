import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
      "/v1": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
  build: {
    manifest: true,
  },
});
