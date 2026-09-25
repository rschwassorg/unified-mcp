import type { McpModule, ToolDefinition } from "./module.js";
type Deps={status:()=>unknown;protocol:(args:Record<string,unknown>)=>unknown;callChrome:(method:string,args:Record<string,unknown>)=>Promise<unknown>};
const methods:Record<string,string>={
 chrome_tabs_list:"tabs.list",chrome_tab_open:"tabs.open",chrome_tab_activate:"tabs.activate",chrome_tab_close:"tabs.close",
 chrome_page_info:"page.info",chrome_page_text:"page.text",chrome_page_click:"page.click",chrome_page_type:"page.type",chrome_page_script:"page.script",
 chrome_cdp_targets:"cdp.targets",chrome_cdp_attached:"cdp.attached",chrome_cdp_attach:"cdp.attach",chrome_cdp_detach:"cdp.detach",
 chrome_cdp_send:"cdp.send",chrome_cdp_call:"cdp.send",chrome_cdp_events:"cdp.events"
};
export function createChromeCdpModule(deps:Deps):McpModule{
 const tools:ToolDefinition[]=[
  tool("chrome_browsers_list","List connected Chrome browser clients."),tool("chrome_status","Check Chrome connection status."),
  tool("chrome_tabs_list","List open Chrome tabs."),tool("chrome_tab_open","Open Chrome tab.",{url:{type:"string"},active:{type:"boolean",default:true}},["url"]),
  tool("chrome_tab_activate","Activate Chrome tab.",{tabId:{type:"integer"}},["tabId"]),tool("chrome_tab_close","Close Chrome tab.",{tabId:{type:"integer"}},["tabId"]),
  tool("chrome_page_info","Get page metadata.",{tabId:{type:"integer"}}),tool("chrome_page_text","Get visible page text.",{tabId:{type:"integer"}}),
  tool("chrome_page_click","Click a CSS selector.",{selector:{type:"string"},tabId:{type:"integer"}},["selector"]),
  tool("chrome_page_type","Type into an input.",{selector:{type:"string"},text:{type:"string"},clear:{type:"boolean",default:true},tabId:{type:"integer"}},["selector","text"]),
  tool("chrome_page_script","Run JavaScript in a page.",{script:{type:"string"},tabId:{type:"integer"}},["script"]),
  tool("chrome_cdp_targets","List CDP targets."),tool("chrome_cdp_protocol","Read bundled CDP metadata.",{domain:{type:"string"},includeDetails:{type:"boolean",default:false},includeExperimental:{type:"boolean",default:true},includeDeprecated:{type:"boolean",default:true}}),
  tool("chrome_cdp_attached","List attached CDP targets."),tool("chrome_cdp_attach","Attach CDP.",{tabId:{type:"integer"},targetId:{type:"string"},extensionId:{type:"string"},protocolVersion:{type:"string",default:"1.3"}}),
  tool("chrome_cdp_detach","Detach CDP.",{tabId:{type:"integer"},targetId:{type:"string"},extensionId:{type:"string"}}),
  tool("chrome_cdp_send","Send any CDP command.",{command:{type:"string"},params:{type:"object",default:{}},tabId:{type:"integer"},targetId:{type:"string"},extensionId:{type:"string"},autoAttach:{type:"boolean",default:true},detach:{type:"boolean",default:false}},["command"]),
  tool("chrome_cdp_call","Send CDP command with auto-attach.",{command:{type:"string"},params:{type:"object",default:{}},tabId:{type:"integer"},targetId:{type:"string"},extensionId:{type:"string"},detach:{type:"boolean",default:false}},["command"]),
  tool("chrome_cdp_events","Poll buffered CDP events.",{limit:{type:"integer",default:100},clear:{type:"boolean",default:false},method:{type:"string"},tabId:{type:"integer"},targetId:{type:"string"},extensionId:{type:"string"}})
 ];
 const names=new Set(tools.map(t=>t.name));
 return{name:"chrome-cdp",tools:()=>tools,owns:n=>names.has(n),call:async(name,args)=>{
  if(name==="chrome_status"||name==="chrome_browsers_list")return deps.status();
  if(name==="chrome_cdp_protocol")return deps.protocol(args);
  const method=methods[name];if(!method)throw new Error(`Unknown Chrome/CDP tool: ${name}`);
  const defaults=name==="chrome_page_type"?{clear:true}:name==="chrome_cdp_attach"?{protocolVersion:"1.3"}:(name==="chrome_cdp_send"||name==="chrome_cdp_call")?{params:{},autoAttach:true,protocolVersion:"1.3"}:{};
  return deps.callChrome(method,{...defaults,...args});
 }};
}
function tool(name:string,description:string,properties:Record<string,unknown>={},required:string[]=[]):ToolDefinition{return{name,title:name,description,inputSchema:{type:"object",title:`${name}_input`,properties:{browserId:{type:"string",description:"Connected browser ID; required with multiple browsers."},...properties},required}}}
