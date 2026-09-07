const socket = io();

const $ = (id) => document.getElementById(id);

// ---------- Landing ----------
const landing = $('landing');
const roomScreen = $('room');
const nameInput = $('nameInput');
const codeInput = $('codeInput');
const errorMsg = $('errorMsg');

let myName = '';
let myCode = '';
let isHost = false;
let pc = {}; // peerConnections keyed by socketId (host: one per viewer, viewer: one for host)
let localStream = null;

// Prefill code from a shared link like /?code=ABCDE
const params = new URLSearchParams(window.location.search);
if (params.get('code')) codeInput.value = params.get('code').toUpperCase();

$('joinBtn').addEventListener('click', () => doJoin(false));
$('createBtn').addEventListener('click', async () => {
  errorMsg.textContent = '';
  if (!nameInput.value.trim()) { errorMsg.textContent = 'Enter your name first.'; return; }
  const res = await fetch('/api/create-room');
  const { code } = await res.json();
  codeInput.value = code;
  doJoin(true);
});

function doJoin(asHost) {
  errorMsg.textContent = '';
  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();
  if (!name) { errorMsg.textContent = 'Enter your name.'; return; }
  if (!code) { errorMsg.textContent = 'Enter a room code.'; return; }
  myName = name;
  socket.emit('join-room', { code, name, asHost });
}

socket.on('join-error', (msg) => { errorMsg.textContent = msg; });

socket.on('joined', ({ code, isHost: host, participants }) => {
  myCode = code;
  isHost = host;
  landing.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  $('roomCodeLabel').textContent = code;
  renderParticipants(participants);
  addSystemMsg(`You joined as ${myName}${isHost ? ' (host)' : ''}.`);

  if (isHost) {
    $('hostControls').classList.remove('hidden');
    $('waitingMsg').classList.add('hidden');
  } else {
    $('waitingMsg').classList.remove('hidden');
    socket.emit('request-stream');
  }
});

// ---------- Participants ----------
function renderParticipants(list) {
  const ul = $('participantList');
  ul.innerHTML = '';
  list.forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    if (name === myName) li.classList.add('me');
    ul.appendChild(li);
  });
}

socket.on('participant-joined', ({ username, participants }) => {
  renderParticipants(participants);
  addSystemMsg(`${username} joined.`);
});

socket.on('participant-left', ({ username, wasHost, participants }) => {
  renderParticipants(participants);
  addSystemMsg(`${username} left${wasHost ? ' (host disconnected — sharing stopped)' : ''}.`);
  if (wasHost) {
    $('remoteVideo').srcObject = null;
    $('waitingMsg').classList.remove('hidden');
  }
});

// ---------- Chat ----------
$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  input.value = '';
});

socket.on('chat-message', ({ username, text }) => {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="who">${escapeHtml(username)}</span>${escapeHtml(text)}`;
  const box = $('chatMessages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
});

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="who system">${escapeHtml(text)}</span>`;
  const box = $('chatMessages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- Invite modal ----------
function openInviteModal() {
  $('shareCode').value = myCode;
  $('shareLink').value = `${window.location.origin}/?code=${myCode}`;
  $('shareModal').classList.remove('hidden');
}
$('addParticipantsBtn').addEventListener('click', openInviteModal);
$('closeModalBtn').addEventListener('click', () => $('shareModal').classList.add('hidden'));
$('copyCodeBtn').addEventListener('click', () => copyField('shareCode'));
$('copyLinkBtn').addEventListener('click', () => copyField('shareLink'));
function copyField(id) {
  const el = $(id);
  el.select();
  navigator.clipboard?.writeText(el.value);
}

// ---------- Leave ----------
$('leaveBtn').addEventListener('click', () => window.location.reload());

// ---------- WebRTC screen share (mesh: host -> each viewer) ----------
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

$('shareBtn').addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    addSystemMsg('Screen share was cancelled or blocked.');
    return;
  }
  $('shareBtn').textContent = 'Sharing…';
  $('shareBtn').disabled = true;
  localStream.getVideoTracks()[0].addEventListener('ended', () => {
    $('shareBtn').textContent = 'Start Screen Share';
    $('shareBtn').disabled = false;
    Object.keys(pc).forEach((id) => pc[id].close());
    pc = {};
  });
});

// Viewer asked host for the stream
socket.on('viewer-wants-stream', async ({ viewerId }) => {
  if (!localStream) return; // host hasn't started sharing yet
  const conn = new RTCPeerConnection(rtcConfig);
  pc[viewerId] = conn;
  localStream.getTracks().forEach((track) => conn.addTrack(track, localStream));
  conn.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: viewerId, data: { candidate: e.candidate } });
  };
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
  socket.emit('signal', { to: viewerId, data: { sdp: offer } });
});

// Host becomes known to a viewer
socket.on('host-available', () => {
  socket.emit('request-stream');
});

// Generic signaling relay handler (works for both host and viewer roles)
socket.on('signal', async ({ from, data }) => {
  let conn = pc[from];

  if (data.sdp && data.sdp.type === 'offer') {
    // We are the viewer receiving an offer from the host
    conn = new RTCPeerConnection(rtcConfig);
    pc[from] = conn;
    conn.ontrack = (e) => {
      $('remoteVideo').srcObject = e.streams[0];
      $('waitingMsg').classList.add('hidden');
    };
    conn.onicecandidate = (e) => {
      if (e.candidate) socket.emit('signal', { to: from, data: { candidate: e.candidate } });
    };
    await conn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await conn.createAnswer();
    await conn.setLocalDescription(answer);
    socket.emit('signal', { to: from, data: { sdp: answer } });
  } else if (data.sdp && data.sdp.type === 'answer' && conn) {
    await conn.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.candidate && conn) {
    try { await conn.addIceCandidate(data.candidate); } catch (e) { /* ignore */ }
  }
});
