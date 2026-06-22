// ============ State ============
let socket;
let currentUser = null;
let currentChat = null; // { id, type: 'channel'|'dm', name, targetUsername? }
let chats = new Map();  // chatId -> { id, type, name, lastMsg, unread, ... }
let onlineUsers = [];
let allChannels = [];
let replyTo = null;
let typingTimers = {};
let typingDisplayTimers = {};
let mediaRecorder = null;
let recordedChunks = [];
let videoStream = null;
let videoRecorder = null;
let videoChunks = [];
let videoTimer = null;
let videoSeconds = 0;
let pendingAvatarBase64 = null;
let editAvatarBase64 = null;
let profileInModal = null;
let contextMenu = null;

// ============ Init ============
window.onload = () => {
  const saved = localStorage.getItem('tgchat_user');
  if (saved) {
    const u = JSON.parse(saved);
    document.getElementById('auth-username').value = u.username || '';
    document.getElementById('auth-displayname').value = u.displayName || '';
    document.getElementById('auth-bio').value = u.bio || '';
  }
  loadTheme();
};

function connectSocket() {
  const host = window.location.hostname;
  const port = window.location.port || (location.protocol === 'https:' ? 443 : 80);
  socket = io(`${location.protocol}//${host}:${port}`);

  socket.on('connect', () => console.log('socket connected'));
  socket.on('auth_ok', onAuthOk);
  socket.on('auth_error', (msg) => showAuthError(msg));
  socket.on('new_message', onNewMessage);
  socket.on('history', onHistory);
  socket.on('users_updated', onUsersUpdated);
  socket.on('channels_updated', onChannelsUpdated);
  socket.on('typing', onTyping);
  socket.on('message_updated', onMessageUpdated);
  socket.on('channel_created', onChannelCreated);
  socket.on('joined_channel', onJoinedChannel);
  socket.on('dm_ready', onDmReady);
  socket.on('profile_updated', (u) => { currentUser = u; updateMenuProfile(); });
}

// ============ Auth ============
function doAuth() {
  const username = document.getElementById('auth-username').value.trim().replace(/\s+/g, '');
  const displayName = document.getElementById('auth-displayname').value.trim();
  const bio = document.getElementById('auth-bio').value.trim();
  if (!username) return showAuthError('Введи юзернейм');
  if (!/^[a-zA-Z0-9_]{2,32}$/.test(username)) return showAuthError('Только буквы, цифры и _ (2-32 символа)');
  if (!socket) connectSocket();
  socket.once('connect', () => {
    socket.emit('auth', { username, displayName: displayName || username, avatar: pendingAvatarBase64, bio });
  });
  if (socket.connected) {
    socket.emit('auth', { username, displayName: displayName || username, avatar: pendingAvatarBase64, bio });
  }
  localStorage.setItem('tgchat_user', JSON.stringify({ username, displayName, bio }));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.getElementById('auth-screen').style.display !== 'none' && !document.getElementById('auth-screen').classList.contains('hidden')) {
    if (document.activeElement.tagName !== 'TEXTAREA') doAuth();
  }
});

function showAuthError(msg) {
  document.getElementById('auth-error').textContent = msg;
}

function onAuthOk({ user, channels, users: u }) {
  currentUser = user;
  onlineUsers = u;
  allChannels = [];
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  updateMenuProfile();
  // Build chat list from joined channels + existing DMs
  channels.forEach(ch => {
    if (!chats.has(ch.id)) chats.set(ch.id, { id: ch.id, type: 'channel', name: ch.name, unread: 0 });
  });
  renderChatList();
  onChannelsUpdated(allChannels.length ? allChannels : channels);
  renderPeopleList();
  // Auto-open general
  const general = chats.get('general');
  if (general) openChat('general', 'channel', 'General');
}

function doLogout() {
  location.reload();
}

function previewAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    pendingAvatarBase64 = e.target.result;
    const wrap = document.getElementById('auth-avatar-preview');
    wrap.innerHTML = `<img src="${pendingAvatarBase64}">`;
  };
  reader.readAsDataURL(file);
}

// ============ Chat list ============
function renderChatList(filter = '') {
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  for (const [id, chat] of chats) {
    if (filter && !chat.name.toLowerCase().includes(filter.toLowerCase())) continue;
    const item = document.createElement('div');
    item.className = 'chat-item' + (currentChat && currentChat.id === id ? ' active' : '');
    item.onclick = () => openChatFromItem(chat);
    const avatarHtml = getAvatarHtml(chat.avatar, chat.name, 'avatar-circle');
    item.innerHTML = `
      <div class="avatar-wrap">${avatarHtml}${chat.onlineTarget ? '<div class="online-dot"></div>' : ''}</div>
      <div class="chat-item-right">
        <div class="chat-item-top">
          <span class="chat-item-name">${escHtml(chat.name)}</span>
          <span class="chat-item-time">${chat.lastTime ? formatTime(chat.lastTime) : ''}</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span class="chat-item-preview">${escHtml(chat.lastMsg || (chat.type === 'channel' ? '#channel' : ''))}</span>
          ${chat.unread ? `<span class="chat-item-badge">${chat.unread}</span>` : ''}
        </div>
      </div>`;
    list.appendChild(item);
  }
}

function openChatFromItem(chat) {
  if (chat.type === 'channel') {
    openChat(chat.id, 'channel', chat.name);
  } else {
    openChat(chat.id, 'dm', chat.name, chat.targetUsername);
  }
}

function openChat(id, type, name, targetUsername) {
  currentChat = { id, type, name, targetUsername };
  if (chats.has(id)) chats.get(id).unread = 0;
  renderChatList();
  // Header
  const chat = chats.get(id) || {};
  document.getElementById('chat-header-name').textContent = name;
  const headerAvatar = document.getElementById('chat-header-avatar');
  headerAvatar.innerHTML = '';
  const img = getAvatarHtml(chat.avatar, name, 'avatar-circle');
  headerAvatar.outerHTML; // won't work - need to set innerHTML of wrapper
  const avatarContainer = document.getElementById('chat-header-avatar');
  avatarContainer.innerHTML = getAvatarInner(chat.avatar, name);
  avatarContainer.style.background = chat.avatar ? '' : getAvatarColor(name);
  if (type === 'channel') {
    const members = allChannels.find(c => c.id === id);
    document.getElementById('chat-header-sub').textContent = members ? `${members.memberCount} участников` : 'канал';
  } else {
    const u = onlineUsers.find(u => u.username === targetUsername);
    document.getElementById('chat-header-sub').textContent = u ? '🟢 онлайн' : 'не в сети';
  }
  // Show chat window
  showChatWindow();
  // Load history
  socket.emit('get_history', { chatId: id });
  // Mobile: hide sidebar
  if (window.innerWidth <= 680) {
    document.getElementById('sidebar').classList.add('hidden-mobile');
  }
}

function showChatWindow() {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('chat-window').classList.remove('hidden');
  document.getElementById('channels-panel').classList.add('hidden');
  document.getElementById('people-panel').classList.add('hidden');
}

function closeChat() {
  currentChat = null;
  document.getElementById('chat-window').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
  document.getElementById('sidebar').classList.remove('hidden-mobile');
}

function showSection(section) {
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('chat-window').classList.add('hidden');
  if (section === 'channels') {
    document.getElementById('channels-panel').classList.remove('hidden');
    document.getElementById('people-panel').classList.add('hidden');
    renderChannelsList();
  } else {
    document.getElementById('people-panel').classList.remove('hidden');
    document.getElementById('channels-panel').classList.add('hidden');
    renderPeopleList();
  }
}

function closePanel() {
  document.getElementById('channels-panel').classList.add('hidden');
  document.getElementById('people-panel').classList.add('hidden');
  document.getElementById('empty-state').classList.remove('hidden');
}

// ============ Messages ============
function onHistory({ chatId, messages }) {
  if (!currentChat || currentChat.id !== chatId) return;
  const area = document.getElementById('messages-area');
  area.innerHTML = '';
  let lastDate = null;
  messages.forEach(msg => {
    const msgDate = new Date(msg.timestamp).toDateString();
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      const div = document.createElement('div');
      div.className = 'date-divider';
      div.textContent = formatDateLabel(msg.timestamp);
      area.appendChild(div);
    }
    area.appendChild(buildMsgEl(msg));
  });
  area.scrollTop = area.scrollHeight;
}

function onNewMessage(msg) {
  // Add to chat list
  const chat = chats.get(msg.chatId);
  if (chat) {
    chat.lastMsg = msg.text || (msg.file ? (msg.file.mime?.startsWith('image') ? '📷 Фото' : msg.file.mime?.startsWith('audio') ? '🎤 Голосовое' : msg.file.mime?.startsWith('video') ? '📹 Видео' : '📎 Файл') : '');
    chat.lastTime = msg.timestamp;
    if (!currentChat || currentChat.id !== msg.chatId) chat.unread = (chat.unread || 0) + 1;
  } else if (msg.chatType === 'dm') {
    const isOut = msg.sender.username === currentUser.username;
    const otherName = isOut ? msg.chatId.split('__dm__').find(n => n !== currentUser.username) : msg.sender.displayName;
    const otherUsername = msg.chatId.split('__dm__').find(n => n !== currentUser.username);
    const otherUser = onlineUsers.find(u => u.username === otherUsername);
    chats.set(msg.chatId, {
      id: msg.chatId, type: 'dm', name: otherUser ? otherUser.displayName : otherUsername,
      targetUsername: otherUsername, avatar: otherUser?.avatar,
      lastMsg: msg.text || '', lastTime: msg.timestamp, unread: isOut ? 0 : 1
    });
  }
  renderChatList();
  if (currentChat && currentChat.id === msg.chatId) {
    const area = document.getElementById('messages-area');
    area.appendChild(buildMsgEl(msg));
    area.scrollTop = area.scrollHeight;
  }
}

function buildMsgEl(msg) {
  const isOut = msg.sender.username === currentUser.username;
  const row = document.createElement('div');
  row.className = `msg-row ${isOut ? 'out' : 'in'}`;
  row.dataset.msgId = msg.id;
  row.dataset.chatId = msg.chatId;

  // Avatar (only for incoming in channels)
  let avatarHtml = '';
  if (!isOut && currentChat && currentChat.type === 'channel') {
    avatarHtml = `<div class="avatar-circle avatar-sm" style="background:${getAvatarColor(msg.sender.username)}">${getAvatarInner(msg.sender.avatar, msg.sender.displayName)}</div>`;
  } else if (!isOut) {
    avatarHtml = `<div class="msg-avatar-spacer"></div>`;
  }

  // Build content
  let content = '';
  if (!isOut && currentChat && currentChat.type === 'channel') {
    content += `<div class="msg-sender">${escHtml(msg.sender.displayName)}</div>`;
  }
  if (msg.replyTo) {
    content += `<div class="msg-reply" onclick="scrollToMsg('${msg.replyTo.id}')"><div class="msg-reply-name">${escHtml(msg.replyTo.sender.displayName)}</div><div>${escHtml(msg.replyTo.text || '[медиа]')}</div></div>`;
  }
  if (msg.file) {
    const f = msg.file;
    if (f.mime && f.mime.startsWith('image/')) {
      content += `<img src="${f.url}" class="msg-image" onclick="openFullImage('${f.url}')" loading="lazy">`;
    } else if (f.mime && f.mime.startsWith('audio/')) {
      content += `<div class="msg-audio"><div style="font-size:12px;opacity:0.7;margin-bottom:4px;">🎤 ${f.isVoice ? 'Голосовое' : 'Аудио'}</div><audio controls src="${f.url}"></audio></div>`;
    } else if (f.mime && f.mime.startsWith('video/') && f.isCircle) {
      content += `<div class="msg-video-circle"><video src="${f.url}" controls playsinline></video></div>`;
    } else if (f.mime && f.mime.startsWith('video/')) {
      content += `<div><video src="${f.url}" controls style="max-width:260px;border-radius:10px;"></video></div>`;
    } else {
      content += `<a href="${f.url}" download="${escHtml(f.name)}" class="msg-file" target="_blank"><span class="msg-file-icon">📄</span><div class="msg-file-info"><div class="name">${escHtml(f.name)}</div><div class="size">${formatSize(f.size)}</div></div></a>`;
    }
  }
  if (msg.text) content += `<div>${escHtml(msg.text)}</div>`;
  content += `<div class="msg-meta"><span>${formatTime(msg.timestamp)}</span>${isOut ? '<span>✓✓</span>' : ''}</div>`;

  // Reactions
  if (msg.reactions && Object.keys(msg.reactions).length) {
    let rxHtml = '<div class="msg-reactions">';
    for (const [emoji, users] of Object.entries(msg.reactions)) {
      if (!users.length) continue;
      const mine = users.includes(currentUser.username);
      rxHtml += `<span class="reaction-pill${mine ? ' mine' : ''}" onclick="react('${msg.chatId}','${msg.id}','${emoji}')">${emoji} ${users.length}</span>`;
    }
    rxHtml += '</div>';
    content += rxHtml;
  }

  const wrap = document.createElement('div');
  wrap.className = 'msg-bubble-wrap';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = content;
  wrap.appendChild(bubble);

  // Context menu on long press / right click
  bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(e, msg); });
  let pressTimer;
  bubble.addEventListener('touchstart', () => { pressTimer = setTimeout(() => showContextMenu(null, msg, bubble), 500); });
  bubble.addEventListener('touchend', () => clearTimeout(pressTimer));

  row.innerHTML = avatarHtml;
  row.appendChild(wrap);
  return row;
}

function onMessageUpdated(msg) {
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`);
  if (!el) return;
  const parent = el.parentNode;
  const newEl = buildMsgEl(msg);
  parent.replaceChild(newEl, el);
}

// Context menu
function showContextMenu(e, msg, anchor) {
  removeContextMenu();
  contextMenu = document.createElement('div');
  contextMenu.className = 'context-menu';
  const emojis = ['👍','❤️','😂','😮','😢','🔥'];
  emojis.forEach(em => {
    const btn = document.createElement('span');
    btn.className = 'context-emoji';
    btn.textContent = em;
    btn.onclick = () => { react(msg.chatId, msg.id, em); removeContextMenu(); };
    contextMenu.appendChild(btn);
  });
  const replyBtn = document.createElement('span');
  replyBtn.className = 'context-reply';
  replyBtn.textContent = '↩ Ответить';
  replyBtn.onclick = () => { setReplyTo(msg); removeContextMenu(); };
  contextMenu.appendChild(replyBtn);
  document.body.appendChild(contextMenu);
  if (e) {
    contextMenu.style.left = Math.min(e.clientX, window.innerWidth - 260) + 'px';
    contextMenu.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px';
  } else if (anchor) {
    const rect = anchor.getBoundingClientRect();
    contextMenu.style.left = Math.min(rect.left, window.innerWidth - 260) + 'px';
    contextMenu.style.top = rect.top - 60 + 'px';
  }
  setTimeout(() => document.addEventListener('click', removeContextMenu, { once: true }), 100);
}

function removeContextMenu() {
  if (contextMenu) { contextMenu.remove(); contextMenu = null; }
}

function react(chatId, messageId, emoji) {
  socket.emit('react', { chatId, messageId, emoji });
}

function scrollToMsg(id) {
  const el = document.querySelector(`[data-msg-id="${id}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ============ Send message ============
function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function sendMessage() {
  if (!currentChat || !socket) return;
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text && !replyTo) return;
  socket.emit('send_message', {
    chatId: currentChat.id,
    chatType: currentChat.type,
    text,
    replyTo: replyTo ? { id: replyTo.id, text: replyTo.text, sender: replyTo.sender } : null
  });
  input.value = '';
  autoResize(input);
  cancelReply();
}

function sendTyping() {
  if (!currentChat) return;
  clearTimeout(typingTimers[currentChat.id]);
  socket.emit('typing', { chatId: currentChat.id, chatType: currentChat.type });
  typingTimers[currentChat.id] = setTimeout(() => {}, 2000);
}

function onTyping({ chatId, username, displayName }) {
  if (!currentChat || currentChat.id !== chatId) return;
  const area = document.getElementById('messages-area');
  let indicator = document.getElementById('typing-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'typing-indicator';
    indicator.className = 'typing-indicator';
    area.appendChild(indicator);
  }
  indicator.textContent = `${displayName} печатает...`;
  clearTimeout(typingDisplayTimers[chatId]);
  typingDisplayTimers[chatId] = setTimeout(() => indicator && indicator.remove(), 2500);
  area.scrollTop = area.scrollHeight;
}

function setReplyTo(msg) {
  replyTo = msg;
  document.getElementById('reply-preview').classList.remove('hidden');
  document.getElementById('reply-preview-name').textContent = msg.sender.displayName;
  document.getElementById('reply-preview-text').textContent = msg.text || '[медиа]';
  document.getElementById('msg-input').focus();
}

function cancelReply() {
  replyTo = null;
  document.getElementById('reply-preview').classList.add('hidden');
}

// ============ File upload ============
async function handleFileSelect(input) {
  const file = input.files[0];
  if (!file || !currentChat) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    socket.emit('send_message', {
      chatId: currentChat.id,
      chatType: currentChat.type,
      text: '',
      file: { url: data.url, name: data.name, size: data.size, mime: data.mime }
    });
  } catch (e) { alert('Ошибка загрузки файла'); }
  input.value = '';
}

// ============ Voice recording ============
async function startRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = e => recordedChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      stream.getTracks().forEach(t => t.stop());
      await uploadBlob(blob, 'voice.webm', 'audio/webm', true, false);
    };
    mediaRecorder.start();
    document.getElementById('voice-btn').style.color = '#ef4444';
  } catch (e) { alert('Нет доступа к микрофону'); }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    document.getElementById('voice-btn').style.color = '';
  }
}

// ============ Video circle ============
async function startVideoMessage() {
  if (!currentChat) return;
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    document.getElementById('video-preview').srcObject = videoStream;
    openModal('video-modal');
    videoChunks = [];
    videoSeconds = 0;
    document.getElementById('video-timer').textContent = '0:00';
    videoRecorder = new MediaRecorder(videoStream);
    videoRecorder.ondataavailable = e => videoChunks.push(e.data);
    videoRecorder.onstop = async () => {
      const blob = new Blob(videoChunks, { type: 'video/webm' });
      videoStream.getTracks().forEach(t => t.stop());
      clearInterval(videoTimer);
      await uploadBlob(blob, 'circle.webm', 'video/webm', false, true);
    };
    videoRecorder.start();
    videoTimer = setInterval(() => {
      videoSeconds++;
      const m = Math.floor(videoSeconds / 60);
      const s = videoSeconds % 60;
      document.getElementById('video-timer').textContent = `${m}:${s.toString().padStart(2,'0')}`;
      if (videoSeconds >= 60) stopVideo();
    }, 1000);
  } catch (e) { alert('Нет доступа к камере'); }
}

function stopVideo() {
  if (videoRecorder && videoRecorder.state === 'recording') {
    videoRecorder.stop();
    closeModal();
  }
}

function cancelVideo() {
  if (videoRecorder && videoRecorder.state === 'recording') videoRecorder.stop();
  if (videoStream) videoStream.getTracks().forEach(t => t.stop());
  clearInterval(videoTimer);
  closeModal();
}

async function uploadBlob(blob, filename, mime, isVoice, isCircle) {
  const formData = new FormData();
  formData.append('file', blob, filename);
  try {
    const res = await fetch('/upload', { method: 'POST', body: formData });
    const data = await res.json();
    socket.emit('send_message', {
      chatId: currentChat.id,
      chatType: currentChat.type,
      text: '',
      file: { url: data.url, name: filename, size: data.size, mime, isVoice, isCircle }
    });
  } catch (e) { alert('Ошибка отправки медиа'); }
}

// ============ Channels ============
function onChannelsUpdated(channels) {
  allChannels = channels;
  // Add joined ones to chat list
  channels.forEach(ch => {
    if (!chats.has(ch.id)) return;
    const c = chats.get(ch.id);
    c.name = ch.name;
  });
  renderChannelsList();
  renderChatList();
}

function renderChannelsList() {
  const list = document.getElementById('channels-list');
  list.innerHTML = '';
  allChannels.forEach(ch => {
    const joined = chats.has(ch.id);
    const card = document.createElement('div');
    card.className = 'channel-card';
    card.innerHTML = `
      <div class="channel-icon">#</div>
      <div class="channel-info">
        <div class="name">${escHtml(ch.name)}</div>
        ${ch.description ? `<div class="desc">${escHtml(ch.description)}</div>` : ''}
        <div class="members">${ch.memberCount} участников</div>
      </div>
      ${joined
        ? `<span class="joined-badge">✓ Вступил</span>`
        : `<button class="join-btn" onclick="joinChannel('${ch.id}')">Вступить</button>`}
    `;
    if (joined) card.onclick = () => { openChat(ch.id, 'channel', ch.name); showChatWindow(); };
    list.appendChild(card);
  });
}

function joinChannel(id) {
  socket.emit('join_channel', { channelId: id });
}

function onChannelCreated(ch) {
  chats.set(ch.id, { id: ch.id, type: 'channel', name: ch.name, unread: 0 });
  renderChatList();
  closeModal();
  openChat(ch.id, 'channel', ch.name);
}

function onJoinedChannel(ch) {
  if (!chats.has(ch.id)) chats.set(ch.id, { id: ch.id, type: 'channel', name: ch.name, unread: 0 });
  renderChatList();
  renderChannelsList();
  openChat(ch.id, 'channel', ch.name);
}

// ============ People / DMs ============
function onUsersUpdated(users) {
  onlineUsers = users;
  renderPeopleList();
  // Update DM chat statuses
  for (const [id, chat] of chats) {
    if (chat.type === 'dm') {
      const u = users.find(u => u.username === chat.targetUsername);
      chat.onlineTarget = !!u;
      if (u) { chat.avatar = u.avatar; chat.name = u.displayName; }
    }
  }
  renderChatList();
}

function renderPeopleList() {
  const list = document.getElementById('people-list');
  list.innerHTML = '';
  onlineUsers.filter(u => u.username !== currentUser?.username).forEach(u => {
    const card = document.createElement('div');
    card.className = 'person-card';
    card.innerHTML = `
      <div class="avatar-wrap">
        <div class="avatar-circle" style="background:${getAvatarColor(u.username)}">${getAvatarInner(u.avatar, u.displayName)}</div>
        <div class="online-dot"></div>
      </div>
      <div>
        <div style="font-weight:700">${escHtml(u.displayName)}</div>
        <div style="font-size:12px;color:var(--text2)">@${escHtml(u.username)}</div>
      </div>
      <button class="join-btn" onclick="startDm('${u.username}')">Написать</button>
    `;
    card.querySelector('.avatar-circle').onclick = () => openProfile(u.username);
    list.appendChild(card);
  });
}

function startDm(username) {
  socket.emit('start_dm', { targetUsername: username });
}

function onDmReady({ chatId, targetUsername }) {
  const u = onlineUsers.find(u => u.username === targetUsername);
  if (!chats.has(chatId)) {
    chats.set(chatId, {
      id: chatId, type: 'dm', name: u ? u.displayName : targetUsername,
      targetUsername, avatar: u?.avatar, unread: 0, onlineTarget: !!u
    });
  }
  renderChatList();
  openChat(chatId, 'dm', u ? u.displayName : targetUsername, targetUsername);
}

// ============ Profile modal ============
function openProfile(username) {
  const u = onlineUsers.find(u => u.username === username) || { username, displayName: username };
  profileInModal = u;
  const modal = document.getElementById('profile-modal');
  const avatarEl = document.getElementById('profile-modal-avatar');
  avatarEl.style.background = getAvatarColor(u.username);
  avatarEl.innerHTML = getAvatarInner(u.avatar, u.displayName);
  document.getElementById('profile-modal-name').textContent = u.displayName;
  document.getElementById('profile-modal-username').textContent = `@${u.username}`;
  document.getElementById('profile-modal-bio').textContent = u.bio || '';
  document.getElementById('profile-modal-status').textContent = u.online ? '🟢 онлайн' : 'не в сети';
  const btn = document.getElementById('profile-modal-btn');
  if (u.username === currentUser.username) { btn.style.display = 'none'; }
  else { btn.style.display = ''; }
  openModal('profile-modal');
}

function startDmFromProfile() {
  if (profileInModal) { startDm(profileInModal.username); closeModal(); }
}

function openChatInfo() {
  if (!currentChat) return;
  if (currentChat.type === 'dm') openProfile(currentChat.targetUsername);
}

// ============ Edit profile ============
function openEditProfile() {
  document.getElementById('edit-displayname').value = currentUser.displayName || '';
  document.getElementById('edit-bio').value = currentUser.bio || '';
  const el = document.getElementById('edit-avatar-preview');
  el.style.background = getAvatarColor(currentUser.username);
  el.innerHTML = getAvatarInner(currentUser.avatar, currentUser.displayName);
  editAvatarBase64 = currentUser.avatar;
  openModal('edit-profile-modal');
}

function previewEditAvatar(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    editAvatarBase64 = e.target.result;
    const el = document.getElementById('edit-avatar-preview');
    el.innerHTML = `<img src="${editAvatarBase64}">`;
  };
  reader.readAsDataURL(file);
}

function saveProfile() {
  socket.emit('update_profile', {
    displayName: document.getElementById('edit-displayname').value.trim(),
    bio: document.getElementById('edit-bio').value.trim(),
    avatar: editAvatarBase64
  });
  closeModal();
}

// ============ Modals ============
function openModal(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.getElementById(id).classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

// ============ Create channel ============
function showCreateChannel() {
  openModal('create-channel-modal');
}
function createChannel() {
  const name = document.getElementById('channel-name-input').value.trim();
  if (!name) return;
  const desc = document.getElementById('channel-desc-input').value.trim();
  socket.emit('create_channel', { name, description: desc });
  document.getElementById('channel-name-input').value = '';
  document.getElementById('channel-desc-input').value = '';
}

// ============ Theme ============
const THEMES = [
  { id: 'theme-default', name: 'Синяя', bg: '#2b5cef', bg2: '#ffffff' },
  { id: 'theme-dark', name: 'Тёмная', bg: '#17212b', bg2: '#0e1621' },
  { id: 'theme-green', name: 'Зелёная', bg: '#1a7f5a', bg2: '#f7fdf9' },
  { id: 'theme-rose', name: 'Розовая', bg: '#d4547a', bg2: '#fffafc' },
  { id: 'theme-purple', name: 'Фиолет', bg: '#7c4dff', bg2: '#fdfaff' },
];

function openThemePicker() {
  const grid = document.getElementById('theme-grid');
  grid.innerHTML = '';
  THEMES.forEach(t => {
    const sw = document.createElement('div');
    sw.className = 'theme-swatch' + (document.body.classList.contains(t.id) ? ' active' : '');
    sw.style.background = `linear-gradient(135deg, ${t.bg} 50%, ${t.bg2} 50%)`;
    sw.innerHTML = `<span class="theme-swatch-label">${t.name}</span>`;
    sw.onclick = () => applyTheme(t.id);
    grid.appendChild(sw);
  });
  openModal('theme-modal');
}

function applyTheme(themeId) {
  document.body.className = themeId;
  localStorage.setItem('tgchat_theme', themeId);
  document.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
  event?.target?.classList.add('active');
}

function applyCustomTheme() {
  const accent = document.getElementById('custom-accent').value;
  const bg = document.getElementById('custom-bg').value;
  const text = document.getElementById('custom-text').value;
  document.body.style.setProperty('--accent', accent);
  document.body.style.setProperty('--bg', bg);
  document.body.style.setProperty('--text', text);
  document.body.style.setProperty('--msg-out', accent);
  document.body.style.setProperty('--sidebar-bg', bg);
}

function loadTheme() {
  const saved = localStorage.getItem('tgchat_theme');
  if (saved) document.body.className = saved;
}

// ============ Menu ============
function toggleMenu() {
  const menu = document.getElementById('slide-menu');
  const overlay = document.getElementById('slide-overlay');
  menu.classList.toggle('hidden');
  overlay.classList.toggle('hidden');
}
function closeMenu() {
  document.getElementById('slide-menu').classList.add('hidden');
  document.getElementById('slide-overlay').classList.add('hidden');
}
function toggleSearch() {
  document.getElementById('search-bar').classList.toggle('hidden');
}
function filterChats(q) {
  renderChatList(q);
}
function showNewChatMenu() {
  document.getElementById('new-chat-menu').classList.toggle('hidden');
}
function closeNewChatMenu() {
  document.getElementById('new-chat-menu').classList.add('hidden');
}

function updateMenuProfile() {
  if (!currentUser) return;
  document.getElementById('menu-display-name').textContent = currentUser.displayName;
  document.getElementById('menu-username-label').textContent = '@' + currentUser.username;
  const el = document.getElementById('menu-avatar-circle');
  el.style.background = getAvatarColor(currentUser.username);
  el.innerHTML = getAvatarInner(currentUser.avatar, currentUser.displayName);
}

// ============ Full image viewer ============
function openFullImage(url) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
  overlay.innerHTML = `<img src="${url}" style="max-width:95vw;max-height:95vh;border-radius:8px;object-fit:contain;">`;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
}

// ============ Helpers ============
function autoResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
}

function formatDateLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === yest.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

const AVATAR_COLORS = ['#2b5cef','#8b44f7','#d4547a','#1a7f5a','#e07b3a','#c0392b','#16a085','#8e44ad'];
function getAvatarColor(str) {
  if (!str) return AVATAR_COLORS[0];
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

function getAvatarInner(avatar, name) {
  if (avatar) return `<img src="${avatar}" alt="">`;
  return `<span>${(name || '?').charAt(0).toUpperCase()}</span>`;
}

function getAvatarHtml(avatar, name, cls) {
  const color = getAvatarColor(name);
  return `<div class="${cls}" style="background:${color}">${getAvatarInner(avatar, name)}</div>`;
}
