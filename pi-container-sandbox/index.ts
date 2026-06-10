import { resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import {
	type ExtensionAPI,
	type ExtensionUIContext,
	createReadTool,
	createWriteTool,
	createEditTool,
	createBashTool,
} from "@earendil-works/pi-coding-agent";
import { detectRuntime, deriveContainerName, spawnWithTimeout } from "./src/runtime";
import { loadSbxConfig, imageRefForTag } from "./src/config";
import { TIER_SPECS, parseSizeTier } from "./src/tiers";
import { getSbx, setSbx, clearSbx, type SbxSession } from "./src/session";
import {
	createReadOps,
	createWriteOps,
	createEditOps,
	createBashOps,
	execCapture,
} from "./src/ops";
import {
	getExternalPath,
	isAllowedExternalResource,
	ensureExternalReadApproved,
	PathApprovalStore,
	REMOTE_ROOT,
} from "./src/paths";
import { discoverSkillMounts } from "./src/skills";
import { createSandboxCommandHandlers } from "./src/commands/sandbox";

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
	pi.registerFlag("container-size", {
		description: "Sandbox size tier: small, medium, large (default: medium)",
		type: "string",
		default: "medium",
	});
	pi.registerFlag("sandbox-name", {
		description: "Re-usable sandbox name. If container exists, reattaches; otherwise creates new.",
		type: "string",
	});
	pi.registerFlag("sandbox-persist", {
		description: "Keep sandbox container running after pi exits",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("sandbox-cache", {
		description: "Docker volume name for persistent cache at /cache",
		type: "string",
	});
	pi.registerFlag("container-image", {
		description: "Image to use for the sandbox (default: pi-container-sandbox:latest)",
		type: "string",
	});
	pi.registerFlag("container-net", {
		description: "Allow outbound network from the sandbox (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("no-container-net", {
		description: "Disable container networking",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-keep", {
		description: "Don't stop the sandbox container when pi exits",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("container-mount-skills", {
		description: "Mount agent skill directories read-only into the container at /skills (default: on)",
		type: "boolean",
		default: true,
	});
	pi.registerFlag("container-mount-paths", {
		description: "Comma-separated list of additional host directories to mount read-only",
		type: "string",
	});
	pi.registerFlag("container-allow-paths", {
		description: "Comma-separated list of host path prefixes to allow for read access from outside the sandbox",
		type: "string",
	});
	pi.registerFlag("container-memory", {
		description: "Memory limit for the container (e.g., 2g, 512m)",
		type: "string",
	});
	pi.registerFlag("container-cpus", {
		description: "CPU limit for the container (e.g., 2, 0.5)",
		type: "string",
	});
	pi.registerFlag("container-swap", {
		description: "Swap limit for the container (e.g., 1g, 0 to disable)",
		type: "string",
	});
	pi.registerFlag("container-pids-limit", {
		description: "Maximum number of PIDs the container can create. Default: 512",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);

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
			const tool = createBashTool(localCwd, { operations: createBashOps(sbx) });
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("user_bash", () => {
		const sbx = getSbx();
		if (!sbx) return;
		return { operations: createBashOps(sbx) };
	});

	pi.on("before_agent_start", async (event) => {
		const sbx = getSbx();
		if (!sbx) return;

		const skillInfo = sbx.mounts.length
			? `Agent skills are mounted read-only at /skills/ (e.g. ${sbx.mounts.map((m) => m.target).join(", ")}). Read skill files via /skills/<name>/SKILL.md. Writing to /skills/ is forbidden.`
			: "No skill directories are mounted.";

		return {
			systemPrompt: event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				[
					`Current working directory: ${REMOTE_ROOT} (sandboxed in ${sbx.runtime.kind} container ${sbx.name}, host cwd ${localCwd} mounted read-write)`,
					skillInfo,
				].join("\n"),
			),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		if ((pi.getFlag("no-container") as boolean) || (pi.getFlag("noc") as boolean)) return;
		if (!(pi.getFlag("container") as boolean)) return;

		try {
			const runtime = await detectRuntime(ctx);
			if (!runtime) {
				ctx.ui.notify("Docker not available or timed out. Running without sandbox.", "warning");
				return;
			}

			const cfg = loadSbxConfig(localCwd);

			const sizeFlag = pi.getFlag("container-size") as string | undefined;
			const sizeTier = parseSizeTier(sizeFlag || cfg.tier) || "medium";
			const tierSpec = TIER_SPECS[sizeTier || "medium"];

			const flagImage = pi.getFlag("container-image") as string | undefined;
			const configImageRef = imageRefForTag(cfg.image, cfg.tag);
			const image = flagImage || configImageRef || "pi-container-sandbox:latest";

			const allowNetwork = (pi.getFlag("container-net") as boolean) && !(pi.getFlag("no-container-net") as boolean);
			const keep = pi.getFlag("container-keep") as boolean;
			const persist = pi.getFlag("sandbox-persist") as boolean || cfg.persist;
			const mountSkills = pi.getFlag("container-mount-skills") as boolean;
			const extraPathsRaw = pi.getFlag("container-mount-paths") as string | undefined;
			const extraPaths = extraPathsRaw ? extraPathsRaw.split(",").map((p: string) => p.trim()).filter(Boolean) : undefined;

			const nameFlag = pi.getFlag("sandbox-name") as string | undefined;
			const sandboxName = nameFlag ?? cfg.containerName ?? deriveContainerName(localCwd);
			const isReusable = !!(nameFlag || cfg.containerName);

			const cacheFlag = pi.getFlag("sandbox-cache") as string | undefined;
			const cacheVolume = cacheFlag ?? cfg.cacheVolume ?? undefined;

			if (cacheVolume) {
				await runtime.createVolume(cacheVolume);
			}

			const skillMounts = mountSkills ? discoverSkillMounts(extraPaths) : [];

			let isReattached = false;
			{
				const running = await runtime.isRunning(sandboxName);
				if (running) {
					isReattached = true;
					ctx.ui.notify(`Reattaching to existing sandbox: ${sandboxName}`, "info");
				} else {
					const inspect = await spawnWithTimeout(
						runtime.bin, ["inspect", "--format", "exists", sandboxName], 5000,
					);
					if (inspect.code === 0 && !inspect.timedOut) {
						if (isReusable || persist) {
							const started = await runtime.start(sandboxName);
							if (started) {
								isReattached = true;
								ctx.ui.notify(`Restarted existing sandbox: ${sandboxName}`, "info");
							} else {
								ctx.ui.notify(`Removing broken container ${sandboxName}, creating fresh...`, "warning");
								runtime.remove(sandboxName);
							}
						} else {
							ctx.ui.notify(`Cleaning up stale container ${sandboxName} for fresh sandbox`, "info");
							runtime.remove(sandboxName);
						}
					}
				}
			}

			if (!(await runtime.exists(image))) {
				ctx.ui.notify(
					`Sandbox image "${image}" not found locally.\nBuild it with: npm run build-image`,
					"error",
				);
				return;
			}

			const allowPathsRaw = pi.getFlag("container-allow-paths") as string | undefined;
			const allowedExternalPrefixes = allowPathsRaw
				? allowPathsRaw.split(",").map((p: string) => p.trim()).filter(Boolean).map((p: string) =>
					p.startsWith("~") ? resolvePath(homedir(), p.slice(1)) : resolvePath(p)
				)
				: [];

			const resources: { memory: string; cpus: string; swap: string; pidsLimit?: number } = {
				memory: tierSpec.memory,
				cpus: tierSpec.cpus,
				swap: tierSpec.swap,
			};

			const memFlag = pi.getFlag("container-memory") as string | undefined;
			const cpusFlag = pi.getFlag("container-cpus") as string | undefined;
			const pidsFlagRaw = pi.getFlag("container-pids-limit") as string | undefined;
			const pidsFlag = pidsFlagRaw ? parseInt(pidsFlagRaw, 10) : undefined;
			const swapFlag = pi.getFlag("container-swap") as string | undefined;
			if (memFlag) resources.memory = memFlag;
			if (cpusFlag) resources.cpus = cpusFlag;
			if (pidsFlag !== undefined) resources.pidsLimit = pidsFlag;
			if (swapFlag !== undefined) resources.swap = swapFlag;

			let actualName = sandboxName;
			if (!isReattached) {
				actualName = await runtime.run({
					name: sandboxName,
					image,
					hostCwd: localCwd,
					allowNetwork,
					extraMounts: skillMounts.length ? skillMounts : undefined,
					resources,
					cacheVolume,
				});
			}

			setSbx({
				runtime,
				name: actualName,
				hostCwd: localCwd,
				keep: keep || persist,
				mounts: skillMounts,
				allowedExternalPrefixes,
				resources,
				imageRef: image,
				config: cfg,
				isReusable,
				isReattached,
			});

			const cleanup = () => {
				const s = getSbx();
				if (!s || s.keep) return;
				try {
					s.runtime.stop(s.name);
					s.runtime.remove(s.name);
				} catch { /* ignore */ }
				clearSbx();
			};
			process.once("exit", cleanup);
			process.once("SIGINT", () => { cleanup(); process.exit(130); });
			process.once("SIGTERM", () => { cleanup(); process.exit(143); });

			const ok = (await execCapture(getSbx()!, "id -un && pwd", 10000)).toString().trim();

			const resParts: string[] = [
				`size=${sizeTier}`,
				`mem=${resources.memory}`,
				`cpu=${resources.cpus}`,
				`swap=${resources.swap}`,
			];
			if (resources.pidsLimit !== undefined) resParts.push(`pids=${resources.pidsLimit}`);
			const resStr = ` (${resParts.join(", ")})`;

			const statusPrefix = isReattached ? "Reattached" : "Sandbox up";
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
				].filter(Boolean).join("\n"),
				"info",
			);
		} catch (e) {
			clearSbx();
			ctx.ui.notify(`Sandbox init failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		const sbx = getSbx();
		if (!sbx) return;
		if (!sbx.keep) {
			sbx.runtime.stop(sbx.name);
			sbx.runtime.remove(sbx.name);
		}
		clearSbx();
	});

	pi.registerCommand("sandbox", {
		description: "Sandbox management. Subcommands: status, start, stop, keep, exec, doctor, config, allow, paths, tiers",
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
							"Available: status, start, stop, keep, exec, doctor, config, allow, paths, tiers",
						].join("\n"),
						"info",
					);
			}
		},
	});
}
