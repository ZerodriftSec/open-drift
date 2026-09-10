import { cp, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { WorkflowSkillSelection } from "../workflow";

export type CopyAuditSkillsOptions = {
  targetPath: string;
  agentConfigDirName: ".agents" | ".claude" | ".gemini";
  skills?: WorkflowSkillSelection;
};

export async function copyAuditSkills({
  targetPath,
  agentConfigDirName,
  skills,
}: CopyAuditSkillsOptions): Promise<void> {
  const sourceDir = await auditSkillsSourceDirectory();
  const targetDir = await resolveTargetDirectory(targetPath);
  const destinationDir = path.join(
    /*turbopackIgnore: true*/ targetDir,
    agentConfigDirName,
    "skills",
  );

  if (skills === undefined) {
    await removeUnselectedProjectSkills(sourceDir, destinationDir, []);
    return;
  }

  const copiedSkillNames = await resolveSkillNames(sourceDir, {
    skillNamePrefixes: skills?.prefixes ? [...skills.prefixes] : undefined,
    skillNames: skills?.names ? [...skills.names] : undefined,
  });

  await mkdir(destinationDir, { recursive: true });
  await removeUnselectedProjectSkills(
    sourceDir,
    destinationDir,
    copiedSkillNames,
  );
  for (const skillName of copiedSkillNames) {
    await cp(
      path.join(/*turbopackIgnore: true*/ sourceDir, skillName),
      path.join(destinationDir, skillName),
      { recursive: true, force: true },
    );
  }
}

export async function listAuditSkillNames() {
  const sourceDir = await auditSkillsSourceDirectory();
  return listSourceSkillNames(sourceDir);
}

async function auditSkillsSourceDirectory() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(process.cwd(), "skills"),
    path.join(moduleDirectory, "skills"),
    path.join(moduleDirectory, "..", "..", "..", "skills"),
  ];

  for (const directory of new Set(candidates)) {
    if (await isDirectory(directory)) return directory;
  }
  throw new Error("Audit skills source directory does not exist.");
}

async function resolveSkillNames(
  sourceDir: string,
  {
    skillNamePrefixes,
    skillNames,
  }: {
    skillNamePrefixes?: string[];
    skillNames?: string[];
  },
): Promise<string[]> {
  if (!skillNames && !skillNamePrefixes) {
    return listSourceSkillNames(sourceDir);
  }

  const sourceSkillNames = await listSourceSkillNames(sourceDir);
  const prefixedSkillNames = resolveSkillNamesByPrefix(
    sourceSkillNames,
    skillNamePrefixes,
  );
  const dedupedSkillNames = [
    ...new Set([
      ...(skillNames ?? []).map((skillName) => skillName.trim()),
      ...prefixedSkillNames,
    ]),
  ]
    .filter(Boolean)
    .sort();

  if (dedupedSkillNames.length === 0) {
    throw new Error("At least one audit skill name must be provided");
  }

  for (const skillName of dedupedSkillNames) {
    if (!sourceSkillNames.includes(skillName)) {
      throw new Error(`Audit skill does not exist: ${skillName}`);
    }
  }

  return dedupedSkillNames;
}

function resolveSkillNamesByPrefix(
  sourceSkillNames: string[],
  skillNamePrefixes: string[] | undefined,
) {
  if (!skillNamePrefixes) {
    return [];
  }

  const selectedSkillNames: string[] = [];

  for (const prefix of skillNamePrefixes
    .map((value) => value.trim())
    .filter(Boolean)) {
    const matchingSkillNames = sourceSkillNames.filter((skillName) =>
      skillName.startsWith(prefix),
    );

    if (matchingSkillNames.length === 0) {
      throw new Error(`No audit skills match prefix: ${prefix}`);
    }

    selectedSkillNames.push(...matchingSkillNames);
  }

  return selectedSkillNames;
}

async function listSourceSkillNames(sourceDir: string) {
  const entries = await readdir(/*turbopackIgnore: true*/ sourceDir, {
    withFileTypes: true,
  });
  const skillNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const existingSkillNames = await Promise.all(
    skillNames.map(async (directoryName) => {
      const skillFile = path.join(sourceDir, directoryName, "SKILL.md");
      if (!(await pathExists(skillFile))) return undefined;

      const content = (await Reflect.apply(readFile, undefined, [
        skillFile,
        "utf8",
      ])) as string;
      const declaredName = declaredAuditSkillName(content, skillFile);
      if (declaredName !== directoryName) {
        throw new Error(
          `Audit Skill directory ${directoryName} does not match its SKILL.md name: ${declaredName}`,
        );
      }
      return declaredName;
    }),
  );

  return existingSkillNames
    .filter((skillName): skillName is string => skillName !== undefined)
    .sort();
}

function declaredAuditSkillName(content: string, skillFile: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) {
    throw new Error(`Audit Skill is missing YAML frontmatter: ${skillFile}`);
  }

  let metadata: unknown;
  try {
    metadata = parseYaml(frontmatter[1]!);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Audit Skill frontmatter ${skillFile}: ${message}`);
  }
  const name =
    typeof metadata === "object" &&
    metadata !== null &&
    "name" in metadata &&
    typeof metadata.name === "string"
      ? metadata.name.trim()
      : "";
  if (!name) {
    throw new Error(`Audit Skill name must not be empty: ${skillFile}`);
  }
  return name;
}

async function removeUnselectedProjectSkills(
  sourceDir: string,
  destinationDir: string,
  selectedSkillNames: string[],
): Promise<void> {
  if (!(await pathExists(destinationDir))) {
    return;
  }

  const selectedSkillNameSet = new Set(selectedSkillNames);

  for (const skillName of await listSourceSkillNames(sourceDir)) {
    if (selectedSkillNameSet.has(skillName)) {
      continue;
    }

    await rm(path.join(/*turbopackIgnore: true*/ destinationDir, skillName), {
      force: true,
      recursive: true,
    });
  }
}

async function resolveTargetDirectory(targetPath: string) {
  const resolvedTargetPath = path.resolve(/*turbopackIgnore: true*/ targetPath);

  let targetStat;
  try {
    targetStat = await lstat(/*turbopackIgnore: true*/ resolvedTargetPath);
  } catch {
    throw new Error(`Target path does not exist: ${resolvedTargetPath}`);
  }

  return targetStat.isDirectory()
    ? resolvedTargetPath
    : path.dirname(resolvedTargetPath);
}

async function pathExists(filePath: string) {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(filePath: string) {
  try {
    return (await lstat(filePath)).isDirectory();
  } catch {
    return false;
  }
}
