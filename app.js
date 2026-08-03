// Import fungsi Firebase SDK
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-analytics.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-firestore.js";

// Konfigurasi Firebase milikmu
const firebaseConfig = {
  apiKey: "AIzaSyBKKo96GF_7lORM4vJTAj5J6Sx7dzDX3MQ",
  authDomain: "absen-kelas-1b2b1.firebaseapp.com",
  projectId: "absen-kelas-1b2b1",
  storageBucket: "absen-kelas-1b2b1.firebasestorage.app",
  messagingSenderId: "845059009928",
  appId: "1:845059009928:web:e3ef092c82bc06ea26de3d",
  measurementId: "G-XZWR0LL24M"
};

// Initialize Firebase & Firestore
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app);

/* ============ STORAGE HELPERS (FIRESTORE) ============ */
async function getData(key){
  try{
    const docId = key.replace(/:/g, '_');
    const docRef = doc(db, 'app_data', docId);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data().value;
    }
    const local = localStorage.getItem(key);
    return local ? JSON.parse(local) : null;
  }catch(e){
    console.error('Firestore get failed, fallback local:', e);
    const local = localStorage.getItem(key);
    return local ? JSON.parse(local) : null;
  }
}

async function setData(key, value){
  try{
    const docId = key.replace(/:/g, '_');
    const docRef = doc(db, 'app_data', docId);
    await setDoc(docRef, { value: value });
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  }catch(e){
    console.error('Firestore set failed:', e);
    localStorage.setItem(key, JSON.stringify(value));
    return false;
  }
}

/* ============ CONSTANTS & HELPERS ============ */
const ROLE_LABEL = {
  admin:'Admin', wali_kelas:'Wali Kelas', sekertaris:'Sekertaris', ketua_kelas:'Ketua Kelas', siswa:'Siswa'
};
const STAFF_ROLES = ['admin','wali_kelas','sekertaris','ketua_kelas'];
const LATE_WINDOW_MS = 10*60*1000; // 10 Menit batas foto untuk izin telat

// BATAS JAM MASUK (07:00 Pagi)
const CUTOFF_HOUR = 7;
const CUTOFF_MINUTE = 0;

function todayStr(){
  const d = new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function fmtTime(ts){
  if(!ts) return '-';
  const d = new Date(ts);
  return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
}
function fmtDateIndo(dateStr){
  const [y,m,d] = dateStr.split('-').map(Number);
  const dt = new Date(y,m-1,d);
  const hari = ['Minggu','Senin','Selasa','Rabu','Kamis',"Jumat",'Sabtu'][dt.getDay()];
  const bulan = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'][m-1];
  return hari+', '+d+' '+bulan+' '+y;
}

// Fungsi Cek Apakah Timestamp Sudah Lewat Jam 07:00
function isPastCutoff(ts){
  const d = new Date(ts);
  const cutoff = new Date(d.getFullYear(), d.getMonth(), d.getDate(), CUTOFF_HOUR, CUTOFF_MINUTE, 0);
  return d.getTime() > cutoff.getTime();
}

/* ============ STATE ============ */
let state = {
  loading:true,
  users:[],
  currentUser:null,
  loginError:'',
  view:'absen', // absen | kelola
  selectedDate:todayStr(),
  attendanceCache:{}, // date -> {closed, records:{username:record}}
  camMode:null, // 'ontime' | 'izin_telat'
  camStream:null,
  camBusy:false,
  camFacing:'user',
  capturedPhoto:null,
  camError:null,
  modalPhoto:null,
  tick:Date.now()
};

/* ============ INIT ============ */
async function init(){
  let users = await getData('users');
  if(!users){
    users = [{username:'admin', password:'admin123', role:'admin', name:'Admin'}];
    await setData('users', users);
  }
  state.users = users;
  state.loading = false;
  render();
  setInterval(()=>{
    state.tick = Date.now();
    if(!state.currentUser) return;
    if(state.camMode) return;
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    if(activeTag==='INPUT' || activeTag==='SELECT' || activeTag==='TEXTAREA') return;
    render();
  }, 1000);
}

/* ============ ATTENDANCE DATA ============ */
async function loadAttendance(dateStr){
  let a = await getData('attendance:'+dateStr);
  if(!a){ a = {closed:false, records:{}}; }
  state.attendanceCache[dateStr] = a;
  return a;
}
async function saveAttendance(dateStr, data){
  state.attendanceCache[dateStr] = data;
  await setData('attendance:'+dateStr, data);
}

// PERBAIKAN LOGIKA STATUS (DETEKSI JAM 07:00)
function computeStatus(record, closed, now){
  if(!record) return closed ? {label:'Alfa', cls:'st-alfa'} : {label:'Belum Absen', cls:'st-belum'};
  
  // Jika sudah mengambil foto
  if(record.photo){
    // Jika awalnya memilih Hadir Tepat Waktu
    if(record.choice === 'ontime'){
      // Cek apakah foto diambil SETELAH jam 07:00
      if(isPastCutoff(record.photoAt)){
        return record.keringanan ? {label:'Hadir (Keringanan)', cls:'st-hadir'} : {label:'Alfa (Telat Foto > 07:00)', cls:'st-alfa'};
      }
      return {label:'Hadir', cls:'st-hadir'};
    }
    
    // Jika memilih Izin Telat
    if(record.choice === 'izin_telat'){
      const diff = record.photoAt - record.requestedAt;
      if(diff <= LATE_WINDOW_MS) return {label:'Hadir (Izin Telat)', cls:'st-hadir'};
      if(record.keringanan) return {label:'Hadir (Keringanan)', cls:'st-hadir'};
      return {label:'Alfa (Telat Foto)', cls:'st-alfa'};
    }
  }

  // Jika sedang menunggu foto (Izin Telat)
  if(record.choice === 'izin_telat'){
    const remaining = LATE_WINDOW_MS - (now - record.requestedAt);
    if(remaining > 0) return {label:'Menunggu Foto', cls:'st-tunggu', countdown:remaining};
    if(record.keringanan) return {label:'Menunggu Foto (Keringanan)', cls:'st-tunggu'};
    return closed ? {label:'Alfa', cls:'st-alfa'} : {label:'Waktu Habis', cls:'st-alfa'};
  }

  if(record.choice === 'ontime') return {label:'Menunggu Foto', cls:'st-tunggu'};
  return closed ? {label:'Alfa', cls:'st-alfa'} : {label:'Belum Absen', cls:'st-belum'};
}

/* ============ LOGIN ============ */
async function handleLogin(username, password){
  const u = state.users.find(x=>x.username===username && x.password===password);
  if(!u){ state.loginError = 'Username atau password salah.'; render(); return; }
  state.loginError = '';
  state.currentUser = u;
  state.view = 'absen';
  await loadAttendance(state.selectedDate);
  render();
}
function handleLogout(){
  stopCamera();
  state.currentUser = null;
  render();
}

/* ============ CAMERA ============ */
async function openCamera(mode){
  if(state.camBusy) return;
  state.camError = null;

  // CEK JIKA KLIK HADIR TEPAT WAKTU TAPI SUDAH LEWAT JAM 07:00
  if(mode === 'ontime' && isPastCutoff(Date.now())){
    alert( 'Sudah lewat jam 07:00 Pagi!\n\nStatus kamu otomatis dialihkan ke "Izin Telat". Kamu punya waktu 10 menit untuk mengambil foto di kelas.');
    chooseIzinTelat();
    return;
  }

  if(!window.isSecureContext){
    state.camError = 'Kamera diblokir browser karena halaman ini tidak dibuka lewat koneksi aman (HTTPS/localhost).';
    render();
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    state.camError = 'Browser atau pratinjau ini tidak mengizinkan akses kamera.';
    render();
    return;
  }
  state.camBusy = true;
  state.camMode = mode;
  state.capturedPhoto = null;
  render();
  try{
    const stream = await navigator.mediaDevices.getUserMedia({video:{facingMode: state.camFacing}});
    state.camStream = stream;
    const video = document.getElementById('cam-video');
    if(video){ video.srcObject = stream; video.play().catch(()=>{}); }
  }catch(e){
    state.camError = 'Tidak bisa mengakses kamera: ' + (e && e.message ? e.message : e);
    state.camMode = null;
    state.camBusy = false;
    render();
  }
}

function stopCamera(){
  if(state.camStream){
    state.camStream.getTracks().forEach(t=>t.stop());
    state.camStream = null;
  }
  state.camBusy = false;
}
async function flipCamera(){
  state.camFacing = state.camFacing === 'user' ? 'environment' : 'user';
  stopCamera();
  await openCamera(state.camMode);
}

function shootPhoto(){
  const video = document.getElementById('cam-video');
  if(!video) return;
  const canvas = document.createElement('canvas');
  
  const maxW = 480;
  const scale = maxW / video.videoWidth;
  canvas.width = maxW;
  canvas.height = video.videoHeight * scale;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const now = new Date();
  const label = fmtDateIndo(todayStr()) + '  ' + fmtTime(now.getTime());
  const pad = Math.max(10, canvas.width*0.02);
  ctx.font = Math.max(12, canvas.width*0.035) + 'px monospace';
  const textW = ctx.measureText(label).width;
  const boxH = Math.max(24, canvas.width*0.06);
  ctx.fillStyle = 'rgba(21,42,71,0.72)';
  ctx.fillRect(0, canvas.height-boxH, textW+pad*2, boxH);
  ctx.fillStyle = '#F2C14E';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, pad, canvas.height-boxH/2);

  state.capturedPhoto = canvas.toDataURL('image/jpeg', 0.6);
  stopCamera();
  render();
}

function retakePhoto(){
  state.capturedPhoto = null;
  openCamera(state.camMode);
}

async function confirmPhoto(){
  const dateStr = state.selectedDate;
  let a = state.attendanceCache[dateStr] || await loadAttendance(dateStr);
  const uname = state.currentUser.username;
  const now = Date.now();
  let record = a.records[uname];

  if(state.camMode === 'ontime'){
    record = {choice:'ontime', requestedAt: record?.requestedAt || now, photo: state.capturedPhoto, photoAt: now, keringanan:false};
  }else{
    record = record || {};
    record.choice = 'izin_telat';
    record.requestedAt = record.requestedAt || now;
    record.photo = state.capturedPhoto;
    record.photoAt = now;
  }
  a.records[uname] = record;
  await saveAttendance(dateStr, a);
  state.camMode = null;
  state.capturedPhoto = null;
  render();
}

async function chooseIzinTelat(){
  const dateStr = state.selectedDate;
  let a = state.attendanceCache[dateStr] || await loadAttendance(dateStr);
  const uname = state.currentUser.username;
  if(!a.records[uname] || a.records[uname].choice !== 'izin_telat'){
    a.records[uname] = {choice:'izin_telat', requestedAt: Date.now(), photo:null, photoAt:null, keringanan:false};
    await saveAttendance(dateStr, a);
    render();
  }
  openCamera('izin_telat');
}

/* ============ STAFF ACTIONS ============ */
async function toggleCloseDay(){
  const dateStr = state.selectedDate;
  let a = state.attendanceCache[dateStr] || await loadAttendance(dateStr);
  a.closed = !a.closed;
  a.closedBy = a.closed ? state.currentUser.name : null;
  await saveAttendance(dateStr, a);
  render();
}
async function giveKeringanan(username){
  const dateStr = state.selectedDate;
  let a = state.attendanceCache[dateStr] || await loadAttendance(dateStr);
  if(a.records[username]){
    a.records[username].keringanan = true;
    a.records[username].keringananBy = state.currentUser.name;
    await saveAttendance(dateStr, a);
    render();
  }
}
async function revokeKeringanan(username){
  const dateStr = state.selectedDate;
  let a = state.attendanceCache[dateStr] || await loadAttendance(dateStr);
  if(a.records[username]){
    a.records[username].keringanan = false;
    await saveAttendance(dateStr, a);
    render();
  }
}

/* ============ USER MANAGEMENT ============ */
async function addUser(username, password, name, role){
  if(state.users.find(u=>u.username===username)){
    alert('Username sudah dipakai.'); return false;
  }
  state.users.push({username, password, name, role});
  await setData('users', state.users);
  render();
  return true;
}
async function deleteUser(username){
  if(username === state.currentUser.username){ alert('Tidak bisa menghapus akun sendiri.'); return; }
  if(!confirm('Hapus akun '+username+'?')) return;
  state.users = state.users.filter(u=>u.username!==username);
  await setData('users', state.users);
  render();
}

/* ============ RENDER ============ */
function el(html){ const d=document.createElement('div'); d.innerHTML=html; return d.firstElementChild; }

function render(){
  const app = document.getElementById('app');
  const scrollY = window.scrollY;
  if(state.loading){ app.innerHTML = '<div class="login-shell"><p style="color:#6B6656">Memuat data database...</p></div>'; return; }
  if(!state.currentUser){ app.innerHTML=''; app.appendChild(renderLogin()); return; }
  app.innerHTML='';
  app.appendChild(renderTopbar());
  const wrap = document.createElement('div'); wrap.className='wrap';
  if(state.currentUser.role === 'siswa'){
    wrap.appendChild(renderSiswaView());
  }else{
    wrap.appendChild(renderStaffTabs());
    if(state.view==='absen') wrap.appendChild(renderStaffAttendance());
    else wrap.appendChild(renderKelolaAkun());
  }
  app.appendChild(wrap);
  if(state.modalPhoto) app.appendChild(renderPhotoModal());
  if(state.camMode && !state.capturedPhoto && state.camStream){
    const v = document.getElementById('cam-video');
    if(v && !v.srcObject) v.srcObject = state.camStream;
  }
  window.scrollTo(0, scrollY);
}

function renderLogin(){
  const box = el(`
    <div class="login-shell">
      <div class="login-card">
        <div class="login-head">
          <div class="chalk-big">AB</div>
          <h1>Absensi Kelas</h1>
          <p>Masuk untuk mencatat atau melihat kehadiran</p>
        </div>
        ${state.loginError ? `<div class="err-box">${state.loginError}</div>` : ''}
        <div class="field"><label>Username</label><input id="li-user" type="text" autocomplete="username"></div>
        <div class="field"><label>Password</label><input id="li-pass" type="password" autocomplete="current-password"></div>
        <button class="btn-primary" id="li-btn">Masuk</button>
        <div class="hint-box">Akun pertama kali: <b>admin</b> / <b>admin123</b> (role Admin). Tambah akun siswa/guru di menu <b>Kelola Akun</b> setelah login.</div>
      </div>
    </div>
  `);
  box.querySelector('#li-btn').onclick = ()=>{
    handleLogin(box.querySelector('#li-user').value.trim(), box.querySelector('#li-pass').value);
  };
  box.querySelector('#li-pass').addEventListener('keydown', e=>{ if(e.key==='Enter') box.querySelector('#li-btn').click(); });
  return box;
}

function renderTopbar(){
  const u = state.currentUser;
  const bar = el(`
    <div class="topbar">
      <div class="brand">
        <div class="chalk">AB</div>
        <div>
          <div class="brand-text">Absensi Kelas</div>
          <div class="brand-sub">${fmtDateIndo(todayStr())}</div>
        </div>
      </div>
      <div class="who">
        <div style="text-align:right">
          <div>${u.name}</div>
          <div class="role-pill">${ROLE_LABEL[u.role]}</div>
        </div>
        <button class="logout-btn" id="btn-logout">Keluar</button>
      </div>
    </div>
  `);
  bar.querySelector('#btn-logout').onclick = handleLogout;
  return bar;
}

function renderSiswaView(){
  const c = el(`<div></div>`);
  const dateStr = todayStr();
  const a = state.attendanceCache[dateStr];
  if(!a){
    loadAttendance(dateStr).then(render);
    c.appendChild(el(`<div class="empty-note">Memuat data absensi...</div>`));
    return c;
  }
  const record = a.records[state.currentUser.username];
  const status = computeStatus(record, a.closed, state.tick);

  const card = el(`<div class="card"></div>`);
  card.appendChild(el(`
    <div class="row-between">
      <h2 style="margin:0">Absen Hari Ini</h2>
      <span class="status-badge ${status.cls}">${status.label}</span>
    </div>
  `));

  if(a.closed && (!record || !record.photo)){
    card.appendChild(el(`<div class="empty-note">Absensi hari ini sudah ditutup oleh wali kelas/admin.</div>`));
    c.appendChild(card);
    return c;
  }

  if(state.camMode){
    card.appendChild(renderCameraBlock());
    c.appendChild(card);
    return c;
  }

  if(record && record.photo){
    const div = el(`<div style="margin-top:10px"></div>`);
    div.appendChild(el(`<img src="${record.photo}" style="width:100%;border-radius:10px;margin-bottom:10px">`));
    div.appendChild(el(`<div style="font-size:12.5px;color:var(--ink-soft)">Difoto pukul ${fmtTime(record.photoAt)}${record.choice==='izin_telat' ? ' · Izin telat diajukan pukul '+fmtTime(record.requestedAt) : ''}</div>`));
    card.appendChild(div);
  }else if(record && record.choice==='izin_telat' && status.countdown){
    const mins = Math.floor(status.countdown/60000);
    const secs = Math.floor((status.countdown%60000)/1000);
    card.appendChild(el(`
      <div class="countdown">
        <div class="num">${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}</div>
        <div class="lbl">Sisa waktu untuk foto di kelas sebelum dianggap Alfa</div>
      </div>
    `));
    const btn = el(`<button class="btn-primary" style="margin-top:12px"> Ambil Foto Sekarang</button>`);
    btn.onclick = ()=>openCamera('izin_telat');
    card.appendChild(btn);
    if(state.camError){
      card.appendChild(el(`<div class="err-box" style="margin-top:12px">${state.camError}</div>`));
    }
  }else{
    const isLateNow = isPastCutoff(Date.now());
    const grid = el(`
      <div class="choice-grid">
        <button class="choice-btn" id="c-ontime"><span class="ic"></span>Hadir Tepat Waktu</button>
        <button class="choice-btn izin" id="c-izin"><span class="ic"></span>Izin Telat</button>
      </div>
    `);
    grid.querySelector('#c-ontime').onclick = ()=>openCamera('ontime');
    grid.querySelector('#c-izin').onclick = ()=>chooseIzinTelat();
    card.appendChild(grid);
    card.appendChild(el(`<div style="font-size:12px;color:var(--ink-soft);margin-top:10px">${isLateNow ? '⚠️ Sekarang sudah lewat jam 07:00 Pagi. Memilih tepat waktu akan otomatis dialihkan ke Izin Telat.' : 'Batas waktu Hadir Tepat Waktu adalah pukul 07:00 WIB.'}</div>`));
    if(state.camError){
      card.appendChild(el(`<div class="err-box" style="margin-top:12px">${state.camError}</div>`));
    }
  }

  c.appendChild(card);
  return c;
}

function renderCameraBlock(){
  const box = el(`<div></div>`);
  if(state.capturedPhoto){
    box.appendChild(el(`
      <div class="cam-box">
        <img src="${state.capturedPhoto}">
        <div class="cam-controls">
          <button class="cam-retake" id="cb-retake">Ambil Ulang</button>
          <button class="cam-confirm" id="cb-confirm">Gunakan Foto Ini</button>
        </div>
      </div>
    `));
    box.querySelector('#cb-retake').onclick = retakePhoto;
    box.querySelector('#cb-confirm').onclick = confirmPhoto;
  }else{
    box.appendChild(el(`
      <div class="cam-box">
        <video id="cam-video" autoplay playsinline muted></video>
        <div class="cam-controls">
          <button class="cam-flip" id="cb-flip"> Ganti Kamera</button>
          <button class="cam-shoot" id="cb-shoot"> Ambil Foto</button>
        </div>
      </div>
    `));
    box.querySelector('#cb-shoot').onclick = shootPhoto;
    box.querySelector('#cb-flip').onclick = flipCamera;
  }
  return box;
}

function renderStaffTabs(){
  const tabs = el(`
    <div class="tabs">
      <button class="tab-btn ${state.view==='absen'?'active':''}" id="t-absen">Absensi</button>
      ${state.currentUser.role==='admin' ? `<button class="tab-btn ${state.view==='kelola'?'active':''}" id="t-kelola">Kelola Akun</button>` : ''}
    </div>
  `);
  tabs.querySelector('#t-absen').onclick = ()=>{ state.view='absen'; loadAttendance(state.selectedDate).then(render); };
  const tk = tabs.querySelector('#t-kelola');
  if(tk) tk.onclick = ()=>{ state.view='kelola'; render(); };
  return tabs;
}

function renderStaffAttendance(){
  const c = el(`<div></div>`);
  const dateStr = state.selectedDate;
  const a = state.attendanceCache[dateStr];
  if(!a){
    loadAttendance(dateStr).then(render);
    c.appendChild(el(`<div class="empty-note">Memuat data absensi...</div>`));
    return c;
  }
  const students = state.users.filter(u=>u.role==='siswa');
  const canManage = state.currentUser.role==='admin' || state.currentUser.role==='wali_kelas';

  const header = el(`
    <div class="card">
      <div class="row-between">
        <div>
          <h2 style="margin:0 0 4px">Rekap Absensi</h2>
          <div style="font-size:12.5px;color:var(--ink-soft)">${fmtDateIndo(dateStr)}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="date" class="date-input" id="date-pick" value="${dateStr}">
          ${canManage ? `<button class="small-btn ${a.closed?'ghost':''}" id="btn-close">${a.closed?'Buka Kembali':'Tutup Absen Hari Ini'}</button>` : ''}
        </div>
      </div>
      ${a.closed ? `<div style="margin-top:10px;font-size:12px;color:var(--clay)">Absensi ditutup${a.closedBy?' oleh '+a.closedBy:''}. Siswa yang belum foto otomatis Alfa.</div>` : ''}
    </div>
  `);
  header.querySelector('#date-pick').onchange = (e)=>{
    state.selectedDate = e.target.value;
    loadAttendance(state.selectedDate).then(render);
  };
  const closeBtn = header.querySelector('#btn-close');
  if(closeBtn) closeBtn.onclick = toggleCloseDay;
  c.appendChild(header);

  const tableCard = el(`<div class="card"></div>`);
  if(students.length===0){
    tableCard.appendChild(el(`<div class="empty-note">Belum ada akun siswa. Tambahkan lewat menu Kelola Akun.</div>`));
  }else{
    let rows = '';
    students.forEach(s=>{
      const rec = a.records[s.username];
      const status = computeStatus(rec, a.closed, state.tick);
      rows += `
        <tr>
          <td>${rec && rec.photo ? `<img class="thumb" data-user="${s.username}" src="${rec.photo}">` : `<div class="thumb-empty">👤</div>`}</td>
          <td>${s.name}</td>
          <td><span class="status-badge ${status.cls}">${status.label}${status.countdown?' ('+Math.ceil(status.countdown/60000)+'m)':''}</span></td>
          <td class="mono" style="font-size:12px">${rec && rec.choice==='izin_telat' ? fmtTime(rec.requestedAt) : '-'}</td>
          <td class="mono" style="font-size:12px">${rec && rec.photoAt ? fmtTime(rec.photoAt) : '-'}</td>
          <td>${canManage && status.label.startsWith('Alfa') ? (rec && rec.keringanan ? `<button class="small-btn ghost" data-revoke="${s.username}">Batalkan Keringanan</button>` : `<button class="small-btn" data-keringanan="${s.username}">Beri Keringanan</button>`) : (rec && rec.keringanan ? `<span style="font-size:11px;color:var(--green)">Keringanan ✓</span>` : '')}</td>
        </tr>
      `;
    });
    tableCard.appendChild(el(`
      <table>
        <thead><tr><th>Foto</th><th>Nama</th><th>Status</th><th>Ajukan Izin</th><th>Foto Pukul</th><th>Aksi</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `));
    tableCard.querySelectorAll('.thumb').forEach(img=>{
      img.onclick = ()=>{ state.modalPhoto = img.src; render(); };
    });
    tableCard.querySelectorAll('[data-keringanan]').forEach(btn=>{
      btn.onclick = ()=>giveKeringanan(btn.getAttribute('data-keringanan'));
    });
    tableCard.querySelectorAll('[data-revoke]').forEach(btn=>{
      btn.onclick = ()=>revokeKeringanan(btn.getAttribute('data-revoke'));
    });
  }
  c.appendChild(tableCard);
  return c;
}

function renderPhotoModal(){
  const m = el(`
    <div class="modal-bg" id="modal-bg">
      <div class="modal-box">
        <button class="close-x" id="modal-close">✕</button>
        <div style="clear:both"></div>
        <img src="${state.modalPhoto}">
      </div>
    </div>
  `);
  m.querySelector('#modal-close').onclick = ()=>{ state.modalPhoto=null; render(); };
  m.onclick = (e)=>{ if(e.target.id==='modal-bg'){ state.modalPhoto=null; render(); } };
  return m;
}

function renderKelolaAkun(){
  const c = el(`<div></div>`);
  const formCard = el(`
    <div class="card">
      <h2>Tambah Akun Baru</h2>
      <div class="form-inline">
        <div class="field" style="margin-bottom:0"><label>Nama Lengkap</label><input id="nu-name"></div>
        <div class="field" style="margin-bottom:0"><label>Username</label><input id="nu-user"></div>
        <div class="field" style="margin-bottom:0"><label>Password</label><input id="nu-pass"></div>
        <div class="field" style="margin-bottom:0">
          <label>Role</label>
          <select id="nu-role">
            <option value="siswa">Siswa</option>
            <option value="wali_kelas">Wali Kelas</option>
            <option value="sekertaris">Sekertaris</option>
            <option value="ketua_kelas">Ketua Kelas</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </div>
      <button class="btn-primary" id="nu-add">Tambah Akun</button>
    </div>
  `);
  formCard.querySelector('#nu-add').onclick = async ()=>{
    const name = formCard.querySelector('#nu-name').value.trim();
    const username = formCard.querySelector('#nu-user').value.trim();
    const password = formCard.querySelector('#nu-pass').value;
    const role = formCard.querySelector('#nu-role').value;
    if(!name || !username || !password){ alert('Lengkapi semua kolom.'); return; }
    const ok = await addUser(username, password, name, role);
    if(ok){ formCard.querySelector('#nu-name').value=''; formCard.querySelector('#nu-user').value=''; formCard.querySelector('#nu-pass').value=''; }
  };
  c.appendChild(formCard);

  const listCard = el(`<div class="card"><h2>Daftar Akun</h2></div>`);
  state.users.forEach(u=>{
    const row = el(`
      <div class="user-row">
        <div>
          <div>${u.name}</div>
          <div class="mono" style="font-size:11px;color:var(--ink-soft)">${u.username}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="badge-role">${ROLE_LABEL[u.role]}</span>
          <button class="small-btn ghost" data-del="${u.username}">Hapus</button>
        </div>
      </div>
    `);
    row.querySelector('[data-del]').onclick = ()=>deleteUser(u.username);
    listCard.appendChild(row);
  });
  c.appendChild(listCard);
  return c;
}

init();