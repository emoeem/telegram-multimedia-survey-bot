export interface PublicationTarget {
  id:number; name:string; targetType:"telegram_topic"; chatId:string; threadId:number|null;
  enabled:boolean; isDefault:boolean; createdAt:string; updatedAt:string;
}
interface Row {id:number;name:string;target_type:"telegram_topic";chat_id:string;thread_id:number|null;enabled:number;is_default:number;created_at:string;updated_at:string;}
const map=(r:Row):PublicationTarget=>({id:r.id,name:r.name,targetType:r.target_type,chatId:r.chat_id,threadId:r.thread_id,enabled:r.enabled===1,isDefault:r.is_default===1,createdAt:r.created_at,updatedAt:r.updated_at});
const now=()=>new Date().toISOString();

export async function listPublicationTargets(db:D1Database){
  const rows=await db.prepare("SELECT * FROM publication_targets ORDER BY is_default DESC,enabled DESC,id DESC").all<Row>();
  return rows.results.map(map);
}
export async function getDefaultPublicationTarget(db:D1Database){
  const row=await db.prepare("SELECT * FROM publication_targets WHERE enabled=1 ORDER BY is_default DESC,id ASC LIMIT 1").first<Row>();
  return row?map(row):null;
}
export async function upsertDefaultPublicationTarget(db:D1Database,input:{name:string;chatId:string;threadId:number|null}){
  const timestamp=now();
  await db.batch([
    db.prepare("UPDATE publication_targets SET is_default=0,updated_at=? WHERE is_default=1").bind(timestamp),
    db.prepare("INSERT INTO publication_targets(name,target_type,chat_id,thread_id,enabled,is_default,created_at,updated_at) VALUES(?,'telegram_topic',?,?,1,1,?,?)").bind(input.name,input.chatId,input.threadId,timestamp,timestamp),
  ]);
  return getDefaultPublicationTarget(db);
}
export async function updatePublicationTarget(db:D1Database,id:number,input:{name:string;chatId:string;threadId:number|null;enabled:boolean;isDefault?:boolean}){
  const timestamp=now();
  if(input.isDefault){
    await db.batch([
      db.prepare("UPDATE publication_targets SET is_default=0,updated_at=? WHERE is_default=1").bind(timestamp),
      db.prepare("UPDATE publication_targets SET name=?,chat_id=?,thread_id=?,enabled=?,is_default=1,updated_at=? WHERE id=?").bind(input.name,input.chatId,input.threadId,input.enabled?1:0,timestamp,id),
    ]);
  } else {
    await db.prepare("UPDATE publication_targets SET name=?,chat_id=?,thread_id=?,enabled=?,is_default=CASE WHEN ?=1 THEN is_default ELSE 0 END,updated_at=? WHERE id=?")
      .bind(input.name,input.chatId,input.threadId,input.enabled?1:0,input.enabled?1:0,timestamp,id).run();
  }
  const row=await db.prepare("SELECT * FROM publication_targets WHERE id=?").bind(id).first<Row>();
  return row?map(row):null;
}
export async function createPublicationTarget(db:D1Database,input:{name:string;chatId:string;threadId:number|null;enabled:boolean;isDefault:boolean}){
  const timestamp=now();
  if(input.isDefault) await db.prepare("UPDATE publication_targets SET is_default=0,updated_at=? WHERE is_default=1").bind(timestamp).run();
  const result=await db.prepare("INSERT INTO publication_targets(name,target_type,chat_id,thread_id,enabled,is_default,created_at,updated_at) VALUES(?,'telegram_topic',?,?,?,?,?,?)")
    .bind(input.name,input.chatId,input.threadId,input.enabled?1:0,input.isDefault?1:0,timestamp,timestamp).run();
  const row=await db.prepare("SELECT * FROM publication_targets WHERE id=?").bind(result.meta.last_row_id).first<Row>();
  return row?map(row):null;
}
export async function deletePublicationTarget(db:D1Database,id:number){
  await db.prepare("DELETE FROM publication_targets WHERE id=?").bind(id).run();
}
export async function disablePublicationTarget(db:D1Database,id:number){
  await db.prepare("UPDATE publication_targets SET enabled=0,is_default=0,updated_at=? WHERE id=?").bind(now(),id).run();
}
