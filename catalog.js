const samples=[
 ['TEE','Áo thun Everyday','Áo',189000,'tee'],['SHIRT','Sơ mi Linen','Áo',329000,'shirt'],
 ['PANTS','Quần suông Classic','Quần',389000,'pants'],['DRESS','Váy Midi thanh lịch','Váy',459000,'dress'],
 ['TEE-CREAM','Áo thun kem Basic','Áo',159000,'tee'],['TEE-BROWN','Áo thun nâu Oversize','Áo',219000,'tee'],
 ['SHIRT-BLUE','Sơ mi xanh công sở','Áo',349000,'shirt'],['SHIRT-WHITE','Sơ mi trắng thanh lịch','Áo',299000,'shirt'],
 ['PANTS-LINEN','Quần Linen thoải mái','Quần',359000,'pants'],['PANTS-WIDE','Quần ống rộng Urban','Quần',429000,'pants'],
 ['DRESS-ROSE','Váy hồng Rose','Váy',489000,'dress'],['DRESS-WEEKEND','Váy Weekend dáng xòe','Váy',399000,'dress']
];
async function seedCatalog(redis){
 let added=0;
 for(const [id,name,category,price,art] of samples){
  const color=id.includes('BROWN')?'Nâu':id.includes('BLUE')?'Xanh':id.includes('WHITE')?'Trắng':id.includes('ROSE')?'Hồng':category==='Quần'?'Be / tông trung tính':'Kem / tông trung tính';
  const material=name.toLowerCase().includes('linen')?'Vải phối Linen, bề mặt tự nhiên, thoáng nhẹ. Thông số của sản phẩm mẫu.':art==='tee'?'Cotton phối, co giãn nhẹ, bề mặt mềm. Thông số của sản phẩm mẫu.':category==='Quần'?'Vải dệt đứng phom, độ co giãn nhẹ. Thông số của sản phẩm mẫu.':'Vải mềm, rủ nhẹ, phom thoải mái. Thông số của sản phẩm mẫu.';
  const description=category==='Quần'?`${name} với ống quần thoải mái và đường nét gọn gàng. Phối cùng sơ mi để đi làm hoặc áo thun cho cuối tuần. Thiết kế hướng đến sự linh hoạt trong tủ đồ hằng ngày.`:category==='Váy'?`${name} mang phom dáng mềm mại, tạo điểm nhấn nhẹ nhàng cho những buổi gặp gỡ và dạo phố. Dễ kết hợp cùng sandal, giày bệt và túi đeo vai.`:`${name} là thiết kế dễ mặc cho ngày đi học, đi làm hoặc dạo phố. Phom thoải mái, phối đẹp với quần suông hoặc chân váy; có thể mặc riêng hoặc phối nhiều lớp.`;
  const product={productId:'SP-DEMO-'+id,name,category,price:String(price),stock:'30',sizes:JSON.stringify(['S','M','L']),image:'/assets/'+art+'.svg',description,material,color,'stock:S':'10','stock:M':'10','stock:L':'10',createdAt:new Date().toISOString()};
  added+=await redis.eval("if redis.call('EXISTS',KEYS[1])==1 then return 0 end redis.call('HSET',KEYS[1],unpack(ARGV)); return 1",{keys:['product:'+product.productId],arguments:Object.entries(product).flat()});
  for(const field of ['description','material','color']) await redis.hSetNX('product:'+product.productId,field,product[field]);
 }
 return added;
}
module.exports={seedCatalog};
