const {stockLua}=require('./stock-policy');
const isNewer=(a,b)=>{const [at,as]=a.split('-').map(BigInt),[bt,bs]=b.split('-').map(BigInt);return at>bt||(at===bt&&as>bs);};
function registerOrderActions(app,redis,requireAdmin){
 app.post('/api/orders/:id/cancel',requireAdmin,async(req,res)=>{
  const id=req.params.id,reason=req.body?.reason;
  if(!/^[A-Za-z0-9_-]{1,60}$/.test(id)||typeof reason!=='string'||!reason.trim()||reason.trim().length>300)return res.status(400).json({error:'Nhập lý do hủy đơn, tối đa 300 ký tự.'});
  const result=await redis.eval(stockLua+`
   local k=KEYS[1];if redis.call('TYPE',k).ok~='hash' then return -1 end
   local state=redis.call('HGET',k,'status');if state=='CANCELLED' then return 2 end
   if state=='COMPLETED' then return 0 end
   if state~='PENDING' and state~='PROCESSING' and state~='WAITING_STOCK' and state~='FAILED' and state~='RETRYING' then return 0 end
   destinations(k)
   redis.call('HSET',k,'status','CANCELLED','cancelledAt',ARGV[2],'cancelReason',ARGV[3],'cancelledBy',ARGV[4],'errorMessage',ARGV[3])
   redis.call('HDEL',k,'nextRetryAt')
   for _,s in ipairs({'PENDING','PROCESSING','WAITING_STOCK','FAILED','RETRYING'}) do redis.call('SREM','order:status:'..s,ARGV[1]) end
   redis.call('LREM','order:queue',0,ARGV[1]);redis.call('LREM','order:processing',0,ARGV[1]);redis.call('ZREM','order:stock-wait',ARGV[1]);redis.call('ZREM','order:retry',ARGV[1])
   redis.call('SADD','order:status:CANCELLED',ARGV[1])
   record(k,'CANCELLED','Quản trị hủy đơn: '..ARGV[3],ARGV[2])
   notice(k,'CANCELLED','Đơn '..ARGV[1]..' đã được hủy. Lý do: '..ARGV[3],ARGV[2],true,true)
   return 1
  `,{keys:['order:'+id],arguments:[id,new Date().toISOString(),reason.trim(),req.user.userId]});
  if(result===-1)return res.status(404).json({error:'Không tìm thấy đơn hàng.'});
  if(result===0)return res.status(409).json({error:'Đơn đã được xác nhận hoặc không còn ở trạng thái cho phép hủy.'});
  res.json(await redis.hGetAll('order:'+id));
 });
 app.get('/api/notifications',async(req,res)=>{
  const key=req.user.role==='admin'?'notification:admin':'notification:user:'+req.user.userId;
  const marker=await redis.get('notification:read:'+req.user.userId)||'0-0';
  const [rows,unread]=await Promise.all([redis.xRevRange(key,'+','-',{COUNT:50}),redis.xRange(key,'('+marker,'+',{COUNT:101})]);
  res.json({notifications:rows.map(row=>({id:row.id,...row.message,unread:isNewer(row.id,marker)})),unreadCount:Math.min(unread.length,100),hasMoreUnread:unread.length>100});
 });
 app.post('/api/notifications/read',async(req,res)=>{
  const id=req.body?.lastSeenId;if(typeof id!=='string'||!/^\d{1,20}-\d{1,20}$/.test(id))return res.status(400).json({error:'Mốc thông báo không hợp lệ.'});
  const key=req.user.role==='admin'?'notification:admin':'notification:user:'+req.user.userId;
  const rows=await redis.xRange(key,id,id,{COUNT:1});if(!rows.length)return res.status(404).json({error:'Thông báo không còn tồn tại.'});
  await redis.eval(`
   local previous=redis.call('GET',KEYS[1]) or '0-0'
   local function greater(a,b)
    local at,as=string.match(a,'^(%d+)%-(%d+)$');local bt,bs=string.match(b,'^(%d+)%-(%d+)$')
    if #at~=#bt then return #at>#bt end;if at~=bt then return at>bt end
    if #as~=#bs then return #as>#bs end;return as>bs
   end
   if greater(ARGV[1],previous) then redis.call('SET',KEYS[1],ARGV[1]) end;return 1
  `,{keys:['notification:read:'+req.user.userId],arguments:[rows[0].id]});
  res.json({ok:true});
 });
}
module.exports={registerOrderActions};
