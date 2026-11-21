const {stockLua,refreshStockWait,STOCK_WINDOW_MS}=require('./stock-policy');
const {fulfillmentLua}=require('./fulfillment');
const claim=stockLua+`
check('order:queue','list');check('order:processing','list');check('order:events','stream');check('order:status:PENDING','set');check('order:status:PROCESSING','set')
local id=redis.call('LINDEX','order:processing',0)
if id then return id end
id=redis.call('LINDEX','order:queue',0);if not id then return false end
local k='order:'..id;check(k,'hash')
if redis.call('HGET',k,'status')~='PENDING' then redis.call('LPOP','order:queue');return false end
redis.call('LMOVE','order:queue','order:processing','LEFT','RIGHT')
redis.call('HSET',k,'status','PROCESSING','processingStartedAt',ARGV[1]);redis.call('HINCRBY',k,'attemptCount',1)
redis.call('SREM','order:status:PENDING',id);redis.call('SADD','order:status:PROCESSING',id)
record(k,'PROCESSING','Đang kiểm tra tồn kho.',ARGV[1]);return id
`;
const finish=stockLua+fulfillmentLua+`
local id=ARGV[1];local k='order:'..id;check(k,'hash');check('order:processing','list')
if redis.call('HGET',k,'status')~='PROCESSING' then redis.call('LREM','order:processing',0,id);return 'SKIPPED' end
destinations(k)
fulfillmentDestinations()
local now=clockMs();local untilMs=tonumber(redis.call('HGET',k,'stockWaitDeadlineAt'))
if untilMs and now>=untilMs then waitStock(k,now,ARGV[2]);return redis.call('HGET',k,'status') end
local valid,enough,demands,sizes=stock(k)
if valid and not enough then waitStock(k,now,ARGV[2]);return redis.call('HGET',k,'status') end
local status='FAILED';local message='Dữ liệu đơn hoặc sản phẩm không hợp lệ. Cần quản trị kiểm tra; chưa trừ kho.'
if valid and enough then
 status='COMPLETED';message=''
 for pk,qty in pairs(demands) do redis.call('HINCRBY',pk,'stock',-qty) end
 for pk,fields in pairs(sizes) do for field,qty in pairs(fields) do redis.call('HINCRBY',pk,field,-qty) end end
 redis.call('RPUSH','fulfillment:packing:queue',id);redis.call('HSET',k,'fulfillmentQueuedAt',ARGV[2])
end
redis.call('HSET',k,'status',status,'processedAt',ARGV[2],'errorMessage',message,'failureCode',status=='COMPLETED' and '' or 'INVALID_ORDER')
redis.call('LREM','order:processing',0,id);redis.call('SREM','order:status:PROCESSING',id);redis.call('SREM','order:status:WAITING_STOCK',id);redis.call('ZREM','order:stock-wait',id)
redis.call('SADD','order:status:'..status,id)
record(k,status,message,ARGV[2])
if status=='COMPLETED' then notice(k,'COMPLETED','Đơn '..id..' đã xác nhận đủ hàng và đang chờ đóng gói.',ARGV[2],true,true)
else notice(k,'ORDER_ERROR','Đơn '..id..' cần kiểm tra dữ liệu trước khi xử lý.',ARGV[2],true,false) end
return status
`;
function createWorker(redis){
 const configured=Number(process.env.WORKER_DELAY_MS||5000);
 let processingDelayMs=Number.isFinite(configured)&&configured>=100?Math.min(configured,60000):5000;
 let initialized=false,enabled=process.env.WORKER_AUTO_START!=='false',busy=false,activeOrder=null,activeUntil=null,lastError=null,cursor='0';
 const timer=setInterval(async()=>{
  if(!initialized||busy||!redis.isReady)return;
  busy=true;
  try{
   cursor=String(await redis.eval(refreshStockWait,{arguments:[cursor,new Date().toISOString()]}));
   if(!enabled)return;
   const id=await redis.eval(claim,{arguments:[new Date().toISOString()]});if(!id)return;
   activeOrder=id;const delayForThisOrder=processingDelayMs;activeUntil=Date.now()+delayForThisOrder;
   await new Promise(resolve=>setTimeout(resolve,delayForThisOrder));
   await redis.eval(finish,{arguments:[id,new Date().toISOString()]});lastError=null;
  }catch(error){lastError=error.message;enabled=false;console.error('Worker:',error.message);}
  finally{busy=false;activeOrder=null;activeUntil=null;}
 },500);timer.unref();
 return{
  status:()=>({enabled,busy,activeOrder,activeUntil,lastError,processingDelayMs,stockWaitWindowMs:STOCK_WINDOW_MS}),
  async initialize(){const saved=Number(await redis.get('settings:worker:delayMs'));if(Number.isInteger(saved)&&saved>=1000&&saved<=60000&&saved%1000===0)processingDelayMs=saved;initialized=true;},
  async setProcessingDelay(value){await redis.set('settings:worker:delayMs',String(value));processingDelayMs=value;return this.status();},
  setEnabled(value){enabled=value;return this.status();}
 };
}
module.exports={createWorker,claim,finish};
