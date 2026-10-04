import { activateLicense, validateLicense } from "../services/license.service";
import { getSoftwareLicenseByPublicId } from "../db/repositories/license.repository";
import {
  claimDeploymentTask,
  createDeploymentTask,
  finishDeploymentTask,
  getCustomerDeployment,
  listCustomerDeployments,
  listDeploymentTasks,
  setDeploymentStatus,
  upsertCustomerDeployment,
} from "../db/repositories/deployment.repository";
import {
  createPublicationTarget,
  deletePublicationTarget,
  getDefaultPublicationTarget,
  listPublicationTargets,
  updatePublicationTarget,
  upsertDefaultPublicationTarget,
} from "../db/repositories/publication-target.repository";
import { isLicenseCenter } from "../services/deployment-role.service";

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{"Cache-Control":"no-store"}});
const text=(v:unknown,name:string,min=1,max=256)=>{
  if(typeof v!=="string") throw new Error(name+" 必须是字符串");
  const s=v.trim(); if(s.length<min||s.length>max) throw new Error(name+" 长度无效"); return s;
};
async function body(request:Request):Promise<Record<string,unknown>>{
  const value=await request.json().catch(()=>null);
  if(!value||typeof value!=="object"||Array.isArray(value)) throw new Error("请求必须是 JSON 对象");
  return value as Record<string,unknown>;
}
function bearer(request:Request){const v=request.headers.get("Authorization")??"";return v.startsWith("Bearer ")?v.slice(7).trim():"";}
async function customerAuth(db:D1Database,b:Record<string,unknown>){
  const licenseKey=text(b.licenseKey,"licenseKey",20,128);
  const installationId=text(b.installationId,"installationId",6,128);
  const appVersion=text(b.appVersion,"appVersion",1,64);
  const metadata=b.metadata&&typeof b.metadata==="object"&&!Array.isArray(b.metadata)?b.metadata as Record<string,unknown>: {};
  let decision=await validateLicense(db,{licenseKey,installationId,appVersion,metadata});
  if(!decision.valid) decision=await activateLicense(db,{licenseKey,installationId,appVersion,metadata});
  if(!decision.valid||!decision.license) throw new Error("授权无效："+decision.message);
  const license=await getSoftwareLicenseByPublicId(db,decision.license.publicId);
  if(!license) throw new Error("授权不存在");
  return {license,licenseKey,installationId,appVersion};
}

export async function handleControlApiRequest(
  request:Request,
  env:{DB:D1Database;LICENSE_ADMIN_TOKEN?:string;CONTROL_PLANE_RUNNER_TOKEN?:string;DEPLOYMENT_ROLE?:string},
  auth:{isAdmin:boolean;userId:number|null},
):Promise<Response|null>{
  const url=new URL(request.url);
  if(!url.pathname.startsWith("/api/control/")) return null;
  try {
    const b=request.method==="GET"?{}:await body(request);
    const runnerToken=env.CONTROL_PLANE_RUNNER_TOKEN?.trim();
    const runnerAuth=Boolean(runnerToken&&bearer(request)===runnerToken);
    if(url.pathname.startsWith("/api/control/runner/")&&!runnerAuth) return json({ok:false,error:"unauthorized"},401);
    const customerRoute=url.pathname.startsWith("/api/control/customer/");
    if(!url.pathname.startsWith("/api/control/runner/")&&!customerRoute&&!auth.isAdmin) return json({ok:false,error:"forbidden"},403);
    if(url.pathname==="/api/control/deployments"&&request.method==="GET"){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      const publicId=typeof b.licensePublicId==="string"?b.licensePublicId.trim():undefined;
      const license=publicId?await getSoftwareLicenseByPublicId(env.DB,publicId):undefined;
      return json({ok:true,items:await listCustomerDeployments(env.DB,license?.id)});
    }
    if(url.pathname==="/api/control/deployments"&&request.method==="POST"){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      const license=await getSoftwareLicenseByPublicId(env.DB,text(b.licensePublicId,"licensePublicId",6,100));
      if(!license) return json({ok:false,error:"license_not_found"},404);
      const workerName=text(b.workerName,"workerName",1,63);
      if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workerName)) {
        return json({ok:false,error:"invalid_worker_name"},400);
      }
      const deployment=await upsertCustomerDeployment(env.DB,{
        licenseId:license.id,installationId:text(b.installationId,"installationId",6,128),
        workerName,
        workerUrl:typeof b.workerUrl==="string"?b.workerUrl.trim():null,
        currentVersion:typeof b.currentVersion==="string"?b.currentVersion.trim():null,
      });
      return json({ok:true,deployment},201);
    }
    const match=url.pathname.match(/^\/api\/control\/deployments\/(\d+)(?:\/(tasks|status))?$/);
    if(match){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      const deploymentId=Number(match[1]); const deployment=await getCustomerDeployment(env.DB,deploymentId);
      if(!deployment) return json({ok:false,error:"deployment_not_found"},404);
      if(!match[2]&&request.method==="GET") return json({ok:true,deployment});
      if(match[2]==="tasks"&&request.method==="GET") return json({ok:true,items:await listDeploymentTasks(env.DB,deploymentId)});
      if(match[2]==="status"&&request.method==="PATCH"){
        const status=b.status;
        if(!["pending","deploying","online","offline","disabled","failed"].includes(String(status))) return json({ok:false,error:"invalid_status"},400);
        return json({ok:true,deployment:await setDeploymentStatus(env.DB,deploymentId,status as never,typeof b.currentVersion==="string"?b.currentVersion:null)});
      }
      if(!match[2]&&request.method==="POST"){
        const type=String(b.type);
        if(!["deploy","update","rollback","disable","enable"].includes(type)) return json({ok:false,error:"invalid_task_type"},400);
        const task=await createDeploymentTask(env.DB,{deploymentId,type:type as never,targetVersion:typeof b.targetVersion==="string"?b.targetVersion.trim():null,requestedBy:auth.userId});
        return json({ok:true,task},201);
      }
    }
    if(url.pathname==="/api/control/publication-targets"&&request.method==="GET"){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      return json({ok:true,items:await listPublicationTargets(env.DB),defaultTarget:await getDefaultPublicationTarget(env.DB)});
    }
    if(url.pathname==="/api/control/publication-targets/default"&&(request.method==="PUT"||request.method==="POST")){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      const chatId=text(b.chatId,"chatId",1,64);
      const threadId=b.threadId===null||b.threadId===undefined?null:Number(b.threadId);
      if(threadId!==null&&(!Number.isInteger(threadId)||threadId<=0)) return json({ok:false,error:"invalid_thread_id"},400);
      const target=await upsertDefaultPublicationTarget(env.DB,{name:text(b.name,"name",1,120),chatId,threadId});
      return json({ok:true,target});
    }
    const targetMatch=url.pathname.match(/^\/api\/control\/publication-targets\/(\d+)$/);
    if(targetMatch&&request.method==="PATCH"){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      const id=Number(targetMatch[1]);
      const name=text(b.name,"name",1,120);
      const chatId=text(b.chatId,"chatId",1,64);
      const threadId=b.threadId===null||b.threadId===undefined?null:Number(b.threadId);
      const enabled=b.enabled!==false;
      const isDefault=enabled&&b.isDefault===true;
      if(threadId!==null&&(!Number.isInteger(threadId)||threadId<=0)) return json({ok:false,error:"invalid_thread_id"},400);
      const target=await updatePublicationTarget(env.DB,id,{name,chatId,threadId,enabled,isDefault});
      return target?json({ok:true,target}):json({ok:false,error:"target_not_found"},404);
    }
    if(targetMatch&&request.method==="DELETE"){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      await deletePublicationTarget(env.DB,Number(targetMatch[1]));
      return json({ok:true});
    }
    if(url.pathname==="/api/control/publication-targets"&&request.method==="POST"){
      if(!isLicenseCenter(env)) return json({ok:false,error:"vendor_only"},403);
      const chatId=text(b.chatId,"chatId",1,64);
      const threadId=b.threadId===null||b.threadId===undefined?null:Number(b.threadId);
      if(threadId!==null&&(!Number.isInteger(threadId)||threadId<=0)) return json({ok:false,error:"invalid_thread_id"},400);
      const target=await createPublicationTarget(env.DB,{name:text(b.name,"name",1,120),chatId,threadId,enabled:b.enabled!==false,isDefault:b.isDefault===true});
      return target?json({ok:true,target},201):json({ok:false,error:"target_create_failed"},500);
    }

    if(url.pathname==="/api/control/runner/tasks/claim"&&request.method==="POST"){
      const task=await claimDeploymentTask(env.DB);
      return json({ok:true,task});
    }
    const resultMatch=url.pathname.match(/^\/api\/control\/runner\/tasks\/(\d+)\/result$/);
    if(resultMatch&&request.method==="POST"){
      const taskId=Number(resultMatch[1]);
      const status=b.status==="failed"?"failed":"succeeded";
      const result=b.result&&typeof b.result==="object"&&!Array.isArray(b.result)?b.result as Record<string,unknown>:null;
      const task=await finishDeploymentTask(env.DB,{taskId,status,logText:typeof b.logText==="string"?b.logText.slice(0,20000):null,result,errorMessage:typeof b.errorMessage==="string"?b.errorMessage.slice(0,2000):null,currentVersion:typeof b.currentVersion==="string"?b.currentVersion.trim():null});
      return task?json({ok:true,task}):json({ok:false,error:"task_not_found"},404);
    }

    if(url.pathname==="/api/control/customer/heartbeat"&&request.method==="POST"){
      const a=await customerAuth(env.DB,b);
      const workerName=text(b.workerName,"workerName",1,63);
      if(!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(workerName)) {
        return json({ok:false,error:"invalid_worker_name"},400);
      }
      const deployment=await upsertCustomerDeployment(env.DB,{
        licenseId:a.license.id,installationId:a.installationId,workerName,
        workerUrl:typeof b.workerUrl==="string"?b.workerUrl.trim():null,currentVersion:a.appVersion,
        metadata:b.metadata&&typeof b.metadata==="object"&&!Array.isArray(b.metadata)?b.metadata as Record<string,unknown>:null,
      });
      return json({ok:true,deployment});
    }
    if(url.pathname==="/api/control/customer/publication-target"&&request.method==="POST"){
      const a=await customerAuth(env.DB,b);
      const target=await getDefaultPublicationTarget(env.DB);
      if(!target) return json({ok:false,error:"publication_target_not_configured"},503);
      return json({ok:true,target:{id:target.id,chatId:target.chatId,threadId:target.threadId}});
    }
    return json({ok:false,error:"not_found"},404);
  } catch(error) {
    console.error("Control API failed",error);
    return json({ok:false,error:"invalid_request",message:error instanceof Error?error.message:"请求处理失败"},400);
  }
}
