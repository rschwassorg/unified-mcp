export type ToolDefinition = { name:string; title?:string; description:string; inputSchema:Record<string,unknown> };
export type McpModule = {
  name:string;
  tools:()=>Promise<ToolDefinition[]>|ToolDefinition[];
  owns:(toolName:string)=>boolean;
  call:(toolName:string,args:Record<string,unknown>)=>Promise<unknown>;
};
