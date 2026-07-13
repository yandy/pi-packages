import { getSubagentsService, type SubagentsService } from "@yandy0725/pi-subagents";
import type { WorkspaceProvider } from "@yandy0725/pi-subagents";
import { access } from "node:fs/promises";

export function buildDreamTask(memoryDir: string, maxLines: number): string {
  return `You are a memory consolidation agent. Your job: read all memory files in the given directory, consolidate entries within each topic (merge duplicates, resolve contradictions, update outdated info), and rebuild the MEMORY.md index to be concise and accurate.

Task: Consolidate the memory files under ${memoryDir}. Read every .md file (including MEMORY.md), then:
1. Deduplicate entries within each topic that say the same thing.
2. Merge contradictory or overlapping entries into one accurate entry.
3. Update outdated information.
4. Move entries to more appropriate topic files when needed.
5. Rebuild MEMORY.md (max ${maxLines} lines): - [Entry Title](topic.md) per entry you deem valuable (not necessarily every entry). Entries use ## Entry Title format.

Rules:
- Each topic file contains entries as \`## Entry Title\` blocks.
- Only modify files under the given directory. Never touch anything else.
- Rebuild MEMORY.md index: list entries you deem valuable. Each line: - [Entry Title](topic.md). Accuracy matters more than completeness.
- CRITICAL for entry titles: Only the MEMORY.md index is injected into future coding sessions (topic file content is NOT seen by the coding agent). Rewrite every entry title to be self-contained and descriptive — like "always use uv instead of pip for Python" instead of just "python tools". The title alone must tell the model what the entry is about.
- When done, output a concise summary of changes (merged N, removed N, moved N, updated N).`;
}

export interface RunDreamOpts {
  model: string;
  memoryDir: string;
  signal?: AbortSignal;
  events?: { on(channel: string, handler: (data: any) => void): () => void };
  service?: SubagentsService;
}

export async function runDream(opts: RunDreamOpts): Promise<string> {
  const service = opts.service ?? getSubagentsService();
  if (!service) throw new Error("pi-subagents not available — install @yandy0725/pi-subagents");

  const events = opts.events;
  if (!events) throw new Error("events required for dream — pass pi.events");

  const model = opts.model === "auto" ? undefined : opts.model;
  const task = buildDreamTask(opts.memoryDir, 200);

  // Register workspace provider so the subagent runs in memoryDir
  const provider: WorkspaceProvider = {
    async prepare(_ctx) {
      await access(opts.memoryDir).catch(() => {
        throw new Error(`Memory directory not found: ${opts.memoryDir}`);
      });
      return {
        cwd: opts.memoryDir,
        dispose: () => undefined,
      };
    },
  };
  const unregister = service.registerWorkspaceProvider(provider);

  // Spawn the dream subagent
  const agentId = service.spawn(
    "general-purpose",
    task,
    model ? { model } : {},
  );

  // Wait for completion/failure via events
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        unsubCompleted();
        unsubFailed();
        unregister();
        opts.signal?.removeEventListener("abort", onAbort);
      };

      const onCompleted = (data: { id: string }) => {
        if (data.id !== agentId) return;
        cleanup();
        const record = service.getRecord(agentId);
        resolve(record?.result ?? "Dream completed.");
      };

      const onFailed = (data: { id: string; error?: string }) => {
        if (data.id !== agentId) return;
        cleanup();
        reject(new Error(data.error ?? "Dream agent failed"));
      };

      const onAbort = () => {
        service.abort(agentId);
      };

      const unsubCompleted = events.on("subagents:completed", onCompleted);
      const unsubFailed = events.on("subagents:failed", onFailed);

      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  } catch (e) {
    // Ensure cleanup on rejection
    unregister();
    throw e;
  }
}
