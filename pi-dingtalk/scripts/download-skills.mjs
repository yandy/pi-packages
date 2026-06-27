#!/usr/bin/env node

import { existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const SKILLS_DIR = resolve(PACKAGE_DIR, "skills");
const SOURCE_DIR = resolve(homedir(), ".dws", "skills", "multi");

if (!existsSync(SOURCE_DIR)) {
	console.error("请先安装 dingtalk-workspace-cli: npm install -g dingtalk-workspace-cli");
	process.exit(1);
}

mkdirSync(SKILLS_DIR, { recursive: true });
execSync(`cp -r "${SOURCE_DIR}/"* "${SKILLS_DIR}/"`, { stdio: "inherit" });
console.log("Done.");
