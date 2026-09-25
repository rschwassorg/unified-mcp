import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import type { ToolDefinition } from "./module.js";

type CommandSpec={executable:string;allowedArgs?:string[];timeoutMs?:number};
type Config={commands?:Record<string,CommandSpec>};
const MAX_OUTPUT=1024*1024;

export const commandTools:ToolDefinition[]=[
 tool("cmd_list","List commands approved for execution."),
 tool("cmd_run","Run one approved executable directly without a shell.",{
  command:{type:"string"},args:{type:"array",items:{type:"string"},default:[]},
  cwd:{type:"string",description:"Optional absolute working directory under an approved filesystem root."},
  timeoutMs:{type:"integer",minimum:1,maximum:600000}
 },["command"])
];
export const ownsCommandTool=(name:string)=>commandTools.some(t=>t.name===name);

export async function commandCall(name:string,input:Record<string,unknown>){
 const config=await loadConfig();
 if(name==="cmd_list") return {commands:Object.entries(config.commands||{}).map(([name,s])=>({name,executable:s.executable,allowedArgs:s.allowedArgs||["*"],timeoutMs:s.timeoutMs||60000}))};
 if(name!=="cmd_run") throw new Error(`Unknown command tool: ${name}`);
 const command=required(input.command,"command"), spec=config.commands?.[command];
 if(!spec) throw new Error(`Command is not approved: ${command}`);
 const args=Array.isArray(input.args)?input.args.map(String):[];
 validateArgs(command,args,spec.allowedArgs||["*"]);
 const cwd=input.cwd?await validateCwd(String(input.cwd)):undefined;
 const requested=input.timeoutMs===undefined?undefined:Number(input.timeoutMs);
 const ceiling=spec.timeoutMs||60000;
 const timeoutMs=Math.min(requested&&Number.isInteger(requested)?requested:ceiling,ceiling,600000);
 return run(spec.executable,args,cwd,timeoutMs);
}

function run(executable:string,args:string[],cwd:string|undefined,timeoutMs:number){
 return new Promise((done,reject)=>{
  const child=spawn(executable,args,{cwd,shell:false,windowsHide:true,env:process.env});
  let stdout="",stderr="",truncated=false;
  const add=(current:string,chunk:Buffer)=>{const next=current+chunk.toString("utf8");if(Buffer.byteLength(next)<=MAX_OUTPUT)return next;truncated=true;return Buffer.from(next).subarray(0,MAX_OUTPUT).toString("utf8")};
  child.stdout?.on("data",(c:Buffer)=>stdout=add(stdout,c)); child.stderr?.on("data",(c:Buffer)=>stderr=add(stderr,c));
  const timer=setTimeout(()=>child.kill(),timeoutMs);
  child.once("error",e=>{clearTimeout(timer);reject(e)});
  child.once("close",(exitCode,signal)=>{clearTimeout(timer);done({executable,args,cwd:cwd||process.cwd(),exitCode,signal,stdout,stderr,truncated})});
 });
}

function validateArgs(command:string,args:string[],patterns:string[]){
 if(patterns.includes("*"))return;
 for(const arg of args) if(!patterns.some(p=>p===arg||(p.endsWith("*")&&arg.startsWith(p.slice(0,-1))))) throw new Error(`Argument is not approved for ${command}: ${arg}`);
}
async function validateCwd(input:string){
 if(!isAbsolute(input)&&!win32.isAbsolute(input))throw new Error("cwd must be absolute");
 const path=fsConfigPath(); if(!path)throw new Error("Filesystem roots are not configured");
 const config=JSON.parse((await readFile(path,"utf8")).replace(/^\uFEFF/,"")) as {roots?:Record<string,{path:string}>};
 const candidate=resolve(input);
 const ok=Object.values(config.roots||{}).some(r=>{const base=resolve(r.path),rel=relative(base,candidate);return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel))});
 if(!ok)throw new Error("cwd is outside configured filesystem roots"); return candidate;
}
async function loadConfig():Promise<Config>{
 const path=process.env.UNIFIED_MCP_COMMANDS_CONFIG||(process.env.ProgramData?resolve(process.env.ProgramData,"UnifiedMcp","commands.json"):"");
 if(!path)return {commands:{}};
 try{return JSON.parse((await readFile(path,"utf8")).replace(/^\uFEFF/,"")) as Config}catch(e){throw new Error(`Unable to read command config at ${path}: ${e instanceof Error?e.message:String(e)}`)}
}
function fsConfigPath(){return process.env.UNIFIED_MCP_FS_CONFIG||(process.env.ProgramData?resolve(process.env.ProgramData,"UnifiedMcp","filesystem-roots.json"):"")}
function required(v:unknown,n:string){if(typeof v!=="string"||!v)throw new Error(`${n} must be a non-empty string`);return v}
function tool(name:string,description:string,properties:Record<string,unknown>={},required:string[]=[]):ToolDefinition{return{name,title:name,description,inputSchema:{type:"object",additionalProperties:false,properties,required}}}
