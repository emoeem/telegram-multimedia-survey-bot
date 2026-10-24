import { activateLicense, validateLicense } from "../services/license.service";
import { getSoftwareLicenseByPublicId, listSoftwareReleases } from "../db/repositories/license.repository";
import {
  completeDeviceTask, createDeviceTask, getManagedDevice, listDeviceTasks, listManagedDevices,
  claimNextDeviceTasks, setManagedDeviceStatus, upsertManagedDevice,
} from "../db/repositories/device.repository";
import type { DeviceTaskType } from "../db/schema";

const MAX_BODY = 16_384;
const TASK_TYPES = new Set<DeviceTaskType>(["update","restart","stop","start","diagnostics","collect_logs","sync_config"]);
const HEADERS = {"Cache-Control":"no-store","Content-Type":"application/json; charset=utf-8"};
const json = (body:unknown,status=200) => new Response(JSON.stringify(body),{status,headers:HEADERS});
const text = (v:unknown,n:string,min=1,max=256) => {
  if(typeof v!=="string") throw new Error(n+" 必须是字符串");
  const s=v.trim(); if(s.length<min||s.length>max) throw new Error(n+" 长度无效"); return s;
};
const adminToken = (r:Request) => {
  const a=r.headers.get("Authorization");
  return a?.startsWith("Bearer ") ? a.slice(7).trim() : r.headers.get("X-License-Admin-Token")?.trim() ?? "";
};
const equal = (a:string,b:string) => {
  if(a.length!==b.length) return false; let d=0;
  for(let i=0;i<a.length;i++) d |= a.charCodeAt(i)^b.charCodeAt(i);
  return d===0;
};
async function readBody(r:Request):Promise<Record<string,unknown>> {
  const s=await r.text(); if(s.length>MAX_BODY) throw new Error("请求内容过大");
  const v=JSON.parse(s) as unknown;
  if(!v||typeof v!=="object"||Array.isArray(v)) throw new Error("请求必须是 JSON 对象");
  return v as Record<string,unknown>;
}
async function auth(db:D1Database,b:Record<string,unknown>) {
  const licenseKey=text(b.licenseKey,"licenseKey",20,128);
  const installationId=text(b.installationId,"installationId",6,128);
  const appVersion=text(b.appVersion,"appVersion",1,64);
  const metadata=b.metadata&&typeof b.metadata==="object"&&!Array.isArray(b.metadata) ? b.metadata as Record<string,unknown> : undefined;
  const input={licenseKey,installationId,appVersion,...(metadata?{metadata}:{})};
  let decision=await validateLicense(db,input);
  if(!decision.valid) decision=await activateLicense(db,input);
  if(!decision.valid) throw new Error("授权无效："+decision.message);
  return {licenseKey,installationId,appVersion,decision};
}
async function licenseId(db:D1Database,publicId:string){
  const l=await getSoftwareLicenseByPublicId(db,publicId);
  if(!l) throw new Error("授权不存在");
  return l.id;
}

export async function handleDeviceApiRequest(request:Request,db:D1Database,licenseAdminToken?:string):Promise<Response|null>{
  const path=new URL(request.url).pathname;
  if(!path.startsWith("/api/v1/devices")) return null;
  if(request.method!=="POST") return json({ok:false,error:"method_not_allowed"},405);
  try {
    const b=await readBody(request);
    if(path==="/api/v1/devices/heartbeat") {
      const a=await auth(db,b);
      const deviceId=text(b.deviceId,"deviceId",6,128);
      const lid=await licenseId(db,a.decision.license!.publicId);
      const device=await upsertManagedDevice(db,{licenseId:lid,installationId:a.installationId,deviceId,
        deviceName:typeof b.deviceName==="string"?b.deviceName.trim().slice(0,120):null,
        hostname:typeof b.hostname==="string"?b.hostname.trim().slice(0,255):null,
        platform:typeof b.platform==="string"?b.platform.trim().slice(0,80):null,
        arch:typeof b.arch==="string"?b.arch.trim().slice(0,40):null,appVersion:a.appVersion,
        agentVersion:typeof b.agentVersion==="string"?b.agentVersion.trim().slice(0,64):null,
        metadata:b.metadata&&typeof b.metadata==="object"&&!Array.isArray(b.metadata)?b.metadata as Record<string,unknown>:null});
      const tasks=await claimNextDeviceTasks(db,device.id,10);
      return json({ok:true,device,tasks,releases:await listSoftwareReleases(db,20)});
    }
    if(path==="/api/v1/devices/tasks/poll") {
      const a=await auth(db,b); const lid=await licenseId(db,a.decision.license!.publicId);
      const d=await getManagedDevice(db,lid,text(b.deviceId,"deviceId",6,128));
      if(!d) return json({ok:false,error:"device_not_registered"},404);
      return json({ok:true,tasks:await claimNextDeviceTasks(db,d.id,10)});
    }
    if(path==="/api/v1/devices/tasks/result") {
      const a=await auth(db,b); const lid=await licenseId(db,a.decision.license!.publicId);
      const d=await getManagedDevice(db,lid,text(b.deviceId,"deviceId",6,128));
      if(!d) return json({ok:false,error:"device_not_registered"},404);
      const id=Number(b.taskId); if(!Number.isInteger(id)||id<=0) return json({ok:false,error:"invalid_task_id"},400);
      const status=b.status==="failed"?"failed":"completed";
      const result=b.result&&typeof b.result==="object"&&!Array.isArray(b.result)?b.result as Record<string,unknown>:null;
      const task=await completeDeviceTask(db,{deviceId:d.id,taskId:id,status,result,
        errorMessage:typeof b.errorMessage==="string"?b.errorMessage.slice(0,1000):null});
      return task?json({ok:true,task}):json({ok:false,error:"task_not_found"},404);
    }
    if(!licenseAdminToken||!equal(licenseAdminToken,adminToken(request))) return json({ok:false,error:"unauthorized"},401);
    if(path==="/api/v1/devices/list") {
      const publicId=typeof b.licensePublicId==="string"?b.licensePublicId.trim():undefined;
      const l=publicId?await getSoftwareLicenseByPublicId(db,publicId):undefined;
      return json({ok:true,devices:await listManagedDevices(db,l?.id)});
    }
    const publicId=text(b.licensePublicId,"licensePublicId",6,100);
    const lid=await licenseId(db,publicId);
    const deviceId=text(b.deviceId,"deviceId",6,128);
    const d=await getManagedDevice(db,lid,deviceId);
    if(!d) return json({ok:false,error:"device_not_found"},404);
    if(path==="/api/v1/devices/task") {
      const type=text(b.type,"type",1,40) as DeviceTaskType;
      if(!TASK_TYPES.has(type)) return json({ok:false,error:"invalid_task_type"},400);
      const payload=b.payload&&typeof b.payload==="object"&&!Array.isArray(b.payload)?b.payload as Record<string,unknown>:null;
      return json({ok:true,task:await createDeviceTask(db,{deviceId:d.id,type,payload})});
    }
    if(path==="/api/v1/devices/status") {
      const status=b.status==="disabled"?"disabled":b.status==="online"?"online":"offline";
      return json({ok:true,device:await setManagedDeviceStatus(db,lid,deviceId,status)});
    }
    if(path==="/api/v1/devices/tasks") return json({ok:true,tasks:await listDeviceTasks(db,d.id)});
    return json({ok:false,error:"not_found"},404);
  } catch(e) {
    console.error("Device API failed",e);
    return json({ok:false,error:"invalid_request",message:e instanceof Error?e.message:"请求处理失败"},400);
  }
}
