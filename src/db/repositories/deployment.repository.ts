import type { CustomerDeployment, DeploymentTask, DeploymentTaskStatus, DeploymentTaskType } from "../schema";

interface DeploymentRow {
  id:number; license_id:number; installation_id:string; worker_name:string; worker_url:string|null;
  status:CustomerDeployment["status"]; current_version:string|null; desired_version:string|null;
  last_seen_at:string|null; metadata_json:string|null; created_at:string; updated_at:string;
  license_public_id:string; customer_name:string|null; license_status:string; license_expires_at:string|null;
}
interface TaskRow {
  id:number; deployment_id:number; type:DeploymentTaskType; target_version:string|null; status:DeploymentTaskStatus;
  requested_by:number|null; requested_at:string; started_at:string|null; finished_at:string|null;
  log_text:string|null; result_json:string|null; error_message:string|null; payload_json:string|null;
}
const mapDeployment=(r:DeploymentRow):CustomerDeployment=>({
  id:r.id,licenseId:r.license_id,installationId:r.installation_id,workerName:r.worker_name,workerUrl:r.worker_url,
  status:r.status,currentVersion:r.current_version,desiredVersion:r.desired_version,lastSeenAt:r.last_seen_at,
  metadataJson:r.metadata_json,createdAt:r.created_at,updatedAt:r.updated_at,
  licensePublicId:r.license_public_id,customerName:r.customer_name,licenseStatus:r.license_status,licenseExpiresAt:r.license_expires_at,
});
const mapTask=(r:TaskRow):DeploymentTask=>({
  id:r.id,deploymentId:r.deployment_id,type:r.type,targetVersion:r.target_version,status:r.status,
  requestedBy:r.requested_by,requestedAt:r.requested_at,startedAt:r.started_at,finishedAt:r.finished_at,
  logText:r.log_text,resultJson:r.result_json,errorMessage:r.error_message,
});
const now=()=>new Date().toISOString();

export async function listCustomerDeployments(db:D1Database, licenseId?:number){
  const q=licenseId===undefined
    ? db.prepare("SELECT d.*,l.public_id AS license_public_id,l.customer_name,l.status AS license_status,l.expires_at AS license_expires_at FROM customer_deployments d JOIN software_licenses l ON l.id=d.license_id ORDER BY d.updated_at DESC,d.id DESC")
    : db.prepare("SELECT d.*,l.public_id AS license_public_id,l.customer_name,l.status AS license_status,l.expires_at AS license_expires_at FROM customer_deployments d JOIN software_licenses l ON l.id=d.license_id WHERE d.license_id=? ORDER BY d.updated_at DESC,d.id DESC").bind(licenseId);
  const rows=await q.all<DeploymentRow>(); return rows.results.map(mapDeployment);
}
export async function getCustomerDeployment(db:D1Database,id:number){
  const row=await db.prepare("SELECT d.*,l.public_id AS license_public_id,l.customer_name,l.status AS license_status,l.expires_at AS license_expires_at FROM customer_deployments d JOIN software_licenses l ON l.id=d.license_id WHERE d.id=?").bind(id).first<DeploymentRow>();
  return row?mapDeployment(row):null;
}
export async function upsertCustomerDeployment(db:D1Database,input:{licenseId:number;installationId:string;workerName:string;workerUrl?:string|null;currentVersion?:string|null;metadata?:Record<string,unknown>|null;status?:CustomerDeployment["status"]}){
  const timestamp=now();
  const requestedStatus=input.status??"online";
  // `worker_url` keeps its previous value when the writer has none: the
  // heartbeat cannot know the instance's own public URL (it runs from a cron
  // with no request), so a plain assignment erased what the deploy-time
  // registration had recorded — and the vendor console needs that URL to open a
  // customer's data viewer.
  await db.prepare("INSERT INTO customer_deployments (license_id,installation_id,worker_name,worker_url,status,current_version,last_seen_at,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(license_id,installation_id) DO UPDATE SET worker_name=excluded.worker_name,worker_url=COALESCE(excluded.worker_url,customer_deployments.worker_url),status=CASE WHEN customer_deployments.status='disabled' THEN 'disabled' ELSE excluded.status END,current_version=excluded.current_version,last_seen_at=excluded.last_seen_at,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at")
    .bind(input.licenseId,input.installationId,input.workerName,input.workerUrl??null,requestedStatus,input.currentVersion??null,timestamp,input.metadata?JSON.stringify(input.metadata):null,timestamp,timestamp).run();
  const row=await db.prepare("SELECT d.*,l.public_id AS license_public_id,l.customer_name,l.status AS license_status,l.expires_at AS license_expires_at FROM customer_deployments d JOIN software_licenses l ON l.id=d.license_id WHERE d.license_id=? AND d.installation_id=?").bind(input.licenseId,input.installationId).first<DeploymentRow>();
  if(!row) throw new Error("客户部署注册失败"); return mapDeployment(row);
}
export async function setDeploymentStatus(db:D1Database,id:number,status:CustomerDeployment["status"],currentVersion?:string|null){
  await db.prepare("UPDATE customer_deployments SET status=?,current_version=COALESCE(?,current_version),updated_at=? WHERE id=?").bind(status,currentVersion??null,now(),id).run();
  return getCustomerDeployment(db,id);
}
/**
 * Stores the customer's Cloudflare account credentials as an opaque encrypted
 * envelope (see `deployment-task-secret.service`). Kept out of
 * `mapDeployment`/`DeploymentRow` on purpose: it must never reach an API
 * response, only the encrypted task payload of a follow-up `update`.
 */
export async function setCustomerDeploymentCredentials(db:D1Database,id:number,credentialsJson:string|null){
  await db.prepare("UPDATE customer_deployments SET credentials_json=?,updated_at=? WHERE id=?").bind(credentialsJson,now(),id).run();
}
/** The stored encrypted envelope, or null when the deployment is same-account. */
export async function getCustomerDeploymentCredentials(db:D1Database,id:number):Promise<string|null>{
  const row=await db.prepare("SELECT credentials_json FROM customer_deployments WHERE id=?").bind(id).first<{credentials_json:string|null}>();
  return row?.credentials_json??null;
}
/**
 * The shared secret for `/api/remote/*`, encrypted at rest. Reported by the
 * instance itself on its first heartbeat, so it never has to travel through
 * the deployment task payload.
 */
export async function setCustomerDeploymentRemoteSecret(db:D1Database,id:number,remoteSecretJson:string|null){
  await db.prepare("UPDATE customer_deployments SET remote_secret_json=?,updated_at=? WHERE id=?").bind(remoteSecretJson,now(),id).run();
}
export async function getCustomerDeploymentRemoteSecret(db:D1Database,id:number):Promise<string|null>{
  const row=await db.prepare("SELECT remote_secret_json FROM customer_deployments WHERE id=?").bind(id).first<{remote_secret_json:string|null}>();
  return row?.remote_secret_json??null;
}
export async function createDeploymentTask(db:D1Database,input:{deploymentId:number;type:DeploymentTaskType;targetVersion?:string|null;requestedBy?:number|null;payloadJson?:string|null}){
  const timestamp=now();
  await db.prepare("INSERT INTO deployment_tasks(deployment_id,type,target_version,status,requested_by,requested_at,payload_json) VALUES(?,?,?,'queued',?,?,?)").bind(input.deploymentId,input.type,input.targetVersion??null,input.requestedBy??null,timestamp,input.payloadJson??null).run();
  const row=await db.prepare("SELECT * FROM deployment_tasks WHERE id=last_insert_rowid()").first<TaskRow>();
  if(!row) throw new Error("部署任务创建失败"); return mapTask(row);
}
export async function listDeploymentTasks(db:D1Database,deploymentId:number,limit=30){
  const rows=await db.prepare("SELECT * FROM deployment_tasks WHERE deployment_id=? ORDER BY id DESC LIMIT ?").bind(deploymentId,Math.min(Math.max(limit,1),100)).all<TaskRow>();
  return rows.results.map(mapTask);
}
export async function claimDeploymentTask(db:D1Database){
  const row=await db.prepare("SELECT * FROM deployment_tasks WHERE status='queued' ORDER BY id ASC LIMIT 1").first<TaskRow>();
  if(!row) return null;
  const timestamp=now();
  const result=await db.prepare("UPDATE deployment_tasks SET status='running',started_at=? WHERE id=? AND status='queued'").bind(timestamp,row.id).run();
  if(!result.meta.changes) return null;
  await db.prepare("UPDATE customer_deployments SET status='deploying',desired_version=COALESCE(?,desired_version),updated_at=? WHERE id=?").bind(row.target_version,timestamp,row.deployment_id).run();
  return {...mapTask({...row,status:"running",started_at:timestamp}),payloadJson:row.payload_json};
}
export async function finishDeploymentTask(db:D1Database,input:{taskId:number;status:"succeeded"|"failed";logText?:string|null;result?:Record<string,unknown>|null;errorMessage?:string|null;currentVersion?:string|null}){
  const timestamp=now();
  await db.prepare("UPDATE deployment_tasks SET status=?,finished_at=?,log_text=?,result_json=?,error_message=?,payload_json=NULL WHERE id=? AND status='running'").bind(input.status,timestamp,input.logText??null,input.result?JSON.stringify(input.result):null,input.errorMessage??null,input.taskId).run();
  const row=await db.prepare("SELECT * FROM deployment_tasks WHERE id=?").bind(input.taskId).first<TaskRow>();
  if(!row) return null;
  const deploymentStatus = input.status === "failed"
    ? "failed"
    : row.type === "disable"
      ? "disabled"
      : "online";
  await db.prepare("UPDATE customer_deployments SET status=?,current_version=COALESCE(?,current_version),updated_at=? WHERE id=?").bind(deploymentStatus,input.currentVersion??null,timestamp,row.deployment_id).run();
  return mapTask(row);
}
