const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 50e6
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Storage
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// In-memory state
const users = new Map();       // socketId -> user object
const usersByName = new Map(); // username -> user object
const messages = new Map();    // chatId -> [messages]
const channels = new Map();    // channelId -> channel info
const channelMembers = new Map(); // channelId -> Set of usernames

// Helpers
function getOrCreate(map, key, def) {
  if (!map.has(key)) map.set(key, def);
  return map.get(key);
}
function dmChatId(a, b) {
  return [a, b].sort().join('__dm__');
}
function getPublicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar, bio: u.bio, online: u.online };
}

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname, size: req.file.size, mime: req.file.mimetype });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('auth', ({ username, displayName, avatar, bio }) => {
    if (!username) return socket.emit('error', 'Username required');
    // Check if username taken by another active socket
    const existing = usersByName.get(username);
    if (existing && existing.id !== socket.id && existing.online) {
      return socket.emit('auth_error', 'Username already taken');
    }
    const user = {
      id: socket.id,
      username,
      displayName: displayName || username,
      avatar: avatar || null,
      bio: bio || '',
      online: true
    };
    users.set(socket.id, user);
    usersByName.set(username, user);
    socket.username = username;

    // Join general channel
    const generalId = 'general';
    if (!channels.has(generalId)) {
      channels.set(generalId, { id: generalId, name: 'General', type: 'public', createdBy: username });
    }
    getOrCreate(channelMembers, generalId, new Set()).add(username);
    socket.join(generalId);

    socket.emit('auth_ok', {
      user: getPublicUser(user),
      channels: getMyChannels(username),
      users: getOnlineUsers()
    });
    io.emit('users_updated', getOnlineUsers());
    io.emit('channels_updated', getPublicChannels());
    console.log('authed:', username);
  });

  socket.on('send_message', (data) => {
    const sender = users.get(socket.id);
    if (!sender) return;
    const { chatId, chatType, text, file, replyTo } = data;
    const msg = {
      id: uuidv4(),
      chatId,
      chatType,
      sender: getPublicUser(sender),
      text: text || '',
      file: file || null,
      replyTo: replyTo || null,
      timestamp: Date.now(),
      reactions: {}
    };
    getOrCreate(messages, chatId, []).push(msg);
    if (chatType === 'channel') {
      io.to(chatId).emit('new_message', msg);
    } else {
      // DM
      const [a, b] = chatId.split('__dm__');
      const targetUser = usersByName.get(a === sender.username ? b : a);
      socket.emit('new_message', msg);
      if (targetUser) {
        const targetSocket = io.sockets.sockets.get(targetUser.id);
        if (targetSocket) targetSocket.emit('new_message', msg);
      }
    }
  });

  socket.on('get_history', ({ chatId }) => {
    socket.emit('history', { chatId, messages: messages.get(chatId) || [] });
  });

  socket.on('typing', ({ chatId, chatType }) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (chatType === 'channel') {
      socket.to(chatId).emit('typing', { chatId, username: user.username, displayName: user.displayName });
    } else {
      const [a, b] = chatId.split('__dm__');
      const targetName = a === user.username ? b : a;
      const target = usersByName.get(targetName);
      if (target) {
        const ts = io.sockets.sockets.get(target.id);
        if (ts) ts.emit('typing', { chatId, username: user.username, displayName: user.displayName });
      }
    }
  });

  socket.on('react', ({ chatId, messageId, emoji }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const msgs = messages.get(chatId) || [];
    const msg = msgs.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(user.username);
    if (idx === -1) msg.reactions[emoji].push(user.username);
    else msg.reactions[emoji].splice(idx, 1);
    io.to(chatId).emit('message_updated', msg);
    // Also send to DM participants
    if (!chatId.includes('__dm__')) return;
    const [a, b] = chatId.split('__dm__');
    [a, b].forEach(name => {
      const u = usersByName.get(name);
      if (u) {
        const s = io.sockets.sockets.get(u.id);
        if (s) s.emit('message_updated', msg);
      }
    });
  });

  socket.on('create_channel', ({ name, description }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const id = uuidv4();
    const ch = { id, name, description: description || '', type: 'public', createdBy: user.username, createdAt: Date.now() };
    channels.set(id, ch);
    getOrCreate(channelMembers, id, new Set()).add(user.username);
    socket.join(id);
    socket.emit('channel_created', ch);
    io.emit('channels_updated', getPublicChannels());
  });

  socket.on('join_channel', ({ channelId }) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (!channels.has(channelId)) return socket.emit('error', 'Channel not found');
    getOrCreate(channelMembers, channelId, new Set()).add(user.username);
    socket.join(channelId);
    socket.emit('joined_channel', channels.get(channelId));
  });

  socket.on('start_dm', ({ targetUsername }) => {
    const user = users.get(socket.id);
    if (!user) return;
    const chatId = dmChatId(user.username, targetUsername);
    socket.emit('dm_ready', { chatId, targetUsername });
  });

  socket.on('update_profile', ({ displayName, bio, avatar }) => {
    const user = users.get(socket.id);
    if (!user) return;
    if (displayName) user.displayName = displayName;
    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar;
    usersByName.set(user.username, user);
    socket.emit('profile_updated', getPublicUser(user));
    io.emit('users_updated', getOnlineUsers());
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      user.online = false;
      users.delete(socket.id);
      io.emit('users_updated', getOnlineUsers());
    }
  });

  function getMyChannels(username) {
    const result = [];
    for (const [id, ch] of channels) {
      const members = channelMembers.get(id);
      if (members && members.has(username)) result.push({ ...ch, memberCount: members.size });
    }
    return result;
  }

  function getPublicChannels() {
    return Array.from(channels.values()).map(ch => ({
      ...ch,
      memberCount: (channelMembers.get(ch.id) || new Set()).size
    }));
  }

  function getOnlineUsers() {
    return Array.from(usersByName.values()).filter(u => u.online).map(getPublicUser);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
