#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WELL_KNOWN_PATHS = [
	"/.well-known/skills/index.json",
	"/.well-known/agent-skills/index.json",
];

const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const SKILLS_DIR = resolve(PACKAGE_DIR, "skills");
const FEISHU_ORIGIN = "https://open.feishu.cn";

async function probeEndpoint() {
	for (const path of WELL_KNOWN_PATHS) {
		const url = `${FEISHU_ORIGIN}${path}`;
		try {
			const resp = await fetch(url);
			if (resp.ok) {
				return { endpoint: path, index: await resp.json() };
			}
		} catch {
			continue;
		}
	}
	throw new Error(
		`All well-known endpoints returned non-200:\n${WELL_KNOWN_PATHS.map((p) => `  ${FEISHU_ORIGIN}${p}`).join("\n")}`,
	);
}

function buildDownloadUrl(endpoint, skillName, file) {
	const baseDir = endpoint.replace(/\/[^/]+$/, "");
	return `${FEISHU_ORIGIN}${baseDir}/${skillName}/${file}`;
}

async function downloadFile(url, destPath) {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${url}`);
	const dir = destPath.substring(0, destPath.lastIndexOf("/"));
	await mkdir(dir, { recursive: true });
	await writeFile(destPath, Buffer.from(await resp.arrayBuffer()));
}

async function main() {
	console.log("Probing well-known endpoints...");
	const { endpoint, index } = await probeEndpoint();
	console.log(`Using endpoint: ${endpoint} (${index.skills.length} skills)`);

	console.log("Downloading skills...");
	for (const skill of index.skills) {
		const skillDir = resolve(SKILLS_DIR, skill.name);
		console.log(`  ${skill.name}`);
		await mkdir(skillDir, { recursive: true });
		for (const file of skill.files) {
			const url = buildDownloadUrl(endpoint, skill.name, file);
			const dest = resolve(skillDir, file);
			try {
				await downloadFile(url, dest);
			} catch (err) {
				console.warn(`    \u26a0 failed to download ${url}: ${err.message}`);
			}
		}
	}

	console.log("Done.");
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
