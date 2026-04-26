import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationPaths } from "./types.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const bundledSkillsDir = resolve(moduleDir, "..", "skills");

export function loadWorkspaceAndConversationSkills(
  workspaceRoot: string,
  conversationPaths: ConversationPaths
): Skill[] {
  const skills = new Map<string, Skill>();

  for (const skill of loadSkillsFromDir({ dir: bundledSkillsDir, source: "bundled" }).skills) {
    skills.set(skill.name, skill);
  }

  for (const skill of loadSkillsFromDir({ dir: `${workspaceRoot}/skills`, source: "workspace" }).skills) {
    skills.set(skill.name, skill);
  }

  for (const skill of loadSkillsFromDir({ dir: conversationPaths.skillsDir, source: "channel" }).skills) {
    skills.set(skill.name, skill);
  }

  return [...skills.values()];
}
