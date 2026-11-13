// Requires a new, disposable Redis DB. Never run against the application's DB.
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createClient}=require('redis');
const {claim,finish}=require('./worker');
const {migrateFulfillment}=require('./fulfillment');
const redisUrl=process.env.TEST_FULFILLMENT_REDIS_URL;
if(!redisUrl)throw Error('Set TEST_FULFILLMENT_REDIS_URL to an empty disposable database.');
const redis=createClient({url:redisUrl,socket:{reconnectStrategy:false}});redis.on('error',()=>{});
const base='http://127.0.0.1:13011';let child;
async function api(cookie,path,body){const r=await fetch(base+path,{method:body?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
async function main(){
 await redis.connect();assert.equal(await redis.dbSize(),0,'Test DB must be empty');
 child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,PORT:'13011',REDIS_URL:redisUrl,ADMIN_EMAIL:'qa-admin@nosql.local',ADMIN_PASSWORD:'QaAdmin-Long-Pass2026',WORKER_AUTO_START:'false'},stdio:'pipe'});let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 let ready=false;for(let i=0;i<50;i++){try{if((await api('','/api/health')).status===200){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,logs);
 const admin=(await api('','/api/auth/login',{email:'qa-admin@nosql.local',password:'QaAdmin-Long-Pass2026'})).cookie;
 const customer=await api('','/api/auth/register',{name:'Khách vận hành',email:'ops-customer@example.com',password:'Customer-Ops-2026'});
 const guest=await api('','/api/auth/register',{name:'Khách khác',email:'ops-other@example.com',password:'Customer-Ops-2026'});
 assert.equal((await api(customer.cookie,'/api/staff',{name:'Lén tạo',email:'no@example.com',password:'Secret-Long-2026',role:'warehouse'})).status,403);
 assert.equal((await api(admin,'/api/staff',{name:'Kho',email:'bad',password:'Secret-Long-2026',role:'warehouse'})).status,400);
 const staff=[];
 for(const [email,name,role]of [['warehouse1@example.com','Kho A','warehouse'],['warehouse2@example.com','Kho B','warehouse'],['delivery1@example.com','Giao A','delivery'],['delivery2@example.com','Giao B','delivery']]){
  const created=await api(admin,'/api/staff',{name,email,password:'Staff-Long-Pass2026',role});assert.equal(created.status,201);assert.ok(!JSON.stringify(created.body).includes('password'));const login=await api('','/api/auth/login',{email,password:'Staff-Long-Pass2026'});assert.equal(login.status,200);staff.push({...created.body,cookie:login.cookie});
 }
 assert.equal((await api(admin,'/api/staff')).body.length,4);
 assert.equal((await api(admin,'/api/staff',{name:'Trùng',email:'warehouse1@example.com',password:'Staff-Long-Pass2026',role:'delivery'})).status,409);
 const [wa,wb,da,db]=staff;
 for(const s of staff){assert.equal((await api(s.cookie,'/api/orders')).status,403);assert.equal((await api(s.cookie,'/api/worker',{enabled:true})).status,403);assert.equal((await api(s.cookie,'/api/staff')).status,403);assert.equal((await fetch(base+'/admin.html',{headers:{Cookie:s.cookie}})).status,403);assert.equal((await fetch(base+'/fulfillment.html',{headers:{Cookie:s.cookie}})).status,200);}
 assert.equal((await api(customer.cookie,'/api/fulfillment')).status,403);assert.equal((await api('','/api/fulfillment')).status,401);
 assert.equal((await api(wa.cookie,'/api/fulfillment/shipping/claim',{})).status,403);assert.equal((await api(da.cookie,'/api/fulfillment/packing/claim',{})).status,403);
 const product=(await api(admin,'/api/products',{name:'Áo sơ mi vận hành',price:250000,stock:10,sizes:['S']})).body;
 await api(customer.cookie,'/api/customers',{name:'Khách vận hành',phone:'0901234567',address:'TP.HCM'});
 const place=async()=>{const o=await api(customer.cookie,'/api/orders',{items:[{productId:product.productId,size:'S',quantity:1}]});assert.equal(o.status,201);assert.equal(await redis.eval(claim,{arguments:[new Date().toISOString()]}),o.body.orderId);assert.equal(await redis.eval(finish,{arguments:[o.body.orderId,new Date().toISOString()]}),'COMPLETED');return o.body;};
 const first=await place(),second=await place();
 assert.deepEqual(await redis.lRange('fulfillment:packing:queue',0,-1),[first.orderId,second.orderId]);assert.equal(await redis.hGet('product:'+product.productId,'stock:S'),'8');
 assert.equal(await redis.eval(finish,{arguments:[first.orderId,new Date().toISOString()]}),'SKIPPED');await migrateFulfillment(redis);await migrateFulfillment(redis);assert.equal(await redis.lLen('fulfillment:packing:queue'),2,'No duplicate enqueue');
 const [a,b]=await Promise.all([api(wa.cookie,'/api/fulfillment/packing/claim',{}),api(wb.cookie,'/api/fulfillment/packing/claim',{})]);assert.equal(a.status,200);assert.equal(b.status,200);assert.notEqual(a.body.order.orderId,b.body.order.orderId);assert.deepEqual(new Set([a.body.order.orderId,b.body.order.orderId]),new Set([first.orderId,second.orderId]));
 assert.equal((await api(wa.cookie,'/api/fulfillment/packing/claim',{})).body.order.orderId,a.body.order.orderId,'Repeat claim resumes own work');
 assert.equal((await api(wa.cookie,'/api/fulfillment/packing/complete',{orderId:b.body.order.orderId})).status,403);
 const repeated=await Promise.all([api(wa.cookie,'/api/fulfillment/packing/complete',{orderId:a.body.order.orderId}),api(wa.cookie,'/api/fulfillment/packing/complete',{orderId:a.body.order.orderId})]);assert.ok(repeated.every(r=>r.status===200));assert.deepEqual(await redis.lRange('fulfillment:shipping:queue',0,-1),[a.body.order.orderId]);
 assert.equal((await api(wb.cookie,'/api/fulfillment/packing/complete',{orderId:b.body.order.orderId})).status,200);assert.equal(await redis.lLen('fulfillment:shipping:queue'),2);
 assert.deepEqual(Object.keys((await api(wa.cookie,'/api/fulfillment')).body.stages),['packing']);assert.deepEqual(Object.keys((await api(da.cookie,'/api/fulfillment')).body.stages),['shipping']);
 const [shipA,shipB]=await Promise.all([api(da.cookie,'/api/fulfillment/shipping/claim',{}),api(db.cookie,'/api/fulfillment/shipping/claim',{})]);assert.notEqual(shipA.body.order.orderId,shipB.body.order.orderId);
 assert.equal((await api(db.cookie,'/api/fulfillment/shipping/complete',{orderId:shipA.body.order.orderId})).status,403);
 assert.equal((await api(da.cookie,'/api/fulfillment/shipping/complete',{orderId:shipA.body.order.orderId})).status,200);
 const eventCount=await redis.xLen('order:events'),noticeCount=await redis.xLen('notification:user:'+customer.body.user.userId);
 assert.equal((await api(da.cookie,'/api/fulfillment/shipping/complete',{orderId:shipA.body.order.orderId})).status,200);assert.equal(await redis.xLen('order:events'),eventCount);assert.equal(await redis.xLen('notification:user:'+customer.body.user.userId),noticeCount);
 assert.equal((await api(admin,'/api/fulfillment/shipping/complete',{orderId:shipB.body.order.orderId})).status,200);
 assert.equal(await redis.hGet('product:'+product.productId,'stock:S'),'8','No stock deductions while packing/shipping');
 for(const o of [first,second]){const row=(await api(customer.cookie,'/api/orders/'+o.orderId)).body;assert.equal(row.status,'DELIVERED');assert.ok(row.packedAt&&row.deliveredAt);assert.equal((await api(guest.cookie,'/api/orders/'+o.orderId)).status,404);}
 const customerNotes=(await api(customer.cookie,'/api/notifications')).body.notifications;assert.ok(customerNotes.some(n=>n.event==='PACKING'));assert.ok(customerNotes.some(n=>n.event==='SHIPPING'));assert.ok(customerNotes.some(n=>n.event==='DELIVERED'));assert.equal((await api(guest.cookie,'/api/notifications')).body.notifications.length,0);
 assert.equal((await api(wa.cookie,'/api/fulfillment/packing/claim',{})).body.order,null);
 // Legacy confirmed orders migrate once and keep stock intact.
 const old=await place();await redis.lRem('fulfillment:packing:queue',0,old.orderId);await redis.hDel('order:'+old.orderId,'fulfillmentQueuedAt');await migrateFulfillment(redis);await migrateFulfillment(redis);assert.deepEqual(await redis.lRange('fulfillment:packing:queue',0,-1),[old.orderId]);
 // A wrong destination type must fail before deduction or state change.
 const unsafe=(await api(customer.cookie,'/api/orders',{items:[{productId:product.productId,size:'S',quantity:1}]})).body;await redis.eval(claim,{arguments:[new Date().toISOString()]});await redis.rename('fulfillment:packing:queue','qa:saved-queue');await redis.set('fulfillment:packing:queue','wrong-type');await assert.rejects(redis.eval(finish,{arguments:[unsafe.orderId,new Date().toISOString()]}));assert.equal(await redis.hGet('order:'+unsafe.orderId,'status'),'PROCESSING');assert.equal(await redis.hGet('product:'+product.productId,'stock:S'),'7');await redis.del('fulfillment:packing:queue');await redis.rename('qa:saved-queue','fulfillment:packing:queue');
 console.log('PASS: role-scoped staff accounts, FIFO packing/shipping, concurrent claims, ownership, idempotent completion, customer tracking/notifications, stock deducted once, legacy migration and destination-type safety.');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(child)child.kill();if(redis.isOpen)await redis.quit();});
