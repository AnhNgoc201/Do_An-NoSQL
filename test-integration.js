// Run only against a disposable Redis: TEST_REDIS_URL=redis://127.0.0.1:16381/1
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createClient } = require('redis');
const { claim, finish } = require('./worker');
const {refreshStockWait,migrateStockWait,STOCK_WINDOW_MS}=require('./stock-policy');
const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw Error('Set TEST_REDIS_URL to an empty disposable Redis database.');
const r = createClient({ url: redisUrl, socket: { reconnectStrategy: false, connectTimeout: 3000 } });
r.on('error', () => {});
async function settleFinish(options){return r.eval(finish,options);}
const base='http://127.0.0.1:13009';
let child,adminCookie='';
async function api(route, data) {
  const response=await fetch(base+route, data ? {method:'POST',headers:{'Content-Type':'application/json',...(adminCookie?{Cookie:adminCookie}:{})},body:JSON.stringify(data)} : {headers:adminCookie?{Cookie:adminCookie}:{}});
  return {status:response.status,body:await response.json(),setCookie:response.headers.get('set-cookie')};
}
async function main(){
  await r.connect();
  assert.equal(await r.dbSize(),0,'Test database must be empty');
  child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,REDIS_URL:redisUrl,PORT:'13009',ADMIN_EMAIL:'qa-admin@nosql.local',ADMIN_PASSWORD:'QaAdmin-Long-Pass2026',WORKER_DELAY_MS:'3000',WORKER_RETRY_DELAY_MS:'100',WORKER_AUTO_START:'false'},stdio:'pipe'});
  let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
  let ready=false;
  for(let i=0;i<40;i++){try{if((await api('/api/health')).body.redis==='PONG'){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(ready,logs);
  assert.equal((await api('/api/orders')).status,401);const adminLogin=await api('/api/auth/login',{email:'qa-admin@nosql.local',password:'QaAdmin-Long-Pass2026'});assert.equal(adminLogin.status,200);adminCookie=adminLogin.setCookie.split(';')[0];
  assert.equal((await api('/api/worker',{processingDelayMs:1000})).status,200);assert.equal((await api('/api/worker')).body.enabled,false);assert.equal(await r.get('settings:worker:delayMs'),'1000');
  for(const invalid of [0,-1,999,1500,61000,'5000',null])assert.equal((await api('/api/worker',{processingDelayMs:invalid})).status,400);
  assert.equal((await api('/api/worker',{enabled:true,processingDelayMs:0})).status,400);assert.equal((await api('/api/worker')).body.enabled,false,'Invalid mixed request must not toggle worker');
  assert.equal((await api('/api/worker',{processingDelayMs:3000})).status,200);
  assert.match(await (await fetch(base)).text(),/NOSQL BOUTIQUE/);assert.match(await (await fetch(base+'/shop.html')).text(),/NOSQL BOUTIQUE/);
  assert.match(await (await fetch(base+'/admin.html',{headers:{Cookie:adminCookie}})).text(),/Hàng đợi/);
  assert.equal((await api('/api/products',{name:'Bad',price:-1,stock:3})).status,400);
  assert.equal((await api('/api/customers',{name:'',phone:'123',address:''})).status,400);
  const customer=(await api('/api/customers',{name:'Ngọc',phone:'0901234567',address:'TP.HCM'})).body;
  const product=(await api('/api/products',{name:'Bàn phím',price:250000,stock:3})).body;
  assert.equal((await api('/api/customers')).body.length,1);
  assert.equal((await api('/api/products')).body.length,1);
  assert.equal((await api('/api/orders',{customerId:'missing',productId:product.productId,quantity:1})).status,400);
  const place=async()=>{const result=await api('/api/orders',{customerId:customer.customerId,productId:product.productId,quantity:2,unitPrice:1});assert.equal(result.status,201);assert.equal(result.body.totalAmount,'500000');return result.body;};
  const first=await place(),second=await place();
  assert.deepEqual(await r.lRange('order:queue',0,-1),[first.orderId,second.orderId]);
  assert.equal((await api('/api/worker')).body.enabled,false);
  const claimed=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(claimed,first.orderId);
  // Re-claiming after a restart resumes processing rather than losing the order.
  assert.equal(await r.eval(claim,{arguments:[new Date().toISOString()]}),first.orderId);
  assert.equal(await settleFinish({arguments:[claimed,new Date().toISOString()]}),'COMPLETED');
  assert.equal(await settleFinish({arguments:[claimed,new Date().toISOString()]}),'SKIPPED');
  assert.equal(await r.hGet('product:'+product.productId,'stock'),'1');
  await api('/api/worker',{enabled:true});
  let status='PENDING';
  for(let i=0;i<220;i++){status=(await api('/api/orders/'+second.orderId)).body.status;if(status==='WAITING_STOCK')break;await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(status,'WAITING_STOCK');
  assert.equal(await r.hGet('product:'+product.productId,'stock'),'1');
  assert.equal(await r.lLen('order:queue'),0);assert.equal(await r.lLen('order:processing'),0);
  assert.ok(await r.sIsMember('order:status:COMPLETED',first.orderId));
  assert.ok(await r.sIsMember('order:status:WAITING_STOCK',second.orderId));
  assert.equal(await r.sCard('order:status:PENDING'),0);
  assert.equal(await r.sCard('order:status:PROCESSING'),0);
  assert.equal((await api('/api/events')).body.length,6);
  assert.equal((await api('/api/orders')).body.count,2);
  await api('/api/worker',{enabled:false});
  const clothing=(await api('/api/products',{name:'Áo cotton',category:'Áo',price:189000,stock:3,sizes:['S','M','L']})).body;
  assert.equal(clothing.stock,'9');
  assert.equal((await api('/api/orders',{customerId:customer.customerId,productId:clothing.productId,size:'XL',quantity:1})).status,400);
  const shirt=(await api('/api/orders',{customerId:customer.customerId,productId:clothing.productId,size:'M',quantity:2})).body;
  assert.equal(shirt.size,'M');assert.equal(shirt.productName,'Áo cotton');
  await r.eval(claim,{arguments:[new Date().toISOString()]});
  assert.equal(await settleFinish({arguments:[shirt.orderId,new Date().toISOString()]}),'COMPLETED');
  assert.equal(await r.hGet('product:'+clothing.productId,'stock:M'),'1');
  assert.equal(await r.hGet('product:'+clothing.productId,'stock:S'),'3');
  assert.equal(await r.hGet('product:'+clothing.productId,'stock'),'7');
  const tooMany=(await api('/api/orders',{customerId:customer.customerId,productId:clothing.productId,size:'M',quantity:2})).body;
  await r.eval(claim,{arguments:[new Date().toISOString()]});
  assert.equal(await settleFinish({arguments:[tooMany.orderId,new Date().toISOString()]}),'WAITING_STOCK');
  assert.equal(await r.hGet('product:'+clothing.productId,'stock'),'7');
  assert.equal((await api('/api/demo/catalog',{})).body.added,12);
  assert.equal((await api('/api/demo/catalog',{})).body.added,0);
  const other=(await api('/api/products',{name:'Quần test',price:200000,stock:5,sizes:['S','M']})).body;
  const basket=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:clothing.productId,size:'S',quantity:1},{productId:other.productId,size:'M',quantity:2}]})).body;
  assert.equal(JSON.parse(basket.items).length,2);assert.equal(basket.totalAmount,'589000');
  await r.eval(claim,{arguments:[new Date().toISOString()]});
  assert.equal(await settleFinish({arguments:[basket.orderId,new Date().toISOString()]}),'COMPLETED');
  assert.equal(await r.hGet('product:'+other.productId,'stock:M'),'3');
  const failure=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:other.productId,size:'S',quantity:1},{productId:clothing.productId,size:'M',quantity:10}]})).body;
  await r.eval(claim,{arguments:[new Date().toISOString()]});
  assert.equal(await settleFinish({arguments:[failure.orderId,new Date().toISOString()]}),'WAITING_STOCK');
  assert.equal(await r.hGet('product:'+other.productId,'stock:S'),'5','No partial deduction on failed basket');
  const merged=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:other.productId,size:'M',quantity:2},{productId:other.productId,size:'M',quantity:2}]})).body;
  assert.equal(JSON.parse(merged.items).length,1);assert.equal(JSON.parse(merged.items)[0].quantity,4);
  await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(await settleFinish({arguments:[merged.orderId,new Date().toISOString()]}),'WAITING_STOCK');
  assert.equal(await r.hGet('product:'+other.productId,'stock:M'),'3');
  assert.equal((await api('/api/contact',{name:'Test',email:'bad',subject:'Hỗ trợ đơn hàng',message:'Cần hỗ trợ đặt hàng'})).status,400);
  const support=await api('/api/contact',{name:'Khách demo',email:'demo@example.com',subject:'Hỗ trợ đơn hàng',message:'Cần hỗ trợ chọn size cho đơn hàng.'});assert.equal(support.status,201);
  const tickets=(await api('/api/contact')).body;assert.equal(tickets.length,1);assert.equal(tickets[0].ticketId,support.body.ticketId);
  console.log('PASS: multi-item cart total, duplicate line merge, atomic whole-order stock deduction and no partial stock on failure.');
  const lastItem=(await api('/api/products',{name:'Chiếc cuối cùng',price:100000,stock:1,sizes:['S']})).body;
  const buyerB=(await api('/api/customers',{name:'Khách B',phone:'0900000001',address:'Địa chỉ demo B'})).body;
  const simultaneous=await Promise.all([api('/api/orders',{customerId:customer.customerId,items:[{productId:lastItem.productId,size:'S',quantity:1}]}),api('/api/orders',{customerId:buyerB.customerId,items:[{productId:lastItem.productId,size:'S',quantity:1}]})]);
  assert.ok(simultaneous.every(response=>response.status===201));const results=[];
  for(let i=0;i<2;i++){const id=await r.eval(claim,{arguments:[new Date().toISOString()]});results.push(await settleFinish({arguments:[id,new Date().toISOString()]}));}
  assert.deepEqual(results,['COMPLETED','WAITING_STOCK']);assert.equal(await r.hGet('product:'+lastItem.productId,'stock:S'),'0');assert.equal(await r.hGet('product:'+lastItem.productId,'stock'),'0');
  console.log('PASS: two concurrent customers, one remaining item, one confirmation and one stock failure, inventory never negative.');

  let picked;
  assert.equal((await fetch(base+'/api/orders/missing/demo-failure',{method:'POST',headers:{Cookie:adminCookie,'Content-Type':'application/json'},body:JSON.stringify({failCount:1})})).status,404);
  const normal=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:other.productId,size:'S',quantity:1}]})).body;
  await r.hSet('order:'+normal.orderId,{demoFailuresRemaining:'4'});
  picked=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(picked,normal.orderId);
  assert.equal(await settleFinish({arguments:[picked,new Date().toISOString()]}),'COMPLETED','Old simulation fields must not inject failures');
  console.log('PASS: failure simulation endpoint removed; old simulation settings ignored.');
  async function productRequest(method,id,data){const response=await fetch(base+'/api/products/'+id,{method,headers:{Cookie:adminCookie,...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json()};}
  const editable=(await api('/api/products',{name:'Áo sửa thử',price:120000,stock:3,sizes:['S','M']})).body;
  const editPayload={name:'Áo đã sửa',price:150000,category:'Áo',image:'/assets/tee.svg',description:'Mô tả đã cập nhật',material:'Cotton',color:'Kem',stockBySize:{S:1,M:4},expectedStockBySize:{S:3,M:3}};
  let edited=await productRequest('PUT',editable.productId,editPayload);assert.equal(edited.status,200);assert.equal(edited.body.name,'Áo đã sửa');assert.equal(edited.body.stock,'5');assert.equal(edited.body['stock:S'],'1');assert.equal(edited.body['stock:M'],'4');
  assert.equal((await productRequest('PUT',editable.productId,editPayload)).status,409,'Stale stock must not overwrite sales');
  assert.equal((await productRequest('PUT',editable.productId,{...editPayload,stockBySize:{S:-1,M:4}})).status,400);
  const historical=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:editable.productId,size:'S',quantity:1}]})).body;assert.equal(historical.totalAmount,'150000');
  edited=await productRequest('PUT',editable.productId,{...editPayload,name:'Tên mới sau đặt',price:200000,expectedStockBySize:{S:1,M:4}});assert.equal(edited.status,200);
  assert.equal((await api('/api/orders/'+historical.orderId)).body.totalAmount,'150000');assert.equal((await productRequest('DELETE',editable.productId)).status,409,'Pending order blocks deletion');
  picked=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(picked,historical.orderId);assert.equal((await productRequest('DELETE',editable.productId)).status,409,'Processing order blocks deletion');
  assert.equal(await settleFinish({arguments:[picked,new Date().toISOString()]}),'COMPLETED');assert.equal((await productRequest('DELETE',editable.productId)).status,200);assert.equal((await productRequest('DELETE',editable.productId)).status,404);
  assert.equal((await api('/api/orders/'+historical.orderId)).body.productName,'Áo đã sửa');assert.equal((await api('/api/products')).body.some(p=>p.productId===editable.productId),false);
  const guardA=(await api('/api/products',{name:'Món thứ nhất',price:10000,stock:1,sizes:['S']})).body,guardB=(await api('/api/products',{name:'Món thứ hai',price:10000,stock:1,sizes:['S']})).body;
  const guarded=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:guardA.productId,size:'S',quantity:1},{productId:guardB.productId,size:'S',quantity:1}]})).body;
  assert.equal((await productRequest('DELETE',guardB.productId)).status,409,'Must inspect all order items, not only first');picked=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(picked,guarded.orderId);await settleFinish({arguments:[picked,new Date().toISOString()]});await productRequest('DELETE',guardA.productId);await productRequest('DELETE',guardB.productId);
  const raceProduct=(await api('/api/products',{name:'Race create/delete',price:10000,stock:1,sizes:['S']})).body;
  const [raceOrder,raceDelete]=await Promise.all([api('/api/orders',{customerId:customer.customerId,items:[{productId:raceProduct.productId,size:'S',quantity:1}]}),productRequest('DELETE',raceProduct.productId)]);
  if(raceDelete.status===200)assert.ok([400,409].includes(raceOrder.status),'Deleted product cannot leave a new pending order');else{assert.equal(raceDelete.status,409);assert.equal(raceOrder.status,201);picked=await r.eval(claim,{arguments:[new Date().toISOString()]});await settleFinish({arguments:[picked,new Date().toISOString()]});assert.equal((await productRequest('DELETE',raceProduct.productId)).status,200);}
  console.log('PASS: product edit, stock totals, stale-stock conflict, invalid stock, historical price snapshot, guarded deletion and concurrent checkout/delete.');
  const stockProduct=(await api('/api/products',{name:'Hàng chờ nhập',price:100000,stock:0,sizes:['S']})).body;
  const stockOrder=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:stockProduct.productId,size:'S',quantity:1}]})).body;
  picked=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(picked,stockOrder.orderId);
  assert.equal(await r.eval(finish,{arguments:[picked,new Date().toISOString()]}),'WAITING_STOCK');
  const waiting=await r.hGetAll('order:'+picked);assert.equal(waiting.failureCode,'OUT_OF_STOCK');assert.equal(Number(waiting.stockWaitDeadlineAt),Number(stockOrder.createdAtMs)+STOCK_WINDOW_MS);assert.equal(waiting.retryCount,'0');assert.equal(await r.hGet('product:'+stockProduct.productId,'stock'),'0');
  assert.equal((await productRequest('DELETE',stockProduct.productId)).status,409,'Waiting stock order must block product deletion');
  const noticeCount=await r.xLen('notification:admin');for(let i=0;i<3;i++)await r.eval(refreshStockWait,{arguments:['0',new Date().toISOString()]});assert.equal(await r.hGet('order:'+picked,'attemptCount'),'1');assert.equal(await r.xLen('notification:admin'),noticeCount,'No repeated shortage notices');assert.equal(await r.lLen('order:queue'),0);
  const restocked=await productRequest('PUT',stockProduct.productId,{name:stockProduct.name,price:100000,category:'Áo',image:'',description:'',material:'',color:'',stockBySize:{S:1},expectedStockBySize:{S:0}});assert.equal(restocked.status,200);
  await r.eval(refreshStockWait,{arguments:['0',new Date().toISOString()]});await r.eval(refreshStockWait,{arguments:['0',new Date().toISOString()]});assert.equal(await r.lLen('order:queue'),1,'Only queue once when stock becomes available');
  picked=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(picked,stockOrder.orderId);assert.equal(await r.eval(finish,{arguments:[picked,new Date().toISOString()]}),'COMPLETED');assert.equal(await r.eval(finish,{arguments:[picked,new Date().toISOString()]}),'SKIPPED');assert.equal(await r.hGet('product:'+stockProduct.productId,'stock:S'),'0');
  assert.equal((await api('/api/orders/'+picked+'/cancel',{reason:'Không thể hủy đơn hoàn tất'})).status,409);
  // A waiting order must not be confirmed after its fixed 24h deadline, even with new stock.
  const late=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:stockProduct.productId,size:'S',quantity:1}]})).body;
  picked=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(picked,late.orderId);await r.eval(finish,{arguments:[picked,new Date().toISOString()]});
  await r.multi().hSet('order:'+late.orderId,{stockWaitDeadlineAt:String(Date.now()-1000)}).zAdd('order:stock-wait',[{score:Date.now()-1000,value:late.orderId}]).hSet('product:'+stockProduct.productId,{stock:'1','stock:S':'1'}).exec();
  await r.eval(refreshStockWait,{arguments:['0',new Date().toISOString()]});assert.equal(await r.hGet('order:'+late.orderId,'status'),'WAITING_STOCK');assert.equal(await r.hGet('order:'+late.orderId,'stockWaitExpired'),'1');assert.equal(await r.lLen('order:queue'),0);assert.equal(await r.hGet('product:'+stockProduct.productId,'stock:S'),'1');
  const expiryEvents=(await r.xRange('order:events','-','+')).filter(e=>e.message.orderId===late.orderId&&e.message.event==='STOCK_WAIT_EXPIRED').length;assert.equal(expiryEvents,1);await r.eval(refreshStockWait,{arguments:['0',new Date().toISOString()]});assert.equal((await r.xRange('order:events','-','+')).filter(e=>e.message.orderId===late.orderId&&e.message.event==='STOCK_WAIT_EXPIRED').length,1);
  const cancelled=await Promise.all([api('/api/orders/'+late.orderId+'/cancel',{reason:'Không có nguồn cung trong thời gian phù hợp'}),api('/api/orders/'+late.orderId+'/cancel',{reason:'Không có nguồn cung trong thời gian phù hợp'})]);assert.ok(cancelled.every(r=>r.status===200));assert.equal(await r.hGet('order:'+late.orderId,'status'),'CANCELLED');assert.equal(await r.hGet('product:'+stockProduct.productId,'stock:S'),'1');assert.equal((await r.xRange('order:events','-','+')).filter(e=>e.message.orderId===late.orderId&&e.message.event==='CANCELLED').length,1);
  // Cancellation during processing wins before stock deduction; finish must then skip.
  const inflight=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:stockProduct.productId,size:'S',quantity:1}]})).body;assert.equal(await r.eval(claim,{arguments:[new Date().toISOString()]}),inflight.orderId);assert.equal((await api('/api/orders/'+inflight.orderId+'/cancel',{reason:'Nguồn cung không phù hợp'})).status,200);assert.equal(await r.eval(finish,{arguments:[inflight.orderId,new Date().toISOString()]}),'SKIPPED');assert.equal(await r.hGet('product:'+stockProduct.productId,'stock:S'),'1');
  // A deadline crossed after requeue, while processing, must also prevent auto-confirmation.
  const crossed=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:stockProduct.productId,size:'S',quantity:1}]})).body;assert.equal(await r.eval(claim,{arguments:[new Date().toISOString()]}),crossed.orderId);await r.hSet('order:'+crossed.orderId,{stockWaitDeadlineAt:String(Date.now()-100)});assert.equal(await r.eval(finish,{arguments:[crossed.orderId,new Date().toISOString()]}),'WAITING_STOCK');assert.equal(await r.hGet('product:'+stockProduct.productId,'stock:S'),'1');await api('/api/orders/'+crossed.orderId+'/cancel',{reason:'Quá hạn chờ nguồn hàng'});
  // Old failed stock orders are migrated without resetting placement time or duplicating notices.
  const legacy=(await api('/api/orders',{customerId:customer.customerId,items:[{productId:stockProduct.productId,size:'S',quantity:2}]})).body;await r.multi().lRem('order:queue',0,legacy.orderId).sRem('order:status:PENDING',legacy.orderId).sAdd('order:status:FAILED',legacy.orderId).hSet('order:'+legacy.orderId,{status:'FAILED',failureCode:'OUT_OF_STOCK',retryCount:'3'}).exec();assert.equal(await migrateStockWait(r),1);assert.equal(await migrateStockWait(r),0);assert.equal(await r.hGet('order:'+legacy.orderId,'status'),'WAITING_STOCK');assert.equal(Number(await r.hGet('order:'+legacy.orderId,'stockWaitDeadlineAt')),Number(legacy.createdAtMs)+STOCK_WINDOW_MS);
  console.log('PASS: fixed 24h stock waiting, replenishment through product API, no repeated attempts/notices, no partial/double deduction, expiry without auto-cancel, cancellation races and legacy migration.');
  async function as(cookie,route,data){const response=await fetch(base+route,{method:data?'POST':'GET',headers:{...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
  assert.equal((await as('', '/api/worker')).status,401);
  assert.equal((await as('', '/api/products')).status,200);
  assert.equal((await fetch(base+'/admin.html',{redirect:'manual'})).status,302);
  const alice=await as('','/api/auth/register',{name:'Khách A',email:'alice@example.com',password:'Customer-A-2026',role:'admin'});assert.equal(alice.status,201);assert.equal(alice.body.user.role,'customer');assert.ok(!JSON.stringify(alice.body).includes('password'));
  const bob=await as('','/api/auth/register',{name:'Khách B',email:'bob@example.com',password:'Customer-B-2026'});assert.equal(bob.status,201);
  assert.equal((await as('','/api/auth/register',{name:'Trùng email',email:'alice@example.com',password:'Customer-A-2026'})).status,409);
  assert.equal((await as('','/api/auth/login',{email:'alice@example.com',password:'wrong'})).status,401);
  assert.equal((await as(alice.cookie,'/api/products',{name:'Forbidden',price:1,stock:1})).status,403);
  assert.equal((await as(alice.cookie,'/api/contact')).status,403);assert.equal((await fetch(base+'/api/products/'+other.productId,{method:'DELETE',headers:{Cookie:alice.cookie}})).status,403);assert.equal((await fetch(base+'/api/products/'+other.productId,{method:'PUT',headers:{Cookie:alice.cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/admin.html',{headers:{Cookie:alice.cookie},redirect:'manual'})).status,403);
  await as(alice.cookie,'/api/customers',{name:'Khách A',phone:'0900000002',address:'Địa chỉ A'});
  const ownOrder=await as(alice.cookie,'/api/orders',{customerId:customer.customerId,items:[{productId:other.productId,size:'S',quantity:1}]});assert.equal(ownOrder.status,201);assert.equal(ownOrder.body.userId,alice.body.user.userId);assert.equal(ownOrder.body.customerId,alice.body.user.customerId);
  assert.equal((await as(bob.cookie,'/api/orders/'+ownOrder.body.orderId)).status,404);
  assert.equal((await as(alice.cookie,'/api/orders')).body.count,1);
  assert.equal((await as(bob.cookie,'/api/orders')).body.count,0);assert.equal((await as(bob.cookie,'/api/orders/'+stockOrder.orderId+'/cancel',{reason:'Khách không có quyền hủy'})).status,403);assert.equal((await as(bob.cookie,'/api/worker',{processingDelayMs:1000})).status,403);
  const privateProduct=(await api('/api/products',{name:'Hàng riêng cho kiểm thử thông báo',price:10000,stock:0,sizes:['S']})).body;
  const privateOrder=await as(alice.cookie,'/api/orders',{items:[{productId:privateProduct.productId,size:'S',quantity:1}]});assert.equal(privateOrder.status,201);
  // The previous ownOrder is still queued; process it before the shortage order.
  picked=await r.eval(claim,{arguments:[new Date().toISOString()]});await r.eval(finish,{arguments:[picked,new Date().toISOString()]});picked=await r.eval(claim,{arguments:[new Date().toISOString()]});assert.equal(picked,privateOrder.body.orderId);assert.equal(await r.eval(finish,{arguments:[picked,new Date().toISOString()]}),'WAITING_STOCK');
  let aliceNotices=await as(alice.cookie,'/api/notifications');assert.equal(aliceNotices.status,200);assert.ok(aliceNotices.body.notifications.some(n=>n.orderId===privateOrder.body.orderId&&n.event==='WAITING_STOCK'));assert.equal((await as(bob.cookie,'/api/notifications')).body.notifications.length,0);
  assert.equal((await as(alice.cookie,'/api/orders/'+privateOrder.body.orderId+'/cancel',{reason:'Không có quyền'})).status,403);
  assert.equal((await as(alice.cookie,'/api/notifications/read',{lastSeenId:aliceNotices.body.notifications[0].id})).status,200);assert.equal((await as(alice.cookie,'/api/notifications')).body.unreadCount,0);
  await api('/api/orders/'+privateOrder.body.orderId+'/cancel',{reason:'Không nhập được hàng trong 24 giờ'});aliceNotices=await as(alice.cookie,'/api/notifications');assert.equal(aliceNotices.body.unreadCount,1);assert.ok(aliceNotices.body.notifications.some(n=>n.event==='CANCELLED'&&n.message.includes('Không nhập được hàng trong 24 giờ')));assert.equal((await as(bob.cookie,'/api/notifications')).body.notifications.length,0);
  const privateCancelled=await as(alice.cookie,'/api/orders/'+privateOrder.body.orderId);assert.equal(privateCancelled.body.status,'CANCELLED');assert.equal(privateCancelled.body.cancelReason,'Không nhập được hàng trong 24 giờ');
  console.log('PASS: admin shortage alerts, customer cancellation notifications/reasons, unread markers, role and cross-account privacy.');
  const relogin=await as(alice.cookie,'/api/auth/login',{email:'alice@example.com',password:'Customer-A-2026'});assert.equal(relogin.status,200);assert.notEqual(relogin.cookie,alice.cookie);assert.equal((await as(alice.cookie,'/api/orders')).status,401);
  await as(relogin.cookie,'/api/auth/logout',{});assert.equal((await as(relogin.cookie,'/api/orders')).status,401);
  const storedPassword=await r.hGet('auth:user:'+alice.body.user.userId,'passwordHash');assert.notEqual(storedPassword,'Customer-A-2026');assert.match(storedPassword,/^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.equal((await fetch(base+'/api/auth/register',{method:'POST',headers:{Origin:'http://evil.example','Content-Type':'application/json'},body:'{}'})).status,403);
  console.log('PASS: registration, login, logout, cookie rotation, password hashing, customer/admin authorization, cross-account order protection and request-origin checks.');
  await r.set('lab:note','Thuc hanh String va TTL',{EX:120});await r.hSet('lab:order:LAB001',{orderId:'LAB001',status:'PENDING'});await r.rPush('lab:queue',['LAB001','LAB002']);await r.sAdd('lab:status:PENDING',['LAB001','LAB002']);await r.zAdd('lab:created',[{score:1000,value:'LAB001'}]);await r.xAdd('lab:events','*',{event:'CREATED'});
  const {exportData,importData}=require('./scripts/data-transfer');const file=require('node:path').join(__dirname,'qa-artifacts','transfer-'+Date.now()+'.json');const out=await exportData(r,file);assert.ok(out.exported>6);
  const transferClient=createClient({url:new URL('/3',redisUrl).href,socket:{reconnectStrategy:false}});transferClient.on('error',()=>{});await transferClient.connect();
  try{assert.equal(await transferClient.dbSize(),0,'Isolated target DB3 must be empty');const imported=await importData(transferClient,file);assert.equal(imported.restored,out.exported);assert.equal(await transferClient.get('lab:note'),'Thuc hanh String va TTL');assert.equal(await transferClient.type('lab:events'),'stream');assert.equal(await transferClient.xLen('order:events'),await r.xLen('order:events'));assert.deepEqual(await transferClient.hGetAll('lab:order:LAB001'),await r.hGetAll('lab:order:LAB001'));assert.deepEqual(await transferClient.lRange('lab:queue',0,-1),['LAB001','LAB002']);assert.ok(await transferClient.pTTL('lab:note')<=await r.pTTL('lab:note')+100);assert.equal((await transferClient.keys('auth:*')).length,0);await assert.rejects(importData(transferClient,file),/trống/);await assert.rejects(importData(r,file),/DB 0\/1/);}finally{await transferClient.quit();}
  console.log('PASS: isolated logical export/import, all key types, TTL preservation, auth exclusion and overwrite protection.');
  // Verify automatic mode is the default after a fresh backend start.
  const exit=new Promise(resolve=>child.once('exit',resolve));child.kill();await exit;
  child=spawn(process.execPath,['server.js'],{cwd:__dirname,env:{...process.env,REDIS_URL:redisUrl,PORT:'13009',ADMIN_EMAIL:'qa-admin@nosql.local',ADMIN_PASSWORD:'QaAdmin-Long-Pass2026',WORKER_AUTO_START:'true',WORKER_DELAY_MS:'9000'},stdio:'pipe'});
  child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
  let auto=false;for(let i=0;i<40;i++){try{auto=(await api('/api/worker')).body.enabled;if(auto)break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.equal(auto,true);assert.equal((await api('/api/worker')).body.processingDelayMs,3000,'Persisted delay must override env after restart');
  console.log('PASS: pages, catalog validation, server pricing, FIFO, resume processing, idempotent completion, stock failure, worker loop, status indexes and event history.');
  console.log('PASS: clothing sizes, per-size stock isolation, sold-out size failure, idempotent sample catalog and automatic worker startup.');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(child)child.kill();if(r.isOpen)await r.quit();});
