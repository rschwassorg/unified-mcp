import { spawn } from "node:child_process";
import { hostname, platform } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WebSocket } from "ws";
import { filesystemCall, ownsFilesystemTool } from "./filesystem.js";
import { commandCall, ownsCommandTool } from "./modules/commands.js";

const url=process.env.UNIFIED_MCP_SERVER||process.argv[2]||"ws://127.0.0.1:18766/bridge/system";
const key=process.env.UNIFIED_MCP_SSH_KEY||process.argv[3]||resolve(process.env.HOME||process.env.USERPROFILE||".",".ssh","id_ed25519");
const systemId=process.env.UNIFIED_MCP_SYSTEM_ID||hostname();
const systemName=process.env.UNIFIED_MCP_SYSTEM_NAME||hostname();
let retry=1000;

connect();
function connect(){
 const ws=new WebSocket(url);
 ws.on("open",()=>{retry=1000;ws.send(JSON.stringify({type:"hello",role:"system",systemId,systemName,platform:platform()}))});
 ws.on("message",async data=>{
   let m:any; try{m=JSON.parse(data.toString())}catch{return}
   if(m.type==="challenge"){
     try{ws.send(JSON.stringify({type:"auth",systemId,signature:await signChallenge(String(m.challenge))}))}
     catch(e){ws.send(JSON.stringify({type:"auth",systemId,error:err(e)}))}
     return;
   }
   if(m.type==="request"&&m.id){
     try{
       const args=m.params&&typeof m.params==="object"?m.params:{};
       let result;
       if(ownsFilesystemTool(m.method)) result=await filesystemCall(m.method,args);
       else if(ownsCommandTool(m.method)) result=await commandCall(m.method,args);
       else throw new Error(`Unsupported system operation: ${m.method}`);
       ws.send(JSON.stringify({type:"response",id:m.id,ok:true,result}));
     }catch(e){ws.send(JSON.stringify({type:"response",id:m.id,ok:false,error:err(e)}))}
   }
 });
 ws.on("close",()=>setTimeout(connect,retry=Math.min(retry*2,30000)));
 ws.on("error",()=>{});
}
async function signChallenge(challenge:string){
 const dir=await mkdtemp(join(tmpdir(),"unified-mcp-"));
 const file=join(dir,"challenge");
 try{
   await writeFile(file,challenge,"utf8");
   await run("ssh-keygen",["-Y","sign","-f",key,"-n","unified-mcp",file]);
   return await readFile(file+".sig","utf8");
 }finally{await rm(dir,{recursive:true,force:true})}
}
function run(cmd:string,args:string[]){return new Promise<void>((ok,no)=>{const p=spawn(cmd,args,{stdio:["ignore","ignore","pipe"]});let e="";p.stderr.on("data",d=>e+=d);p.on("error",no);p.on("close",c=>c===0?ok():no(new Error(e||`${cmd} exited ${c}`)))})}
function err(e:unknown){return e instanceof Error?e.message:String(e)}
