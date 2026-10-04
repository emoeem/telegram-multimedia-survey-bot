#!/usr/bin/env node
import process from "node:process";
import path from "node:path";
import { spawn } from "node:child_process";

const CONTROL_PLANE_URL=(process.env.CONTROL_PLANE_URL||"").replace(/\/+$/,"");
const TOKEN=process.env.CONTROL_PLANE_RUNNER_TOKEN||"";
const ROOT_DIR=process.cwd();
if(!CONTROL_PLANE_URL||!TOKEN) throw new Error("需要 CONTROL_PLANE_URL 和 CONTROL_PLANE_RUNNER_TOKEN");

async function api(endpoint,options={}){
  const response=await fetch(CONTROL_PLANE_URL+endpoint,{
    ...options,headers:{"Content-Type":"application/json",Authorization:"Bearer "+TOKEN,...(options.headers||{})},
  });
  const body=await response.json().catch(()=>({}));
  if(!response.ok) throw new Error("Control Plane HTTP "+response.status+": "+(body.message||body.error||"unknown"));
  return body;
}
function run(args,envOverrides={}){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[path.join(ROOT_DIR,"scripts/deploy-customer.mjs"),...args],{
      cwd:ROOT_DIR,env:{...process.env,...envOverrides},stdio:["ignore","pipe","pipe"],
    });
    let output=""; child.stdout.on("data",d=>{output+=d;}); child.stderr.on("data",d=>{output+=d;});
    child.on("error",e=>resolve({ok:false,output:String(e)}));
    child.on("close",code=>resolve({ok:code===0,output}));
  });
}
function stringValue(input,key){
  return typeof input?.[key]==="string" ? input[key].trim() : "";
}
async function once(){
  const claimed=await api("/api/control/runner/tasks/claim",{method:"POST",body:"{}"});
  const task=claimed.task;
  if(!task) return false;
  const deployment=await api("/api/control/deployments/"+task.deploymentId,{method:"GET"}).catch(()=>null);
  const workerName=deployment?.deployment?.workerName;
  if(!workerName) throw new Error("无法解析 deployment #"+task.deploymentId+" 的 Worker 名称");
  const deploymentDir=path.join(ROOT_DIR,"customer-deployments",workerName);
  let result;
  if(task.type==="deploy"){
    const input=claimed.input;
    if(!input){
      await api("/api/control/runner/tasks/"+task.id+"/result",{method:"POST",body:JSON.stringify({status:"failed",errorMessage:"部署任务缺少安全配置"})});
      return true;
    }
    const args=[
      "--customer-name",stringValue(input,"customerName"),
      "--bot-token",stringValue(input,"botToken"),
      "--admin-id",stringValue(input,"adminIds"),
      "--license-key",stringValue(input,"licenseKey"),
      "--license-server-url",stringValue(input,"licenseServerUrl"),
      "--worker-name",stringValue(input,"workerName")||workerName,
      "--installation-id",stringValue(input,"installationId"),
      "--deployment-dir",deploymentDir,
    ];
    const accountId=stringValue(input,"accountId");
    const apiToken=stringValue(input,"apiToken");
    const webhookSecret=stringValue(input,"webhookSecret");
    if(accountId) args.push("--account-id",accountId);
    if(apiToken) args.push("--api-token",apiToken);
    if(webhookSecret) args.push("--webhook-secret",webhookSecret);
    result=await run(args);
  }else if(task.type==="update"){
    // An update must carry the same account credentials as the original
    // deploy: the deployment directory records `account_id`, so without the
    // matching API token wrangler would either fail or (worse) redeploy a
    // cross-account customer into the runner's own account.
    const input=claimed.input||{};
    const updateArgs=["--update-existing",deploymentDir];
    const accountId=stringValue(input,"accountId");
    const apiToken=stringValue(input,"apiToken");
    if(accountId) updateArgs.push("--account-id",accountId);
    if(apiToken) updateArgs.push("--api-token",apiToken);
    result=await run(updateArgs);
  }else{
    result={ok:true,output:"任务已由控制中心记录；该操作不需要重新部署 Worker。"};
  }
  await api("/api/control/runner/tasks/"+task.id+"/result",{
    method:"POST",
    body:JSON.stringify({
      status:result.ok?"succeeded":"failed",
      logText:result.output.slice(-20000),
      errorMessage:result.ok?null:"deploy-customer.mjs 执行失败",
      currentVersion:result.ok?(process.env.APP_VERSION||null):null,
    }),
  });
  return true;
}
async function sleep(ms){ await new Promise(resolve=>setTimeout(resolve,ms)); }
async function main(){
  const onceOnly=process.argv.includes("--once");
  console.log("Deployment Runner started:",CONTROL_PLANE_URL);
  do{
    try{
      const handled=await once();
      if(onceOnly||!handled){ if(onceOnly) break; await sleep(3000); }
    }catch(error){
      console.error("Deployment Runner iteration failed:",error);
      if(onceOnly) throw error;
      await sleep(5000);
    }
  }while(true);
}
main().catch(e=>{console.error(e);process.exit(1);});
