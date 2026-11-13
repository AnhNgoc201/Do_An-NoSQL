function registerProductManagement(app,redis,requireAdmin){
  app.put('/api/products/:id',requireAdmin,async(req,res)=>{
    if(!/^[A-Za-z0-9_-]{1,60}$/.test(req.params.id))return res.status(400).json({error:'Mã sản phẩm không hợp lệ.'});
    const {name,price,category,image='',description='',material='',color='',stockBySize,expectedStockBySize}=req.body||{};
    if(typeof name!=='string'||!name.trim()||name.length>100||!Number.isSafeInteger(price)||price<1||!['Áo','Quần','Váy'].includes(category)||
      [image,description,material,color].some(v=>typeof v!=='string'||v.length>2000)||(image&&!/^https?:\/\//i.test(image)&&!/^\/assets\/[a-z0-9_-]+\.(svg|png|jpg|webp)$/i.test(image))||!stockBySize||typeof stockBySize!=='object'||Array.isArray(stockBySize)||!expectedStockBySize||typeof expectedStockBySize!=='object'||Array.isArray(expectedStockBySize))
      return res.status(400).json({error:'Kiểm tra tên, giá nguyên dương, loại sản phẩm và tồn kho từng size.'});
    const key='product:'+req.params.id,current=await redis.hGetAll(key);
    if(!current.productId)return res.status(404).json({error:'Sản phẩm không còn tồn tại.'});
    const sizes=current.sizes?JSON.parse(current.sizes):['ONE SIZE'];
    if(Object.keys(stockBySize).length!==sizes.length||Object.keys(expectedStockBySize).length!==sizes.length||sizes.some(size=>!Object.hasOwn(stockBySize,size)||!Number.isSafeInteger(stockBySize[size])||stockBySize[size]<0||!Object.hasOwn(expectedStockBySize,size)||!Number.isSafeInteger(expectedStockBySize[size])||expectedStockBySize[size]<0))
      return res.status(400).json({error:'Nhập đầy đủ tồn kho nguyên không âm cho các size hiện có.'});
    const stock=sizes.reduce((sum,size)=>sum+stockBySize[size],0);
    if(!Number.isSafeInteger(stock))return res.status(400).json({error:'Tổng tồn kho quá lớn.'});
    const fields={name:name.trim(),price:String(price),category,image,description,material,color,stock:String(stock),sizes:JSON.stringify(sizes),updatedAt:new Date().toISOString()};
    for(const size of sizes)fields['stock:'+size]=String(stockBySize[size]);
    const result=await redis.eval(`
      if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('HEXISTS',KEYS[1],'productId')==0 then return 0 end
      if (redis.call('HGET',KEYS[1],'sizes') or '')~=ARGV[1] then return -1 end
      local expected=cjson.decode(ARGV[2])
      for size,value in pairs(expected) do
        local actual=redis.call('HGET',KEYS[1],'stock:'..size)
        if not actual and ARGV[1]=='' then actual=redis.call('HGET',KEYS[1],'stock') end
        if tonumber(actual)~=tonumber(value) then return -2 end
      end
      redis.call('HSET',KEYS[1],unpack(ARGV,3));return 1
    `,{keys:[key],arguments:[current.sizes||'',JSON.stringify(expectedStockBySize),...Object.entries(fields).flat()]});
    if(result===0)return res.status(404).json({error:'Sản phẩm không còn tồn tại.'});
    if(result===-1)return res.status(409).json({error:'Danh sách size đã thay đổi. Vui lòng tải lại sản phẩm.'});
    if(result===-2)return res.status(409).json({error:'Tồn kho vừa thay đổi do đơn hàng hoặc người khác cập nhật. Đóng form và mở Sửa lại để lấy tồn kho mới.'});
    res.json(await redis.hGetAll(key));
  });
  app.delete('/api/products/:id',requireAdmin,async(req,res)=>{
    if(!/^[A-Za-z0-9_-]{1,60}$/.test(req.params.id))return res.status(400).json({error:'Mã sản phẩm không hợp lệ.'});
    const result=await redis.eval(`
      if redis.call('EXISTS',KEYS[1])==0 then return 0 end
      local cursor='0'
      repeat
        local page=redis.call('SCAN',cursor,'MATCH','order:*','COUNT',100);cursor=page[1]
        for _,key in ipairs(page[2]) do
          if redis.call('TYPE',key).ok=='hash' then
            local status=redis.call('HGET',key,'status')
            if status=='PENDING' or status=='PROCESSING' or status=='RETRYING' or status=='WAITING_STOCK' then
              if redis.call('HGET',key,'productId')==ARGV[1] then return -2 end
              local raw=redis.call('HGET',key,'items')
              if raw then
                local ok,items=pcall(cjson.decode,raw)
                if not ok or type(items)~='table' then return -3 end
                for _,item in ipairs(items) do if item.productId==ARGV[1] then return -2 end end
              end
            end
          end
        end
      until cursor=='0'
      redis.call('DEL',KEYS[1]);return 1
    `,{keys:['product:'+req.params.id],arguments:[req.params.id]});
    if(result===0)return res.status(404).json({error:'Sản phẩm đã được xóa hoặc không tồn tại.'});
    if(result===-2)return res.status(409).json({error:'Sản phẩm còn trong đơn đang chờ, đang xử lý hoặc chờ nhập kho. Hãy đợi các đơn này kết thúc rồi xóa.'});
    if(result===-3)return res.status(409).json({error:'Có đơn đang xử lý bị lỗi dữ liệu. Cần kiểm tra trước khi xóa sản phẩm.'});
    res.json({ok:true,productId:req.params.id});
  });
}
module.exports={registerProductManagement};
