import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

type SystemConnection={id:string;name:string;platform:string;socket:WebSocket;connectedAt:string;lastSeenAt:string};
type Pending={systemId:string;resolve:(v:unknown)=>void;reject:(e:Error)=>void;timeout:NodeJS.Timeout};
const systems=new Map<string,SystemConnection>();
const aliases=new Map<string,string>();
const socketIds=new WeakMap<WebSocket,string>();
const challenges=new WeakMap<WebSocket,string>();
const pending=new Map<string,Pending>();

export const systemWss=new WebSocketServer({noServer:true});
systemWss.on("connection",socket=>{
 const challenge=randomBytes(32).toString("base64url");challenges.set(socket,challenge);
 socket.send(JSON.stringify({type:"challenge",challenge}));
 const authTimer=setTimeout(()=>socket.close(1008,"Authentication timeout"),10000);
 socket.on("message",async data=>{
  let m:any;try{m=JSON.parse(data.toString())}catch{return}
  if(m.type==="hello"&&m.role==="system"){
    (socket as any)._hello=m; return;
  }
  if(m.type==="auth"){
    const hello=(socket as any)._hello;
    if(!hello?.systemId||m.systemId!==hello.systemId||!m.signature)return socket.close(1008,"Invalid authentication");
    const ok=await verify(String(hello.systemId),challenge,String(m.signature));
    if(!ok)return socket.close(1008,"SSH signature rejected");
    clearTimeout(authTimer);
    const id=String(hello.systemId),name=String(hello.systemName||id);
    const old=systems.get(id);if(old&&old.socket!==socket)old.socket.close(1000,"System reconnected");
    const now=new Date().toISOString();
    systems.set(id,{id,name,platform:String(hello.platform||"unknown"),socket,connectedAt:now,lastSeenAt:now});
    aliases.set(name,id);socketIds.set(socket,id);socket.send(JSON.stringify({type:"authenticated",systemId:id}));
    return;
  }
  if(m.type==="response"&&m.id){
    const p=pending.get(String(m.id));if(!p)return;clearTimeout(p.timeout);pending.delete(String(m.id));
    m.ok?p.resolve(m.result):p.reject(new Error(m.error||"System request failed"));
  }
 });
 socket.on("close",()=>{clearTimeout(authTimer);const id=socketIds.get(socket);if(id&&systems.get(id)?.socket===socket)systems.delete(id)});
});

export function listSystems(){return {systems:Array.from(systems.values(),s=>({id:s.id,name:s.name,platform:s.platform,connectedAt:s.connectedAt,lastSeenAt:s.lastSeenAt}))}}
export async function callSystem(idOrName:string,method:string,params:Record<string,unknown>){
 const id=systems.has(idOrName)?idOrName:aliases.get(idOrName);const system=id?systems.get(id):undefined;
 if(!system||system.socket.readyState!==WebSocket.OPEN)throw new Error(`System is not connected: ${idOrName}`);
 const idReq=randomUUID();const result=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(idReq);reject(new Error(`Timed out waiting for ${idOrName}`))},60000);pending.set(idReq,{systemId:system.id,resolve,reject,timeout})});
 system.socket.send(JSON.stringify({type:"request",id:idReq,method,params}));return result;
}
export function shutdownSystems(){for(const p of pending.values()){clearTimeout(p.timeout);p.reject(new Error("Server shutting down"))}pending.clear();for(const s of systems.values())s.socket.close();systems.clear();systemWss.close()}

async function verify(identity:string,challenge:string,signature:string){
 const allowed=process.env.UNIFIED_MCP_AUTHORIZED_SIGNERS||"/etc/unified-mcp/authorized_signers";
 const dir=await mkdtemp(join(tmpdir(),"unified-mcp-verify-"));const sig=join(dir,"signature");
 try{
  await writeFile(sig,signature,"utf8");
  return await new Promise<boolean>(done=>{
   const p=spawn("ssh-keygen",["-Y","verify","-f",allowed,"-I",identity,"-n","unified-mcp","-s",sig],{stdio:["pipe","ignore","ignore"]});
   p.stdin.end(challenge);p.on("error",()=>done(false));p.on("close",c=>done(c===0));
  });
 }finally{await rm(dir,{recursive:true,force:true})}
}
