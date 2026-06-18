import { createInterface } from "node:readline";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dockerDir = resolvePath(__dirname, "..", "docker");
const image = "pi-container-sandbox:latest";

function discoverDockerfiles(): string[] {
	if (!existsSync(dockerDir)) return [];
	return readdirSync(dockerDir)
		.filter((f) => f.endsWith(".Dockerfile"))
		.map((f) => basename(f, extname(f)));
}

function build(name: string) {
	const dockerfilePath = `${name}.Dockerfile`;
	const cmd = `docker build -t ${image} -f "${resolvePath(dockerDir, dockerfilePath)}" "${dockerDir}"`;
	console.log(cmd);
	execSync(cmd, { stdio: "inherit" });
	console.log(`Image ${image} built successfully.`);
}

async function main() {
	const arg = process.argv[2];
	if (arg) {
		const dockerfilePath = resolvePath(dockerDir, `${arg}.Dockerfile`);
		if (!existsSync(dockerfilePath)) {
			console.error(`Dockerfile not found: ${arg}.Dockerfile`);
			process.exit(1);
		}
		build(arg);
		return;
	}

	const dockerfiles = discoverDockerfiles();
	if (dockerfiles.length === 0) {
		console.error("No .Dockerfile files found in docker/ directory.");
		process.exit(1);
	}

	const options = [...dockerfiles, "跳过"];
	console.log("Select a Dockerfile:");
	options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));

	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await new Promise<string>((resolve) => {
		rl.question(`Enter number (1-${options.length}): `, (a) => {
			rl.close();
			resolve(a.trim());
		});
	});

	const idx = parseInt(answer, 10) - 1;
	if (isNaN(idx) || idx < 0 || idx >= options.length) {
		console.error("Invalid selection.");
		process.exit(1);
	}

	if (options[idx] === "跳过") {
		console.log("Skipped. Build the image manually.");
		return;
	}

	build(options[idx]);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
