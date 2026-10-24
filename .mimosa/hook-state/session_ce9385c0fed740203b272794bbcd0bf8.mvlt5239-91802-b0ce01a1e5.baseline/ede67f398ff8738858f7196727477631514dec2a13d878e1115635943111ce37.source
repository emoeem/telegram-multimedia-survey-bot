import { checkDeploymentLicense } from "./license-client.service";

export interface CustomerControlEnv {
  CACHE:KVNamespace; LICENSE_SERVER_URL?:string; LICENSE_KEY?:string; INSTALLATION_ID?:string;
  APP_VERSION?:string; LICENSE_ENFORCEMENT?:string; WORKER_NAME?:string; WORKER_URL?:string;
}
export async function sendCustomerHeartbeat(env:CustomerControlEnv):Promise<void>{
  if(env.LICENSE_ENFORCEMENT!=="required") return;
  const license=await checkDeploymentLicense(env);
  if(!license.allowed) return;
  const base=env.LICENSE_SERVER_URL?.replace(/\/+$/,"");
  if(!base||!env.LICENSE_KEY||!env.INSTALLATION_ID||!env.APP_VERSION||!env.WORKER_NAME) return;
  const response=await fetch(base+"/api/control/customer/heartbeat",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      licenseKey:env.LICENSE_KEY,installationId:env.INSTALLATION_ID,appVersion:env.APP_VERSION,
      workerName:env.WORKER_NAME,workerUrl:env.WORKER_URL,
      metadata:{role:"customer-worker"},
    }),
  });
  if(!response.ok) throw new Error("客户 Worker 心跳上报失败："+response.status);
}
