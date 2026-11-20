import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri の dev サーバー設定 (tauri.conf.json の devUrl と合わせる)
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
});
