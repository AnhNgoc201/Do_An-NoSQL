const {stockLua}=require('./stock-policy');
const stages={packing:{queue:'fulfillment:packing:queue',active:'fulfillment:packing:active',ready:'COMPLETED',working:'PACKING',done:'READY_TO_SHIP',role:'warehouse'},shipping:{queue:'fulfillment:shipping:queue',active:'fulfillment:shipping:active',ready:'READY_TO_SHIP',working:'SHIPPING',done:'DELIVERED',role:'delivery'}};
const fulfillmentLua=`
local function fulfillmentDestinations()
 for _,key in ipairs({'fulfillment:packing:queue','fulfillment:packing:active','fulfillment:shipping:queue','fulfillment:shipping:active'}) do check(key,'list') end
 for _,s in ipairs({'PACKING','READY_TO_SHIP','SHIPPING','DELIVERED'}) do check('order:status:'..s,'set') end
end
`;
async function migrateFulfillment(redis){
 // Existing confirmed orders have already deducted stock. Enqueue without deducting again.
 const legacy=[];
 for await(const page of redis.sScanIterator('order:status:COMPLETED',{COUNT:100})){
  for(const id of page){const row=await redis.hGetAll('order:'+id);if(row.status==='COMPLETED'&&!row.fulfillmentQueuedAt)legacy.push(row);}
 }
 legacy.sort((a,b)=>Date.parse(a.processedAt||a.createdAt)-Date.parse(b.processedAt||b.createdAt)||a.orderId.localeCompare(b.orderId));
 for(const row of legacy){const id=row.orderId;await redis.eval(stockLua+fulfillmentLua+`
   local k=KEYS[1];check(k,'hash');fulfillmentDestinations()
   if redis.call('HGET',k,'status')~='COMPLETED' or redis.call('HGET',k,'fulfillmentQueuedAt') then return 0 end
   redis.call('LREM','fulfillment:packing:queue',0,ARGV[1]);redis.call('RPUSH','fulfillment:packing:queue',ARGV[1])
   redis.call('HSET',k,'fulfillmentQueuedAt',ARGV[2]);return 1
  `,{keys:['order:'+id],arguments:[id,new Date().toISOString()]});
 }
}
function registerFulfillment(app,redis,auth){
 const allowed=(req,res,next)=>{if(!['admin','warehouse','delivery'].includes(req.user?.role))return res.status(403).json({error:'Chỉ dành cho nhân viên vận hành.'});next();};
 app.get('/api/fulfillment',allowed,async(req,res)=>{
  const visible=req.user.role==='admin'?Object.keys(stages):Object.keys(stages).filter(s=>stages[s].role===req.user.role);
  const result={stages:{}};
  for(const stage of visible){const s=stages[stage];const waiting=await redis.lRange(s.queue,0,-1),active=await redis.lRange(s.active,0,-1);const ids=[...new Set([...waiting,...active])];const orders=[];for(const id of ids){const order=await redis.hGetAll('order:'+id);if([s.ready,s.working].includes(order.status))orders.push(order);}result.stages[stage]={waiting,active,orders};}
  // Staff see only their assigned tasks in the completed list.
  const statuses=req.user.role==='warehouse'?['READY_TO_SHIP','SHIPPING','DELIVERED']:['DELIVERED'];const done=[];
  for(const status of statuses){for await(const page of redis.sScanIterator('order:status:'+status,{COUNT:100})){for(const id of page){const order=await redis.hGetAll('order:'+id);if(req.user.role==='admin'||order[req.user.role==='warehouse'?'packingUserId':'shippingUserId']===req.user.userId)done.push(order);}}}
  result.recent=done.sort((a,b)=>String(b.deliveredAt||b.packedAt).localeCompare(String(a.deliveredAt||a.packedAt))).slice(0,30);res.json(result);
 });
 app.post('/api/fulfillment/:stage/:action',allowed,async(req,res)=>{
  const s=stages[req.params.stage],action=req.params.action;
  if(!s||!['claim','complete'].includes(action))return res.status(404).json({error:'Thao tác không tồn tại.'});
  if(req.user.role!=='admin'&&req.user.role!==s.role)return res.status(403).json({error:'Bạn không phụ trách công đoạn này.'});
  const id=req.body?.orderId;if(action==='complete'&&(typeof id!=='string'||!/^[-\w]{1,60}$/.test(id)))return res.status(400).json({error:'Mã đơn không hợp lệ.'});
  const stage=req.params.stage,field=stage==='packing'?'packingUserId':'shippingUserId',nameField=stage==='packing'?'packingUserName':'shippingUserName';
  const result=await redis.eval(stockLua+fulfillmentLua+`
   fulfillmentDestinations()
   local action=ARGV[1];local id=ARGV[2]
   if action=='claim' then
    -- Each employee works on one task at a time; repeated clicks return that task.
    for _,existing in ipairs(redis.call('LRANGE',KEYS[2],0,-1)) do
     if redis.call('HGET','order:'..existing,ARGV[8])==ARGV[3] and redis.call('HGET','order:'..existing,'status')==ARGV[6] then return {1,existing} end
    end
    id=redis.call('LINDEX',KEYS[1],0);if not id then return {0,''} end
   end
   local k='order:'..id;check(k,'hash');destinations(k)
   local state=redis.call('HGET',k,'status')
   if not state then return {-1,id} end
   if action=='claim' then
    if state~=ARGV[5] then return {-2,id} end
    redis.call('LMOVE',KEYS[1],KEYS[2],'LEFT','RIGHT')
    redis.call('HSET',k,'status',ARGV[6],ARGV[8],ARGV[3],ARGV[9],ARGV[4],ARGV[10],ARGV[11])
    redis.call('SREM','order:status:'..state,id);redis.call('SADD','order:status:'..ARGV[6],id)
    record(k,ARGV[6],ARGV[12],ARGV[11]);notice(k,ARGV[6],'Đơn '..id..': '..ARGV[12],ARGV[11],true,true)
   else
    -- Completion is idempotent only for the assigned employee (or admin).
    if redis.call('HGET',k,ARGV[8])~=ARGV[3] and ARGV[13]~='admin' then return {-3,id} end
    if state==ARGV[7] or (ARGV[7]=='READY_TO_SHIP' and (state=='SHIPPING' or state=='DELIVERED')) then return {1,id} end
    if state~=ARGV[6] then return {-2,id} end
    redis.call('HSET',k,'status',ARGV[7],ARGV[10],ARGV[11]);redis.call('LREM',KEYS[2],0,id)
    redis.call('SREM','order:status:'..state,id);redis.call('SADD','order:status:'..ARGV[7],id)
    if ARGV[7]=='READY_TO_SHIP' then redis.call('RPUSH','fulfillment:shipping:queue',id) end
    record(k,ARGV[7],ARGV[12],ARGV[11]);notice(k,ARGV[7],'Đơn '..id..': '..ARGV[12],ARGV[11],true,true)
   end
   return {1,id}
  `,{keys:[s.queue,s.active],arguments:[action,id||'',req.user.userId,req.user.name,s.ready,s.working,s.done,field,nameField,action==='claim'?(stage==='packing'?'packingStartedAt':'shippingStartedAt'):(stage==='packing'?'packedAt':'deliveredAt'),new Date().toISOString(),action==='claim'?(stage==='packing'?'Nhân viên kho đang đóng gói.':'Nhân viên giao hàng đã nhận đơn, đang giao đến bạn.'):(stage==='packing'?'Đã đóng gói, chờ bàn giao vận chuyển.':'Đã giao hàng thành công.'),req.user.role]});
  const [code,orderId]=result;if(code===0)return res.json({order:null,message:'Hiện chưa có đơn chờ trong hàng đợi.'});
  if(code===-1)return res.status(404).json({error:'Không tìm thấy đơn.'});
  if(code===-3)return res.status(403).json({error:'Đơn đang do nhân viên khác phụ trách.'});
  if(code===-2)return res.status(409).json({error:'Trạng thái đơn đã thay đổi. Vui lòng làm mới.'});
  res.json({order:await redis.hGetAll('order:'+orderId)});
 });
 app.get('/api/staff',auth.requireAdmin,async(req,res)=>{const users=[];for await(const page of redis.scanIterator({MATCH:'auth:user:*',COUNT:100})){for(const k of page){if(await redis.type(k)!=='hash')continue;const u=await redis.hGetAll(k);if(['warehouse','delivery'].includes(u.role))users.push(auth.publicUser(u));}}res.json(users);});
 app.post('/api/staff',auth.requireAdmin,async(req,res)=>{
  const {name,email,password,role}=req.body||{};
  if(typeof name!=='string'||!name.trim()||name.trim().length>100||typeof email!=='string'||email.length>200||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())||typeof password!=='string'||password.length<12||password.length>128||!['warehouse','delivery'].includes(role))return res.status(400).json({error:'Nhập tên, email, bộ phận và mật khẩu từ 12 đến 128 ký tự.'});
  const user=await auth.createUser(name.trim(),email.trim().toLowerCase(),password,role);if(!user)return res.status(409).json({error:'Email đã được sử dụng.'});res.status(201).json(auth.publicUser(user));
 });
}
module.exports={registerFulfillment,migrateFulfillment,fulfillmentLua};
