import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: { "@": resolve(import.meta.dirname, "src") },
	},
	server: {
		port: 3001,
		proxy: {
			// 不 rewrite：后端路由本身带 /api 前缀
			"/api": { target: "http://localhost:3333", changeOrigin: true },
		},
	},
});
