import type { McpModule } from "./module.js";
import { filesystemCall, filesystemTools, ownsFilesystemTool } from "../filesystem.js";
import { commandCall, commandTools, ownsCommandTool } from "./commands.js";

export const systemModule: McpModule = {
  name: "system",
  tools: () => [...filesystemTools, ...commandTools],
  owns: (name) => ownsFilesystemTool(name) || ownsCommandTool(name),
  call: async (name, args) => ownsFilesystemTool(name) ? filesystemCall(name, args) : commandCall(name, args)
};
