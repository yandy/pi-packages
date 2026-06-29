import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { createSandboxCommandHandlers } from "./src/commands/sandbox";
import { discoverDockerfiles, imageRef, loadSbxConfig, PACKAGE_DOCKER_DIR } from "./src/config";
import {
	createEditOps,
	createHostBashOps,
	createReadOps,
	createRemoteBashOps,
	createWriteOps,
	execCapture,
	extractCommandName,
} from "./src/ops";
import {
	ensureExternalReadApproved,
	getExternalPath,
	isAllowedExternalResource,
	PathApprovalStore,
	REMOTE_ROOT,
} from "./src/paths";
import { DockerRuntime, deriveContainerName } from "./src/runtime";
import { clearSbx, getSbx, type SbxSession, setSbx } from "./src/session";
import { discoverSkillMounts } from "./src/skills";
import { TIER_SPECS } from "./src/tiers";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("container", {
		description: "Sandbox all bash/read/write/edit ops inside a Linux container (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-container", {
		description: "Force-disable container sandboxing",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("noc", {
		description: "Alias for --no-container",
		type: "boolean",
		default: false,
	});


	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	let hostBashTool: ReturnType<typeof createBashTool> | null = null;

	const pathApprovals = new PathApprovalStore(localCwd);
	const handlers = createSandboxCommandHandlers(localCwd, pathApprovals);

	async function guardExternalRead(
		paramsPath: string,
		sbx: SbxSession,
		ctx: { ui: ExtensionUIContext; hasUI: boolean },
	): Promise<void> {
		const external = getExternalPath(paramsPath, sbx.hostCwd, sbx.mounts);
		if (!external) return;
		if (isAllowedExternalResource(external, sbx.allowedExternalPrefixes)) return;
		if (!ctx.hasUI) {
			throw new Error(
				`sandbox: refusing to access ${external}: outside of project cwd ${sbx.hostCwd}. ` +
					`Use --container-allow-paths or /sandbox allow to grant access.`,
			);
		}
		await ensureExternalReadApproved(external, sbx.allowedExternalPrefixes, pathApprovals, ctx.ui);
	}

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localRead.execute(id, params, signal, onUpdate);
			await guardExternalRead(params.path, sbx, _ctx);
			const tool = createReadTool(localCwd, { operations: createReadOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localWrite.execute(id, params, signal, onUpdate);
			const tool = createWriteTool(localCwd, { operations: createWriteOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localEdit.execute(id, params, signal, onUpdate);
			const tool = createEditTool(localCwd, { operations: createEditOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		label: "bash (sandboxed)",
		async execute(id, params, signal, onUpdate, _ctx) {
			const sbx = getSbx();
			if (!sbx) return localBash.execute(id, params, signal, onUpdate);

			const hostCommands = sbx.config.host.commands ?? [];
			const cmdName = extractCommandName(params.command);
			if (cmdName && hostCommands.includes(cmdName)) {
				if (!hostBashTool) {
					hostBashTool = createBashTool(localCwd, {
						operations: createHostBashOps(sbx.hostCwd, sbx.mounts),
					});
				}
				return hostBashTool.execute(id, params, signal, onUpdate);
			}

			const tool = createBashTool(localCwd, { operations: createRemoteBashOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		const sbx = getSbx();
		if (!sbx) return;
		return { operations: createRemoteBashOps(sbx) };
	});

	pi.on("before_agent_start", async (event) => {
		const sbx = getSbx();
		if (!sbx) return;

		const skillInfo = sbx.mounts.length
			? `Agent skills are mounted read-only at /skills/ (e.g. ${sbx.mounts.map((m) => m.target).join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
			: "No skill directories are mounted.";

		const hostCommands = sbx.config.host.commands ?? [];
		const hostCmdHint = hostCommands.length
			? [
					"",
					`The following commands run directly on the host (not inside the container):`,
					`  ${hostCommands.join(", ")}`,
					"",
					`When using these commands, prefer relative paths (e.g. \`src/foo.ts\`)`,
					`rather than absolute /workspace paths, because they execute outside the`,
					`container where /workspace does not exist.`,
				].join("\n")
			: "";

		return {
			systemPrompt: event.systemPrompt.replace(
				/Current working directory:\s*\S+/,
				[
					`Current working directory: ${REMOTE_ROOT} (sandboxed in docker container ${sbx.name}, host cwd ${localCwd} mounted read-write)`,
					skillInfo,
					hostCmdHint,
				]
					.filter(Boolean)
					.join("\n"),
			),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if ((pi.getFlag("no-container") as boolean) || (pi.getFlag("noc") as boolean)) return;
		if (!(pi.getFlag("container") as boolean)) return;

		try {
			const cfg = loadSbxConfig(localCwd);
			const rt = cfg.runtime;
			const sizeTier = rt.tier;
			const tierSpec = TIER_SPECS[sizeTier];
			const image = imageRef(cfg.image);
			const allowNetwork = rt.network;
			const keep = rt.persist;

			const extraPaths = rt.mounts.length ? rt.mounts : undefined;
			const sandboxName = rt.name ?? deriveContainerName(localCwd);
			const isReusable = !!(rt.name);

			const cacheVolume = rt.cache ?? undefined;

			const skillMounts = discoverSkillMounts(extraPaths);

			const allowedExternalPrefixes: string[] = [];

			const resources: { memory: string; cpus: string; swap: string; pidsLimit?: number } = {
				memory: tierSpec.memory, cpus: tierSpec.cpus, swap: tierSpec.swap,
			};
			if (rt.memory) resources.memory = rt.memory;
			if (rt.cpus) resources.cpus = rt.cpus;
			if (rt.pidsLimit !== null) resources.pidsLimit = rt.pidsLimit;
			if (rt.swap !== null) resources.swap = rt.swap;

			const runtime = new DockerRuntime({
				image, hostCwd: localCwd, name: sandboxName, allowNetwork,
				resources,
				extraMounts: skillMounts.length ? skillMounts : undefined,
				cacheVolume,
				onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
			});

			await runtime.init();

			const hasImage = await runtime.imageExists();
			if (!hasImage) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`镜像 ${image} 不存在。请运行 docker build 手动构建，或使用 /sandbox build 命令。`, "error");
					return;
				}

				const dockerfiles = discoverDockerfiles();
				if (dockerfiles.length === 0) {
					ctx.ui.notify("没有找到内置 Dockerfile（docker/ 目录为空）。请自行构建镜像。", "warning");
					return;
				}

				const skipLabel = "跳过 - 我自己构建";
				const labelMap = new Map<string, string>();
				const options: string[] = [];
				for (const f of dockerfiles) {
					const label = `${f} (内置)`;
					labelMap.set(label, f);
					options.push(label);
				}
				options.push(skipLabel);

				const selected = await ctx.ui.select("Docker 镜像不存在，选择 Dockerfile 构建", options);
				if (!selected || selected === skipLabel) {
					ctx.ui.notify(
						`镜像 ${image} 不存在。请手动构建，例如：\n  docker build -t ${image} -f docker/cn.Dockerfile docker`,
						"warning",
					);
					return;
				}

				const dockerfile = `${labelMap.get(selected!)}.Dockerfile`;
				const buildCtx = PACKAGE_DOCKER_DIR;

				try {
					await runtime.buildImage({
						dockerfile,
						buildContext: buildCtx,
						onProgress: (msg: string) => ctx.ui.setStatus("sandbox", `[build] ${msg}`),
					});
				} catch (e) {
					ctx.ui.notify(`镜像构建失败: ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
			}

			if (!runtime.isReady()) {
				await runtime.withReady();
			}

			setSbx({
				runtime, name: sandboxName, hostCwd: localCwd,
				keep, mounts: skillMounts, allowedExternalPrefixes,
				resources, imageRef: image, config: cfg,
				isReusable, isReattached: false,
			});

			let cleaned = false;
			const cleanup = async () => {
				if (cleaned) return;
				cleaned = true;
				const s = getSbx();
				if (s && !s.keep) {
					try {
						await s.runtime.shutdown();
					} catch {
						/* ignore */
					}
					clearSbx();
				}
			};
			process.on("beforeExit", async () => {
				await cleanup();
			});
			process.once("SIGINT", async () => {
				await cleanup();
				process.exit(130);
			});
			process.once("SIGTERM", async () => {
				await cleanup();
				process.exit(143);
			});

			const ok = (await execCapture(getSbx()!, "id -un && pwd", 10000)).toString().trim();

			const resParts: string[] = [
				`size=${sizeTier}`,
				`mem=${resources.memory}`,
				`cpu=${resources.cpus}`,
				`swap=${resources.swap}`,
			];
			if (resources.pidsLimit !== undefined) resParts.push(`pids=${resources.pidsLimit}`);
			const resStr = ` (${resParts.join(", ")})`;

			const actualName = runtime.getContainerId()?.slice(0, 12) ?? sandboxName;
			const statusPrefix = "Sandbox up";
			ctx.ui.setStatus(
				"sandbox",
				ctx.ui.theme.fg("accent", `${statusPrefix}: ${actualName} (net=${allowNetwork ? "on" : "off"})${resStr}`),
			);
			ctx.ui.notify(
				[
					`${statusPrefix}: docker ${actualName}${resStr}${isReusable ? " [re-usable]" : ""}`,
					ok,
					skillMounts.length ? `Skills mounted: ${skillMounts.map((m) => m.target).join(", ")}` : "",
					cacheVolume ? `Cache volume: ${cacheVolume} at /cache` : "",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		} catch (e) {
			clearSbx();
			ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	});

	pi.on("session_shutdown", async (event) => {
		if (event.reason !== "quit") return;
		const sbx = getSbx();
		if (!sbx) return;
		if (!sbx.keep) {
			try {
				await sbx.runtime.shutdown();
			} catch {
				/* ignore */
			}
		}
		clearSbx();
	});

	pi.registerCommand("sandbox", {
		description:
			"Sandbox management. Subcommands: status, start, build, stop, keep, exec, doctor, config, allow, paths, tiers",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0]?.toLowerCase() || "status";
			const rest = parts.slice(1).join(" ");

			switch (sub) {
				case "status":
				case "info":
					return handlers.status(rest, ctx);
				case "start":
					return handlers.start(rest, ctx);
				case "build":
				case "rebuild":
					return handlers.build(rest, ctx);
				case "stop":
					return handlers.stop(rest, ctx);
				case "keep":
					return handlers.keep(rest, ctx);
				case "exec":
					return handlers.exec(rest, ctx);
				case "doctor":
				case "check":
					return handlers.doctor(rest, ctx);
				case "config":
				case "settings":
					return handlers.config(rest, ctx);
				case "allow":
					return handlers.allow(rest, ctx);
				case "paths":
					return handlers.paths(rest, ctx);
				case "tiers":
					return handlers.tiers(rest, ctx);
				default:
					ctx.ui.notify(
						[
							`Unknown subcommand: ${sub}`,
							"Available: status, start, build, stop, keep, exec, doctor, config, allow, paths, tiers",
						].join("\n"),
						"info",
					);
			}
		},
	});
}
