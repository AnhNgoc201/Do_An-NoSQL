const STOCK_WINDOW_MS=24*60*60*1000;
// Shared by atomic Redis transitions. Validate every destination before writing.
const stockLua=`
local function check(k,t) local a=redis.call('TYPE',k).ok;if a~='none' and a~=t then error('Wrong type: '..k) end end
local function clockMs() local t=redis.call('TIME');return tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000) end
local function destinations(k)
 check('order:queue','list');check('order:processing','list');check('order:stock-wait','zset');check('order:retry','zset');check('order:created','zset');check('order:events','stream')
 for _,s in ipairs({'PENDING','PROCESSING','WAITING_STOCK','COMPLETED','FAILED','CANCELLED','RETRYING'}) do check('order:status:'..s,'set') end
 check('notification:admin','stream')
 local user=redis.call('HGET',k,'userId');if user and user~='' then check('notification:user:'..user,'stream') end
end
local function notice(k,event,message,at,admin,customer)
 local id=redis.call('HGET',k,'orderId') or string.sub(k,7)
 if admin then redis.call('XADD','notification:admin','MAXLEN','~',200,'*','orderId',id,'event',event,'message',message,'createdAt',at,'href','/admin.html#order-list') end
 local user=redis.call('HGET',k,'userId')
 if customer and user and user~='' then redis.call('XADD','notification:user:'..user,'MAXLEN','~',200,'*','orderId',id,'event',event,'message',message,'createdAt',at,'href','/#tracking') end
end
local function record(k,event,message,at)
 redis.call('XADD','order:events','*','orderId',redis.call('HGET',k,'orderId') or string.sub(k,7),'event',event,'message',message,'createdAt',at)
end
local function stock(k)
 local raw=redis.call('HGET',k,'items');local items
 if raw then local ok,data=pcall(cjson.decode,raw);if not ok or type(data)~='table' then return false,false,{},{} end;items=data
 else items={{productId=redis.call('HGET',k,'productId'),quantity=redis.call('HGET',k,'quantity'),size=redis.call('HGET',k,'size')}} end
 if #items==0 then return false,false,{},{} end
 local demands={};local sizes={}
 for _,item in ipairs(items) do
  if type(item)~='table' or type(item.productId)~='string' then return false,false,{},{} end
  local pk='product:'..item.productId;check(pk,'hash')
  local qty=tonumber(item.quantity)
  if not qty or qty<1 or qty~=math.floor(qty) or redis.call('EXISTS',pk)==0 then return false,false,{},{} end
  demands[pk]=(demands[pk] or 0)+qty
  if redis.call('HEXISTS',pk,'sizes')==1 then
   if type(item.size)~='string' then return false,false,{},{} end
   if not sizes[pk] then sizes[pk]={} end
   local field='stock:'..item.size;sizes[pk][field]=(sizes[pk][field] or 0)+qty
  end
 end
 local enough=true
 for pk,qty in pairs(demands) do local n=tonumber(redis.call('HGET',pk,'stock'));if not n or n<0 or n~=math.floor(n) then return false,false,{},{} end;if n<qty then enough=false end end
 for pk,fields in pairs(sizes) do for field,qty in pairs(fields) do local n=tonumber(redis.call('HGET',pk,field));if not n or n<0 or n~=math.floor(n) then return false,false,{},{} end;if n<qty then enough=false end end end
 return true,enough,demands,sizes
end
local function deadline(k,now)
 local existing=tonumber(redis.call('HGET',k,'stockWaitDeadlineAt'))
 if existing then return existing end
 local id=redis.call('HGET',k,'orderId') or string.sub(k,7)
 local created=tonumber(redis.call('HGET',k,'createdAtMs')) or tonumber(redis.call('ZSCORE','order:created',id)) or now
 return created+${STOCK_WINDOW_MS}
end
local function expireNotice(k,at)
 local state=redis.call('HGET',k,'status')
 if state~='WAITING_STOCK' and state~='PENDING' and state~='PROCESSING' and state~='FAILED' and state~='RETRYING' then return end
 local id=redis.call('HGET',k,'orderId') or string.sub(k,7)
 local reason='Không bổ sung đủ hàng trong 24 giờ từ lúc đặt. Hệ thống tự động hủy đơn; chưa trừ kho.'
 redis.call('HSET',k,'status','CANCELLED','stockWaitExpired','1','stockWaitDeadlineAt',deadline(k,clockMs()),'cancelledAt',at,'cancelledBy','system','cancelReason',reason,'errorMessage',reason,'failureCode','STOCK_WAIT_EXPIRED')
 redis.call('HDEL',k,'nextRetryAt')
 for _,s in ipairs({'PENDING','PROCESSING','WAITING_STOCK','FAILED','RETRYING'}) do redis.call('SREM','order:status:'..s,id) end
 redis.call('LREM','order:queue',0,id);redis.call('LREM','order:processing',0,id)
 redis.call('ZREM','order:stock-wait',id);redis.call('ZREM','order:retry',id)
 redis.call('SADD','order:status:CANCELLED',id)
 record(k,'CANCELLED',reason,at)
 notice(k,'CANCELLED','Đơn '..id..' đã tự động hủy. '..reason,at,true,true)
end
local function waitStock(k,now,at)
 local id=redis.call('HGET',k,'orderId') or string.sub(k,7);local untilMs=deadline(k,now)
 if now>=untilMs then expireNotice(k,at);return end
 redis.call('HSET',k,'status','WAITING_STOCK','stockWaitDeadlineAt',untilMs,'failureCode','OUT_OF_STOCK','errorMessage','Cửa hàng đang chờ bổ sung hàng. Đơn tự động hủy nếu không đủ hàng trong 24 giờ từ lúc đặt.')
 redis.call('HSETNX',k,'stockWaitStartedAt',at)
 redis.call('HDEL',k,'processedAt','nextRetryAt')
 for _,s in ipairs({'PENDING','PROCESSING','FAILED','RETRYING'}) do redis.call('SREM','order:status:'..s,id) end
 redis.call('LREM','order:queue',0,id);redis.call('LREM','order:processing',0,id);redis.call('ZREM','order:retry',id)
 redis.call('SADD','order:status:WAITING_STOCK',id);redis.call('ZADD','order:stock-wait',untilMs,id)
 if redis.call('HGET',k,'stockWaitNotified')~='1' then
  redis.call('HSET',k,'stockWaitNotified','1')
  record(k,'WAITING_STOCK','Thiếu hàng, giữ đơn chờ bổ sung kho; chưa trừ kho.',at)
  notice(k,'WAITING_STOCK','Đơn '..id..' chưa đủ hàng. Hãy bổ sung kho trong 24 giờ từ lúc đặt hoặc hủy đơn nếu không có nguồn cung.',at,true,false)
  notice(k,'WAITING_STOCK','Đơn '..id..' đang chờ bổ sung hàng. Đơn sẽ tự động hủy nếu không đủ hàng trong 24 giờ từ lúc đặt.',at,false,true)
 end
end
`;
const refreshStockWait=stockLua+`
check('order:status:WAITING_STOCK','set')
local page=redis.call('SSCAN','order:status:WAITING_STOCK',ARGV[1],'COUNT',50)
local now=clockMs()
check('order:stock-wait','zset')
for _,id in ipairs(redis.call('ZRANGEBYSCORE','order:stock-wait','-inf',now,'LIMIT',0,100)) do
 local k='order:'..id;check(k,'hash');local state=redis.call('HGET',k,'status')
 if state=='WAITING_STOCK' or state=='PENDING' or state=='PROCESSING' then destinations(k);waitStock(k,now,ARGV[2]) else redis.call('ZREM','order:stock-wait',id) end
end
for _,id in ipairs(page[2]) do
 local k='order:'..id;check(k,'hash')
 if redis.call('HGET',k,'status')=='WAITING_STOCK' then
  destinations(k)
  if now>=deadline(k,now) then expireNotice(k,ARGV[2])
  else
   local valid,enough=stock(k)
   if valid and enough then
    redis.call('HSET',k,'status','PENDING','errorMessage','','failureCode','')
    redis.call('SREM','order:status:WAITING_STOCK',id)
    redis.call('SADD','order:status:PENDING',id);redis.call('RPUSH','order:queue',id)
    record(k,'STOCK_AVAILABLE','Đã có đủ hàng, đưa đơn về cuối hàng đợi để xác nhận.',ARGV[2])
   end
  end
 else redis.call('SREM','order:status:WAITING_STOCK',id) end
end
return page[1]
`;
async function migrateStockWait(redis){
 let migrated=0;
 for(const state of ['FAILED','RETRYING'])for await(const batch of redis.sScanIterator('order:status:'+state,{COUNT:100}))for(const id of batch){
  migrated+=Number(await redis.eval(stockLua+`
   local k=KEYS[1];if redis.call('TYPE',k).ok~='hash' then return 0 end
   local state=redis.call('HGET',k,'status');local reason=redis.call('HGET',k,'failureCode')
   if not ((state=='FAILED' and reason=='OUT_OF_STOCK') or state=='RETRYING') then return 0 end
   destinations(k);waitStock(k,clockMs(),ARGV[1]);return 1
  `,{keys:['order:'+id],arguments:[new Date().toISOString()]}));
 }
 return migrated;
}
module.exports={STOCK_WINDOW_MS,stockLua,refreshStockWait,migrateStockWait};
