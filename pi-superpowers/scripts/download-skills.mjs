import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CACHE_DIR = "/tmp/pi-superpowers-cache";

function readConfig() {
  const raw = readFileSync(resolve(ROOT, "skills.config.json"), "utf-8");
  const config = JSON.parse(raw);
  if (!config.repo || !config.ref || !Array.isArray(config.skills)) {
    throw new Error("Invalid skills.config.json: must have repo, ref, and skills array");
  }
  return config;
}

function cloneOrPull(repo, ref) {
  if (existsSync(CACHE_DIR)) {
    console.log(`[cache] Pulling latest in ${CACHE_DIR}...`);
    execSync(`cd ${CACHE_DIR} && git fetch && git checkout ${ref} && git pull`, { stdio: "inherit" });
  } else {
    console.log(`[cache] Cloning ${repo} (ref: ${ref})...`);
    execSync(`git clone --branch ${ref} ${repo} ${CACHE_DIR}`, { stdio: "inherit" });
  }
}

function transformSkill(name, cacheSkillsDir) {
  const src = resolve(cacheSkillsDir, name);
  const dest = resolve(ROOT, "skills", `superpowers-${name}`);

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
      content = content.replace(/^name:\s*(.+)$/m, `name: superpowers-${name}`);
    }

    // Replace cross-references in body: superpowers:<any-skill> → superpowers-<any-skill>
    content = content.replace(/superpowers:([a-z][a-z0-9-]*)/g, "superpowers-$1");

    writeFileSync(mdPath, content, "utf-8");
  }

  console.log(`[done] ${name} → superpowers-${name}`);
}

function cleanStale(configSkills) {
  const skillsDir = resolve(ROOT, "skills");
  if (!existsSync(skillsDir)) return;

  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (!dirName.startsWith("superpowers-")) continue;

    const originalName = dirName.slice("superpowers-".length);
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

  // Clone or pull
  cloneOrPull(repo, ref);

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

  // Clean stale
  cleanStale(skills);

  console.log(`\nDone! ${skills.length} skills processed.`);
}

main();
