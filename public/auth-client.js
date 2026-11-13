(() => {
  const auth={user:null};
  const icon='<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/></svg>';
  auth.loginUrl=next=>'/login.html?next='+encodeURIComponent(next||location.pathname+location.hash);
  auth.render=()=>{
    const slot=document.getElementById('auth-slot');if(!slot)return;slot.replaceChildren();
    if(!auth.user){const link=document.createElement('a');link.className='account-login';link.href=auth.loginUrl();link.innerHTML=icon+'<span>Đăng nhập</span>';slot.append(link);return;}
    const menu=document.createElement('details');menu.className='account-menu';const summary=document.createElement('summary');summary.innerHTML=icon;summary.setAttribute('aria-label','Tài khoản của bạn');const text=document.createElement('span');text.textContent='Tài khoản';summary.append(text);
    const panel=document.createElement('div');panel.className='account-dropdown';const name=document.createElement('strong'),email=document.createElement('small');name.textContent=auth.user.name;email.textContent=auth.user.email;panel.append(name,email);
    if(auth.user.role==='admin'){const link=document.createElement('a');link.href='/admin.html';link.textContent='Quản trị cửa hàng ↗';panel.append(link);}
    if(['warehouse','delivery'].includes(auth.user.role)){const link=document.createElement('a');link.href='/fulfillment.html';link.textContent='Không gian vận hành ↗';panel.append(link);}
    const logout=document.createElement('button');logout.type='button';logout.textContent='Đăng xuất';logout.onclick=auth.logout;const error=document.createElement('p');error.id='auth-error';error.setAttribute('role','status');panel.append(logout,error);menu.append(summary,panel);slot.append(menu);
  };
  auth.logout=async()=>{
    try{const response=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error();auth.user=null;location.href='/';}
    catch{const status=document.getElementById('auth-error');if(status)status.textContent='Chưa đăng xuất được. Kiểm tra kết nối và thử lại.';}
  };
  auth.ready=fetch('/api/auth/me',{cache:'no-store'}).then(async response=>{if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error();const data=await response.json();auth.user=data.user;auth.render();return auth.user;}).catch(()=>{auth.render();return null;});
  window.nosqlAuth=auth;
  const logout=document.getElementById('logout-button');if(logout)logout.onclick=auth.logout;
})();
