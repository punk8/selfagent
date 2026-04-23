import { loadSkillsFromDir, type Skill } from "@mariozechner/pi-coding-agent";
import type { ConversationPaths } from "./types.js";

export function loadWorkspaceAndConversationSkills(
  workspaceRoot: string,
  conversationPaths: ConversationPaths
): Skill[] {
  const skills = new Map<string, Skill>();

  for (const skill of loadSkillsFromDir({ dir: `${workspaceRoot}/skills`, source: "workspace" }).skills) {
    skills.set(skill.name, skill);
  }

  for (const skill of loadSkillsFromDir({ dir: conversationPaths.skillsDir, source: "channel" }).skills) {
    skills.set(skill.name, skill);
  }

  return [...skills.values()];
}
