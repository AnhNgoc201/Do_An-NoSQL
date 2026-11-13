require('dotenv').config();
const express = require('express');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');
const { createWorker } = require('./worker');
const {migrateStockWait}=require('./stock-policy');
const { seedCatalog } = require('./catalog');
const { createAuth } = require('./auth');
const { registerProductManagement } = require('./products');
const { registerOrderActions } = require('./order-actions');
const {registerFulfillment,migrateFulfillment}=require('./fulfillment');

const app = express();
const port = Number(process.env.PORT || 3000);
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379/1';
const database = Number(new URL(redisUrl).pathname.slice(1) || 0);
const redis = createClient({ url: redisUrl });
const worker = createWorker(redis);
const auth = createAuth(redis);
redis.on('error', (error) => console.error('Redis:', error.message));
app.use(express.json());
app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');if(req.path.startsWith('/api/'))res.set('Cache-Control','no-store');if(!['GET','HEAD','OPTIONS'].includes(req.method)&&req.headers.origin){try{if(new URL(req.headers.origin).host!==req.get('host'))return res.status(403).json({error:'Nguồn yêu cầu không hợp lệ.'});}catch{return res.status(403).json({error:'Nguồn yêu cầu không hợp lệ.'});}}next();});
app.use(auth.resolve);
auth.routes(app);
app.use('/api',(req,res,next)=>{
 const publicRoute=req.path==='/health'||req.path.startsWith('/auth/')||(req.path==='/products'&&req.method==='GET')||(req.path==='/contact'&&req.method==='POST');
 if(publicRoute)return next();
 if(['warehouse','delivery'].includes(req.user?.role)&&!req.path.startsWith('/fulfillment')&&!req.path.startsWith('/notifications'))return res.status(403).json({error:'Tài khoản nhân viên chỉ sử dụng chức năng vận hành.'});
 const adminRoute=req.path==='/worker'||req.path==='/events'||req.path.startsWith('/demo/')||(req.path==='/products'&&req.method!=='GET')||(req.path==='/contact'&&req.method==='GET')||(req.path==='/customers'&&req.method==='GET');
 return (adminRoute?auth.requireAdmin:auth.requireUser)(req,res,next);
});
app.get('/admin.html',(req,res,next)=>{if(!req.user)return res.redirect('/login.html?next=%2Fadmin.html');if(req.user.role!=='admin')return res.status(403).send('<meta charset="utf-8"><p>Trang này chỉ dành cho chủ shop.</p><a href="/">Quay về cửa hàng</a>');next();});
app.get('/fulfillment.html',(req,res,next)=>{if(!req.user)return res.redirect('/login.html?next=%2Ffulfillment.html');if(!['admin','warehouse','delivery'].includes(req.user.role))return res.status(403).send('<meta charset="utf-8"><p>Trang này dành cho nhân viên vận hành.</p><a href="/">Về cửa hàng</a>');next();});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (req, res) => {
  res.json({ redis: await redis.ping(), database, host:new URL(redisUrl).hostname, port:Number(new URL(redisUrl).port||6379) });
});
app.get('/api/profile',async(req,res)=>{
  const profile=req.user.customerId?await redis.hGetAll('customer:'+req.user.customerId):{};
  res.json({name:profile.name||req.user.name,phone:profile.phone||'',address:profile.address||''});
});

async function listHashes(prefix, idField) {
  const items = [], seen = new Set();
  for await (const keys of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (await redis.type(key) !== 'hash') continue;
      const item = await redis.hGetAll(key);
      if (item[idField]) items.push(item);
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

app.get('/api/customers', async (req, res) => res.json(await listHashes('customer', 'customerId')));
app.get('/api/products', async (req, res) => res.json(await listHashes('product', 'productId')));
app.get('/api/worker', async (req,res)=>res.json({...worker.status(),queue:await redis.lRange('order:queue',0,-1),processing:await redis.lRange('order:processing',0,-1),stockWait:await redis.zRangeWithScores('order:stock-wait',0,-1)}));
app.post('/api/worker', async(req,res)=>{
  const body=req.body||{},hasEnabled=Object.hasOwn(body,'enabled'),hasDelay=Object.hasOwn(body,'processingDelayMs');
  if(!hasEnabled&&!hasDelay)return res.status(400).json({error:'Chọn trạng thái xử lý hoặc thời gian xử lý.'});
  if(hasEnabled&&typeof body.enabled!=='boolean')return res.status(400).json({error:'enabled phải là boolean'});
  if(hasDelay&&(!Number.isInteger(body.processingDelayMs)||body.processingDelayMs<1000||body.processingDelayMs>60000||body.processingDelayMs%1000!==0))return res.status(400).json({error:'Thời gian xử lý phải từ 1 đến 60 giây, theo từng giây.'});
  if(hasDelay)await worker.setProcessingDelay(body.processingDelayMs);
  if(hasEnabled)worker.setEnabled(body.enabled);
  res.json(worker.status());
});
app.get('/api/events',async(req,res)=>res.json(await redis.xRevRange('order:events','+','-',{COUNT:30})));

app.post('/api/contact', async (req,res)=>{
  const {name,email,subject,message}=req.body||{};
  if(typeof name!=='string'||!name.trim()||name.length>100||typeof email!=='string'||email.length>200||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||
     !['Tư vấn sản phẩm & chọn size','Hỗ trợ đơn hàng','Góp ý về cửa hàng'].includes(subject)||typeof message!=='string'||message.trim().length<10||message.length>2000)
    return res.status(400).json({error:'Nhập họ tên, email hợp lệ và nội dung từ 10 đến 2000 ký tự.'});
  const ticket={ticketId:'HT-'+randomUUID(),name:name.trim(),email:email.trim(),subject,message:message.trim(),createdAt:new Date().toISOString()};
  await redis.hSet('support:'+ticket.ticketId,ticket);
  res.status(201).json({ticketId:ticket.ticketId});
});
app.get('/api/contact',async(req,res)=>{
  const tickets=await listHashes('support','ticketId');
  tickets.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
  res.json(tickets);
});

app.post('/api/customers', async (req, res) => {
  const { name, phone, address } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
      typeof phone !== 'string' || !/^[0-9+() .-]{8,20}$/.test(phone.trim()) ||
      typeof address !== 'string' || !address.trim() || address.trim().length > 300) {
    return res.status(400).json({ error: 'Nhập tên (tối đa 100 ký tự), số điện thoại (8–20 ký tự) và địa chỉ (tối đa 300 ký tự).' });
  }
  const customer = { userId:req.user.userId, customerId: req.user.role==='admin'?'KH-'+randomUUID():req.user.customerId, name: name.trim(), phone: phone.trim(), address: address.trim(), createdAt: new Date().toISOString() };
  await redis.hSet(`customer:${customer.customerId}`, customer);
  res.status(201).json(customer);
});

app.post('/api/products', async (req, res) => {
  const { name, price, stock, sizes = ['ONE SIZE'], category = 'Áo', image = '', description = '', material = '', color = '' } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 ||
      !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0 ||
      !Array.isArray(sizes) || !sizes.length || sizes.length > 8 || sizes.some(s=>typeof s!=='string'||!/^[A-Z0-9 -]{1,12}$/.test(s)) || new Set(sizes).size!==sizes.length || !Number.isSafeInteger(stock*sizes.length) ||
      [description,material,color].some(v=>typeof v!=='string'||v.length>2000) || !['Áo','Quần','Váy'].includes(category) || typeof image!=='string' || image.length>2000 || (image && !/^https?:\/\//i.test(image))) {
    return res.status(400).json({ error: 'Nhập tên sản phẩm (tối đa 100 ký tự), giá nguyên dương và tồn kho nguyên không âm.' });
  }
  const product = { productId: 'SP-' + randomUUID(), name: name.trim(), price: String(price), stock: String(stock*sizes.length), sizes:JSON.stringify(sizes),category,image,description,material,color, createdAt: new Date().toISOString() };
  for(const size of sizes) product['stock:'+size]=String(stock);
  await redis.hSet(`product:${product.productId}`, product);
  res.status(201).json(product);
});

app.post('/api/demo/catalog',async(req,res)=>res.json({added:await seedCatalog(redis)}));
registerProductManagement(app,redis,auth.requireAdmin);
registerOrderActions(app,redis,auth.requireAdmin);
registerFulfillment(app,redis,auth);

// Validate key types before writing: a Lua runtime error does not roll back writes.
const createOrderScript = `
local expected = {'hash','list','set','zset','stream'}
for i=1,5 do
  local t = redis.call('TYPE', KEYS[i]).ok
  if t ~= 'none' and t ~= expected[i] then
    return redis.error_reply('Unexpected key type: ' .. KEYS[i])
  end
end
if redis.call('EXISTS', KEYS[1]) == 1 then return redis.error_reply('Order ID already exists') end
local items=cjson.decode(ARGV[11])
for _,item in ipairs(items) do
 local product='product:'..item.productId
 if redis.call('TYPE',product).ok~='hash' or redis.call('HEXISTS',product,'productId')==0 then return redis.error_reply('PRODUCT_CHANGED') end
 if tonumber(redis.call('HGET',product,'price'))~=tonumber(item.unitPrice) then return redis.error_reply('PRODUCT_CHANGED') end
end
redis.call('HSET', KEYS[1], 'orderId', ARGV[1], 'customerId', ARGV[2],
 'productId', ARGV[3], 'quantity', ARGV[4], 'unitPrice', ARGV[5],
 'totalAmount', ARGV[6], 'status', 'PENDING', 'createdAtMs',ARGV[8],'createdAt', ARGV[7], 'retryCount', '0', 'size', ARGV[9], 'productName', ARGV[10], 'items', ARGV[11], 'userId', ARGV[12], 'customerName', ARGV[13], 'customerPhone', ARGV[14], 'customerAddress', ARGV[15])
redis.call('RPUSH', KEYS[2], ARGV[1])
redis.call('SADD', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[4], ARGV[8], ARGV[1])
redis.call('XADD', KEYS[5], '*', 'orderId', ARGV[1], 'event', 'CREATED', 'status', 'PENDING', 'createdAt', ARGV[7])
return ARGV[1]
`;

app.post('/api/orders', async (req, res) => {
  const customerId=req.user.role==='admin'?req.body?.customerId:req.user.customerId;
  const raw = req.body?.items ?? [{productId:req.body?.productId,quantity:req.body?.quantity,size:req.body?.size}];
  if(typeof customerId!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(customerId)||!Array.isArray(raw)||!raw.length||raw.length>50)
    return res.status(400).json({error:'Chọn khách hàng và từ 1 đến 50 dòng sản phẩm.'});
  const customer=await redis.hGetAll('customer:'+customerId);
  if(!customer.customerId)return res.status(400).json({error:'Vui lòng nhập thông tin nhận hàng trước khi đặt.'});
  if(req.user.role!=='admin'&&customer.userId!==req.user.userId)return res.status(403).json({error:'Thông tin nhận hàng không thuộc tài khoản này.'});
  const merged=new Map();let totalAmount=0;
  for(const item of raw){
    if(!item||typeof item.productId!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(item.productId)||!Number.isSafeInteger(item.quantity)||item.quantity<1||item.quantity>100000)
      return res.status(400).json({error:'Sản phẩm hoặc số lượng không hợp lệ.'});
    const p=await redis.hGetAll('product:'+item.productId);
    if(!p.productId)return res.status(400).json({error:'Sản phẩm không còn tồn tại.'});
    const sizes=p.sizes?JSON.parse(p.sizes):['ONE SIZE'];const size=item.size||(sizes.length===1?sizes[0]:null);
    if(!sizes.includes(size))return res.status(400).json({error:'Hãy chọn size hợp lệ cho '+p.name});
    const price=Number(p.price);const key=item.productId+'|'+size;
    const quantity=item.quantity+(merged.get(key)?.quantity||0);
    if(!Number.isSafeInteger(price)||price<1||quantity>100000||!Number.isSafeInteger(price*quantity))return res.status(400).json({error:'Giá hoặc số lượng không hợp lệ.'});
    merged.set(key,{productId:p.productId,productName:p.name,size,quantity,unitPrice:price,lineTotal:price*quantity});
  }
  const items=[...merged.values()];for(const item of items)totalAmount+=item.lineTotal;
  if(!Number.isSafeInteger(totalAmount))return res.status(400).json({error:'Tổng tiền quá lớn.'});
  const first=items[0],orderId='ORD-'+randomUUID(),now=Date.now(),createdAt=new Date(now).toISOString();
  try { await redis.eval(createOrderScript,{
    keys:['order:'+orderId,'order:queue','order:status:PENDING','order:created','order:events'],
    arguments:[orderId,customerId,first.productId,String(items.reduce((n,i)=>n+i.quantity,0)),String(first.unitPrice),String(totalAmount),createdAt,String(now),first.size,items.length===1?first.productName:items.map(i=>i.productName+' ('+i.size+') × '+i.quantity).join('; '),JSON.stringify(items),customer.userId||req.user.userId,customer.name||'',customer.phone||'',customer.address||'']
  }); } catch(error) { if(error.message.includes('PRODUCT_CHANGED'))return res.status(409).json({error:'Sản phẩm hoặc giá vừa thay đổi. Vui lòng tải lại giỏ hàng trước khi đặt.'});throw error; }
  res.status(201).json(await redis.hGetAll('order:'+orderId));
});

app.get('/api/orders', async (req, res) => {
  const orders = [];
  const seen = new Set();
  // SCAN can return a key more than once; include only actual order hashes.
  for await (const keys of redis.scanIterator({ MATCH: 'order:*', COUNT: 100 })) {
    for (const key of keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (await redis.type(key) !== 'hash') continue;
      const order = await redis.hGetAll(key);
      if (order.orderId&&(req.user.role==='admin'||order.userId===req.user.userId)) orders.push(order);
    }
  }
  orders.sort((a, b) => a.orderId.localeCompare(b.orderId, undefined, { numeric: true }));
  res.json({ count: orders.length, orders });
});

app.get('/api/orders/:id', async (req, res) => {
  const order = await redis.hGetAll(`order:${req.params.id}`);
  if (!Object.keys(order).length||(req.user.role!=='admin'&&order.userId!==req.user.userId)) return res.status(404).json({ error: 'Khong tim thay don hang' });
  res.json(order);
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status === 400 ? 400 : 500).json({ error: error.status === 400 ? 'Dữ liệu JSON không hợp lệ' : 'Không thể thực hiện thao tác Redis. Kiểm tra kết nối và kiểu dữ liệu các key.' });
});

async function start() {
  await redis.connect();
  await auth.bootstrap();
  await migrateStockWait(redis);
  await migrateFulfillment(redis);
  await worker.initialize();
  app.listen(port, '127.0.0.1', () => console.log(`Backend: http://localhost:${port}`));
}

start().catch((error) => {
  console.error('Khong khoi dong duoc backend:', error.message);
  process.exit(1);
});
