// Minimal stand-in for @earendil-works/pi-coding-agent when running tests outside pi.
import { homedir } from "node:os";
import { join } from "node:path";
export const CONFIG_DIR_NAME = ".pi";
export const getAgentDir = () => join(homedir(), ".pi", "agent");
