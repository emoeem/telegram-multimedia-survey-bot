import type { DeviceTask, DeviceTaskStatus, DeviceTaskType, ManagedDevice, ManagedDeviceStatus } from "../schema";

interface DeviceRow {
  id:number; license_id:number; installation_id:string; device_id:string;
  device_name:string|null; hostname:string|null; platform:string|null; arch:string|null;
  app_version:string|null; agent_version:string|null; status:ManagedDeviceStatus;
  last_seen_at:string; metadata_json:string|null; created_at:string; updated_at:string;
}
interface TaskRow {
  id:number; device_id:number; type:DeviceTaskType; payload_json:string|null;
  status:DeviceTaskStatus; created_at:string; claimed_at:string|null;
  completed_at:string|null; result_json:string|null; error_message:string|null;
}
const mapDevice=(r:DeviceRow):ManagedDevice=>({
  id:r.id, licenseId:r.license_id, installationId:r.installation_id, deviceId:r.device_id,
  deviceName:r.device_name, hostname:r.hostname, platform:r.platform, arch:r.arch,
  appVersion:r.app_version, agentVersion:r.agent_version, status:r.status,
  lastSeenAt:r.last_seen_at, metadataJson:r.metadata_json, createdAt:r.created_at, updatedAt:r.updated_at,
});
const mapTask=(r:TaskRow):DeviceTask=>({
  id:r.id, deviceId:r.device_id, type:r.type, payloadJson:r.payload_json, status:r.status,
  createdAt:r.created_at, claimedAt:r.claimed_at, completedAt:r.completed_at,
  resultJson:r.result_json, errorMessage:r.error_message,
});

export async function upsertManagedDevice(db:D1Database,input:{
  licenseId:number; installationId:string; deviceId:string; deviceName?:string|null;
  hostname?:string|null; platform?:string|null; arch?:string|null; appVersion?:string|null;
  agentVersion?:string|null; metadata?:Record<string,unknown>|null;
}):Promise<ManagedDevice>{
  const now=new Date().toISOString();
  await db.prepare(`INSERT INTO managed_devices
    (license_id,installation_id,device_id,device_name,hostname,platform,arch,app_version,agent_version,status,last_seen_at,metadata_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'online',?,?,?,?)
    ON CONFLICT(license_id,device_id) DO UPDATE SET
      installation_id=excluded.installation_id,device_name=excluded.device_name,hostname=excluded.hostname,
      platform=excluded.platform,arch=excluded.arch,app_version=excluded.app_version,
      agent_version=excluded.agent_version,status='online',last_seen_at=excluded.last_seen_at,
      metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`)
    .bind(input.licenseId,input.installationId,input.deviceId,input.deviceName??null,input.hostname??null,input.platform??null,
      input.arch??null,input.appVersion??null,input.agentVersion??null,now,input.metadata?JSON.stringify(input.metadata):null,now,now).run();
  const row=await db.prepare("SELECT * FROM managed_devices WHERE license_id=? AND device_id=?").bind(input.licenseId,input.deviceId).first<DeviceRow>();
  if(!row) throw new Error("保存设备失败");
  return mapDevice(row);
}

export async function getManagedDevice(db:D1Database,licenseId:number,deviceId:string):Promise<ManagedDevice|null>{
  const row=await db.prepare("SELECT * FROM managed_devices WHERE license_id=? AND device_id=?").bind(licenseId,deviceId).first<DeviceRow>();
  return row?mapDevice(row):null;
}
export async function listManagedDevices(db:D1Database,licenseId?:number):Promise<ManagedDevice[]>{
  const result=licenseId===undefined
    ? await db.prepare("SELECT * FROM managed_devices ORDER BY last_seen_at DESC,id DESC").all<DeviceRow>()
    : await db.prepare("SELECT * FROM managed_devices WHERE license_id=? ORDER BY last_seen_at DESC,id DESC").bind(licenseId).all<DeviceRow>();
  return (result.results??[]).map(mapDevice);
}

export async function markDeviceStatuses(db:D1Database,offlineSeconds=120):Promise<number>{
  const cutoff=new Date(Date.now()-offlineSeconds*1000).toISOString();
  const result=await db.prepare("UPDATE managed_devices SET status='offline',updated_at=? WHERE status='online' AND last_seen_at<?").bind(new Date().toISOString(),cutoff).run();
  return result.meta.changes??0;
}

export async function setManagedDeviceStatus(db:D1Database,licenseId:number,deviceId:string,status:ManagedDeviceStatus):Promise<ManagedDevice|null>{
  await db.prepare("UPDATE managed_devices SET status=?,updated_at=? WHERE license_id=? AND device_id=?")
    .bind(status,new Date().toISOString(),licenseId,deviceId).run();
  return getManagedDevice(db,licenseId,deviceId);
}

export async function createDeviceTask(db:D1Database,input:{
  deviceId:number; type:DeviceTaskType; payload?:Record<string,unknown>|null;
}):Promise<DeviceTask>{
  const now=new Date().toISOString();
  const result=await db.prepare("INSERT INTO device_tasks(device_id,type,payload_json,status,created_at) VALUES(?,?,?,'pending',?)")
    .bind(input.deviceId,input.type,input.payload?JSON.stringify(input.payload):null,now).run();
  const id=result.meta.last_row_id;
  if(typeof id!=="number") throw new Error("创建设备任务失败");
  const row=await db.prepare("SELECT * FROM device_tasks WHERE id=?").bind(id).first<TaskRow>();
  if(!row) throw new Error("读取设备任务失败");
  return mapTask(row);
}

export async function claimNextDeviceTasks(db:D1Database,deviceId:number,limit=10):Promise<DeviceTask[]>{
  const rows=await db.prepare("SELECT * FROM device_tasks WHERE device_id=? AND status='pending' ORDER BY id ASC LIMIT ?")
    .bind(deviceId,Math.max(1,Math.min(20,limit))).all<TaskRow>();
  const tasks=rows.results??[];
  if(!tasks.length) return [];
  const now=new Date().toISOString();
  for(const row of tasks){
    await db.prepare("UPDATE device_tasks SET status='claimed',claimed_at=? WHERE id=? AND status='pending'").bind(now,row.id).run();
  }
  const claimed=await db.prepare("SELECT * FROM device_tasks WHERE device_id=? AND status='claimed' AND id IN ("+
    tasks.map(()=>"?").join(",")+") ORDER BY id ASC").bind(deviceId,...tasks.map(r=>r.id)).all<TaskRow>();
  return (claimed.results??[]).map(mapTask);
}
export async function completeDeviceTask(db:D1Database,input:{
  deviceId:number; taskId:number; status:"completed"|"failed"; result?:Record<string,unknown>|null; errorMessage?:string|null;
}):Promise<DeviceTask|null>{
  const row=await db.prepare("SELECT * FROM device_tasks WHERE id=? AND device_id=?").bind(input.taskId,input.deviceId).first<TaskRow>();
  if(!row) return null;
  const now=new Date().toISOString();
  await db.prepare("UPDATE device_tasks SET status=?,completed_at=?,result_json=?,error_message=? WHERE id=? AND device_id=? AND status IN ('claimed','pending')")
    .bind(input.status,now,input.result?JSON.stringify(input.result):null,input.errorMessage??null,input.taskId,input.deviceId).run();
  const updated=await db.prepare("SELECT * FROM device_tasks WHERE id=?").bind(input.taskId).first<TaskRow>();
  return updated?mapTask(updated):null;
}

export async function listDeviceTasks(db:D1Database,deviceId:number,limit=50):Promise<DeviceTask[]>{
  const result=await db.prepare("SELECT * FROM device_tasks WHERE device_id=? ORDER BY id DESC LIMIT ?")
    .bind(deviceId,Math.max(1,Math.min(100,limit))).all<TaskRow>();
  return (result.results??[]).map(mapTask);
}
