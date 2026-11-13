// Logical business-key export for inspection on an isolated DB. Not P3X's JSON format.
require('dotenv').config({quiet:true});
const {createClient,RESP_TYPES}=require('redis');
const fs=require('node:fs/promises');
const path=require('node:path');
const {allowedKey}=require('../redis-key-scope');
const readScript="local d=redis.call('DUMP',KEYS[1]);if not d then return false end;return {d,tostring(redis.call('PEXPIRETIME',KEYS[1])),redis.call('TYPE',KEYS[1]).ok}";
const importScript=`
 for i=1,#KEYS do if redis.call('EXISTS',KEYS[i])==1 then return redis.error_reply('Target key exists') end end
 local count=0
 for i=1,#KEYS do
  local offset=(i-1)*2
  if ARGV[offset+1]=='0' then redis.call('RESTORE',KEYS[i],0,ARGV[offset+2]) else redis.call('RESTORE',KEYS[i],ARGV[offset+1],ARGV[offset+2],'ABSTTL') end
  count=count+1
 end
 return count
`;
async function exportData(client,file){
  const keys=new Set();for(const prefix of ['product','customer','order','lab'])for await(const batch of client.scanIterator({MATCH:prefix+':*',COUNT:100}))for(const key of batch)if(allowedKey(key))keys.add(key);
  if(keys.size>5000)throw Error('Giới hạn công cụ học tập: 5000 key.');
  const binary=client.withTypeMapping({[RESP_TYPES.BLOB_STRING]:Buffer});const records=[];
  for(const key of [...keys].sort()){
    const result=await binary.eval(readScript,{keys:[key],arguments:[]});if(!result)continue;
    records.push({key,dump:result[0].toString('base64'),expiresAt:Number(result[1].toString()),type:result[2].toString()});
  }
  const document={format:'redis-lab-dump-v1',createdAt:new Date().toISOString(),database:Number(new URL(client.options.url).pathname.slice(1)||0),scope:'Business and lab keys only; no auth/session keys. Pause worker and writes before exporting.',records};
  await fs.mkdir(path.dirname(path.resolve(file)),{recursive:true});await fs.writeFile(file,JSON.stringify(document,null,2),{flag:'wx'});return {exported:records.length};
}
async function importData(client,file){
  const database=Number(new URL(client.options.url).pathname.slice(1)||0);
  if(database<2)throw Error('Chỉ import vào DB thử >= 2. Không import vào DB 0/1.');
  if(await client.dbSize())throw Error('DB đích phải trống; không xóa hoặc ghi đè dữ liệu.');
  const document=JSON.parse(await fs.readFile(file,'utf8'));
  if(document.format!=='redis-lab-dump-v1'||!Array.isArray(document.records)||document.records.length>5000)throw Error('Không phải định dạng redis-lab-dump-v1 hợp lệ.');
  const seen=new Set(),records=[];
  for(const record of document.records){
    if(!allowedKey(record.key)||seen.has(record.key)||typeof record.dump!=='string'||!record.dump.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(record.dump)||!Number.isSafeInteger(record.expiresAt)||record.expiresAt< -1)throw Error('Bản ghi hoặc TTL không hợp lệ.');
    seen.add(record.key);if(record.expiresAt!==-1&&record.expiresAt<=Date.now())continue;
    records.push(record);
  }
  // RESTORE verifies each payload's Redis version/checksum. A Lua error is not rollback;
  // therefore this tool only accepts trusted local exports into an empty isolated DB.
  const restored=records.length?await client.eval(importScript,{keys:records.map(record=>record.key),arguments:records.flatMap(record=>[record.expiresAt===-1?'0':String(record.expiresAt),Buffer.from(record.dump,'base64')])}):0;
  return {restored,expiredSkipped:document.records.length-records.length};
}
async function main(){
  const [mode,file]=process.argv.slice(2);if(!['export','import'].includes(mode)||!file)throw Error('Dùng: node scripts/data-transfer.js export|import <file.json>');
  const url=mode==='export'?process.env.REDIS_URL:process.env.IMPORT_REDIS_URL;if(!url)throw Error('Thiếu '+(mode==='export'?'REDIS_URL':'IMPORT_REDIS_URL'));
  const client=createClient({url,socket:{reconnectStrategy:false}});client.on('error',()=>{});
  try{await client.connect();if(mode==='export'&&await client.lLen('order:processing'))throw Error('Còn đơn đang xử lý; đợi xong và tạm dừng worker trước khi xuất.');console.log(JSON.stringify(await(mode==='export'?exportData(client,file):importData(client,file))));}
  finally{if(client.isOpen)await client.quit();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={exportData,importData};
