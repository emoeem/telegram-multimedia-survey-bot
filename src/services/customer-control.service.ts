import { callLicenseCenter, checkDeploymentLicense } from "./license-client.service";

export interface CustomerControlEnv {
  CACHE:KVNamespace; LICENSE_SERVER_URL?:string; LICENSE_CENTER?:Fetcher; LICENSE_KEY?:string; INSTALLATION_ID?:string;
  APP_VERSION?:string; LICENSE_ENFORCEMENT?:string; WORKER_NAME?:string; WORKER_URL?:string;
  /** Shared with the center so it can sign tokens for `/api/remote/*`. */
  REMOTE_ACCESS_SECRET?:string;
}
export async function sendCustomerHeartbeat(env:CustomerControlEnv):Promise<void>{
  if(env.LICENSE_ENFORCEMENT!=="required") return;
  const license=await checkDeploymentLicense(env);
  if(!license.allowed) return;
  if(!env.LICENSE_KEY||!env.INSTALLATION_ID||!env.APP_VERSION||!env.WORKER_NAME) return;
  // Same transport as the license check: a same-account instance must not
  // `fetch()` the center's workers.dev URL (Cloudflare error 1042 → 404).
  const response=await callLicenseCenter(env,"/api/control/customer/heartbeat",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      licenseKey:env.LICENSE_KEY,installationId:env.INSTALLATION_ID,appVersion:env.APP_VERSION,
      workerName:env.WORKER_NAME,workerUrl:env.WORKER_URL,
      // Re-sent every heartbeat so the center can recover it after a restore,
      // and so a deployment made before this field existed starts working
      // without a manual re-registration. Idempotent: the center re-encrypts
      // and overwrites.
      ...(env.REMOTE_ACCESS_SECRET?{remoteAccessSecret:env.REMOTE_ACCESS_SECRET}:{}),
      metadata:{role:"customer-worker"},
    }),
  });
  if(!response.ok) throw new Error("客户 Worker 心跳上报失败："+response.status);
}
