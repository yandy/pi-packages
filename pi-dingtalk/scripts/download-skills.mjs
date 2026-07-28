#!/usr/bin/env node

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	readdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const SKILLS_DIR = resolve(PACKAGE_DIR, "skills");


/** 解析命令行参数，返回 mode。冲突/未知参数时报错退出。 */
function parseArgs(argv) {
	const flags = new Set();
	for (const arg of argv) {
		if (arg === "--mono" || arg === "--multi") {
			flags.add(arg);
		} else {
			console.error(`错误：未知参数: ${arg}`);
			console.error(`用法：node scripts/download-skills.mjs [--mono | --multi]`);
			process.exit(1);
		}
	}

	if (flags.has("--mono") && flags.has("--multi")) {
		console.error("错误：不能同时指定 --mono 和 --multi");
		console.error("用法：node scripts/download-skills.mjs [--mono | --multi]");
		process.exit(1);
	}

	if (flags.has("--multi")) return "multi";
	return "mono"; // 默认 mono
}

const mode = parseArgs(process.argv.slice(2));

const tmpDir = mkdtempSync(join(tmpdir(), "dws-skills-"));
try {
	// 1. npm pack dingtalk-workspace-cli → tarball 落在临时目录
	const out = execSync("npm pack dingtalk-workspace-cli", { cwd: tmpDir, encoding: "utf8" });
	const tarballName = out.trim().split(/\r?\n/).filter(Boolean).pop().trim();
	const tarballPath = join(tmpDir, tarballName);
	if (!existsSync(tarballPath)) {
		throw new Error(`npm pack 未生成 tarball: ${tarballPath}`);
	}

	// 2. 从 tarball 只解压出 skills.zip
	const zipInTarball = "package/assets/dws-skills.zip";
	execSync(`tar -xzf "${tarballPath}" "${zipInTarball}"`, {
		cwd: tmpDir,
		stdio: "inherit",
	});
	const zipPath = join(tmpDir, "package", "assets", "dws-skills.zip");
	if (!existsSync(zipPath)) {
		throw new Error(`tar 未解压出 skills.zip: ${zipPath}`);
	}

	// 3. 解压 zip 到临时目录的 extract/ 子目录
	const extractDir = join(tmpDir, "extract");
	mkdirSync(extractDir, { recursive: true });
	execSync(`unzip -oq "${zipPath}" -d "${extractDir}"`, {
		stdio: "inherit",
	});

	// 4. 按 mode 确定源子树
	const modeRoot = join(extractDir, mode);
	if (!existsSync(modeRoot)) {
		throw new Error(`zip 内未找到 ${mode}/ 子目录: ${modeRoot}`);
	}

	// 5. 清空 skills/ 目录
	rmSync(SKILLS_DIR, { recursive: true, force: true });
	mkdirSync(SKILLS_DIR, { recursive: true });

	// 6. 按 mode 拷贝
	if (mode === "mono") {
		// mono 内容包裹到 skills/dws/
		const dest = join(SKILLS_DIR, "dws");
		mkdirSync(dest, { recursive: true });
		for (const entry of readdirSync(modeRoot)) {
			const src = join(modeRoot, entry);
			execSync(`cp -r "${src}" "${dest}/"`, { stdio: "inherit" });
		}
	} else {
		// multi: 各子目录直接拷到 skills/
		for (const entry of readdirSync(modeRoot)) {
			const src = join(modeRoot, entry);
			execSync(`cp -r "${src}" "${SKILLS_DIR}/"`, { stdio: "inherit" });
		}
	}
} catch (e) {
	console.error("错误：" + e.message);
	process.exit(1);
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}

console.log("Done.");
