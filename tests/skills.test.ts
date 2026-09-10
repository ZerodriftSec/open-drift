import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { copyAuditSkills } from "@/audit/agent/skills";

test("does not inject audit skills when a Workflow does not select skills", async () => {
  const targetPath = await mkdtemp(
    path.join(tmpdir(), "zerodrift-no-workflow-skills-"),
  );
  const skillsPath = path.join(targetPath, ".agents", "skills");

  try {
    await copyAuditSkills({ agentConfigDirName: ".agents", targetPath });

    await expect(access(skillsPath)).rejects.toThrow();
  } finally {
    await rm(targetPath, { force: true, recursive: true });
  }
});

test("removes previously injected audit skills when the next Stage selects none", async () => {
  const targetPath = await mkdtemp(
    path.join(tmpdir(), "zerodrift-clear-workflow-skills-"),
  );
  const selectedSkillPath = path.join(
    targetPath,
    ".agents",
    "skills",
    "finding-format-skill",
    "SKILL.md",
  );

  try {
    await copyAuditSkills({
      agentConfigDirName: ".agents",
      skills: { names: ["finding-format-skill"] },
      targetPath,
    });
    await access(selectedSkillPath);

    await copyAuditSkills({ agentConfigDirName: ".agents", targetPath });

    await expect(access(selectedSkillPath)).rejects.toThrow();
  } finally {
    await rm(targetPath, { force: true, recursive: true });
  }
});
