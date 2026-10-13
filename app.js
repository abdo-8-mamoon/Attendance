
// ==========================================================
// Configuration & Supabase client
// ==========================================================
const SUPABASE_URL = 'https://ftnowxxzlprnoagncsew.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_pZueCb4KVnR4u9gG9PLTpw_8vxTAiUK';
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    detectSessionInUrl: true,
    persistSession: true,
    autoRefreshToken: true
  }
});

// ==========================================================
// Live application state (loaded from Supabase after authentication)
let forcePasswordChange = false;
const depts = ['HR', 'Sales', 'Marketing', 'IT', 'Accounting', 'Operations', 'Customer Service', 'Management'];
const jobs = ['أخصائي موارد بشرية', 'تنفيذي مبيعات', 'مصمم جرافيك', 'مطور برمجيات', 'محاسب أول', 'منسق عمليات', 'مسؤول خدمة عملاء', 'مدير قسم'];
// App state
// ==========================================================
let data = { employees: [], attendance: [], leaves: [], missions: [], notifications: [], rules: {}, currentEmployee: null, dark: localStorage.getItem('workflow_hr_dark') === 'true' };
let dashboardRefreshTimer = null;
function uiDisplayName(){return session?.role==='manager'?'إيمي':(session?.name||'');}
let session = null;
let companyManagerProfileIds = [];
let companyManagerEmployeeIds = [];
async function loadCompanyManagerContext() {
  if (!session?.company_id || session.role !== 'manager') { companyManagerProfileIds=[]; companyManagerEmployeeIds=[]; return; }
  const pr = await supabaseClient.from('profiles').select('id,role').eq('company_id', session.company_id);
  companyManagerProfileIds = (pr.data || []).filter(x => x.role === 'manager').map(x => String(x.id));
  if (session.id && !companyManagerProfileIds.includes(String(session.id))) companyManagerProfileIds.push(String(session.id));
  if (!companyManagerProfileIds.length) { companyManagerEmployeeIds=[]; return; }
  const er = await supabaseClient.from('employees').select('id,profile_id').eq('company_id', session.company_id).in('profile_id', companyManagerProfileIds);
  companyManagerEmployeeIds = (er.data || []).map(x => String(x.id));
}
function isCompanyManagerEmployee(row) {
  return session?.role === 'manager' && (companyManagerEmployeeIds.includes(String(row?.id)) || companyManagerEmployeeIds.includes(String(row?.employee_id)) || companyManagerProfileIds.includes(String(row?.profile_id)));
}
function onlyCompanyStaff(rows) { return (rows || []).filter(row => !isCompanyManagerEmployee(row)); }
let currentPage = 'dashboard',
  charts = {};


// ==========================================================
// Persistence & toast helpers
// ==========================================================
function save() {
  localStorage.setItem('workflow_hr_dark', data.dark ? 'true' : 'false')
}

function toast(msg, type = 'success') {
  let el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<i class="fa-solid ' + (type === 'error' ? 'fa-circle-xmark' : 'fa-circle-check') + '"></i><span>' + msg + '</span>';
  document.getElementById('toastWrap').appendChild(el);
  setTimeout(() => el.remove(), 3500)
}

// ==========================================================
// Authentication (login / logout / invite flow)
// ==========================================================
async function login(e) {
  e.preventDefault();
  let loginId = document.getElementById('email').value.trim(),
    pass = document.getElementById('password').value,
    x = document.getElementById('loginError');
  x.classList.add('hidden');
  const submit = document.getElementById('loginSubmit');
  if (submit) { submit.disabled = true; submit.dataset.original = submit.innerHTML; submit.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> جارٍ التحقق...'; }
  let authEmail = loginId.includes('@') ? loginId : loginId.toLowerCase() + '@internal.workflow.local';
  const {
    data: authData,
    error
  } = await supabaseClient.auth.signInWithPassword({
    email: authEmail,
    password: pass
  });
  if (error) {
    x.textContent = 'تعذر تسجيل الدخول. تحقق من البريد/كود الموظف وكلمة المرور.';
    x.classList.remove('hidden');
    if (submit) { submit.disabled = false; submit.innerHTML = submit.dataset.original; }
    return
  }
  const {
    data: profile,
    error: profileError
  } = await supabaseClient.from('profiles').select('*').eq('id', authData.user.id).single();
  if (profileError || !profile) {
    await supabaseClient.auth.signOut();
    x.textContent = 'حساب المستخدم غير مكتمل.';
    x.classList.remove('hidden');
    if (submit) { submit.disabled = false; submit.innerHTML = submit.dataset.original; }
    return
  }
  session = {
    id: authData.user.id,
    email: authData.user.email,
    role: profile.role,
    name: profile.full_name,
    company_id: profile.company_id
  };
  forcePasswordChange = !!authData.user.user_metadata?.must_change_password;
  startApp();
  if (submit) { submit.disabled = false; submit.innerHTML = submit.dataset.original; }
  toast(`مرحبًا بك يا ${uiDisplayName()}، تم تسجيل الدخول بنجاح`);
}
async function logout() {
  await supabaseClient.auth.signOut();
  session = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'grid';
  toast('تم تسجيل الخروج');
}

function showInvitePasswordSetup() {
  openModal(`<div class="modal-head"><h3>تعيين كلمة المرور</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><p class="muted">مرحبًا بك في Milestones Group. عيّن كلمة مرور لحسابك للمتابعة.</p><div class="form-group"><label>كلمة المرور الجديدة</label><input id="invite-pass" type="password" class="form-control ltr" minlength="6" placeholder="6 أحرف على الأقل"></div><div class="form-group"><label>تأكيد كلمة المرور</label><input id="invite-pass-confirm" type="password" class="form-control ltr" minlength="6"></div><p id="invite-pass-error" class="error-text hidden"></p></div><div class="modal-foot"><button class="primary-btn" onclick="finishInvitePassword()">حفظ كلمة المرور</button></div>`)
}
async function finishInvitePassword() {
  let pass = document.getElementById('invite-pass').value,
    confirmPass = document.getElementById('invite-pass-confirm').value,
    err = document.getElementById('invite-pass-error');
  err.classList.add('hidden');
  if (pass.length < 6) {
    err.textContent = 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
    err.classList.remove('hidden');
    return
  }
  if (pass !== confirmPass) {
    err.textContent = 'كلمتا المرور غير متطابقتين';
    err.classList.remove('hidden');
    return
  }
  let {
    error
  } = await supabaseClient.auth.updateUser({
    password: pass,
    data: {
      must_change_password: false
    }
  });
  if (error) {
    err.textContent = 'تعذر حفظ كلمة المرور: ' + error.message;
    err.classList.remove('hidden');
    return
  }
  history.replaceState({}, document.title, location.pathname);
  closeModal();
  toast('تم تعيين كلمة المرور بنجاح')
}

function isInviteFlow() {
  let raw = location.hash + ' ' + location.search;
  return raw.includes('type=invite') || raw.includes('access_token=') || raw.includes('token_hash=')
}

let notificationChannel=null;
function notificationTarget(n){
  if(n?.target_page) return {page:n.target_page,id:n.target_id};
  const text=((n?.title||'')+' '+(n?.message||'')).toLowerCase();
  if(text.includes('مأمورية')||text.includes('mission')) return {page:'missions'};
  if(text.includes('إجاز')||text.includes('leave')) return {page:'leaves'};
  if(text.includes('حضور')||text.includes('بصمة')||text.includes('attendance')) return {page:'attendance'};
  return {page:'dashboard'};
}
function notificationText(n){ let msg=n?.message||''; if(session?.role==='employee') msg=msg.replace(/(?:بواسطة|من قبل|عن طريق)\s+[^:،.]+/g,'').replace(/المدير\s*[^:،.]+/g,''); return msg.trim() || (appLang==='en'?'New notification':'إشعار جديد'); }
function requestBrowserNotifications(){ if('Notification' in window && Notification.permission==='default') Notification.requestPermission().catch(()=>{}); }
function enableNotificationAudio(){try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;window.__notifAudioCtx=window.__notifAudioCtx||new C();if(window.__notifAudioCtx.state==='suspended')window.__notifAudioCtx.resume();}catch(e){}}
function playNotificationSound(){try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return;const ctx=window.__notifAudioCtx||(window.__notifAudioCtx=new C());if(ctx.state==='suspended')ctx.resume();[0,0.18].forEach((delay,i)=>{const o=ctx.createOscillator(),g=ctx.createGain();o.type='sine';o.frequency.value=i?1046:880;g.gain.setValueAtTime(.0001,ctx.currentTime+delay);g.gain.exponentialRampToValueAtTime(.22,ctx.currentTime+delay+.025);g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+delay+.16);o.connect(g);g.connect(ctx.destination);o.start(ctx.currentTime+delay);o.stop(ctx.currentTime+delay+.18);});}catch(e){}}
document.addEventListener('pointerdown',enableNotificationAudio,{once:true,passive:true});
function showBrowserNotification(n){ if('Notification' in window && Notification.permission==='granted'){ const x=new Notification(n.title||'WorkFlow HR',{body:notificationText(n),tag:String(n.id||Date.now())}); x.onclick=()=>{window.focus();openNotification(n);x.close()}; } }
function subscribeNotifications(){if(!session?.id||notificationChannel)return;notificationChannel=supabaseClient.channel('notifications-'+session.id).on('postgres_changes',{event:'INSERT',schema:'public',table:'notifications',filter:'user_id=eq.'+session.id},payload=>{data.notifications=[payload.new,...(data.notifications||[])];refreshNotificationBadge();toast(payload.new.title||'إشعار جديد');playNotificationSound();showBrowserNotification(payload.new)}).subscribe();requestBrowserNotifications()}
function startApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.body.classList.toggle('dark', data.dark);
  document.getElementById('userName').textContent = uiDisplayName();
  document.getElementById('userRole').textContent = session.role === 'manager' ? 'مدير الشركة' : 'موظف';
  document.getElementById('userAvatar').textContent = (uiDisplayName() || 'م')[0];
  renderNav();
  openPage('dashboard');
  if (isInviteFlow() || forcePasswordChange) setTimeout(showInvitePasswordSetup, 350);
  refreshNotificationBadge(); subscribeNotifications(); requestBrowserNotifications(); applyLanguage();
  clearInterval(dashboardRefreshTimer);
  dashboardRefreshTimer=setInterval(()=>{if(session&&currentPage==='dashboard')loadDashboardLive();},30000);
}
async function restoreAuth() {
  const {
    data: authData
  } = await supabaseClient.auth.getSession();
  if (!authData.session) return;
  const {
    data: profile
  } = await supabaseClient.from('profiles').select('*').eq('id', authData.session.user.id).single();
  if (profile) {
    session = {
      id: authData.session.user.id,
      email: authData.session.user.email,
      role: profile.role,
      name: profile.full_name,
      company_id: profile.company_id
    };
    startApp();
    setTimeout(() => toast(`مرحبًا بك يا ${uiDisplayName()}`), 250)
  }
}
document.getElementById('loginForm').addEventListener('submit', login);
document.getElementById('togglePassword').onclick = () => {
  let p = document.getElementById('password');
  p.type = p.type === 'password' ? 'text' : 'password'
};

// ==========================================================
// Navigation & routing
// ==========================================================
const managerNav = [
  ['dashboard', 'لوحة التحكم', 'fa-chart-pie'],
  ['employees', 'الموظفون', 'fa-users'],
  ['attendance', 'الحضور والانصراف', 'fa-calendar-check'],
  ['leaves', 'طلبات الإجازات', 'fa-calendar-xmark'],
  ['missions', 'المأموريات', 'fa-route'],
  ['payroll', 'الرواتب', 'fa-money-bill-wave'],
  ['rules', 'اللائحة الداخلية', 'fa-scale-balanced'],
  ['reports', 'التقارير', 'fa-chart-column'],
  ['directory', 'دليل الموظفين', 'fa-address-book']
];
const employeeNav = [
  ['dashboard', 'لوحة الموظف', 'fa-house'],
  ['attendance', 'حضوري', 'fa-calendar-check'],
  ['leaves', 'إجازاتي', 'fa-calendar-xmark'],
  ['missions', 'مأمورياتي', 'fa-route'],
  ['payroll', 'راتبي', 'fa-money-bill-wave'],
  ['profile', 'ملفي الشخصي', 'fa-user'],
  ['allowances', 'مخصصات الإجازات', 'fa-chart-pie'],
  ['directory', 'دليل الموظفين', 'fa-address-book']
];
function renderNav() {
  let arr = session.role === 'manager' ? managerNav : employeeNav;
  document.getElementById('nav').innerHTML = `<div class="side-section">${t('القائمة الرئيسية')}</div>` + arr.map(n => `<div class="nav-item ${currentPage===n[0]?'active':''}" onclick="openPage('${n[0]}')"><i class="fa-solid ${n[2]}"></i><span>${t(n[1])}</span></div>`).join('')
}

function openPage(page) {
  if (['tasks', 'assets', 'documents', 'learning', 'recognition'].includes(page)) page = 'dashboard';
  if (session.role === 'employee' && ['employees', 'rules', 'reports'].includes(page)) {
    toast('ليس لديك صلاحية للوصول إلى هذه الصفحة', 'error');
    return
  }
  currentPage = page;
  renderNav();
  document.getElementById('sidebar').classList.remove('open');
  let titles = {
    dashboard: 'لوحة التحكم',
    employees: 'إدارة الموظفين',
    attendance: 'الحضور والانصراف',
    leaves: 'إدارة الإجازات',
    missions: 'إدارة المأموريات',
    payroll: 'الرواتب Payroll',
    rules: 'اللائحة الداخلية',
    reports: 'التقارير والتحليلات',
    profile: 'الملف الشخصي',
    settings: 'الإعدادات',
    allowances: 'مخصصات الإجازات',
    directory: 'دليل الموظفين',
  };
  document.getElementById('topTitle').textContent = titles[page] || '';
  if (!views) {
    setTimeout(() => openPage(page), 0);
    return
  }
  let fn = views[page] || views.dashboard;
  document.getElementById('content').innerHTML = fn();
  setTimeout(() => {
    drawCharts(page);
    if (page === 'dashboard' || page === 'reports') loadDashboardLive();
    if (page === 'employees' || page === 'directory') loadEmployeesLive();
    if (page === 'attendance') loadAttendanceLive();
    if (page === 'leaves') loadLeavesLive();
    if (page === 'missions') loadMissionsLive();
    if (page === 'payroll') { loadPayrollLive(); if (session.role === 'manager' && !data.employees?.length) loadEmployeesLive(); }
    if (page === 'profile') loadProfileLive();
    if (page === 'settings' && session.role === 'manager') loadCompanyGeo()
  }, 50)
}


// ==========================================================
// Shared UI helpers (page head, stat cards)
// ==========================================================
function pageHead(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="head-actions">${actions}</div></div>`
}

function stat(icon, label, value, cls, trend = '') {
  return `<div class="stat-card"><div class="stat-top"><span class="stat-icon ${cls}"><i class="fa-solid ${icon}"></i></span><span class="trend">${trend}</span></div><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`
}


// ==========================================================
// Dashboard views
// ==========================================================
function todayLabel() {
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
}
function emptyState(text = 'لا توجد بيانات') {
  return `<div class="empty"><i class="fa-solid fa-inbox"></i><p>${text}</p></div>`;
}
function calendarWidget(selectedDate=null){
  const now=selectedDate?new Date(selectedDate+'T12:00:00'):new Date(), y=now.getFullYear(), mo=now.getMonth(), todayKey=new Date().toISOString().slice(0,10), selectedKey=selectedDate||todayKey, first=new Date(y,mo,1).getDay(), days=new Date(y,mo+1,0).getDate();
  const names=['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
  const events=(data.missions||[]).map(x=>({date:x.start_date,title:'مأمورية: '+x.title,page:'missions'}));
  let cells=names.map(n=>`<div class="cal-head">${n.slice(0,2)}</div>`).join('');for(let i=0;i<first;i++)cells+='<div class="cal-cell muted"></div>';
  for(let d=1;d<=days;d++){const key=`${y}-${String(mo+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,ev=events.filter(e=>e.date===key);cells+=`<button class="cal-cell ${key===todayKey?'today':''} ${key===selectedKey?'selected':''}" onclick="selectCalendarDate('${key}')"><b>${d}</b>${ev.length?`<small>${ev.length} نشاط</small>`:''}</button>`;}
  const selectedEvents=events.filter(e=>e.date===selectedKey);
  return `<div class="calendar-toolbar"><input type="date" class="form-control ltr" value="${selectedKey}" onchange="selectCalendarDate(this.value)"><span class="muted">اختر أي يوم لمراجعة المأموريات</span></div><div class="calendar-grid">${cells}</div><div class="card" style="margin-top:14px;background:var(--bg);box-shadow:none"><b>أنشطة ${selectedKey}</b>${selectedEvents.length?`<div class="timeline">${selectedEvents.map(e=>`<div class="timeline-item"><span class="timeline-dot"></span><div><p>${e.title}</p><button class="link" onclick="openPage('${e.page}')">فتح التفاصيل</button></div></div>`).join('')}</div>`:'<p class="muted">لا توجد مأموريات مسجلة في هذا اليوم.</p>'}</div>`;
}
function selectCalendarDate(date){const el=document.getElementById('dashboardCalendar');if(el)el.innerHTML=calendarWidget(date);}
async function loadDashboardCalendar(){
  if(!session?.company_id)return;
  const m=await supabaseClient.from('missions').select('id,title,start_date,employee_id,status').eq('company_id',session.company_id);
  if(session.role==='employee'){const ce=await getCurrentEmployee();data.currentEmployeeId=ce?.id;}
  data.missions=session.role==='employee'?(m.data||[]).filter(x=>x.employee_id===data.currentEmployeeId):(m.data||[]);
  const el=document.getElementById('dashboardCalendar');if(el)el.innerHTML=calendarWidget();
}
function managerDash() {
  const employees = onlyCompanyStaff(data.employees || []);
  const attendance = onlyCompanyStaff(data.attendance || []);
  const leaves = onlyCompanyStaff(data.leaves || []);
  const payroll = onlyCompanyStaff(data.payroll || []);
  const todayKey = new Date().toDateString();
  const todayAttendance = attendance.filter(a => { const raw=a.check_in||a.date; return raw && new Date(raw).toDateString()===todayKey; });
  const presentIds = new Set(todayAttendance.filter(a => ['حاضر','متأخر','مكتمل','قيد العمل'].includes(a.status)).map(a => String(a.employee_id || a.employee || '')));
  const lateIds = new Set(todayAttendance.filter(a => a.status === 'متأخر').map(a => String(a.employee_id || a.employee || '')));
  const present = presentIds.size, late = lateIds.size;
  const absent = Math.max(employees.length - presentIds.size, 0);
  const pendingLeaves = leaves.filter(l => l.status === 'معلق').length;
  const latestMonth = payroll.map(r => r.month).filter(Boolean).sort().pop();
  const payrollTotal = payroll.filter(r => !latestMonth || r.month === latestMonth).reduce((sum, r) => sum + Number(r.net_salary || 0), 0);
  const rate = employees.length ? `${Math.round((present / employees.length) * 100)}%` : '—';
  const recentLeaves = leaves.slice(0, 4);
  return pageHead(`مرحبًا بك يا ${uiDisplayName()} 👋`, `ملخص أداء فريقك اليوم — ${todayLabel()}`, `<button class="ghost-btn" onclick="openPage('dashboard')"><i class="fa-solid fa-rotate"></i> تحديث</button>`) +
    `<div class="stats-grid">${stat('fa-users','إجمالي الموظفين',employees.length,'purple')}${stat('fa-user-check','الحاضرين اليوم',present,'green')}${stat('fa-user-xmark','الغائبين',absent,'red')}${stat('fa-clock','المتأخرين',late,'orange')}${stat('fa-calendar-xmark','طلبات إجازة معلقة',pendingLeaves,'purple')}${stat('fa-money-bill-wave','إجمالي الرواتب',payrollTotal ? payrollTotal.toLocaleString() + ' ر.س' : '—','green')}${stat('fa-chart-line','نسبة الحضور',rate,'purple')}</div>` +
    `<div class="grid-2"><div class="card"><div class="card-head"><h3>نظرة عامة على الحضور</h3><span class="muted">آخر 7 أيام</span></div><div class="chart-box">${attendance.length ? '<canvas id="attendanceChart"></canvas>' : emptyState()}</div></div><div class="card"><div class="card-head"><h3>آخر طلبات الإجازة</h3><span class="link" onclick="openPage('leaves')">عرض الإجازات</span></div>${recentLeaves.length ? `<div class="timeline">${recentLeaves.map(l => `<div class="timeline-item"><span class="timeline-dot"></span><div><p>طلب إجازة <b>${l.employee || 'موظف'}</b></p><small>${l.status}</small></div></div>`).join('')}</div>` : emptyState('لا توجد طلبات إجازة حديثة')}</div></div>` +
    `<div class="card calendar-card"><div class="card-head"><h3><i class="fa-regular fa-calendar"></i> التقويم</h3><span class="muted">${todayLabel()}</span></div><div id="dashboardCalendar">${calendarWidget()}</div></div>` +
    `<div class="grid-2"><div class="card"><div class="card-head"><h3>توزيع الموظفين حسب القسم</h3></div><div class="chart-box">${employees.length ? '<canvas id="deptChart"></canvas>' : emptyState()}</div></div><div class="card"><div class="card-head"><h3>إجراءات سريعة</h3></div><div class="quick-grid"><div class="quick" onclick="openEmployeeModal()"><i class="fa-solid fa-user-plus"></i><b>إضافة موظف</b></div><div class="quick" onclick="openPage('leaves')"><i class="fa-solid fa-calendar-check"></i><b>مراجعة الإجازات</b></div><div class="quick" onclick="openPage('reports')"><i class="fa-solid fa-chart-column"></i><b>عرض التقارير</b></div><div class="quick" onclick="openPage('missions')"><i class="fa-solid fa-route"></i><b>إدارة المأموريات</b></div></div></div></div>`;
}
function employeeDash() {
  const mine = data.attendance?.[0];
  const leaves = data.leaves || [];
  const payroll = data.payroll?.[0];
  return pageHead(`مرحبًا بك يا ${session.name} 👋`, `نتمنى لك يومًا منتجًا — ${todayLabel()}`, `<button class="primary-btn" onclick="openAttendanceModal()"><i class="fa-solid fa-fingerprint"></i> تسجيل الحضور</button><button class="ghost-btn" onclick="openCheckoutModal()"><i class="fa-solid fa-right-from-bracket"></i> تسجيل الانصراف</button>`) +
    `<div class="stats-grid">${stat('fa-calendar-check','حالة اليوم',mine?.status || '—','orange')}${stat('fa-clock','ساعات العمل',mine?.hours || '—','purple')}${stat('fa-calendar-days','رصيد الإجازات',leaves.length ? '—' : '—','green')}${stat('fa-money-bill-wave','صافي الراتب',payroll ? Number(payroll.net_salary||0).toLocaleString() + ' ر.س' : '—','purple')}</div>` +
    `<div class="grid-2"><div class="card"><div class="card-head"><h3>أدوات سريعة</h3></div><div class="quick-grid"><div class="quick" onclick="openAttendanceModal()"><i class="fa-solid fa-fingerprint"></i><div><b>تسجيل الحضور</b><small class="muted">صورة حقيقية + GPS</small></div></div><div class="quick" onclick="openLeaveModal()"><i class="fa-solid fa-calendar-plus"></i><div><b>طلب إجازة</b><small class="muted">قدّم طلبًا جديدًا</small></div></div><div class="quick" onclick="openPage('missions')"><i class="fa-solid fa-route"></i><div><b>المأموريات</b><small class="muted">متابعة المأموريات</small></div></div><div class="quick" onclick="openPage('payroll')"><i class="fa-solid fa-file-invoice-dollar"></i><div><b>كشف الراتب</b><small class="muted">${payroll ? 'آخر كشف جاهز' : 'لا يوجد كشف'}</small></div></div></div></div><div class="card"><div class="card-head"><h3>آخر الإشعارات</h3></div>${data.notifications?.length ? `<div class="timeline">${data.notifications.slice(0,4).map(n=>`<div class="timeline-item"><span class="timeline-dot"></span><div><p>${n.message || n}</p></div></div>`).join('')}</div>` : emptyState()}</div></div>`;
}
async function loadDashboardLive() {
  if (!session?.company_id) return; await loadCompanyManagerContext(); const currentEmp = session.role === 'employee' ? await getCurrentEmployee(true) : null;
  if(currentEmp) data.currentEmployee=currentEmp;
  const today = new Date(); today.setHours(0,0,0,0);
  const [employeesRes, attendanceRes, leavesRes, payrollRes, notificationsRes] = await Promise.all([
    supabaseClient.from('employees').select('*').eq('company_id', session.company_id),
    supabaseClient.from('attendance').select('*, employees(full_name,employee_code)').eq('company_id', session.company_id).gte('check_in', new Date(Date.now()-7*86400000).toISOString()).order('created_at',{ascending:false}),
    supabaseClient.from('leaves').select('*, employees(full_name)').eq('company_id', session.company_id).order('created_at',{ascending:false}),
    supabaseClient.from('payroll_records').select('*').eq('company_id', session.company_id).order('month',{ascending:false}),
    supabaseClient.from('notifications').select('*').eq('user_id', session.id).order('created_at',{ascending:false}).limit(4)
  ]);
  const staffRows = session.role === 'manager' ? onlyCompanyStaff(employeesRes.data || []) : (employeesRes.data || []);
  const staffIds = new Set(staffRows.map(e => String(e.id)));
  if (employeesRes.data) data.employees = staffRows.map(e=>({id:e.employee_code||e.id,name:e.full_name,dept:e.department||'—',job:e.job_title||'—',phone:e.phone||'—',email:e.email||'—',join:e.join_date||'—',salary:Number(e.salary||0),status:e.status==='active'?'نشط':e.status||'نشط',dbId:e.id,profile_id:e.profile_id,canCreateMissions:!!e.can_create_missions}));
  if (notificationsRes.data) data.notifications = notificationsRes.data;
  if (session.role === 'employee') {
    if (attendanceRes.data) data.attendance = attendanceRes.data.filter(a=>a.employee_profile_id===session.id).map(a=>({employee:a.employees?.full_name||'—',status:a.status==='late'?'متأخر':a.status==='present'?'حاضر':a.status==='completed'?'مكتمل':'قيد العمل',hours:a.work_hours?`${a.work_hours} ساعات`:'—'}));
    if (leavesRes.data) data.leaves = leavesRes.data.filter(l=>l.employee_profile_id===session.id).map(l=>({employee:l.employees?.full_name||'—',status:l.status==='approved'?'مقبول':l.status==='rejected'?'مرفوض':'معلق'}));
  } else {
    data.attendance = (attendanceRes.data || []).filter(a=>staffIds.has(String(a.employee_id))).map(a=>({id:a.id,employee_id:a.employee_id,employee:a.employees?.full_name||'—',date:a.check_in||'',check_in:a.check_in,status:a.status==='present'?'حاضر':a.status==='late'?'متأخر':a.status==='completed'?'مكتمل':a.status==='absent'?'غائب':'قيد العمل',hours:a.work_hours?`${a.work_hours} ساعات`:'—'}));
    data.leaves = (leavesRes.data || []).filter(l=>staffIds.has(String(l.employee_id))).map(l=>({id:l.id,employee_id:l.employee_id,employee:l.employees?.full_name||'—',type:l.leave_type,status:l.status==='approved'?'مقبول':l.status==='rejected'?'مرفوض':'معلق'}));
  }
  data.payroll = session.role === 'manager' ? (payrollRes.data || []).filter(r=>staffIds.has(String(r.employee_id))) : (payrollRes.data || []);
  if (currentPage === 'dashboard' || currentPage === 'reports') { document.getElementById('content').innerHTML = views[currentPage](); drawCharts(currentPage); if(currentPage==='dashboard'){ loadDashboardCalendar().then(()=>autoPeriodicReports()); } }
}
// Employees module
// ==========================================================
function employeesView() {
  return pageHead('الموظفون', 'إدارة بيانات فريقك ومتابعة حالة كل موظف', `<button class="primary-btn" onclick="openEmployeeModal()"><i class="fa-solid fa-user-plus"></i> إضافة موظف</button>`) + `<div class="card"><div class="toolbar"><input id="empSearch" class="form-control" placeholder="ابحث عن موظف..." oninput="filterEmployees()"><select id="empDeptFilter" class="form-control" onchange="filterEmployees()"><option value="">كل الأقسام</option>${depts.map(d=>`<option>${d}</option>`).join('')}</select><select id="empStatusFilter" class="form-control" onchange="filterEmployees()"><option value="">كل الحالات</option><option>نشط</option><option>إجازة</option></select><button class="ghost-btn" onclick="exportEmployeesCSV()"><i class="fa-solid fa-download"></i> تصدير</button></div><div id="employeesTable"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>جاري تحميل الموظفين...</p></div></div></div>`;
}
async function loadEmployeesLive() {
  if (!session?.company_id) return;
  await loadCompanyManagerContext();
  const {
    data: rows,
    error
  } = await supabaseClient.from('employees').select('*').eq('company_id', session.company_id).order('created_at', {
    ascending: false
  });
  if (error) {
    toast('تعذر تحميل الموظفين من Supabase — تأكد من تشغيل migration الموظفين', 'error');
    document.getElementById('employeesTable').innerHTML = employeesTable(data.employees);
    return
  }
  const mapped = onlyCompanyStaff(rows || []).map(e => ({
    id: e.employee_code || e.id,
    name: e.full_name,
    dept: e.department || '—',
    job: e.job_title || '—',
    phone: e.phone || '—',
    email: e.email || '—',
    join: e.join_date || '—',
    salary: Number(e.salary || 0),
    status: e.status === 'active' ? 'نشط' : e.status || 'نشط',
    dbId: e.id,
    canCreateMissions: !!e.can_create_missions
  }));
  data.employees = mapped;
  if (document.getElementById('employeesTable')) document.getElementById('employeesTable').innerHTML = employeesTable(mapped);
  if (document.getElementById('directoryGrid')) document.getElementById('directoryGrid').innerHTML = directoryCards(mapped);
  if (document.getElementById('orgStructure')) {
    let counts = {};
    mapped.forEach(e => {
      counts[e.dept] = (counts[e.dept] || 0) + 1
    });
    document.getElementById('orgStructure').innerHTML = depts.map(d => `<div class="quick"><span class="avatar">${d[0]}</span><div><b>${d}</b><small class="muted" style="display:block">${counts[d]||0} موظفين</small></div></div>`).join('')
  }
}

function employeesTable(rows) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>الموظف</th><th>الرقم الوظيفي</th><th>القسم</th><th>المسمى الوظيفي</th><th>الهاتف</th><th>تاريخ الانضمام</th><th>الراتب</th><th>الحالة</th><th>صلاحية المأموريات</th><th>إجراءات</th></tr></thead><tbody>${rows.map((e,i)=>`<tr><td><div class="person"><span class="avatar">${e.name[0]}</span><b>${e.name}</b></div></td><td class="ltr">${e.id}</td><td>${e.dept}</td><td>${e.job}</td><td class="ltr">${e.phone}</td><td class="ltr">${e.join}</td><td>${e.salary.toLocaleString()} ر.س</td><td><span class="badge ${e.status==='نشط'?'success':'warning'}">${e.status}</span></td><td>${e.canCreateMissions?'<span class="badge success">مفعّلة</span>':'<span class="muted">—</span>'}</td><td><button class="action-btn" onclick="viewEmployeeProfile('${e.dbId}')"><i class="fa-solid fa-eye"></i></button><button class="action-btn" onclick="openEmployeeModal('${e.dbId}')"><i class="fa-solid fa-pen"></i></button><button class="action-btn" onclick="deleteEmployee('${e.dbId}')"><i class="fa-solid fa-trash"></i></button></td></tr>`).join('')}</tbody></table></div>`
}

function filterEmployees() {
  let q = (document.getElementById('empSearch')?.value || '').toLowerCase();
  let dept = document.getElementById('empDeptFilter')?.value || '';
  let st = document.getElementById('empStatusFilter')?.value || '';
  let rows = data.employees.filter(e => (e.name + e.email + e.dept).toLowerCase().includes(q) && (!dept || e.dept === dept) && (!st || e.status === st));
  document.getElementById('employeesTable').innerHTML = employeesTable(rows)
}

async function exportEmployeesCSV() {
  if (!data.employees?.length) await loadEmployeesLive();
  let rows = data.employees || [];
  if (!rows.length) {
    toast('لا يوجد بيانات لتصديرها', 'error');
    return
  }
  let head = ['الاسم', 'الرقم الوظيفي', 'القسم', 'المسمى الوظيفي', 'الهاتف', 'البريد', 'تاريخ الانضمام', 'الراتب', 'الحالة'];
  let lines = [head.join(',')].concat(rows.map(e => [e.name, e.id, e.dept, e.job, e.phone, e.email || '', e.join, e.salary, e.status].map(v => `"${String(v??'').replace(/"/g,'""')}"`).join(',')));
  let blob = new Blob(['\ufeff' + lines.join('\n')], {
    type: 'text/csv;charset=utf-8;'
  });
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a');
  a.href = url;
  a.download = 'employees.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('تم تصدير ملف CSV بنجاح')
}

function viewEmployeeProfile(dbId) {
  let e = data.employees.find(x => String(x.dbId) === String(dbId));
  if (!e) {
    toast('تعذر العثور على الموظف', 'error');
    return
  }
  openModal(`<div class="modal-head"><h3>ملف الموظف</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="form-grid"><p><small class="muted">الاسم</small><br><b>${e.name}</b></p><p><small class="muted">الرقم الوظيفي</small><br><b>${e.id}</b></p><p><small class="muted">القسم</small><br><b>${e.dept}</b></p><p><small class="muted">المسمى الوظيفي</small><br><b>${e.job}</b></p><p><small class="muted">الهاتف</small><br><b class="ltr">${e.phone}</b></p><p><small class="muted">البريد الإلكتروني</small><br><b class="ltr">${e.email||'—'}</b></p><p><small class="muted">تاريخ الانضمام</small><br><b>${e.join}</b></p><p><small class="muted">الراتب</small><br><b>${e.salary.toLocaleString()} ر.س</b></p></div></div><div class="modal-foot"><button class="ghost-btn" onclick="closeModal()">إغلاق</button></div>`)
}


// ==========================================================
// Attendance module
// ==========================================================
function attendanceView() {
  let mine = session.role === 'employee';
  return pageHead(mine ? 'حضوري اليوم' : 'الحضور والانصراف', 'متابعة دقيقة للحضور، الانصراف، التأخير والموقع', mine ? `<button class="primary-btn" onclick="openAttendanceModal()"><i class="fa-solid fa-fingerprint"></i> تسجيل الحضور</button><button class="ghost-btn" onclick="openCheckoutModal()"><i class="fa-solid fa-right-from-bracket"></i> تسجيل الانصراف</button>` : `<button class="ghost-btn" onclick="exportAttendanceCSV()"><i class="fa-solid fa-download"></i> تصدير التقرير</button>`) + `<div class="card"><div class="toolbar"><input id="attSearch" class="form-control" placeholder="بحث بالاسم..." oninput="filterAttendance()"><input id="attDate" type="date" class="form-control" onchange="filterAttendance()"><select id="attStatus" class="form-control" onchange="filterAttendance()"><option value="">كل الحالات</option><option>حاضر</option><option>متأخر</option><option>غائب</option><option>إجازة</option></select></div><div id="attendanceTable"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>جاري تحميل سجلات الحضور...</p></div></div></div>`
}
async function loadAttendanceLive() {
  if (!session?.company_id) return;
  let q = supabaseClient.from('attendance').select('*, employees(full_name,employee_code)').eq('company_id', session.company_id).order('created_at', {
    ascending: false
  });
  if (session.role === 'employee') q = q.eq('employee_profile_id', session.id);
  let {
    data: rows,
    error
  } = await q;
  if (error) {
    toast('تعذر تحميل الحضور من Supabase — شغّل migration الحضور', 'error');
    document.getElementById('attendanceTable').innerHTML = attendanceTable([]);
    return
  }
  let mapped = (rows || []).map(a => ({
    employee: a.employees?.full_name || '—',
    date: a.check_in ? new Date(a.check_in).toISOString().slice(0, 10) : '',
    in: a.check_in ? new Date(a.check_in).toLocaleTimeString('ar-EG', {
      hour: '2-digit',
      minute: '2-digit'
    }) : '—',
    out: a.check_out ? new Date(a.check_out).toLocaleTimeString('ar-EG', {
      hour: '2-digit',
      minute: '2-digit'
    }) : '—',
    hours: a.work_hours ? `${a.work_hours} ساعات` : a.check_out ? 'مكتملة' : 'قيد العمل',
    late: a.status === 'late' ? 'نعم' : 'لا',
    status: a.status === 'present' ? 'حاضر' : a.status === 'late' ? 'متأخر' : a.status === 'completed' ? 'مكتمل' : a.status === 'absent' ? 'غائب' : 'قيد العمل',
    location: a.latitude ? `GPS ${Number(a.latitude).toFixed(4)}, ${Number(a.longitude).toFixed(4)}` : '—',
    dbId: a.id
  }));
  data.attendance = mapped;
  document.getElementById('attendanceTable').innerHTML = attendanceTable(mapped)
}

function attendanceTable(rows) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>الموظف</th><th>الدخول</th><th>الخروج</th><th>الساعات</th><th>التأخير</th><th>الحالة</th><th>الموقع GPS</th><th>إجراء</th></tr></thead><tbody>${rows.map(a=>`<tr><td><div class="person"><span class="avatar">${a.employee[0]}</span><b>${a.employee}</b></div></td><td class="ltr">${a.in}</td><td class="ltr">${a.out}</td><td>${a.hours}</td><td>${a.late}</td><td><span class="badge ${a.status==='حاضر'?'success':a.status==='متأخر'?'warning':a.status==='غائب'?'danger':'info'}">${a.status}</span></td><td>${a.location} <i class="fa-solid fa-location-dot muted"></i></td><td><button class="action-btn" onclick="showAttendanceDetails('${a.employee}','${a.in}','${a.out}','${a.location}')"><i class="fa-solid fa-eye"></i></button><button class="action-btn" onclick="requestMissingPunch('${a.employee}')"><i class="fa-solid fa-clock-rotate-left"></i></button></td></tr>`).join('')}</tbody></table></div>`
}

function filterAttendance() {
  let q = (document.getElementById('attSearch')?.value || '');
  let d = document.getElementById('attDate')?.value || '';
  let st = document.getElementById('attStatus')?.value || '';
  let rows = (data.attendance || []).filter(a => a.employee.includes(q) && (!d || a.date === d) && (!st || a.status === st));
  document.getElementById('attendanceTable').innerHTML = attendanceTable(rows)
}

async function exportAttendanceCSV() {
  if (!data.attendance?.length) await loadAttendanceLive();
  let rows = data.attendance || [];
  if (!rows.length) {
    toast('لا يوجد بيانات لتصديرها', 'error');
    return
  }
  let head = ['الموظف', 'التاريخ', 'الدخول', 'الخروج', 'الساعات', 'الحالة', 'الموقع'];
  let lines = [head.join(',')].concat(rows.map(a => [a.employee, a.date, a.in, a.out, a.hours, a.status, a.location].map(v => `"${String(v??'').replace(/"/g,'""')}"`).join(',')));
  let blob = new Blob(['\ufeff' + lines.join('\n')], {
    type: 'text/csv;charset=utf-8;'
  });
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a');
  a.href = url;
  a.download = 'attendance.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('تم تصدير تقرير الحضور')
}


// ==========================================================
// Leaves module
// ==========================================================
function leavesView() {
  let mine = session.role === 'employee';
  return pageHead(mine ? 'إجازاتي' : 'طلبات الإجازات', 'إدارة أرصدة الإجازات والطلبات', `<button class="primary-btn" onclick="openLeaveModal()"><i class="fa-solid fa-plus"></i> طلب إجازة</button>`) + `<div class="grid-3"><div class="card leave-card"><div class="leave-ring"><span>—</span></div><div><b>الإجازة السنوية</b><p class="muted">يتم تحميل الرصيد من قاعدة البيانات</p></div></div><div class="card"><span class="muted">طلبات قيد المراجعة</span><h2 style="margin:8px 0">—</h2><span class="badge warning">من قاعدة البيانات</span></div><div class="card"><span class="muted">إجازات مقبولة هذا العام</span><h2 style="margin:8px 0">—</h2><span class="badge success">من قاعدة البيانات</span></div></div><div class="card"><div class="card-head"><h3>سجل الطلبات</h3></div><div id="leavesTable"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>جاري تحميل الطلبات...</p></div></div></div>`
}
async function loadLeavesLive() {
  if (!session?.company_id) return;
  let q = supabaseClient.from('leaves').select('*, employees(full_name)').eq('company_id', session.company_id).order('created_at', {
    ascending: false
  });
  if (session.role === 'employee') q = q.eq('employee_profile_id', session.id);
  let {
    data: rows,
    error
  } = await q;
  if (error) {
    toast('تعذر تحميل الإجازات من Supabase — شغّل migration الإجازات', 'error');
    document.getElementById('leavesTable').innerHTML = leaveTable([], session.role === 'employee');
    return
  }
  let mapped = (rows || []).map(l => ({
    id: l.id,
    employee: l.employees?.full_name || '—',
    type: l.leave_type,
    start: l.start_date,
    end: l.end_date,
    days: l.days,
    reason: l.reason || '—',
    balance: l.balance_days ?? 16,
    status: l.status === 'approved' ? 'مقبول' : l.status === 'rejected' ? 'مرفوض' : 'معلق'
  }));
  data.leaves = mapped;
  document.getElementById('leavesTable').innerHTML = leaveTable(mapped, session.role === 'employee')
}

function leaveTable(rows, mine) {
  return `<div class="table-wrap"><table class="data-table"><thead><tr><th>الموظف</th><th>نوع الإجازة</th><th>الفترة</th><th>الأيام</th><th>السبب</th><th>الرصيد</th><th>مسار الاعتماد</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>${rows.map((l,i)=>`<tr><td><b>${l.employee}</b></td><td>${l.type}</td><td class="ltr">${l.start} → ${l.end}</td><td>${l.days}</td><td>${l.reason}</td><td>${l.balance} يوم</td><td><button class="action-btn" onclick="showApproval('${l.id}')"><i class="fa-solid fa-route"></i> عرض المسار</button></td><td><span class="badge ${l.status==='مقبول'?'success':l.status==='مرفوض'?'danger':'warning'}">${l.status}</span></td><td>${!mine&&l.status==='معلق'?`<button class="action-btn" title="قبول" onclick="approveLeave('${l.id}',true)"><i class="fa-solid fa-check"></i></button><button class="action-btn" title="رفض" onclick="approveLeave('${l.id}',false)"><i class="fa-solid fa-xmark"></i></button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`
}


// ==========================================================
// Missions module
// ==========================================================
function missionDelegateAllowedName(name){
  const n=String(name||'').trim().toLowerCase().replace(/\s+/g,' ');
  return n==='mahmoud el sayed'||n==='mohamed nazih';
}
function canCreateMissions(){return session?.role==='manager'||!!data.currentEmployee?.can_create_missions;}
function renderMissionCreateAction(){
  const el=document.getElementById('missionCreateAction');
  if(el)el.innerHTML=canCreateMissions()?`<button class="primary-btn" onclick="openMissionModal()"><i class="fa-solid fa-plus"></i> إضافة مأمورية</button>`:'';
}
function missionsView() {
  const action = `<span id="missionCreateAction"></span>`;
  return pageHead(session.role === 'employee' ? 'مأمورياتي' : 'المأموريات', 'تخطيط ومتابعة مهام السفر والعمل الميداني', action) + `<div id="missionsGrid" class="grid-2"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>جاري تحميل المأموريات...</p></div></div>`
}
async function loadMissionsLive() {
  let q = supabaseClient.from('missions').select('*, employees(full_name)').eq('company_id', session.company_id).order('created_at', { ascending: false });
  if (session.role === 'employee') { let currentEmp = await getCurrentEmployee(true); data.currentEmployee=currentEmp; if (!currentEmp) { document.getElementById('missionsGrid')?.replaceChildren(); return } q = q.eq('employee_id', currentEmp.id); }
  let { data: rows, error } = await q;
  if (error) { toast('تعذر تحميل المأموريات — شغّل migration المأموريات', 'error'); return }
  window.__missionRows = rows || [];
  renderMissionCreateAction();
  let reports = {};
  const ids = (rows || []).map(r => r.id).filter(Boolean);
  if (ids.length) {
    const r = await supabaseClient.from('mission_attendance').select('*').in('mission_id', ids).order('created_at', { ascending: false });
    (r.data || []).forEach(x => { if (!reports[x.mission_id]) reports[x.mission_id] = x; });
  }
  document.getElementById('missionsGrid').innerHTML = (rows || []).map(m => {
    const report = reports[m.id], status = m.status === 'completed' ? 'مكتملة' : m.status === 'pending_approval' ? 'بانتظار اعتماد المدير' : m.status === 'in_progress' ? 'قيد التنفيذ' : 'مجدولة';
    const canCheck = session.role === 'employee' && !report && m.status !== 'completed';
    const reportBtn = report && session.role === 'manager' ? `<button class="ghost-btn" onclick="openMissionReport('${m.id}')"><i class="fa-solid fa-image"></i> تفاصيل التنفيذ والصورة</button>` : '';
    const approvalBtn = report && session.role === 'manager' && m.status === 'pending_approval' ? `<button class="primary-btn" onclick="approveMission('${m.id}')"><i class="fa-solid fa-circle-check"></i> اعتماد وتسجيل الحضور</button>` : '';
    const managerActions = session.role === 'manager' ? `<div style="display:flex;gap:8px;margin-top:16px"><button class="ghost-btn" onclick="openMissionModal('${m.id}')"><i class="fa-solid fa-pen"></i> تعديل</button><button class="ghost-btn danger" onclick="deleteMission('${m.id}')"><i class="fa-solid fa-trash"></i> حذف</button></div>` : '';
    return `<div class="card"><div class="card-head"><h3>${m.title}</h3><span class="badge ${m.status==='completed'?'success':m.status==='in_progress'?'info':'warning'}">${status}</span></div><div class="muted"><i class="fa-solid fa-user"></i> ${m.employees?.full_name||'—'} &nbsp; <i class="fa-solid fa-location-dot"></i> ${m.destination||'—'}</div><p>${m.purpose||'—'}</p><div class="muted"><i class="fa-regular fa-calendar"></i> ${m.start_date||'—'}${m.end_date?` — ${m.end_date}`:''}<br><i class="fa-solid fa-car"></i> ${m.transportation||'—'}</div><hr style="border:0;border-top:1px solid var(--line);margin:16px 0"><b>المصروفات: ${Number(m.expenses||0).toLocaleString()} ر.س</b>${canCheck?`<div style="margin-top:16px"><button class="primary-btn" onclick="openMissionCheckIn('${m.id}')"><i class="fa-solid fa-camera"></i> تسجيل حضور المأمورية</button></div>`:''}${reportBtn}${approvalBtn}${managerActions}</div>`;
  }).join('') || '<div class="empty">لا توجد مأموريات</div>'
}


// ==========================================================
// Payroll module
// ==========================================================
function payrollView() {
  return pageHead(session.role === 'employee' ? 'راتبي' : 'الرواتب Payroll', 'ملخص الرواتب والبدلات والاستقطاعات', session.role === 'manager' ? `<button class="primary-btn" onclick="openPayrollModal()"><i class="fa-solid fa-plus"></i> إضافة راتب</button><button class="ghost-btn" onclick="exportPayrollCSV()"><i class="fa-solid fa-download"></i> تصدير</button>` : '') + `<div class="card"><div class="table-wrap"><table class="data-table"><thead><tr><th>الموظف</th><th>الشهر</th><th>الأساسي</th><th>البدلات</th><th>الإضافي</th><th>الاستقطاعات</th><th>الصافي</th><th>الحالة</th><th>${session.role==='manager'?'إجراءات':'التفاصيل'}</th></tr></thead><tbody id="payrollTable"><tr><td colspan="9" class="empty">جاري تحميل الرواتب...</td></tr></tbody></table></div></div>`
}
async function loadPayrollLive() {
  await loadCompanyManagerContext();
  let q = supabaseClient.from('payroll_records').select('*, employees(full_name,employee_code)').eq('company_id', session.company_id).order('month', {
    ascending: false
  });
  if (session.role === 'employee') { let currentEmp = await getCurrentEmployee(); if (!currentEmp) return; q = q.eq('employee_id', currentEmp.id); }
  let {
    data: rows,
    error
  } = await q;
  if (error) {
    toast('تعذر تحميل الرواتب — شغّل migration الرواتب', 'error');
    return
  }
  rows = session.role === 'manager' ? (rows || []).filter(r => !companyManagerEmployeeIds.includes(String(r.employee_id))) : (rows || []);
  data.payroll = rows;
  window.__payrollRows = Object.fromEntries((rows || []).map(r => [String(r.id), r]));
  let isManager = session.role === 'manager';
  document.getElementById('payrollTable').innerHTML = (rows || []).map(r => `<tr><td><b>${r.employees?.full_name||'—'}</b></td><td class="ltr">${r.month? String(r.month).slice(0,7): '—'}</td><td>${Number(r.basic_salary||0).toLocaleString()}</td><td>${Number(r.allowances||0).toLocaleString()}</td><td>${Number(r.overtime||0).toLocaleString()}</td><td>${Number(r.deductions||0).toLocaleString()}</td><td><b>${Number(r.net_salary||0).toLocaleString()} ر.س</b></td><td><span class="badge ${r.status==='paid'?'success':'warning'}">${r.status==='paid'?'مدفوع':'مسودة'}</span></td><td><button class="action-btn" title="تفاصيل الراتب" onclick="openPayrollSlip('${r.id}')"><i class="fa-solid fa-eye"></i></button>${isManager?`<button class="action-btn" title="تعديل الراتب" onclick="openPayrollModal('${r.id}')"><i class="fa-solid fa-pen"></i></button><button class="action-btn" title="حذف الراتب" onclick="deletePayrollRecord('${r.id}')"><i class="fa-solid fa-trash"></i></button>`:''}</td></tr>`).join('') || `<tr><td colspan="9" class="empty">لا توجد سجلات رواتب</td></tr>`
}
function openPayrollSlip(recordId) {
  let r = window.__payrollRows?.[String(recordId)];
  if (!r) { toast('لم يتم العثور على سجل الراتب','error'); return }
  openSlip(r.employees?.full_name||'—', r.employees?.employee_code||'—', Number(r.basic_salary||0), Number(r.net_salary||0), Number(r.allowances||0), Number(r.overtime||0), Number(r.deductions||0), r.month||'—', r.status);
}
function exportPayrollCSV() {
  let rows = data.payroll || [];
  if (!rows.length) {
    toast('لا يوجد بيانات لتصديرها', 'error');
    return
  }
  let head = ['الموظف', 'الرقم الوظيفي', 'الشهر', 'الأساسي', 'البدلات', 'الإضافي', 'الاستقطاعات', 'الصافي', 'الحالة'];
  let lines = [head.join(',')].concat(rows.map(r => [r.employees?.full_name || '—', r.employees?.employee_code || '—', r.month ? String(r.month).slice(0, 7) : '—', r.basic_salary || 0, r.allowances || 0, r.overtime || 0, r.deductions || 0, r.net_salary || 0, r.status === 'paid' ? 'مدفوع' : 'مسودة'].map(v => `"${String(v ?? '').replace(/"/g,'""')}"`).join(',')));
  let blob = new Blob(['\ufeff' + lines.join('\n')], {
    type: 'text/csv;charset=utf-8;'
  });
  let url = URL.createObjectURL(blob);
  let a = document.createElement('a');
  a.href = url;
  a.download = 'payroll.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast('تم تصدير ملف الرواتب بنجاح')
}
function openPayrollModal(recordId = null) {
  let r = recordId ? window.__payrollRows?.[String(recordId)] : null;
  if (recordId && !r) { toast('تعذر العثور على سجل الراتب', 'error'); return }
  let empOptions = data.employees.slice(0, 200).map(e => `<option value="${e.dbId||e.id}" ${r && String(r.employee_id) === String(e.dbId||e.id) ? 'selected' : ''}>${e.name}${e.salary?` (الأساسي الحالي: ${e.salary.toLocaleString()} ر.س)`:''}</option>`).join('');
  openModal(`<div class="modal-head"><h3>${recordId?'تعديل الراتب':'إضافة راتب لموظف'}</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group full"><label>الموظف</label><select id="p-emp" class="form-control">${empOptions}</select></div><div class="form-group"><label>الشهر</label><input id="p-month" type="month" class="form-control ltr" value="${r?.month ? String(r.month).slice(0,7) : new Date().toISOString().slice(0,7)}"></div><div class="form-group"><label>الحالة</label><select id="p-status" class="form-control"><option value="draft" ${r && r.status!=='paid'?'selected':''}>مسودة</option><option value="paid" ${r?.status==='paid'?'selected':''}>مدفوع</option></select></div><div class="form-group"><label>الراتب الأساسي</label><input id="p-basic" type="number" class="form-control ltr" value="${r?.basic_salary ?? ''}" oninput="updatePayrollNetPreview()"></div><div class="form-group"><label>البدلات</label><input id="p-allow" type="number" class="form-control ltr" value="${r?.allowances ?? 0}" oninput="updatePayrollNetPreview()"></div><div class="form-group"><label>الإضافي</label><input id="p-ot" type="number" class="form-control ltr" value="${r?.overtime ?? 0}" oninput="updatePayrollNetPreview()"></div><div class="form-group"><label>الاستقطاعات</label><input id="p-ded" type="number" class="form-control ltr" value="${r?.deductions ?? 0}" oninput="updatePayrollNetPreview()"></div><div class="form-group"><label>الصافي (تلقائي)</label><input id="p-net" class="form-control ltr" value="${Number((r?.basic_salary||0)+(r?.allowances||0)+(r?.overtime||0)-(r?.deductions||0)).toLocaleString()}" disabled></div></div></div><div class="modal-foot"><button class="primary-btn" onclick="savePayroll(${recordId?`'${recordId}'`:'null'})">حفظ الراتب</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`);
  if (!data.employees.length) toast('لا يوجد موظفون بعد — أضف موظفًا أولاً', 'error')
}
function updatePayrollNetPreview() {
  let basic = +document.getElementById('p-basic')?.value || 0;
  let allow = +document.getElementById('p-allow')?.value || 0;
  let ot = +document.getElementById('p-ot')?.value || 0;
  let ded = +document.getElementById('p-ded')?.value || 0;
  let net = document.getElementById('p-net');
  if (net) net.value = (basic + allow + ot - ded).toLocaleString()
}
async function savePayroll(recordId) {
  let empId = document.getElementById('p-emp')?.value;
  let emp = data.employees.find(e => String(e.dbId || e.id) === String(empId));
  if (!emp || companyManagerEmployeeIds.includes(String(emp.dbId || emp.id))) {
    toast('مدير الشركة ليس ضمن الموظفين ولا يمكن إنشاء راتب له', 'error');
    return
  }
  let basic = +document.getElementById('p-basic').value || 0,
    allow = +document.getElementById('p-allow').value || 0,
    ot = +document.getElementById('p-ot').value || 0,
    ded = +document.getElementById('p-ded').value || 0;
  let record = {
    company_id: session.company_id,
    employee_id: emp.dbId || emp.id,
    month: (document.getElementById('p-month').value || new Date().toISOString().slice(0, 7)) + '-01',
    basic_salary: basic,
    allowances: allow,
    overtime: ot,
    deductions: ded,
    net_salary: basic + allow + ot - ded,
    status: document.getElementById('p-status').value
  };
  let error;
  if (recordId) {
    ({ error } = await supabaseClient.from('payroll_records').update(record).eq('id', recordId));
  } else {
    ({ error } = await supabaseClient.from('payroll_records').insert(record));
  }
  if (error) {
    toast('تعذر حفظ الراتب: ' + error.message, 'error');
    return
  }
  await notifyEmployeeProfile(emp.dbId||emp.id,recordId?'تم تحديث الراتب':'تم إصدار كشف راتب',recordId?'تم تعديل كشف راتبك بواسطة الإدارة.':'تم إصدار كشف راتب جديد لك ويمكنك مراجعته من صفحة راتبي.','payroll',recordId);
  closeModal();
  await loadPayrollLive();
  toast(recordId ? 'تم تحديث الراتب وإشعار الموظف' : 'تم إضافة الراتب وإشعار الموظف — سيظهر في صفحة راتبه')
}
async function deletePayrollRecord(id) {
  if (!confirm('هل تريد حذف سجل الراتب هذا؟')) return;
  const old=await supabaseClient.from('payroll_records').select('employee_id,month').eq('id',id).maybeSingle();
  let { error } = await supabaseClient.from('payroll_records').delete().eq('id', id);
  if (error) {
    toast('تعذر حذف السجل: ' + error.message, 'error');
    return
  }
  if(old.data?.employee_id) await notifyEmployeeProfile(old.data.employee_id,'تم حذف كشف راتب','تم حذف كشف الراتب الخاص بك بواسطة الإدارة.','payroll',id);
  await loadPayrollLive();
  toast('تم حذف سجل الراتب وإشعار الموظف')
}
// ==========================================================
// Rules, reports & profile
// ==========================================================
function rulesView() {
  const saved=JSON.parse(localStorage.getItem(`workflow_rules_${session?.company_id||'default'}`)||'{}');
  const v=(key,fallback)=>saved[key]??fallback;
  return pageHead('اللائحة الداخلية', 'إدارة قواعد الحضور والانصراف والرواتب') + `<div class="grid-2"><div class="card"><div class="card-head"><h3>قواعد الدوام</h3></div><div class="form-grid"><div class="form-group"><label>بداية الدوام</label><input id="r-start" type="time" class="form-control" value="${v('start','09:00')}"></div><div class="form-group"><label>نهاية الدوام</label><input id="r-end" type="time" class="form-control" value="${v('end','17:00')}"></div><div class="form-group"><label>السماح بالتأخير بالدقائق</label><input id="r-grace" type="number" class="form-control" value="${v('grace',15)}"></div><div class="form-group"><label>ساعات العمل</label><input id="r-hours" type="number" class="form-control" value="${v('hours',8)}"></div></div><button class="primary-btn" onclick="saveRules()">حفظ القواعد</button></div><div class="card"><div class="card-head"><h3>الخصومات والإضافي</h3></div><div class="form-group"><label>قيمة الساعة الإضافية</label><input id="r-overtime" type="number" class="form-control" value="${v('overtime',1.5)}"></div><div class="form-group"><label>خصم التأخير</label><input id="r-late" type="number" class="form-control" value="${v('late',100)}"></div><div class="form-group"><label>خصم الغياب</label><input id="r-absence" type="number" class="form-control" value="${v('absence',500)}"></div></div></div>`
}
function saveRules(){
  const ids=['r-start','r-end','r-grace','r-hours','r-overtime','r-late','r-absence'];
  if(ids.some(id=>!document.getElementById(id))){toast('تعذر قراءة حقول القواعد','error');return;}
  const rules={start:document.getElementById('r-start').value||'09:00',end:document.getElementById('r-end').value||'17:00',grace:Math.max(0,Number(document.getElementById('r-grace').value)||0),hours:Math.max(0,Number(document.getElementById('r-hours').value)||0),overtime:Math.max(0,Number(document.getElementById('r-overtime').value)||0),late:Math.max(0,Number(document.getElementById('r-late').value)||0),absence:Math.max(0,Number(document.getElementById('r-absence').value)||0)};
  if(rules.end<=rules.start){toast('وقت نهاية الدوام يجب أن يكون بعد بدايته','error');return;}
  localStorage.setItem(`workflow_rules_${session.company_id}`,JSON.stringify(rules));data.rules=rules;toast('تم حفظ قواعد الدوام والخصومات ✓');
}

function reportPeriodRange(period){const now=new Date(), end=new Date(now), start=new Date(now);if(period==='daily')start.setHours(0,0,0,0);if(period==='weekly'){const day=(start.getDay()+6)%7;start.setDate(start.getDate()-day);start.setHours(0,0,0,0);}if(period==='monthly'){start.setDate(1);start.setHours(0,0,0,0);}if(period==='yearly'){start.setMonth(0,1);start.setHours(0,0,0,0);}return {start,end};}
function buildPeriodicReport(period){
  const r=reportPeriodRange(period), inRange=x=>{const d=new Date(x);return d>=r.start&&d<=r.end;};
  const att=(data.attendance||[]).filter(x=>inRange(x.check_in||x.date));
  const leaves=(data.leaves||[]).filter(x=>inRange(x.created_at||x.date||new Date()));
  const missions=(data.missions||[]).filter(x=>inRange(x.created_at||x.start_date||new Date()));
  return `تقرير ${period==='daily'?'يومي':period==='weekly'?'أسبوعي':period==='monthly'?'شهري':'سنوي'}\nالفترة: ${r.start.toLocaleDateString('ar-EG')} — ${r.end.toLocaleDateString('ar-EG')}\nسجلات الحضور: ${att.length}\nطلبات الإجازة: ${leaves.length}\nالمأموريات: ${missions.length} (مكتملة: ${missions.filter(x=>x.status==='مكتملة'||x.status==='completed').length})\nتم إنشاء التقرير آليًا من بيانات Milestones Group.`;
}
async function sendPeriodicReport(period,force=false){if(session.role!=='manager')return;const key=`workflow_report_${period}_${new Date().toISOString().slice(0,10)}`;if(!force&&localStorage.getItem(key))return;const managers=await supabaseClient.from('profiles').select('id').eq('company_id',session.company_id).eq('role','manager');if(managers.data?.length){const msg=buildPeriodicReport(period);await supabaseClient.from('notifications').insert(managers.data.map(x=>({user_id:x.id,title:`تقرير ${period==='daily'?'يومي':period==='weekly'?'أسبوعي':period==='monthly'?'شهري':'سنوي'}`,message:msg,target_page:'reports'})));localStorage.setItem(key,'1');}}
async function autoPeriodicReports(){if(session.role!=='manager')return;await sendPeriodicReport('daily');const d=new Date();if(d.getDay()===1)await sendPeriodicReport('weekly');if(d.getDate()===1)await sendPeriodicReport('monthly');if(d.getMonth()===0&&d.getDate()===1)await sendPeriodicReport('yearly');}
function reportsView(){return pageHead('التقارير والتحليلات','تقارير يومية وأسبوعية وشهرية وسنوية',`<button class="primary-btn" onclick="generateReportNow()"><i class="fa-solid fa-file-export"></i> إنشاء تقرير الآن</button>`)+`<div class="card"><div class="toolbar"><select id="reportPeriod" class="form-control"><option value="daily">يومي</option><option value="weekly">أسبوعي</option><option value="monthly">شهري</option><option value="yearly">سنوي</option></select><button class="ghost-btn" onclick="generateReportNow()">عرض التقرير وإرساله للمدير</button><button class="ghost-btn" onclick="exportPeriodicReportExcel()"><i class="fa-solid fa-file-excel"></i> تصدير Excel</button></div><pre id="periodicReportPreview" class="report-preview">اختر نوع التقرير ثم اضغط إنشاء تقرير الآن.</pre></div><div class="grid-2"><div class="card"><div class="card-head"><h3>معدل الحضور</h3></div><div class="chart-box"><canvas id="reportAttendance"></canvas></div></div><div class="card"><div class="card-head"><h3>إحصائيات الإجازات</h3></div><div class="chart-box"><canvas id="leaveChart"></canvas></div></div><div class="card"><div class="card-head"><h3>ملخص الرواتب</h3></div><div class="chart-box"><canvas id="payrollChart"></canvas></div></div></div>`;}
function excelCell(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function exportPeriodicReportExcel(){
  const p=document.getElementById('reportPeriod')?.value||'daily', r=reportPeriodRange(p);
  const att=(data.attendance||[]).filter(x=>{const d=new Date(x.check_in||x.date);return d>=r.start&&d<=r.end;});
  const leaves=(data.leaves||[]).filter(x=>{const d=new Date(x.created_at||x.date||new Date());return d>=r.start&&d<=r.end;});
  const missions=(data.missions||[]).filter(x=>{const d=new Date(x.created_at||x.start_date||new Date());return d>=r.start&&d<=r.end;});
  const rows=[['تقرير Milestones Group',p],['الفترة',`${r.start.toLocaleDateString('ar-EG')} - ${r.end.toLocaleDateString('ar-EG')}`],['سجلات الحضور',att.length],['طلبات الإجازة',leaves.length],['المأموريات',missions.length],['المأموريات المكتملة',missions.filter(x=>x.status==='مكتملة'||x.status==='completed').length],[],['تفاصيل المأموريات'],['العنوان','الموظف','الحالة','التاريخ'],...missions.map(x=>[x.title,x.employee||x.employees?.full_name||'—',x.status,x.start_date||'—'])];
  const table='<table border="1"><tbody>'+rows.map(row=>'<tr>'+row.map(c=>`<td>${excelCell(c)}</td>`).join('')+'</tr>').join('')+'</tbody></table>';
  const blob=new Blob(['\ufeff<html><meta charset="utf-8"><body dir="rtl">'+table+'</body></html>'],{type:'application/vnd.ms-excel;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`milestones-report-${p}-${new Date().toISOString().slice(0,10)}.xls`;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);toast('تم تصدير التقرير بصيغة Excel ✓');
}
async function generateReportNow(){const p=document.getElementById('reportPeriod')?.value||'daily', text=buildPeriodicReport(p), el=document.getElementById('periodicReportPreview');if(el)el.textContent=text;await sendPeriodicReport(p,true);toast('تم إنشاء التقرير وإرساله إلى مركز إشعارات المدير ✓');}
function profileView() {
  return pageHead('ملفي الشخصي', 'بياناتك الأساسية ومعلومات التواصل') + `<div class="card"><div class="form-grid"><div class="form-group"><label>الاسم الكامل</label><input id="profileFullName" class="form-control" value="${session.name||''}"></div><div class="form-group"><label>البريد الإلكتروني</label><input class="form-control ltr" value="${session.email||''}" disabled></div><div class="form-group"><label>الصورة الشخصية</label><div id="profilePhotoPreview" style="margin-bottom:10px"></div><input id="profilePhoto" type="file" accept="image/*" class="form-control" onchange="previewProfilePhoto(this)"></div><div class="form-group"><label>الهاتف</label><input id="profilePhone" class="form-control ltr"></div><div class="form-group"><label>الرقم الوظيفي</label><input id="profileCode" class="form-control ltr" value="—" disabled></div></div><button class="primary-btn" onclick="saveProfileLive()">حفظ التغييرات</button></div>`
}
async function loadProfileLive() {
  let {
    data: e
  } = await supabaseClient.from('employees').select('*').eq('profile_id', session.id).maybeSingle();
  if (e) {
    document.getElementById('profilePhone').value = e.phone || '';
    document.getElementById('profileCode').value = e.employee_code || '—'
  }
  let {
    data: p
  } = await supabaseClient.from('profiles').select('photo_path').eq('id', session.id).maybeSingle();
  if (p?.photo_path) {
    let signed = await supabaseClient.storage.from('profile-photos').createSignedUrl(p.photo_path, 300);
    if (signed.data?.signedUrl) document.getElementById('profilePhotoPreview').innerHTML = `<img src="${signed.data.signedUrl}" alt="الصورة الشخصية" style="width:90px;height:90px;border-radius:50%;object-fit:cover;border:3px solid var(--primary)"><div class="muted" style="margin-top:5px">الصورة الحالية المستخدمة في مطابقة الحضور</div>`
  }
}

function previewProfilePhoto(input) {
  let f = input.files?.[0];
  if (!f) return;
  let url = URL.createObjectURL(f);
  document.getElementById('profilePhotoPreview').innerHTML = `<img src="${url}" alt="معاينة الصورة" style="width:90px;height:90px;border-radius:50%;object-fit:cover;border:3px solid var(--primary)"><div class="muted" style="margin-top:5px">معاينة الصورة الجديدة</div>`
}
async function saveProfileLive() {
  let name = document.getElementById('profileFullName').value.trim(),
    phone = document.getElementById('profilePhone').value.trim(),
    photo = document.getElementById('profilePhoto')?.files?.[0],
    photo_path = null;
  if (photo) {
    let path = `${session.id}/profile.jpg`,
      up = await supabaseClient.storage.from('profile-photos').upload(path, photo, {
        contentType: photo.type,
        upsert: true
      });
    if (up.error) {
      toast('تعذر رفع الصورة الشخصية: ' + up.error.message, 'error');
      return
    }
    photo_path = path
  }
  let {
    error
  } = await supabaseClient.from('profiles').update(photo_path ? {
    full_name: name,
    photo_path
  } : {
    full_name: name
  }).eq('id', session.id);
  if (!error)({
    error
  } = await supabaseClient.from('employees').update({
    full_name: name,
    phone
  }).eq('profile_id', session.id));
  if (error) {
    toast('تعذر حفظ الملف: ' + error.message, 'error');
    return
  }
  session.name = name;
  document.getElementById('userName').textContent = name;
  toast('تم حفظ الملف الشخصي')
}


let appLang=localStorage.getItem('workflow_hr_lang')||'ar';
const EN={"الإعدادات":"Settings","تحكم في تفضيلات النظام":"Control system preferences","اللغة":"Language","المظهر":"Appearance","الوضع الداكن":"Dark mode","حفظ الاختيار تلقائيًا":"Saved automatically","مركز الإشعارات":"Notifications","لا توجد إشعارات":"No notifications","إدارة المأموريات":"Mission management","مأمورياتي":"My missions","المأموريات":"Missions","الحضور والانصراف":"Attendance","الإجازات":"Leaves","لوحة التحكم":"Dashboard","لوحة الموظف":"Employee dashboard","الموظفون":"Employees","الرواتب Payroll":"Payroll","تسجيل حضور المأمورية":"Mission check-in","صورة سيلفي من الكاميرا":"Selfie from camera","فتح الكاميرا":"Open camera","التقاط الصورة":"Take photo","إرسال التسجيل":"Submit check-in","حفظ وإرسال للموظف":"Save and notify employee","لا توجد مأموريات":"No missions","قيد التنفيذ":"In progress","مجدولة":"Scheduled","مكتملة":"Completed"};
function t(x){return appLang==='en'?(EN[x]||x):x}
function setLanguage(lang){appLang=lang;localStorage.setItem('workflow_hr_lang',lang);document.documentElement.lang=lang;document.documentElement.dir=lang==='en'?'ltr':'rtl';applyLanguage();renderNav();openPage(currentPage);toast(lang==='en'?'English mode enabled':'تم تفعيل اللغة العربية')}
function applyLanguage(){document.documentElement.lang=appLang;document.documentElement.dir=appLang==='en'?'ltr':'rtl';document.body.classList.toggle('english-mode',appLang==='en');}
// ==========================================================
// Settings & allowances
// ==========================================================
function settingsView() {
  let geoCard = session.role === 'manager' ? `<div class="card"><div class="card-head"><h3>مواقع الشركة للحضور</h3><span class="muted">يمكن تسجيل الحضور من أي موقع محفوظ</span></div><div class="form-grid">${[1,2].map(i=>`<div class="form-group full"><label>اسم الموقع ${i}</label><input id="companySiteName${i}" class="form-control" placeholder="مثال: الفرع الرئيسي"></div><div class="form-group"><label>رابط خرائط Google للموقع ${i}</label><input id="companyMapUrl${i}" class="form-control ltr" placeholder="https://maps.google.com/..."></div><div class="form-group"><label>النطاق بالمتر</label><input id="companyRadius${i}" type="number" class="form-control ltr" value="200" min="20" max="5000"></div>`).join('')}</div><small class="muted">استخدم رابطًا كاملًا من خرائط Google يحتوي على الإحداثيات حتى يعمل التحقق الجغرافي.</small><br><button class="primary-btn" onclick="saveCompanyGeo()">حفظ مواقع الشركة والنطاق</button></div>` : '';
  return pageHead(t('الإعدادات'), t('تحكم في تفضيلات النظام')) + geoCard + `<div class="card"><div class="card-head"><h3>${t('اللغة')}</h3></div><div class="quick-grid"><button class="primary-btn" onclick="setLanguage('ar')">العربية</button><button class="ghost-btn" onclick="setLanguage('en')">English</button></div></div><div class="card"><div class="card-head"><h3>${t('المظهر')}</h3></div><div class="quick" onclick="toggleDark()"><i class="fa-solid fa-moon"></i><div><b>${t('الوضع الداكن')}</b><small class="muted">${t('حفظ الاختيار تلقائيًا')}</small></div><span style="margin-right:auto">${data.dark?'مفعّل':'معطّل'}</span></div></div>`
}

function allowancesView() {
  return pageHead('مخصصات الإجازات', 'تفصيل أرصدة الإجازات حسب النوع', `<button class="primary-btn" onclick="openLeaveModal()"><i class="fa-solid fa-calendar-plus"></i> طلب إجازة</button>`) + `<div class="card"><div class="card-head"><h3>أرصدة الإجازات</h3></div>${emptyState('لا توجد بيانات أرصدة من قاعدة البيانات')}</div><div class="card"><div class="card-head"><h3>ملخص الأرصدة</h3></div><div class="chart-box">${emptyState()}</div></div>`
}
// ==========================================================
// Directory module
// ==========================================================
function directoryView() {
  return pageHead('دليل الموظفين', 'ابحث عن زملائك وتواصل معهم بسهولة') + `<div class="card"><div class="toolbar"><input id="dirSearch" class="form-control" placeholder="ابحث بالاسم أو القسم..." oninput="filterDirectory(this.value)"><select class="form-control"><option>كل الأقسام</option>${depts.map(d=>`<option>${d}</option>`).join('')}</select></div><div id="directoryGrid" class="grid-3"><div class="empty"><i class="fa-solid fa-spinner fa-spin"></i><p>جاري تحميل الموظفين...</p></div></div></div><div class="card"><div class="card-head"><h3>الهيكل التنظيمي</h3><span class="badge info" id="orgDeptCount">${depts.length} أقسام</span></div><div id="orgStructure" class="quick-grid">${depts.map(d=>`<div class="quick"><span class="avatar">${d[0]}</span><div><b>${d}</b><small class="muted" style="display:block">—</small></div></div>`).join('')}</div></div>`
}

function directoryCards(rows) {
  return rows.slice(0, 12).map(e => `<div class="card" style="margin:0"><div class="person"><span class="avatar" style="width:45px;height:45px">${e.name[0]}</span><div><b>${e.name}</b><small class="muted" style="display:block">${e.job}</small></div></div><hr style="border:0;border-top:1px solid var(--line);margin:15px 0"><small class="muted"><i class="fa-solid fa-building"></i> ${e.dept}<br><i class="fa-solid fa-envelope"></i> ${e.email}<br><i class="fa-solid fa-phone"></i> ${e.phone}</small><button class="ghost-btn" style="width:100%;margin-top:14px" onclick="viewEmployeeProfile('${e.dbId}')"><i class="fa-regular fa-address-card"></i> عرض الملف</button></div>`).join('')
}

function filterDirectory(q) {
  document.getElementById('directoryGrid').innerHTML = directoryCards((data.employees || []).filter(e => (e.name + e.dept + e.job).toLowerCase().includes(q.toLowerCase())))
}


// ==========================================================
// Route table
// ==========================================================
var views = {
  dashboard: () => session.role === 'manager' ? managerDash() : employeeDash(),
  employees: employeesView,
  attendance: attendanceView,
  leaves: leavesView,
  missions: missionsView,
  payroll: payrollView,
  rules: rulesView,
  reports: reportsView,
  profile: profileView,
  settings: settingsView,
  allowances: allowancesView,
  directory: directoryView
};


// ==========================================================
// Modal open/close helpers
// ==========================================================
function openModal(html) {
  document.getElementById('modal').innerHTML = html;
  document.getElementById('modalBackdrop').classList.add('show')
}

function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('show');
  let v = document.querySelector('video');
  if (v && v.srcObject) v.srcObject.getTracks().forEach(t => t.stop())
}


// ==========================================================
// Employee modal & CRUD
// ==========================================================
function openEmployeeModal(dbId = null) {
  let e = dbId ? data.employees.find(x => String(x.dbId) === String(dbId)) : {};
  openModal(`<div class="modal-head"><h3>${dbId?'تعديل بيانات الموظف':'إضافة موظف جديد'}</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group"><label>الاسم الكامل</label><input id="m-name" class="form-control" value="${e.name||''}" placeholder="مثال: فاطمة علي"></div><div class="form-group"><label>البريد الإلكتروني</label><input id="m-email" class="form-control ltr" value="${e.email||''}"></div><div class="form-group"><label>الهاتف</label><input id="m-phone" class="form-control ltr" value="${e.phone||''}"></div><div class="form-group"><label>القسم</label><select id="m-dept" class="form-control">${depts.map(d=>`<option ${d===e.dept?'selected':''}>${d}</option>`).join('')}</select></div><div class="form-group"><label>المسمى الوظيفي</label><input id="m-job" class="form-control" value="${e.job||''}"></div><div class="form-group"><label>الراتب</label><input id="m-salary" type="number" class="form-control ltr" value="${e.salary||''}"></div><div class="form-group"><label>تاريخ الانضمام</label><input id="m-join" type="date" class="form-control ltr" value="${e.join||''}"></div><div class="form-group"><label>الحالة</label><select id="m-status" class="form-control"><option>نشط</option><option>إجازة</option></select></div>${session.role==='manager'&&dbId&&missionDelegateAllowedName(e.name)?`<div class="form-group full"><label><input id="m-mission-permission" type="checkbox" ${e.canCreateMissions?'checked':''}> السماح بإنشاء مأموريات للموظفين</label><small class="muted">هذه الصلاحية متاحة فقط لـ Mahmoud El sayed و Mohamed Nazih.</small></div>`:''}</div></div><div class="modal-foot"><button class="primary-btn" onclick="saveEmployee(${dbId?`'${dbId}'`:'null'})">حفظ الموظف</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`)
}
async function createEmployeeRequest(employee){
  const duplicate=await supabaseClient.from('employees').select('id,full_name,email').eq('company_id',session.company_id).ilike('email',employee.email).maybeSingle();
  if(duplicate.data) return {duplicate:true};
  let lastError=null;
  for(let attempt=0;attempt<2;attempt++){
    const result=await supabaseClient.functions.invoke('create-employee',{body:employee});
    if(result.data?.ok) return result;
    lastError=result.error||new Error(result.data?.error||'تعذر إنشاء الموظف');
    const status=lastError?.context?.status||lastError?.status;
    await new Promise(resolve=>setTimeout(resolve,attempt===0?900:0));
    const created=await supabaseClient.from('employees').select('id,full_name,email').eq('company_id',session.company_id).ilike('email',employee.email).maybeSingle();
    if(created.data) return {alreadyCreated:true,data:{ok:true}};
    if(status&&status<500) break;
  }
  return {error:lastError};
}
async function saveEmployee(idx) {
  if(saveEmployee.busy)return;
  saveEmployee.busy=true;
  const button=document.querySelector('#modal button[onclick^="saveEmployee"]');if(button){button.disabled=true;button.dataset.oldText=button.innerHTML;button.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> جارٍ الحفظ...';}
  try{
    let employee = {
      full_name: document.getElementById('m-name').value.trim() || 'موظف جديد',
      email: document.getElementById('m-email').value.trim().toLowerCase(),
      phone: document.getElementById('m-phone').value,
      department: document.getElementById('m-dept').value,
      job_title: document.getElementById('m-job').value,
      salary: +document.getElementById('m-salary').value || 0,
      join_date: document.getElementById('m-join').value || null
    };
    if (idx === null) {
      if (!employee.email) { toast('البريد الإلكتروني مطلوب لإنشاء حساب الموظف', 'error'); return; }
      const result=await createEmployeeRequest(employee);
      if(result.duplicate){toast('يوجد موظف مسجل بهذا البريد الإلكتروني بالفعل','error');return;}
      if(result.alreadyCreated){closeModal();await loadEmployeesLive();toast('تم إنشاء الموظف بالفعل. أعد تحميل القائمة؛ لم نعد إرسال الطلب حتى لا يتكرر الحساب.','warning');return;}
      if(result.error){
        const detail=result.error?.context?.body?.error||result.error?.message||'خطأ غير معروف';
        toast('تعذر إنشاء الموظف: '+detail+' — جرّب مرة أخرى بعد لحظات.','error');return;
      }
      closeModal();await loadEmployeesLive();
      const temp=result.data?.temporary_password||result.data?.temp_password||result.data?.password||result.data?.temporaryPassword;
      if(temp){openModal(`<div class="modal-head"><h3>تم إنشاء الموظف</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><p>هذه كلمة المرور المؤقتة. انسخها الآن وأرسلها للموظف بأمان.</p><div class="password-copy-row"><input id="tempPasswordValue" class="form-control ltr" value="${temp}" readonly><button class="primary-btn" onclick="copyTemporaryPassword()"><i class="fa-solid fa-copy"></i> نسخ</button></div></div><div class="modal-foot"><button class="ghost-btn" onclick="closeModal()">إغلاق</button></div>`);} else toast('تم إنشاء الموظف بنجاح؛ راجع إشعار المدير لكلمة المرور المؤقتة.');
    } else {
      if(idx!==null && session.role==='manager') employee.can_create_missions=!!document.getElementById('m-mission-permission')?.checked;
      let result = await supabaseClient.from('employees').update(employee).eq('id', idx);
      if (result.error) { toast('تعذر حفظ الموظف: ' + result.error.message, 'error'); return; }
      closeModal();await loadEmployeesLive();toast('تم تحديث بيانات الموظف');
    }
  } finally {
    saveEmployee.busy=false;
    const button=document.querySelector('#modal button[onclick^="saveEmployee"]');if(button){button.disabled=false;button.innerHTML=button.dataset.oldText||'حفظ الموظف';}
  }
}
saveEmployee.busy=false;
async function copyTemporaryPassword(){const el=document.getElementById('tempPasswordValue');if(!el)return;try{await navigator.clipboard.writeText(el.value);toast('تم نسخ كلمة المرور المؤقتة ✓');}catch(e){el.select();document.execCommand('copy');toast('تم نسخ كلمة المرور المؤقتة ✓');}}
async function deleteEmployee(dbId) {
  if (!confirm('هل تريد حذف هذا الموظف؟')) return;
  let result = await supabaseClient.from('employees').delete().eq('id', dbId);
  if (result.error) {
    toast('تعذر حذف الموظف: ' + result.error.message, 'error');
    return
  }
  await loadEmployeesLive();
  toast('تم حذف الموظف')
}


// ==========================================================
// Leave modal & approvals
// ==========================================================
async function notifyManagersAboutEmployeeAction(title,message,page='dashboard',targetId=null){
  if(session?.role!=='employee')return;
  const q=await supabaseClient.from('profiles').select('id').eq('company_id',session.company_id).eq('role','manager');
  if(q.data?.length) await supabaseClient.from('notifications').insert(q.data.map(m=>({user_id:m.id,title,message,target_page:page,target_id:targetId})));
}
function openLeaveModal() {
  openModal(`<div class="modal-head"><h3>تقديم طلب إجازة</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group"><label>نوع الإجازة</label><select id="l-type" class="form-control"><option>إجازة سنوية</option><option>طارئة</option><option>مرضية</option><option>بدون راتب</option><option>أمومة</option><option>أخرى</option></select></div><div class="form-group"><label>نوع الطلب</label><select id="l-unit" class="form-control"><option>أيام</option><option>ساعات</option></select></div><div class="form-group"><label>العدد</label><input id="l-days" type="number" class="form-control" value="1"></div><div class="form-group"><label>تاريخ البداية</label><input id="l-start" type="date" class="form-control ltr"></div><div class="form-group"><label>تاريخ النهاية</label><input id="l-end" type="date" class="form-control ltr"></div><div class="form-group full"><label>السبب</label><textarea id="l-reason" class="form-control" rows="3" placeholder="اكتب سبب الطلب..."></textarea></div><div class="form-group full"><label>مرفق (اختياري)</label><input id="l-file" type="file" class="form-control" accept=".pdf,.jpg,.jpeg,.png" onchange="checkFileSize(this)"><small class="muted">PDF أو صورة — الحد الأقصى 2MB</small></div></div></div><div class="modal-foot"><button class="primary-btn" onclick="saveLeave()">إرسال الطلب</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`)
}
async function saveLeave() {
  let e = await getCurrentEmployee();
  if (!e) return;
  let leave = {
    company_id: session.company_id,
    employee_id: e.id,
    employee_profile_id: session.id,
    leave_type: document.getElementById('l-type').value,
    request_unit: document.getElementById('l-unit')?.value || 'أيام',
    start_date: document.getElementById('l-start').value || new Date().toISOString().slice(0, 10),
    end_date: document.getElementById('l-end').value || new Date().toISOString().slice(0, 10),
    days: +document.getElementById('l-days').value || 1,
    reason: document.getElementById('l-reason').value || '—',
    status: 'pending',
    balance_days: 16
  };
  let {
    error
  } = await supabaseClient.from('leaves').insert(leave);
  if (error) {
    toast('تعذر إرسال الطلب: ' + error.message, 'error');
    return
  }
  await notifyManagersAboutEmployeeAction('طلب إجازة جديد',`قدم ${session.name||'الموظف'} طلب إجازة من ${leave.start_date} إلى ${leave.end_date}.`,'leaves');
  data.notifications.unshift('تم تقديم طلب إجازة جديد.');
  save();
  closeModal();
  openPage('leaves');
  toast('تم إرسال طلب الإجازة للمراجعة')
}
async function approveLeave(id, ok) {
  const old=await supabaseClient.from('leaves').select('employee_id,leave_type,start_date,end_date').eq('id',id).maybeSingle();
  let {
    error
  } = await supabaseClient.from('leaves').update({
    status: ok ? 'approved' : 'rejected'
  }).eq('id', id);
  if (error) {
    toast('تعذر تحديث الطلب: ' + error.message, 'error');
    return
  }
  if(old.data?.employee_id) await notifyEmployeeProfile(old.data.employee_id,ok?'تم قبول طلب الإجازة':'تم رفض طلب الإجازة',ok?`تمت الموافقة على طلب ${old.data.leave_type||'الإجازة'} من ${old.data.start_date||''} إلى ${old.data.end_date||''}.`:`تم رفض طلب ${old.data.leave_type||'الإجازة'} من الإدارة.`,'leaves',id);
  await loadLeavesLive();
  toast(ok ? 'تم قبول طلب الإجازة وإشعار الموظف' : 'تم رفض طلب الإجازة وإشعار الموظف')
}


// ==========================================================
// Mission modal
// ==========================================================
async function openMissionModal(missionId=null) {
  let r=null;
  if(missionId){ const q=await supabaseClient.from('missions').select('*').eq('id',missionId).maybeSingle(); r=q.data; if(q.error||!r){toast('تعذر تحميل المأمورية للتعديل','error');return;} }
  openModal(`<div class="modal-head"><h3>${missionId?'تعديل المأمورية':'إضافة مأمورية'}</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="form-grid"><div class="form-group full"><label>عنوان المأمورية</label><input id="mi-title" class="form-control" value="${r?.title||''}"></div><div class="form-group"><label>الموظف</label><select id="mi-emp" class="form-control">${data.employees.slice(0,100).map(e=>`<option value="${e.dbId||e.id}" ${r&&String(r.employee_id)===String(e.dbId||e.id)?'selected':''}>${e.name}</option>`).join('')}</select></div><div class="form-group"><label>الوجهة</label><input id="mi-dest" class="form-control" value="${r?.destination||''}"></div><div class="form-group full"><label>الغرض / المطلوب</label><input id="mi-purpose" class="form-control" value="${r?.purpose||''}"></div><div class="form-group"><label>من تاريخ</label><input id="mi-start" type="date" class="form-control ltr" value="${r?.start_date||''}"></div><div class="form-group"><label>إلى تاريخ</label><input id="mi-end" type="date" class="form-control ltr" value="${r?.end_date||''}"></div><div class="form-group"><label>وسيلة النقل</label><input id="mi-trans" class="form-control" value="${r?.transportation||''}"></div><div class="form-group"><label>الحالة</label><select id="mi-status" class="form-control"><option value="scheduled" ${!r||r.status==='scheduled'?'selected':''}>مجدولة</option><option value="in_progress" ${r?.status==='in_progress'?'selected':''}>قيد التنفيذ</option><option value="completed" ${r?.status==='completed'?'selected':''}>مكتملة</option></select></div><div class="form-group"><label>المصروفات</label><input id="mi-exp" type="number" class="form-control ltr" value="${r?.expenses||0}"></div><div class="form-group full"><div class="card" style="margin:0;background:var(--bg);box-shadow:none"><b>الموقع</b><p class="muted" style="margin:6px 0 0">لن يحدد المدير إحداثيات. عند الوصول، يرسل الموظف موقعه الحالي ووقت التسجيل مع السيلفي.</p></div></div></div></div><div class="modal-foot"><button class="primary-btn" onclick="saveMission(${missionId?`'${missionId}'`:'null'})">${missionId?'حفظ التعديل':'حفظ وإرسال للموظف'}</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`)
}
async function notifyMissionEmployee(employeeId,title,message,targetId){
  const p=await supabaseClient.from('employees').select('profile_id').eq('id',employeeId).maybeSingle();
  if(p.data?.profile_id) await supabaseClient.from('notifications').insert({user_id:p.data.profile_id,title,message,target_page:'missions',target_id:targetId});
}
async function saveMission(missionId=null) {
  if(!canCreateMissions()){toast('ليس لديك صلاحية إنشاء المأموريات','error');return;}
  const empQ=await supabaseClient.from('employees').select('id').eq('company_id',session.company_id).eq('id',document.getElementById('mi-emp').value).single(); const emp=empQ.data;
  if(!emp?.id || companyManagerEmployeeIds.includes(String(emp.id))){toast('لا يمكن إسناد مأمورية إلى مدير الشركة','error');return;}
  const mission={company_id:session.company_id,employee_id:emp.id,title:document.getElementById('mi-title').value||'مأمورية جديدة',destination:document.getElementById('mi-dest').value||'—',purpose:document.getElementById('mi-purpose').value||'—',start_date:document.getElementById('mi-start').value||null,end_date:document.getElementById('mi-end').value||null,start_time:null,end_time:null,transportation:document.getElementById('mi-trans').value||'—',expenses:+document.getElementById('mi-exp').value||0,status:document.getElementById('mi-status').value};
  const result=missionId?await supabaseClient.from('missions').update(mission).eq('id',missionId).select('id').single():await supabaseClient.from('missions').insert(mission).select('id').single();
  if(result.error){toast('تعذر حفظ المأمورية: '+result.error.message,'error');return;}
  const savedId=result.data?.id||missionId; await notifyMissionEmployee(emp.id,missionId?'تم تعديل مأمورية':'مأمورية جديدة',missionId?`تم تعديل المأمورية «${mission.title}» بواسطة الإدارة.`:`تم إسناد المأمورية «${mission.title}» إليك.`,savedId);
  closeModal();openPage('missions');toast(missionId?'تم تعديل المأمورية وإشعار الموظف':'تم حفظ المأمورية وإرسالها للموظف');
}
async function deleteMission(id){
  if(session.role!=='manager')return;
  if(!confirm('حذف المأمورية سيحذف تسجيل تنفيذها المرتبط بها. هل تريد المتابعة؟'))return;
  const q=await supabaseClient.from('missions').select('employee_id,title').eq('id',id).maybeSingle();
  if(q.data?.employee_id) await notifyMissionEmployee(q.data.employee_id,'تم حذف مأمورية',`تم حذف المأمورية «${q.data.title||''}» بواسطة الإدارة.`,id);
  const r=await supabaseClient.from('missions').delete().eq('id',id);
  if(r.error){toast('تعذر حذف المأمورية: '+r.error.message,'error');return;}
  openPage('missions');toast('تم حذف المأمورية');
}
function openMissionCheckIn(id) {
  const m=(window.__missionRows||[]).find(x=>String(x.id)===String(id)); if(!m)return;
  const now=new Date(), start=m.start_date?new Date(`${m.start_date}T00:00`):null, end=m.end_date?new Date(`${m.end_date}T23:59:59`):null;
  if((start&&now<start)||(end&&now>end)){toast('التسجيل غير متاح الآن؛ المأمورية خارج الوقت المحدد من المدير','error');return;}
  window.__activeMission=m;window.__missionPhoto=null;window.__missionCameraStream=null;window.__missionCoords=null;
  openModal(`<div class="modal-head"><h3>تسجيل حضور المأمورية</h3><button class="close" onclick="stopMissionCamera();closeModal()">×</button></div><div class="modal-body"><p><b>${m.title}</b> — ${m.destination||'—'}</p><div class="card" style="margin:0 0 14px;background:var(--bg);box-shadow:none"><b id="missionLocStatus">جاري تحديد موقعك الحالي...</b><small id="missionLocDetails" class="muted"></small></div><div class="form-group"><label>صورة سيلفي من الكاميرا</label><video id="missionCamera" autoplay playsinline style="display:none;width:100%;max-height:320px;object-fit:cover;border-radius:14px;background:#111"></video><canvas id="missionCanvas" style="display:none"></canvas><img id="missionPhotoPreview" style="display:none;width:100%;max-height:320px;object-fit:cover;border-radius:14px"><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button type="button" class="primary-btn" onclick="startMissionCamera()"><i class="fa-solid fa-camera"></i> فتح الكاميرا</button><button type="button" id="missionCaptureBtn" class="ghost-btn" style="display:none" onclick="captureMissionPhoto()"><i class="fa-solid fa-circle"></i> التقاط الصورة</button></div><small class="muted">سيتم إرسال موقعك الحالي ووقت التسجيل والدقة مع السيلفي إلى المدير.</small></div></div><div class="modal-foot"><button id="missionCheckBtn" class="primary-btn" disabled onclick="submitMissionCheckIn()"><i class="fa-solid fa-paper-plane"></i> إرسال التسجيل</button><button class="ghost-btn" onclick="stopMissionCamera();closeModal()">إلغاء</button></div>`);
  navigator.geolocation?.getCurrentPosition(pos=>{window.__missionCoords=pos.coords;document.getElementById('missionLocStatus').textContent='تم تحديد موقعك الحالي ✓';document.getElementById('missionLocStatus').style.color='var(--success)';document.getElementById('missionLocDetails').innerHTML=`الموقع: ${pos.coords.latitude.toFixed(6)}, ${pos.coords.longitude.toFixed(6)}<br>وقت القراءة: ${new Date().toLocaleString('ar-EG')} · دقة GPS: ${Math.round(pos.coords.accuracy||0)}م`;document.getElementById('missionCheckBtn').disabled=!window.__missionPhoto;},()=>{document.getElementById('missionLocStatus').textContent='يجب السماح بالموقع للتسجيل';document.getElementById('missionLocStatus').style.color='var(--danger)'},{enableHighAccuracy:true,timeout:20000,maximumAge:0});
}
async function startMissionCamera() {
  const video=document.getElementById('missionCamera');
  if (!navigator.mediaDevices?.getUserMedia) { toast('الكاميرا المباشرة غير مدعومة على هذا المتصفح', 'error'); return; }
  try { window.__missionCameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'user'},width:{ideal:1280},height:{ideal:720}},audio:false}); video.srcObject=window.__missionCameraStream; video.style.display='block'; document.getElementById('missionCaptureBtn').style.display='inline-flex'; }
  catch(e) { toast('تعذر فتح الكاميرا؛ اسمح بصلاحية الكاميرا ثم جرّب مرة أخرى', 'error'); }
}
function captureMissionPhoto() {
  const video=document.getElementById('missionCamera'), canvas=document.getElementById('missionCanvas'), preview=document.getElementById('missionPhotoPreview');
  if (!video?.videoWidth) { toast('انتظر فتح الكاميرا أولًا', 'error'); return; }
  canvas.width=video.videoWidth; canvas.height=video.videoHeight; canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  canvas.toBlob(blob => { window.__missionPhoto=new File([blob],`mission-${Date.now()}.jpg`,{type:'image/jpeg'}); preview.src=URL.createObjectURL(blob); preview.style.display='block'; stopMissionCamera(); const btn=document.getElementById('missionCheckBtn'); if(btn) btn.disabled=!window.__missionCoords; toast('تم التقاط الصورة، اضغط إرسال التسجيل'); },'image/jpeg',.88);
}
function stopMissionCamera() { if (window.__missionCameraStream) { window.__missionCameraStream.getTracks().forEach(t=>t.stop()); window.__missionCameraStream=null; } }
async function ensureRegularAttendanceForMission(e,c,checkTime){
  const d=new Date(checkTime), start=new Date(d); start.setHours(0,0,0,0); const end=new Date(start); end.setDate(end.getDate()+1);
  const existing=await supabaseClient.from('attendance').select('id').eq('company_id',session.company_id).eq('employee_id',e.id).gte('check_in',start.toISOString()).lt('check_in',end.toISOString()).order('check_in',{ascending:true}).limit(1).maybeSingle();
  const payload={company_id:session.company_id,employee_id:e.id,employee_profile_id:session.id,check_in:checkTime,latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy,status:'present'};
  if(existing.data?.id) return supabaseClient.from('attendance').update({status:'present',latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy}).eq('id',existing.data.id);
  return supabaseClient.from('attendance').insert(payload);
}
async function submitMissionCheckIn() {
  const m=window.__activeMission,file=window.__missionPhoto,c=window.__missionCoords,checkTime=new Date().toISOString(),checkTimeLabel=new Date(checkTime).toLocaleString('ar-EG');
  if(!m||!c||!file){toast('الموقع الحالي والسيلفي مطلوبان','error');return;}
  if(file.size>8*1024*1024){toast('حجم الصورة يجب ألا يتجاوز 8 ميجابايت','error');return;}
  const e=await getCurrentEmployee();if(!e)return;
  const path=`${session.company_id}/${m.id}/${session.id}-${Date.now()}.${(file.name.split('.').pop()||'jpg').toLowerCase()}`;
  const upload=await supabaseClient.storage.from('mission-photos').upload(path,file,{upsert:false,contentType:file.type||'image/jpeg'});
  if(upload.error){toast('تعذر رفع الصورة: '+upload.error.message,'error');return;}
  const locationUrl=`https://www.google.com/maps?q=${encodeURIComponent(c.latitude+','+c.longitude)}`; const missionResult=await supabaseClient.from('mission_attendance').insert({mission_id:m.id,company_id:session.company_id,employee_id:e.id,employee_profile_id:session.id,check_in:checkTime,latitude:c.latitude,longitude:c.longitude,location_url:locationUrl,accuracy:c.accuracy,photo_path:path});
  if(missionResult.error){toast('تعذر حفظ تسجيل المأمورية: '+missionResult.error.message,'error');return;}
  await supabaseClient.from('missions').update({status:'pending_approval'}).eq('id',m.id);
  const {data:managers}=await supabaseClient.from('profiles').select('id').eq('company_id',session.company_id).eq('role','manager');
  if(managers?.length)await supabaseClient.from('notifications').insert(managers.map(x=>({user_id:x.id,title:'مأمورية بانتظار اعتمادك',message:`تم تنفيذ المأمورية «${m.title}» الساعة ${checkTimeLabel} وإرسال الموقع والسيلفي. اضغط اعتماد لتسجيل الحضور العادي.`,target_page:'missions',target_id:m.id})));
  stopMissionCamera();closeModal();openPage('missions');toast('تم إرسال تنفيذ المأمورية للمدير، وسيُسجل حضورك بعد الاعتماد ✓');
}
async function approveMission(id){
  if(session.role!=='manager')return;
  const r=await supabaseClient.from('mission_attendance').select('*').eq('mission_id',id).order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(r.error||!r.data){toast('لا يوجد تنفيذ لاعتماده','error');return;}
  const e=await supabaseClient.from('employees').select('id,profile_id').eq('id',r.data.employee_id).maybeSingle();
  if(!e.data){toast('تعذر العثور على الموظف','error');return;}
  const checkTime=r.data.check_in,c={latitude:r.data.latitude,longitude:r.data.longitude,accuracy:r.data.accuracy};
  const d=new Date(checkTime),start=new Date(d);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
  const exists=await supabaseClient.from('attendance').select('id').eq('company_id',session.company_id).eq('employee_id',e.data.id).gte('check_in',start.toISOString()).lt('check_in',end.toISOString()).limit(1).maybeSingle();
  let result;
  if(exists.data?.id) result=await supabaseClient.from('attendance').update({status:'present',latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy}).eq('id',exists.data.id);
  else result=await supabaseClient.from('attendance').insert({company_id:session.company_id,employee_id:e.data.id,employee_profile_id:e.data.profile_id,check_in:checkTime,latitude:c.latitude,longitude:c.longitude,accuracy:c.accuracy,status:'present'});
  if(result.error){toast('تعذر تسجيل الحضور بعد الاعتماد: '+result.error.message,'error');return;}
  const up=await supabaseClient.from('missions').update({status:'completed',approved_at:new Date().toISOString(),approved_by:session.id}).eq('id',id);
  if(up.error){toast('تم تسجيل الحضور لكن تعذر اعتماد المأمورية: '+up.error.message,'error');return;}
  await notifyEmployeeProfile(e.data.id,'تم اعتماد المأمورية','تم اعتماد تنفيذ المأمورية وتسجيل حضورك العادي لهذا اليوم.','attendance',id);
  openPage('missions');toast('تم اعتماد المأمورية وتسجيل الحضور العادي ✓');
}
async function openMissionReport(id) {
  const r=await supabaseClient.from('mission_attendance').select('*').eq('mission_id',id).order('created_at',{ascending:false}).limit(1).maybeSingle();
  if(r.error||!r.data){toast('لا يوجد تسجيل تنفيذ لهذه المأمورية','error');return;}
  const m=(window.__missionRows||[]).find(x=>String(x.id)===String(id)), signed=await supabaseClient.storage.from('mission-photos').createSignedUrl(r.data.photo_path,600), mapUrl=r.data.location_url||`https://www.google.com/maps?q=${encodeURIComponent(r.data.latitude+','+r.data.longitude)}`;
  openModal(`<div class="modal-head"><h3>تفاصيل تنفيذ المأمورية</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><p><b>${m?.title||'مأمورية'}</b></p><p class="muted">وقت التسجيل: ${new Date(r.data.check_in).toLocaleString('ar-EG')}<br>الدقة: ${Math.round(r.data.accuracy||0)} متر</p><a class="primary-btn" href="${mapUrl}" target="_blank" rel="noopener"><i class="fa-solid fa-map-location-dot"></i> فتح موقع التسجيل في خرائط Google</a>${signed.data?.signedUrl?`<img src="${signed.data.signedUrl}" alt="صورة تنفيذ المأمورية" style="max-width:100%;margin-top:16px;border-radius:14px">`:'<p class="muted">تعذر عرض الصورة</p>'}</div>`);
}
// ==========================================================
// Check-in/out modal (GPS geofence verification)
// ==========================================================
// Check-in/out modal (GPS geofence verification)
// ==========================================================
function openAttendanceModal() {
  locationOk=false; attendanceBusy=false;
  openModal(`<div class="modal-head"><h3>تسجيل الحضور</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="card" style="margin:0;background:var(--bg);box-shadow:none"><div style="display:flex;justify-content:space-between"><span>GPS Location</span><b id="locStatus">جاري التحقق...</b></div><small id="locDetails" class="muted">يرجى السماح بالوصول إلى موقعك</small></div></div><div class="modal-foot"><button id="checkBtn" class="primary-btn" disabled onclick="completeCheckIn()">تأكيد تسجيل الحضور</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`);
  getLocation()
}
let locationOk = false;
let attendanceBusy = false;

function getLocation() {
  const status=document.getElementById('locStatus'),details=document.getElementById('locDetails');
  if(status)status.textContent='جاري تحديد موقعك...';
  if(details)details.textContent='انتظر لحظات، لا تغلق نافذة التسجيل.';
  locationOk=false;enableCheck();
  if(!navigator.geolocation){locationDenied('المتصفح لا يدعم تحديد الموقع');return;}
  navigator.geolocation.getCurrentPosition(p=>{
    window.lastAttendanceCoords={latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy};locationOk=true;
    if(status)status.innerHTML='<span style="color:var(--success)">تم التحقق ✓</span>';
    if(details)details.textContent=`Latitude: ${p.coords.latitude.toFixed(5)} · Longitude: ${p.coords.longitude.toFixed(5)} · Accuracy: ${Math.round(p.coords.accuracy)}m`;
    enableCheck();
  },err=>{const msg=err?.code===1?'اسمح للموقع من إعدادات المتصفح ثم اضغط إعادة المحاولة':err?.code===3?'استغرق تحديد الموقع وقتًا طويلًا؛ اضغط إعادة المحاولة':'تعذر تحديد الموقع؛ تأكد من تشغيل GPS ثم أعد المحاولة';locationDenied(msg);},{enableHighAccuracy:true,timeout:20000,maximumAge:10000});
}
function locationDenied(message='يجب السماح بالوصول إلى الموقع لتسجيل الحضور.') {
  locationOk=false;const status=document.getElementById('locStatus'),details=document.getElementById('locDetails');
  if(status)status.innerHTML='<span style="color:var(--danger)">غير متاح</span>';
  if(details)details.innerHTML=`${message} <button type="button" class="ghost-btn" style="margin-top:8px" onclick="getLocation()">إعادة المحاولة</button>`;
  enableCheck();
}
function enableCheck(){const b=document.getElementById('checkBtn');if(b)b.disabled=!locationOk||attendanceBusy;}
async function getCurrentEmployee(withPermission=false) {
  let {
    data: e,
    error
  } = await supabaseClient.from('employees').select(withPermission?'id,full_name,can_create_missions':'id').eq('company_id', session.company_id).eq('profile_id', session.id).single();
  if (error || !e) {
    toast('لم يتم ربط حسابك بسجل موظف في Supabase', 'error');
    return null
  }
  return e
}
async function completeCheckIn(){
  if(attendanceBusy)return;
  if(!locationOk){toast('انتظر تحديد الموقع أو اضغط إعادة المحاولة','error');return;}
  attendanceBusy=true;const button=document.getElementById('checkBtn');if(button){button.disabled=true;button.dataset.oldText=button.innerHTML;button.innerHTML='<i class="fa-solid fa-spinner fa-spin"></i> جارٍ تسجيل الحضور...';}
  try{
    const e=await getCurrentEmployee();if(!e)return;
    let coords=window.lastAttendanceCoords;
    try{coords=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(p=>resolve({latitude:p.coords.latitude,longitude:p.coords.longitude,accuracy:p.coords.accuracy}),reject,{enableHighAccuracy:true,timeout:15000,maximumAge:5000}));window.lastAttendanceCoords=coords;}catch(_){if(!coords){toast('تعذر تحديث موقعك الحالي؛ اضغط إعادة المحاولة','error');return;}}
    const locationsRes=await supabaseClient.from('company_locations').select('name,latitude,longitude,radius').eq('company_id',session.company_id).eq('active',true),locations=locationsRes.data||[];
    if(locationsRes.error){toast('تعذر قراءة مواقع الشركة: '+locationsRes.error.message,'error');return;}
    if(!locations.length){toast('لم يحدد المدير مواقع الشركة بعد','error');return;}
    const distances=locations.map(x=>({name:x.name,meters:geoDistance(Number(x.latitude),Number(x.longitude),coords.latitude,coords.longitude),radius:Number(x.radius)||200})),matched=distances.find(x=>x.meters<=x.radius);
    if(!matched){const nearest=distances.sort((a,b)=>a.meters-b.meters)[0];toast(`أنت خارج نطاق مواقع الشركة. أقرب موقع: ${Math.round(nearest.meters)} متر`,'error');return;}
    const dayStart=new Date();dayStart.setHours(0,0,0,0);const dayEnd=new Date(dayStart);dayEnd.setDate(dayEnd.getDate()+1);
    const existing=await supabaseClient.from('attendance').select('id,check_in').eq('company_id',session.company_id).eq('employee_id',e.id).gte('check_in',dayStart.toISOString()).lt('check_in',dayEnd.toISOString()).limit(1).maybeSingle();
    if(existing.error){toast('تعذر التحقق من حضور اليوم: '+existing.error.message,'error');return;}
    if(existing.data){toast(`الحضور مسجل بالفعل اليوم الساعة ${new Date(existing.data.check_in).toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'})}`,'warning');return;}
    const now=new Date(),payload={company_id:session.company_id,employee_id:e.id,employee_profile_id:session.id,check_in:now.toISOString(),latitude:coords.latitude,longitude:coords.longitude,accuracy:coords.accuracy,status:'present'},result=await supabaseClient.from('attendance').insert(payload);
    if(result.error){toast('تعذر حفظ الحضور: '+result.error.message,'error');return;}
    await notifyManagersAboutEmployeeAction('تسجيل حضور جديد',`سجل ${session.name||'الموظف'} حضورًا في ${new Date(payload.check_in).toLocaleString('ar-EG')} وأرسل موقعه الحالي.`,'attendance');data.notifications.unshift('تم تسجيل حضورك بالموقع.');save();closeModal();openPage('attendance');toast('تم تسجيل الحضور بالموقع ✓');
  }finally{attendanceBusy=false;const b=document.getElementById('checkBtn');if(b){b.disabled=!locationOk;b.innerHTML=b.dataset.oldText||'تأكيد تسجيل الحضور';}}
}
async function openCheckoutModal() {
  let e = await getCurrentEmployee();
  if (!e) return;
  let {
    data: row,
    error
  } = await supabaseClient.from('attendance').select('id,check_in').eq('employee_id', e.id).is('check_out', null).order('created_at', {
    ascending: false
  }).limit(1).maybeSingle();
  if (error) {
    toast('تعذر التحقق من حالة الحضور: ' + error.message, 'error');
    return
  }
  if (!row) {
    toast('يجب تسجيل الحضور أولًا قبل الانصراف', 'error');
    return
  }
  let inTime = new Date(row.check_in).toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit'
  });
  openModal(`<div class="modal-head"><h3>تسجيل الانصراف</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="card" style="background:var(--bg);box-shadow:none"><div style="display:flex;justify-content:space-between;margin-bottom:12px"><span>وقت الحضور</span><b>${inTime}</b></div><div style="display:flex;justify-content:space-between;margin-bottom:12px"><span>وقت الانصراف المتوقع</span><b id="checkoutTime">جاري الحساب...</b></div><div style="display:flex;justify-content:space-between"><span>حالة الموقع</span><b style="color:var(--success)">جاهز للتسجيل ✓</b></div></div><p class="muted"><i class="fa-solid fa-circle-info"></i> سيتم حفظ وقت الانصراف الحالي وتحديث ساعات العمل.</p></div><div class="modal-foot"><button class="primary-btn" onclick="completeCheckOut()"><i class="fa-solid fa-check"></i> تأكيد الانصراف</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`);
  document.getElementById('checkoutTime').textContent = new Date().toLocaleTimeString('ar-EG', {
    hour: '2-digit',
    minute: '2-digit'
  })
}
async function completeCheckOut() {
  let e = await getCurrentEmployee();
  if (!e) return;
  let {
    data: row,
    error: findError
  } = await supabaseClient.from('attendance').select('id,check_in').eq('employee_id', e.id).is('check_out', null).order('created_at', {
    ascending: false
  }).limit(1).maybeSingle();
  if (findError || !row) {
    toast('لا يوجد حضور مفتوح لتسجيل الانصراف', 'error');
    return
  }
  let now = new Date();
  let hours = Math.max(0, Math.round(((now - new Date(row.check_in)) / 36e5) * 100) / 100);
  let {
    error
  } = await supabaseClient.from('attendance').update({
    check_out: now.toISOString(),
    work_hours: hours,
    status: 'completed'
  }).eq('id', row.id);
  if (error) {
    toast('تعذر حفظ الانصراف: ' + error.message, 'error');
    return
  }
  await notifyManagersAboutEmployeeAction('تسجيل انصراف جديد',`سجل ${session.name||'الموظف'} انصرافه في ${new Date(now).toLocaleString('ar-EG')}.`,'attendance');
  data.notifications.unshift('تم تسجيل انصرافك بنجاح.');
  save();
  closeModal();
  openPage('attendance');
  toast('تم تسجيل الانصراف بنجاح ✓')
}


// ==========================================================
// Payroll slip
// ==========================================================
function openSlip(name, id, basic, net, allowances=0, overtime=0, deductions=0, month='—', status='draft') {
  openModal(`<div class="modal-head"><h3>كشف راتب — ${month}</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body" id="slip"><div class="card" style="background:var(--bg);box-shadow:none"><div class="form-grid"><p><small class="muted">الموظف</small><br><b>${name}</b></p><p><small class="muted">الرقم الوظيفي</small><br><b>${id}</b></p><p><small class="muted">الراتب الأساسي</small><br><b>${basic.toLocaleString()} ر.س</b></p><p><small class="muted">البدلات</small><br><b>${allowances.toLocaleString()} ر.س</b></p><p><small class="muted">الوقت الإضافي</small><br><b>${overtime.toLocaleString()} ر.س</b></p><p><small class="muted">الاستقطاعات</small><br><b>${deductions.toLocaleString()} ر.س</b></p></div><div style="display:flex;justify-content:space-between;margin-top:20px"><span>الحالة</span><b>${status==='paid'?'مدفوع':'مسودة'}</b></div><div style="background:var(--bg);border-radius:14px;padding:18px;display:flex;justify-content:space-between;margin-top:20px"><span>صافي الراتب</span><strong style="font-size:22px;color:var(--primary)">${net.toLocaleString()} ر.س</strong></div></div></div><div class="modal-foot"><button class="primary-btn" onclick="window.print()"><i class="fa-solid fa-print"></i> طباعة كشف الراتب</button><button class="ghost-btn" onclick="closeModal()">إغلاق</button></div>`)
}
// ==========================================================
// Company geofencing rules
// ==========================================================
async function loadCompanyGeo() {
  const q=await supabaseClient.from('company_locations').select('id,name,map_url,latitude,longitude,radius,active').eq('company_id',session.company_id).order('created_at',{ascending:true}).limit(2);
  if(q.error){toast('تعذر قراءة مواقع الشركة — شغّل migration المواقع المتعددة','error');return;}
  (q.data||[]).forEach((x,i)=>{const n=document.getElementById(`companySiteName${i+1}`),u=document.getElementById(`companyMapUrl${i+1}`),r=document.getElementById(`companyRadius${i+1}`);if(n)n.value=x.name||'';if(u)u.value=x.map_url||'';if(r)r.value=x.radius||200;});
}
function coordinatesFromMapUrl(url){const text=decodeURIComponent(String(url||''));let m=text.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/)||text.match(/[?&](?:query|q|ll)=(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/);return m?{lat:Number(m[1]),lng:Number(m[2])}:null;}
async function saveCompanyGeo(){
  if(session.role!=='manager'){toast('غير مصرح','error');return;}
  const sites=[];
  for(let i=1;i<=2;i++){
    const name=document.getElementById(`companySiteName${i}`).value.trim(),mapUrl=document.getElementById(`companyMapUrl${i}`).value.trim(),radius=Number(document.getElementById(`companyRadius${i}`).value)||200;
    if(!name&&!mapUrl)continue;
    let parsed;try{parsed=new URL(mapUrl);}catch(e){toast(`أدخل رابطًا صحيحًا للموقع ${i}`,'error');return;}
    const isGoogle=/google\.com$/.test(parsed.hostname)||/maps\.app\.goo\.gl$/.test(parsed.hostname)||/goo\.gl$/.test(parsed.hostname);const coords=coordinatesFromMapUrl(mapUrl);
    if(!isGoogle||!coords||coords.lat<-90||coords.lat>90||coords.lng<-180||coords.lng>180){toast(`رابط الموقع ${i} يجب أن يكون رابط Google Maps كاملًا يحتوي على الإحداثيات`,'error');return;}
    sites.push({company_id:session.company_id,name,map_url:mapUrl,latitude:coords.lat,longitude:coords.lng,radius,active:true});
  }
  const old=await supabaseClient.from('company_locations').select('id').eq('company_id',session.company_id).order('created_at',{ascending:true});if(old.error){toast('تعذر قراءة المواقع القديمة: '+old.error.message,'error');return;}
  const del=await supabaseClient.from('company_locations').delete().eq('company_id',session.company_id);if(del.error){toast('تعذر تحديث المواقع: '+del.error.message,'error');return;}
  if(sites.length){const ins=await supabaseClient.from('company_locations').insert(sites);if(ins.error){toast('تعذر حفظ المواقع: '+ins.error.message,'error');return;}}
  toast(sites.length?`تم حفظ ${sites.length} موقع/مواقع للحضور ✓`:'تم حذف مواقع الحضور');
}
// ==========================================================
// Notifications, dark mode & misc utilities
// ==========================================================
async function openNotification(n){
  if(n?.id) await supabaseClient.from('notifications').update({read_at:new Date().toISOString()}).eq('id',n.id).eq('user_id',session.id);
  const target=notificationTarget(n); closeModal(); if(target.page) openPage(target.page); refreshNotificationBadge();
}
async function showNotifications() {
  let {data: rows,error}=await supabaseClient.from('notifications').select('*').eq('user_id',session.id).order('created_at',{ascending:false});
  if(error){toast('تعذر تحميل الإشعارات: '+error.message,'error');return}
  const todayKey=new Date().toDateString(), today=(rows||[]).filter(n=>new Date(n.created_at).toDateString()===todayKey), older=(rows||[]).filter(n=>new Date(n.created_at).toDateString()!==todayKey);
  const render=list=>(list||[]).map(n=>{const unread=!n.read_at;return `<button class="notification-row ${unread?'unread':''}" onclick='openNotification(${JSON.stringify(n).replace(/'/g,"&#39;")})'><span class="timeline-dot"></span><span><b>${n.title||''}</b><p>${notificationText(n)}</p><small class="muted">${new Date(n.created_at).toLocaleString(appLang==='en'?'en-US':'ar-EG')}</small></span>${unread?'<i class="fa-solid fa-circle unread-mark"></i>':''}</button>`}).join('');
  openModal(`<div class="modal-head"><h3>${appLang==='en'?'Notifications':'مركز الإشعارات'}</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><h4 class="notif-section-title">إشعارات اليوم</h4>${render(today)||`<p class="muted">لا توجد إشعارات اليوم</p>`}<details style="margin-top:18px"><summary class="notif-section-title">الإشعارات السابقة (${older.length})</summary><div style="margin-top:8px">${render(older)||'<p class="muted">لا توجد إشعارات سابقة</p>'}</div></details></div>`);
}
function toggleDark() {
  data.dark = !data.dark;
  document.body.classList.toggle('dark', data.dark);
  save();
  if (currentPage === 'settings') openPage('settings');
  toast(data.dark ? 'تم تفعيل الوضع الداكن' : 'تم تفعيل الوضع الفاتح')
}




// ==========================================================
// Chart.js dashboards
// ==========================================================
function drawCharts(page) {
  Object.values(charts).forEach(c => c.destroy()); charts = {};
  const base = { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ labels:{ font:{ family:'Cairo' } } } }, scales:{ x:{ grid:{display:false}, ticks:{font:{family:'Cairo'}} }, y:{ grid:{color:'rgba(150,160,190,.13)'}, ticks:{font:{family:'Cairo'}} } } };
  function chart(id,type,labels,datasets,opts={}) { const el=document.getElementById(id); if (el) charts[id]=new Chart(el,{type,data:{labels,datasets},options:{...base,...opts}}); }
  const attendance=data.attendance||[], employees=data.employees||[], leaves=data.leaves||[], payroll=data.payroll||[];
  const days=[...Array(7)].map((_,i)=>{const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-6+i); return d;});
  const dayLabels=days.map(d=>new Intl.DateTimeFormat('ar-EG',{weekday:'short'}).format(d));
  const countFor=(d,match)=>attendance.filter(a=>{const raw=a.check_in||a.date; return raw && new Date(raw).toDateString()===d.toDateString() && match(a);}).length;
  if(page==='dashboard') {
    const present=days.map(d=>countFor(d,a=>['present','late','حاضر','متأخر','قيد العمل'].includes(a.status)));
    const late=days.map(d=>countFor(d,a=>['late','متأخر'].includes(a.status)));
    const counts={}; employees.forEach(e=>{const k=e.dept||'—'; counts[k]=(counts[k]||0)+1;});
    chart('attendanceChart','line',dayLabels,[{label:'الحضور',data:present,borderColor:'#29235F',backgroundColor:'rgba(41,35,95,.12)',fill:true,tension:.4},{label:'التأخير',data:late,borderColor:'#f3a83b',tension:.4}]);
    chart('deptChart','doughnut',Object.keys(counts),[{data:Object.values(counts),backgroundColor:['#29235F','#BED73B','#16a67a','#f3a83b','#e45757','#7B75AE','#A9B45A','#93a4ba'],borderWidth:0}],{plugins:{legend:{position:'right'}}});
  }
  if(page==='allowances') chart('allowanceChart','doughnut',[],[{data:[],backgroundColor:[],borderWidth:0}],{plugins:{legend:{display:false}}});
  if(page==='reports') {
    const reportDays=days.slice(-5); const reportLabels=reportDays.map(d=>new Intl.DateTimeFormat('ar-EG',{weekday:'short'}).format(d));
    const statuses=['حاضر','متأخر','مكتمل','قيد العمل','غائب'];
    chart('reportAttendance','bar',reportLabels,[{label:'الحضور',data:reportDays.map(d=>countFor(d,a=>['present','late','حاضر','متأخر','مكتمل','قيد العمل'].includes(a.status))),backgroundColor:'#29235F',borderRadius:7}],{plugins:{legend:{display:false}}});
    const leaveTypes=[...new Set(leaves.map(l=>l.type).filter(Boolean))]; const leaveCounts=leaveTypes.map(t=>leaves.filter(l=>l.type===t).length);
    chart('leaveChart','doughnut',leaveTypes,[{data:leaveCounts,backgroundColor:['#29235F','#16a67a','#f3a83b','#e45757'],borderWidth:0}],{plugins:{legend:{position:'right'}}});
    const payrollRows=payroll.slice(0,5).reverse();
    chart('payrollChart','line',payrollRows.map(r=>r.month||''),[{label:'صافي الرواتب',data:payrollRows.map(r=>Number(r.net_salary||0)),borderColor:'#16a67a',backgroundColor:'rgba(22,166,122,.1)',fill:true,tension:.4}],{plugins:{legend:{display:false}}});
  }
}
// File & attendance detail helpers
// ==========================================================
function checkFileSize(input) {
  let f = input.files && input.files[0];
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) {
    toast('حجم الملف أكبر من 2MB، اختر ملفًا أصغر', 'error');
    input.value = ''
  }
}

function showAttendanceDetails(employee, inTime, outTime, location) {
  openModal(`<div class="modal-head"><h3>تفاصيل الحضور</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="card" style="background:var(--bg);box-shadow:none"><div style="display:flex;justify-content:space-between;margin-bottom:12px"><span>الموظف</span><b>${employee}</b></div><div style="display:flex;justify-content:space-between;margin-bottom:12px"><span>وقت الدخول</span><b class="ltr">${inTime}</b></div><div style="display:flex;justify-content:space-between;margin-bottom:12px"><span>وقت الخروج</span><b class="ltr">${outTime}</b></div><div style="display:flex;justify-content:space-between"><span>الموقع</span><b>${location}</b></div></div></div><div class="modal-foot"><button class="ghost-btn" onclick="closeModal()">إغلاق</button></div>`)
}

function requestMissingPunch(employee) {
  openModal(`<div class="modal-head"><h3>طلب تصحيح بصمة</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><p class="muted">طلب تصحيح حضور/انصراف للموظف <b>${employee}</b></p><div class="form-group"><label>سبب الطلب</label><textarea id="punch-reason" class="form-control" rows="3" placeholder="مثال: نسيت تسجيل الانصراف أمس"></textarea></div></div><div class="modal-foot"><button class="primary-btn" onclick="submitMissingPunch('${employee}')"><i class="fa-solid fa-paper-plane"></i> إرسال الطلب</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`)
}
async function submitMissingPunch(employee){let reason=document.getElementById('punch-reason').value.trim();if(!reason){toast('اكتب سبب الطلب','error');return}let {data:managers,error:managerError}=await supabaseClient.from('profiles').select('id').eq('company_id',session.company_id).eq('role','manager');if(managerError||!managers?.length){toast('تعذر العثور على مدير لإرسال الطلب','error');return}let {error}=await supabaseClient.from('notifications').insert(managers.map(m=>({user_id:m.id,title:'طلب تصحيح بصمة',message:`طلب تصحيح بصمة لـ ${employee}: ${reason}`})));if(error){toast('تعذر إرسال الطلب: '+error.message,'error');return}closeModal();toast('تم إرسال طلب التصحيح للمدير')}
function showApproval(id) {
  let l = (data.leaves || []).find(x => String(x.id) === String(id));
  if (!l) {
    toast('تعذر العثور على الطلب', 'error');
    return
  }
  let steps = [{
    label: 'تقديم الطلب',
    done: true
  }, {
    label: 'مراجعة المدير المباشر',
    done: l.status !== 'معلق'
  }, {
    label: l.status === 'مرفوض' ? 'تم الرفض' : 'اعتماد الموارد البشرية',
    done: l.status === 'مقبول'
  }];
  openModal(`<div class="modal-head"><h3>مسار اعتماد الطلب</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><div class="timeline">${steps.map(s=>`<div class="timeline-item"><span class="timeline-dot" style="background:${s.done?'var(--success)':'var(--muted)'}"></span><div><p>${s.label}</p><small class="muted">${s.done?'تم':'قيد الانتظار'}</small></div></div>`).join('')}</div></div><div class="modal-foot"><button class="ghost-btn" onclick="closeModal()">إغلاق</button></div>`)
}


// ==========================================================
// Password reset
// ==========================================================
function openForgotPassword() {
  openModal(`<div class="modal-head"><h3>استعادة كلمة المرور</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><p class="muted">أدخل بريدك الإلكتروني المسجل وسنرسل لك رابط إعادة تعيين كلمة المرور.</p><div class="form-group"><label>البريد الإلكتروني</label><input id="reset-email" type="email" class="form-control ltr" placeholder="name@company.com"></div></div><div class="modal-foot"><button class="primary-btn" onclick="sendPasswordReset()"><i class="fa-solid fa-paper-plane"></i> إرسال رابط الاستعادة</button><button class="ghost-btn" onclick="closeModal()">إلغاء</button></div>`)
}
async function sendPasswordReset() {
  let email = document.getElementById('reset-email').value.trim();
  if (!email || !email.includes('@')) {
    toast('اكتب بريدًا إلكترونيًا صحيحًا', 'error');
    return
  }
  let {
    error
  } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.href.split('#')[0]
  });
  if (error) {
    toast('تعذر إرسال رابط الاستعادة: ' + error.message, 'error');
    return
  }
  closeModal();
  toast('تم إرسال رابط استعادة كلمة المرور إلى بريدك الإلكتروني')
}

// ==========================================================
// Boot
// ==========================================================
async function refreshNotificationBadge() {
  if (!session?.id) return;
  let {
    count,
    error
  } = await supabaseClient.from('notifications').select('*', {
    count: 'exact',
    head: true
  }).eq('user_id', session.id).is('read_at', null);
  let dot = document.getElementById('notifDot');
  if (!dot) return;
  if (!error && count > 0) dot.classList.remove('hidden');
  else dot.classList.add('hidden')
}
restoreAuth();
// PWA installation support (Chrome / Edge on HTTPS or localhost).
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstallPrompt = event; });
window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; toast('تم تثبيت التطبيق بنجاح'); });
async function installApp() {
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) { toast('التطبيق مثبت بالفعل على هذا الجهاز'); return; }
  if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); const result = await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; if (result?.outcome === 'accepted') toast('جارٍ تثبيت التطبيق'); return; }
  openModal(`<div class="modal-head"><h3>تثبيت Milestones Group</h3><button class="close" onclick="closeModal()">×</button></div><div class="modal-body"><p>من Chrome، افتح قائمة <b>⋮</b> ثم اختر <b>تثبيت التطبيق</b> أو <b>إضافة إلى الشاشة الرئيسية</b>.</p><p class="muted">يظهر خيار التثبيت عند فتح التطبيق من عنوان HTTPS أو من localhost.</p></div><div class="modal-foot"><button class="primary-btn" onclick="closeModal()">حسنًا</button></div>`);
}
