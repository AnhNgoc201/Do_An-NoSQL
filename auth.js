const { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const TTL = 7 * 24 * 60 * 60;
const digest = value => createHash('sha256').update(value).digest('hex');
const emailKey = email => 'auth:email:' + digest(email);
const publicUser = user => ({userId:user.userId,name:user.name,email:user.email,role:user.role,customerId:user.customerId||null});

async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex');
  return salt+':'+Buffer.from(await derive(password,salt,64)).toString('hex');
}
async function verifyPassword(password, stored) {
  const [salt,encoded]=String(stored).split(':');
  if(!salt||!encoded)return false;
  const expected=Buffer.from(encoded,'hex'),actual=Buffer.from(await derive(password,salt,64));
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}

function createAuth(redis) {
  const cookieOptions={httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE==='true',path:'/',maxAge:TTL*1000};
  async function createUser(name,email,password,role) {
    const userId=randomUUID(),customerId=role==='customer'?'KH-'+randomUUID():'';
    const user={userId,name,email,role,customerId,passwordHash:await hashPassword(password),createdAt:new Date().toISOString()};
    const saved=await redis.eval(`
      if redis.call('EXISTS',KEYS[1])==1 then return 0 end
      redis.call('SET',KEYS[1],ARGV[1]);redis.call('HSET',KEYS[2],unpack(ARGV,2));return 1
    `,{keys:[emailKey(email),'auth:user:'+userId],arguments:[userId,...Object.entries(user).flat()]});
    return saved?user:null;
  }
  async function session(user,res){
    const token=randomBytes(32).toString('hex');
    await redis.set('auth:session:'+digest(token),user.userId,{EX:TTL});
    res.cookie('nosql_session',token,cookieOptions);
    return publicUser(user);
  }
  async function resolve(req,res,next){
    req.user=null;
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('nosql_session='))?.slice('nosql_session='.length);
    if(token&&/^[a-f0-9]{64}$/.test(token)){
      req.sessionKey='auth:session:'+digest(token);
      const userId=await redis.get(req.sessionKey);
      if(userId){const user=await redis.hGetAll('auth:user:'+userId);if(user.userId)req.user=publicUser(user);}
    }
    next();
  }
  function requireUser(req,res,next){if(!req.user)return res.status(401).json({error:'Vui lòng đăng nhập để tiếp tục.'});next();}
  function requireAdmin(req,res,next){if(!req.user)return res.status(401).json({error:'Vui lòng đăng nhập tài khoản chủ shop.'});if(req.user.role!=='admin')return res.status(403).json({error:'Chức năng này chỉ dành cho chủ shop.'});next();}
  async function limited(req,res,next){
    const key='auth:attempt:'+digest((req.ip||'')+':'+String(req.body?.email||'').trim().toLowerCase());
    const count=await redis.eval("local n=redis.call('INCR',KEYS[1]);if n==1 then redis.call('EXPIRE',KEYS[1],900) end;return n",{keys:[key],arguments:[]});
    if(count>15)return res.status(429).json({error:'Đã thử quá nhiều lần. Vui lòng thử lại sau 15 phút.'});next();
  }
  function routes(app){
    app.get('/api/auth/me',(req,res)=>{res.set('Cache-Control','no-store');res.json({user:req.user});});
    app.post('/api/auth/register',limited,async(req,res)=>{
      const {name,password}=req.body||{},email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
      if(typeof name!=='string'||!name.trim()||name.length>100||email.length>200||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||typeof password!=='string'||password.length<8||password.length>128)
        return res.status(400).json({error:'Nhập họ tên, email hợp lệ và mật khẩu từ 8 đến 128 ký tự.'});
      const user=await createUser(name.trim(),email,password,'customer');
      if(!user)return res.status(409).json({error:'Email này đã được đăng ký.'});
      if(req.sessionKey)await redis.del(req.sessionKey);
      res.status(201).json({user:await session(user,res)});
    });
    app.post('/api/auth/login',limited,async(req,res)=>{
      const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'',password=req.body?.password;
      if(typeof password!=='string'||password.length>128||email.length>200)return res.status(400).json({error:'Thông tin đăng nhập không hợp lệ.'});
      const id=await redis.get(emailKey(email)),user=id?await redis.hGetAll('auth:user:'+id):null;
      if(!user?.userId||!await verifyPassword(password,user.passwordHash))return res.status(401).json({error:'Email hoặc mật khẩu không đúng.'});
      if(req.sessionKey)await redis.del(req.sessionKey);
      res.json({user:await session(user,res)});
    });
    app.post('/api/auth/logout',async(req,res)=>{
      if(req.sessionKey)await redis.del(req.sessionKey);
      res.clearCookie('nosql_session',{httpOnly:true,sameSite:'lax',secure:cookieOptions.secure,path:'/'});
      res.json({ok:true});
    });
  }
  async function bootstrap(){
    const email=process.env.ADMIN_EMAIL?.trim().toLowerCase(),password=process.env.ADMIN_PASSWORD;
    if(!email||!password||password.length<12)throw Error('Cần ADMIN_EMAIL và ADMIN_PASSWORD tối thiểu 12 ký tự trong .env.');
    const id=await redis.get(emailKey(email));
    if(id){const user=await redis.hGetAll('auth:user:'+id);if(user.role!=='admin')throw Error('ADMIN_EMAIL đã được dùng bởi tài khoản khách.');return;}
    await createUser('Chủ shop NOSQL',email,password,'admin');
  }
  return {resolve,requireUser,requireAdmin,routes,bootstrap,createUser,publicUser};
}
module.exports={createAuth};
