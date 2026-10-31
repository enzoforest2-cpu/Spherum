import type { ToolDef } from "../xodos/tools";
import { BROWSER_TOOLS } from "./tools/browser";
import { CONTROL_TOOLS } from "./tools/control";
import { FILES_TOOLS } from "./tools/files";
import { TERMINAL_TOOLS } from "./tools/terminal";

/** Ferramentas do computador na nuvem (só aparecem para xodós com o computador ligado). */
export const COMPUTER_TOOLS: readonly ToolDef[] = [...BROWSER_TOOLS, ...FILES_TOOLS, ...TERMINAL_TOOLS, ...CONTROL_TOOLS];
