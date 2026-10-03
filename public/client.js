const socket = io();

const $ = (id) => document.getElementById(id);

// ---------- Landing ----------
const landing = $('landing');
const roomScreen = $('room');
const nameInput = $('nameInput');
const codeInput = $('codeInput');
const errorMsg = $('errorMsg');

function isMobileBrowser() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

let myName = '';
let myCode = '';
let myId = null;
let myColor = '#7d72c9';
let isHost = false;
let participants = {}; // id -> { name, color }

let pc = {}; // screen-share peerConnections, keyed by peer socketId
let localStream = null;

let audioPc = {}; // voice-chat peerConnections, keyed by peer socketId (separate from screen-share pc)
let localAudioStream = null;
let micEnabled = false;

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

socket.on('joined', ({ code, isHost: host, selfId, color, participants: list }) => {
  myCode = code;
  isHost = host;
  myId = selfId;
  myColor = color;
  setParticipants(list);

  landing.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  $('roomCodeLabel').textContent = code;
  addSystemMsg(`You joined as ${myName}${isHost ? ' (host)' : ''}.`);

  if (isHost) {
    $('hostControls').classList.remove('hidden');
    $('waitingMsg').classList.add('hidden');
    if (isMobileBrowser()) {
      $('shareBtn').disabled = true;
      $('shareBtn').textContent = 'Screen share unavailable';
      $('hostControls').querySelector('.hint').innerHTML =
        'Mobile browsers (Chrome/Safari on phones) don\'t support screen sharing at all — ' +
        'it\'s a platform limitation, not something this app can work around. ' +
        'To share your screen, open this room from a laptop or desktop browser instead. ' +
        'Everyone else can still join and watch from their phones as usual.';
    }
  } else {
    $('waitingMsg').classList.remove('hidden');
    $('viewerControls').classList.remove('hidden');
    socket.emit('request-stream');
  }
});

// Room's shareable code changed (host clicked Add Participants again).
// Doesn't touch anyone's connection — it's just the label everyone sees.
socket.on('code-changed', ({ code }) => {
  myCode = code;
  $('roomCodeLabel').textContent = code;
  if (!$('shareModal').classList.contains('hidden')) {
    populateInviteModal();
  }
});

// ---------- Participants ----------
function setParticipants(list) {
  participants = {};
  list.forEach((p) => { participants[p.id] = { name: p.name, color: p.color }; });
  renderParticipants();
}

function renderParticipants() {
  const ul = $('participantList');
  ul.innerHTML = '';
  Object.entries(participants).forEach(([id, p]) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="color-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}`;
    if (id === myId) li.classList.add('me');
    ul.appendChild(li);
  });
}

socket.on('participant-joined', ({ id, username, color, participants: list }) => {
  setParticipants(list);
  addSystemMsg(`${username} joined.`);
  // If our mic is already on, bring the new person into the voice mesh.
  if (micEnabled && id !== myId) initiateVoiceOffer(id);
});

socket.on('participant-left', ({ id, username, wasHost, participants: list }) => {
  setParticipants(list);
  addSystemMsg(`${username} left${wasHost ? ' (host disconnected — sharing stopped)' : ''}.`);
  if (wasHost) clearVideo();
  closeVoicePeer(id);
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

socket.on('chat-message', ({ username, color, text }) => {
  const mine = username === myName;
  const div = document.createElement('div');
  div.className = `chat-msg ${mine ? 'mine' : 'theirs'}`;
  // Your own messages skip the name label (it's obviously you, like any
  // chat app) and align right; everyone else's shows their colored name
  // and aligns left, since this is a group room, not a 1:1 chat.
  const nameHtml = mine ? '' : `<span class="who" style="color:${color || 'inherit'}">${escapeHtml(username)}</span>`;
  div.innerHTML = `${nameHtml}<span class="bubble-text">${escapeHtml(text)}</span>`;
  const box = $('chatMessages');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
});

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system-msg';
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
function populateInviteModal() {
  $('shareCode').value = myCode;
  $('shareLink').value = `${window.location.origin}/?code=${myCode}`;
}
$('addParticipantsBtn').addEventListener('click', () => {
  // Ask the server for a brand-new code every time. The old one stops
  // working immediately; nobody already in the room is affected.
  socket.emit('regen-code');
  $('shareModal').classList.remove('hidden');
});
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

// ---------- Playback requests (viewer -> host) ----------
// A viewer can't actually pause/seek the host's live screen share — this
// just asks the host, who can act on it in their own player.
function sendPlaybackRequest(action, label, btn) {
  socket.emit('playback-request', { action, label });
  addSystemMsg(`You requested: ${label}`);
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; }, 4000);
}
$('reqPauseBtn').addEventListener('click', (e) => sendPlaybackRequest('pause', 'Pause', e.currentTarget));
$('reqPlayBtn').addEventListener('click', (e) => sendPlaybackRequest('play', 'Resume', e.currentTarget));
$('reqBackBtn').addEventListener('click', (e) => sendPlaybackRequest('back', 'Rewind 10s', e.currentTarget));
$('reqFwdBtn').addEventListener('click', (e) => sendPlaybackRequest('forward', 'Skip ahead 10s', e.currentTarget));

let toastTimer = null;
function showToast(text) {
  let toast = document.getElementById('reqToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'reqToast';
    toast.className = 'req-toast';
    document.querySelector('.video-area').appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 5000);
}

// Only the host receives this (server targets it directly)
socket.on('playback-request', ({ username: who, label }) => {
  showToast(`🔔 ${who} wants: ${label}`);
});

// Everyone sees the request logged in chat too, for transparency
socket.on('system-message', ({ text }) => addSystemMsg(text));

// ---------- Video status indicator ----------
function setVideoState(state) {
  // state: 'idle' | 'sharing' (host, red) | 'watching' (viewer, green)
  const area = document.querySelector('.video-area');
  const badge = $('liveBadge');
  area.classList.remove('sharing', 'watching');
  if (state === 'idle') {
    badge.classList.add('hidden');
    return;
  }
  area.classList.add(state);
  badge.classList.remove('hidden');
  badge.classList.toggle('watching', state === 'watching');
  $('liveBadgeText').textContent = state === 'sharing' ? 'Sharing' : 'Live';
}

function clearVideo() {
  $('remoteVideo').srcObject = null;
  $('remoteVideo').muted = false;
  $('waitingMsg').classList.remove('hidden');
  setVideoState('idle');
}

// ---------- WebRTC screen share (mesh: host -> each viewer) ----------
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

$('shareBtn').addEventListener('click', async () => {
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      // These constraints stop the browser from applying voice-call style
      // processing (echo cancellation etc) to what should be clean movie/
      // stream audio. This only ever captures the shared tab/screen's own
      // audio — never your microphone or headset, regardless of what
      // audio device you're using.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    addSystemMsg('Screen share was cancelled or blocked.');
    return;
  }

  $('shareBtn').textContent = 'Sharing…';
  $('shareBtn').disabled = true;
  $('hostControls').classList.add('hidden');

  // Let the host see their own shared content, muted, so it's obvious
  // sharing is actually working — not just a spinner.
  $('remoteVideo').srcObject = localStream;
  $('remoteVideo').muted = true;
  $('waitingMsg').classList.add('hidden');
  setVideoState('sharing');

  // Tell the room a stream is available now — this catches viewers who
  // joined before sharing started and already asked (and got nothing).
  socket.emit('sharing-started');

  localStream.getVideoTracks()[0].addEventListener('ended', () => {
    $('shareBtn').textContent = 'Start Screen Share';
    $('shareBtn').disabled = false;
    $('hostControls').classList.remove('hidden');
    Object.keys(pc).forEach((id) => pc[id].close());
    pc = {};
    clearVideo();
    socket.emit('sharing-stopped');
  });
});

// Viewer asked host for the stream
socket.on('viewer-wants-stream', async ({ viewerId }) => {
  if (!localStream) return; // host hasn't started sharing yet
  if (pc[viewerId]) pc[viewerId].close();
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

// Host becomes known to a viewer (fires right after joining a room that already has a host)
socket.on('host-available', () => {
  socket.emit('request-stream');
});

// Host just started sharing — ask again in case our earlier request came too early
socket.on('sharing-started', () => {
  if (!isHost) socket.emit('request-stream');
});

socket.on('sharing-stopped', () => {
  if (!isHost) {
    addSystemMsg('Host stopped sharing.');
    clearVideo();
  }
});

// Generic signaling relay handler for screen share (host <-> viewer roles)
socket.on('signal', async ({ from, data }) => {
  let conn = pc[from];

  if (data.sdp && data.sdp.type === 'offer') {
    // We are the viewer receiving an offer from the host
    if (conn) conn.close();
    conn = new RTCPeerConnection(rtcConfig);
    pc[from] = conn;
    conn.ontrack = (e) => {
      $('remoteVideo').srcObject = e.streams[0];
      $('remoteVideo').muted = false;
      $('waitingMsg').classList.add('hidden');
      setVideoState('watching');
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

// =====================================================================
// Voice chat — a separate, independent mesh of audio-only peer
// connections (its own signaling channel, its own RTCPeerConnections),
// so it never interferes with the screen-share connections above.
//
// Simplification: each person who turns their mic on opens one outbound
// connection to every other participant. If both sides turn their mic
// on, that's two one-directional connections between them rather than
// one bidirectional one — slightly more overhead, but far simpler than
// renegotiating a shared connection, and trivial at friend-group scale.
// =====================================================================

const audioSinks = document.createElement('div');
audioSinks.style.display = 'none';
document.body.appendChild(audioSinks);

function playRemoteAudio(peerId, stream) {
  let audioEl = document.getElementById(`audio-${peerId}`);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = `audio-${peerId}`;
    audioEl.autoplay = true;
    audioSinks.appendChild(audioEl);
  }
  audioEl.srcObject = stream;
}

function removeRemoteAudio(peerId) {
  const audioEl = document.getElementById(`audio-${peerId}`);
  if (audioEl) audioEl.remove();
}

function closeVoicePeer(peerId) {
  if (audioPc[peerId]) {
    audioPc[peerId].close();
    delete audioPc[peerId];
  }
  removeRemoteAudio(peerId);
}

async function initiateVoiceOffer(peerId) {
  if (!localAudioStream) return;
  if (audioPc[peerId]) audioPc[peerId].close();
  const conn = new RTCPeerConnection(rtcConfig);
  audioPc[peerId] = conn;
  localAudioStream.getTracks().forEach((t) => conn.addTrack(t, localAudioStream));
  conn.onicecandidate = (e) => {
    if (e.candidate) socket.emit('voice-signal', { to: peerId, data: { candidate: e.candidate } });
  };
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
  socket.emit('voice-signal', { to: peerId, data: { sdp: offer } });
}

$('micBtn').addEventListener('click', async () => {
  if (!micEnabled) {
    try {
      localAudioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      addSystemMsg('Microphone access was blocked or cancelled.');
      return;
    }
    micEnabled = true;
    $('micBtn').textContent = '🎤 Mute Mic';
    $('micBtn').classList.add('mic-on');
    Object.keys(participants).forEach((id) => { if (id !== myId) initiateVoiceOffer(id); });
  } else {
    micEnabled = false;
    $('micBtn').textContent = '🎙️ Enable Mic';
    $('micBtn').classList.remove('mic-on');
    localAudioStream.getTracks().forEach((t) => t.stop());
    localAudioStream = null;
    Object.keys(audioPc).forEach((id) => audioPc[id].close());
    audioPc = {};
    socket.emit('voice-stopped');
  }
});

socket.on('voice-stopped', ({ from }) => closeVoicePeer(from));

// Signaling relay handler for voice chat (independent from screen-share signal)
socket.on('voice-signal', async ({ from, data }) => {
  let conn = audioPc[from];

  if (data.sdp && data.sdp.type === 'offer') {
    if (conn) conn.close();
    conn = new RTCPeerConnection(rtcConfig);
    audioPc[from] = conn;
    conn.ontrack = (e) => playRemoteAudio(from, e.streams[0]);
    conn.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voice-signal', { to: from, data: { candidate: e.candidate } });
    };
    await conn.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await conn.createAnswer();
    await conn.setLocalDescription(answer);
    socket.emit('voice-signal', { to: from, data: { sdp: answer } });
  } else if (data.sdp && data.sdp.type === 'answer' && conn) {
    await conn.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.candidate && conn) {
    try { await conn.addIceCandidate(data.candidate); } catch (e) { /* ignore */ }
  }
});

// ---------- PWA install ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support is a bonus, not critical */ });
  });
}

let deferredInstallPrompt = null;
const installButtons = [$('installBtn'), $('installBtnLanding')].filter(Boolean);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  installButtons.forEach((btn) => btn.classList.remove('hidden'));
});

async function handleInstallClick() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installButtons.forEach((btn) => btn.classList.add('hidden'));
}
installButtons.forEach((btn) => btn.addEventListener('click', handleInstallClick));

window.addEventListener('appinstalled', () => {
  installButtons.forEach((btn) => btn.classList.add('hidden'));
});
