import type { McpModule, ToolDefinition } from "./module.js";

type Deps = {
  listSystems: () => unknown;
  callSystem: (systemId:string, method:string, args:Record<string,unknown>) => Promise<unknown>;
};

const fsNames=["fs_roots_list","fs_list","fs_stat","fs_read_text","fs_write_text","fs_replace_text","fs_mkdir","fs_move"];
const cmdNames=["cmd_list","cmd_run"];
const tools:ToolDefinition[]=[
 tool("systems_list","List authenticated systems currently connected to Unified MCP."),
 ...fsNames.map(name=>tool(name,`Run ${name} on a connected system.`,{
   system:{type:"string",description:"Connected system ID or server-side name."},
   root:{type:"string"},path:{type:"string"},sourcePath:{type:"string"},destinationPath:{type:"string"},
   content:{type:"string"},oldText:{type:"string"},newText:{type:"string"},expectedOccurrences:{type:"integer"},
   expectedSha256:{type:"string"},createParents:{type:"boolean"},recursive:{type:"boolean"},limit:{type:"integer"},maxBytes:{type:"integer"}
 },["system"])),
 ...cmdNames.map(name=>tool(name,`Run ${name} on a connected system.`,{
   system:{type:"string",description:"Connected system ID or server-side name."},
   command:{type:"string"},args:{type:"array",items:{type:"string"}},cwd:{type:"string"},timeoutMs:{type:"integer"}
 },["system"]))
];
const names=new Set(tools.map(t=>t.name));

export function createSystemModule(deps:Deps):McpModule{
 return {name:"system",tools:()=>tools,owns:name=>names.has(name),call:async(name,args)=>{
   if(name==="systems_list") return deps.listSystems();
   const system=String(args.system||""); if(!system) throw new Error("system is required");
   const forwarded={...args}; delete forwarded.system;
   return deps.callSystem(system,name,forwarded);
 }};
}
function tool(name:string,description:string,properties:Record<string,unknown>={},required:string[]=[]):ToolDefinition{
 return {name,title:name,description,inputSchema:{type:"object",additionalProperties:false,properties,required}};
}
