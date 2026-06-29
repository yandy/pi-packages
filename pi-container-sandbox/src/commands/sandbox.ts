import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
	discoverDockerfiles,
	getSbxConfigPath,
	imageRef,
	loadSbxConfig,
	PACKAGE_DOCKER_DIR,
	saveSbxConfig,
} from "../config";
import { execCapture } from "../ops";
import { DockerRuntime } from "../runtime";
import { clearSbx, getSbx } from "../session";
import { type SizeTier, TIER_SPECS } from "../tiers";

export function createSandboxCommandHandlers(
	localCwd: string,
	pathApprovals: {
		list(): { path: string; approvedAt: number; expiresAt: number }[];
		revoke(p: string): boolean;
		add(p: string, days: number | typeof Infinity): void;
		find(p: string): { path: string; approvedAt: number; expiresAt: number } | undefined;
	},
) {
	return {
		status: async (
			_args: string,
			ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
		) => {
			const sbx = getSbx();
			if (!sbx) {
				const cfg = loadSbxConfig(localCwd);
				ctx.ui.notify(
					`Sandbox is not active. Start pi with --container.\nconfigured image: ${imageRef(cfg.image)}`,
					"info",
				);
				return;
			}
			const info = (await execCapture(sbx, "id; uname -a; df -h /workspace | tail -1")).toString();
			const resParts: string[] = [];
			if (sbx.resources?.memory) resParts.push(`memory: ${sbx.resources.memory}`);
			if (sbx.resources?.cpus) resParts.push(`cpus: ${sbx.resources.cpus}`);
			if (sbx.resources?.swap !== undefined) resParts.push(`swap: ${sbx.resources.swap}`);
			if (sbx.resources?.pidsLimit !== undefined) resParts.push(`pids-limit: ${sbx.resources.pidsLimit}`);
			const resStr = resParts.length ? `\nresources: ${resParts.join(", ")}` : "";
			const reusableStr = sbx.isReusable ? ` [re-usable${sbx.isReattached ? ", reattached" : ""}]` : "";
			ctx.ui.notify(
				[
					`Sandbox: docker container ${sbx.name}${reusableStr}`,
					`host cwd: ${sbx.hostCwd}`,
					`image: ${sbx.imageRef}`,
					resStr.trim(),
					info.trimEnd(),
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},

		start: async (
			_args: string,
			ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
		) => {
			ctx.ui.notify(
				"/sandbox start requires sandbox initialization via session start. Restart pi with --container.",
				"info",
			);
		},

		build: async (
			_args: string,
			ctx: {
				ui: {
					setStatus: (key: string, msg: string) => void;
					notify: (msg: string, level?: "info" | "warning" | "error") => void;
					select: (title: string, options: string[], opts?: Record<string, unknown>) => Promise<string | undefined>;
				};
			},
		) => {
			const sbx = getSbx();

			const dockerfiles = discoverDockerfiles();
			if (dockerfiles.length === 0) {
				ctx.ui.notify("docker/ 目录中未找到 .Dockerfile 文件。", "warning");
				return;
			}

			const skipLabel = "跳过";
			const labelMap = new Map<string, string>();
			const options: string[] = [];
			for (const f of dockerfiles) {
				const label = `${f} (内置)`;
				labelMap.set(label, f);
				options.push(label);
			}
			options.push(skipLabel);

			const selected = await ctx.ui.select("选择 Dockerfile 构建镜像", options);
			if (!selected || selected === skipLabel) {
				ctx.ui.notify("构建已跳过。请手动执行 docker build 构建镜像。", "info");
				return;
			}

			const dockerfile = `${labelMap.get(selected) ?? selected}.Dockerfile`;
			const image = sbx?.imageRef ?? "pi-container-sandbox:latest";

			try {
				if (sbx) {
					await sbx.runtime.buildImage({
						dockerfile,
						buildContext: PACKAGE_DOCKER_DIR,
						onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
					});
				} else {
					const runtime = new DockerRuntime({
						image,
						hostCwd: localCwd,
						name: "pi-sbx-build",
						allowNetwork: true,
						resources: { memory: "4g", cpus: "2" },
						onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
					});
					await runtime.init();
					await runtime.buildImage({
						dockerfile,
						buildContext: PACKAGE_DOCKER_DIR,
					});
				}
				ctx.ui.notify(`镜像 ${image} 构建成功。`, "info");
			} catch (e) {
				ctx.ui.notify(`构建失败: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},

		stop: async (_args: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			if (sbx.keep) {
				ctx.ui.notify(
					`Container ${sbx.name} has keep/persist set. Use /sandbox keep with a different name, or clear sandbox.json to disable persistence.`,
					"warning",
				);
				return;
			}
			try {
				sbx.runtime.shutdown();
			} catch (e) {
				ctx.ui.notify(`Stop failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}
			clearSbx();
			ctx.ui.notify(`Sandbox ${sbx.name} stopped and removed.`, "info");
		},

		keep: async (args: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			const name = args.trim() || sbx.name;
			const cfg = loadSbxConfig(sbx.hostCwd);
			cfg.runtime.name = name;
			saveSbxConfig(sbx.hostCwd, cfg);
			ctx.ui.notify(`Sandbox container "${name}" saved to sandbox.json. It will be reused next session.`, "info");
		},

		exec: async (args: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			if (!args.trim()) {
				ctx.ui.notify("Usage: /sandbox exec <command>", "info");
				return;
			}
			try {
				const stdout = (await execCapture(sbx, args.trim(), 30000)).toString();
				ctx.ui.notify(`$ ${args.trim()}\n${stdout}`, "info");
			} catch (e) {
				ctx.ui.notify(`exec failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},

		doctor: async (
			_args: string,
			ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
		) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active. Start pi with --container.", "info");
				return;
			}
			const script = [
				"set -u",
				"for cmd in sh bash git rg fd bat eza jq yq ast-grep uv python python3 bun bunx node npm chromium; do",
				'  if command -v $cmd >/dev/null 2>&1; then printf "ok   %s -> %s\\n" $cmd $(command -v $cmd); else printf "MISS %s\\n" $cmd; fi',
				"done",
				"echo",
				'bun --version 2>&1 | sed "s/^/bun: /"',
				'node --version 2>&1 | sed "s/^/node: /"',
				'npm --version 2>&1 | sed "s/^/npm: /"',
				'python --version 2>&1 | sed "s/^/python: /"',
				'uv --version 2>&1 | sed "s/^/uv: /"',
				'chromium --version 2>&1 | sed "s/^/chromium: /"',
				"echo",
				'ldd $(command -v node) | sed "s/^/node ldd: /"',
			].join("\n");
			const out = (await execCapture(sbx, script, 20000)).toString();
			ctx.ui.notify(`Sandbox doctor:\n${out}`, "info");
		},

		config: async (
			_args: string,
			ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } },
		) => {
			const sbx = getSbx();
			const hostCwd = sbx?.hostCwd ?? localCwd;
			const cfg = loadSbxConfig(hostCwd);
			const ref = imageRef(cfg.image);
			const configPath = getSbxConfigPath(hostCwd);
			const lines: string[] = [
				"Sandbox project config (.pi/agent/sandbox.json):",
				`  Image:   ${ref}`,
				`  Tier:    ${cfg.runtime.tier}`,
				`  Name:    ${cfg.runtime.name ?? "(auto)"}`,
				`  Persist: ${cfg.runtime.persist ? "yes" : "no"}`,
				`  Cache:   ${cfg.runtime.cache ?? "(none)"}`,
				"",
				`Config file: ${existsSync(configPath) ? configPath : "(not yet created)"}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},

		allow: async (raw: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
			const sbx = getSbx();
			if (!sbx) {
				ctx.ui.notify("Sandbox is not active.", "info");
				return;
			}
			if (!raw) {
				ctx.ui.notify(
					"Usage: /sandbox allow <host-path>\nAdds a host path prefix for read access from the sandbox.",
					"info",
				);
				return;
			}
			const abs = raw.startsWith("~") ? resolvePath(homedir(), raw.slice(1)) : resolvePath(raw);
			if (sbx.allowedExternalPrefixes.includes(abs)) {
				ctx.ui.notify(`Path ${abs} is already allowed.`, "info");
				return;
			}
			if (!existsSync(abs)) {
				ctx.ui.notify(`Path ${abs} does not exist on host.`, "warning");
				return;
			}
			sbx.allowedExternalPrefixes.push(abs);
			ctx.ui.notify(`Sandbox: read access now allowed for ${abs}`, "info");
		},

		paths: async (args: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "revoke" && parts[1]) {
				const target = parts.slice(1).join(" ");
				const abs = target.startsWith("~") ? resolvePath(homedir(), target.slice(1)) : resolvePath(target);
				if (pathApprovals.revoke(abs)) {
					ctx.ui.notify(`Revoked path approval: ${abs}`, "info");
				} else {
					ctx.ui.notify(`No approval found for: ${abs}`, "warning");
				}
				return;
			}
			const records = pathApprovals.list();
			if (records.length === 0) {
				ctx.ui.notify("No persisted path approvals. External reads will prompt interactively.", "info");
				return;
			}
			const lines = records.map((r) => {
				const expiry = r.expiresAt === Infinity ? "always" : `expires ${new Date(r.expiresAt).toISOString()}`;
				return `  ${r.path} (${expiry})`;
			});
			ctx.ui.notify(
				[
					`Persisted path approvals (${records.length}):`,
					...lines,
					"",
					"Use /sandbox paths revoke <path> to revoke an approval.",
				].join("\n"),
				"info",
			);
		},

		tiers: async (args: string, ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) => {
			const parts = args.trim().split(/\s+/);
			if (parts[0] === "set" && parts[1]) {
				const tier = parts[1] as SizeTier;
				if (!(tier in TIER_SPECS)) {
					ctx.ui.notify(`Unknown tier: ${tier}. Use: small, medium, large`, "warning");
					return;
				}
				const sbx = getSbx();
				const hostCwd = sbx?.hostCwd ?? localCwd;
				const cfg = loadSbxConfig(hostCwd);
				cfg.runtime.tier = tier;
				saveSbxConfig(hostCwd, cfg);
				ctx.ui.notify(
					`Tier set to ${tier} (mem=${TIER_SPECS[tier].memory}, cpu=${TIER_SPECS[tier].cpus}). Restart pi to apply.`,
					"info",
				);
				return;
			}
			const lines = ["Available tiers:", ""];
			for (const [name, spec] of Object.entries(TIER_SPECS)) {
				lines.push(`  ${name}: mem=${spec.memory}, cpu=${spec.cpus}, swap=${spec.swap}`);
			}
			lines.push("", "Use /sandbox tiers set <name> to switch.");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	};
}
