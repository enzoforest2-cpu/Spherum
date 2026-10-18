import type { ToolDef } from "../../xodos/tools";
import { CALENDAR_TOOLS } from "./calendar";
import { DRIVE_TOOLS } from "./drive";
import { GITHUB_TOOLS } from "./github";
import { GMAIL_TOOLS } from "./gmail";
import { NOTION_TOOLS } from "./notion";
import { SLACK_TOOLS } from "./slack";

/** Ferramentas dos apps do passo "Limites" (Gmail, Agenda, Drive, Slack, Notion e GitHub). */
export const CONNECTOR_TOOLS: readonly ToolDef[] = [
  ...GMAIL_TOOLS,
  ...CALENDAR_TOOLS,
  ...DRIVE_TOOLS,
  ...SLACK_TOOLS,
  ...NOTION_TOOLS,
  ...GITHUB_TOOLS,
];
