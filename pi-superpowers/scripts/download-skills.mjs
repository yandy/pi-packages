import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_DIR = "/tmp/pi-superpowers-cache";
const SKILLS_REF_FILE = resolve(ROOT, ".skills-ref");

function readConfig() {
  const raw = readFileSync(resolve(ROOT, "skills.config.json"), "utf-8");
  const config = JSON.parse(raw);
  if (!config.repo || !config.ref || !Array.isArray(config.skills)) {
    throw new Error("Invalid skills.config.json: must have repo, ref, and skills array");
  }
  return config;
}

function cloneOrPull(repo, ref) {
  // Validate existing cache: must have .git directory
  if (existsSync(CACHE_DIR)) {
    if (!existsSync(resolve(CACHE_DIR, ".git"))) {
      console.log(`[cache] Corrupted cache (no .git), removing and re-cloning...`);
      rmSync(CACHE_DIR, { recursive: true, force: true });
    }
  }

  if (!existsSync(CACHE_DIR)) {
    console.log(`[cache] Cloning ${repo} (ref: ${ref})...`);
    execSync(`git clone --branch ${ref} ${repo} ${CACHE_DIR}`, { stdio: "inherit" });
    return;
  }

  // Cache exists — fetch updates and check if already at target
  console.log(`[cache] Fetching updates...`);
  execSync(`cd ${CACHE_DIR} && git fetch origin --tags`, { stdio: "inherit" });

  // Resolve target ref to commit hash (handle both tag and branch)
  const isTag = execSync(`cd ${CACHE_DIR} && git tag -l "${ref}"`, { encoding: "utf-8" }).trim();
  let targetHash;
  try {
    targetHash = isTag
      ? execSync(`cd ${CACHE_DIR} && git rev-parse "refs/tags/${ref}^{}"`, { encoding: "utf-8" }).trim()
      : execSync(`cd ${CACHE_DIR} && git rev-parse "origin/${ref}"`, { encoding: "utf-8" }).trim();
  } catch {
    console.error(`[error] Cannot resolve ref "${ref}" (tag=${!!isTag}). Is the ref valid?`);
    throw new Error(`Unresolvable ref: ${ref}`);
  }

  const currentHash = execSync(`cd ${CACHE_DIR} && git rev-parse HEAD`, { encoding: "utf-8" }).trim();

  if (currentHash === targetHash) {
    console.log(`[cache] Already at ${ref} (${targetHash.slice(0, 7)}), up to date.`);
    return;
  }

  // Need to switch refs — clean any local dirty state first
  console.log(`[cache] Switching to ${ref} (${targetHash.slice(0, 7)})...`);
  execSync(`cd ${CACHE_DIR} && git reset --hard HEAD && git clean -fd`, { stdio: "inherit" });

  if (isTag) {
    execSync(`cd ${CACHE_DIR} && git checkout ${ref}`, { stdio: "inherit" });
  } else {
    execSync(`cd ${CACHE_DIR} && git checkout ${ref} && git pull --ff-only`, { stdio: "inherit" });
  }
}

function transformSkill(name, cacheSkillsDir) {
  const src = resolve(cacheSkillsDir, name);
  const dest = resolve(ROOT, "skills", `supo-${name}`);

  // Copy entire directory
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, { recursive: true });

  // Transform SKILL.md
  const skillMdPath = resolve(dest, "SKILL.md");
  if (!existsSync(skillMdPath)) {
    console.warn(`[warn] No SKILL.md found in ${name}, skipping`);
    return;
  }

  // Transform all .md files in the skill directory
  const mdFiles = readdirSync(dest, { recursive: true })
    .filter(f => f.endsWith('.md'));

  for (const relPath of mdFiles) {
    const mdPath = resolve(dest, relPath);
    let content = readFileSync(mdPath, "utf-8");

    if (relPath === 'SKILL.md') {
      // Replace frontmatter name only in SKILL.md
      // Parse frontmatter delimited by ---, only replace name within it
      const parts = content.split('---');
      if (parts.length >= 3) {
        parts[1] = parts[1].replace(/^name:\s*(.+)$/m, `name: supo-${name}`);
        content = parts.join('---');
      }
    }

    // Replace cross-references in body: superpowers:<any-skill> → supo-<any-skill>
    content = content.replace(/superpowers:([a-z][a-z0-9-]*)/g, "supo-$1");

    writeFileSync(mdPath, content, "utf-8");
  }

  console.log(`[done] ${name} → supo-${name}`);
}

function cleanStale(configSkills) {
  const skillsDir = resolve(ROOT, "skills");
  if (!existsSync(skillsDir)) return;

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (!dirName.startsWith("supo-")) continue;

    const originalName = dirName.slice("supo-".length);
    if (!configSkills.includes(originalName)) {
      console.log(`[clean] Removing stale skill: ${dirName}`);
      rmSync(resolve(skillsDir, dirName), { recursive: true, force: true });
    }
  }
}

function main() {
  const config = readConfig();
  const { repo, ref, skills } = config;

  // Ensure directories exist
  mkdirSync(resolve(ROOT, "skills"), { recursive: true });
  mkdirSync(resolve(ROOT, "prompts"), { recursive: true });

  // Clone or pull (skips git operations if already at target ref)
  cloneOrPull(repo, ref);

  // Check if skills are already up to date for this ref
  if (existsSync(SKILLS_REF_FILE)) {
    const cachedRef = readFileSync(SKILLS_REF_FILE, "utf-8").trim();
    if (cachedRef === ref) {
      const allExist = skills.every(name =>
        existsSync(resolve(ROOT, "skills", `supo-${name}`, "SKILL.md"))
      );
      if (allExist) {
        console.log(`[skills] Already up to date for ref ${ref}, skipping transform.`);
        cleanStale(skills);
        console.log(`\nDone! ${skills.length} skills (no changes needed).`);
        return;
      }
    }
  }

  // Copy and transform each skill
  const cacheSkillsDir = resolve(CACHE_DIR, "skills");
  for (const name of skills) {
    const src = resolve(cacheSkillsDir, name);
    if (!existsSync(src)) {
      console.warn(`[warn] Skill "${name}" not found in upstream, skipping`);
      continue;
    }
    transformSkill(name, cacheSkillsDir);
  }

  // Record successful ref for next run
  writeFileSync(SKILLS_REF_FILE, ref + "\n", "utf-8");

  // Clean stale
  cleanStale(skills);

  console.log(`\nDone! ${skills.length} skills processed.`);
}

main();
