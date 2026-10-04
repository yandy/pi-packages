import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		// 本包的 win32 真机套件会改写共享的 %TEMP% ACL（如 e2e 的首授权会在整棵树上急切
		// 传播常驻 ACE），而 diagnose-script 等“前后不变”断言也在同一棵树下建夹具——
		// 文件级并行会让授权传播插进断言的 before/after 之间（真机首跑已复现），故串行。
		fileParallelism: false,
	},
});
