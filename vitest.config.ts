import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["pi-ask-user", "pi-coding-tools", "pi-container-sandbox", "pi-web-tools", "pi-todo", "pi-memory", "pi-vision-tools", "pi-lark", "pi-dingtalk", "pi-permission-system", "pi-subagents"],
	},
});
