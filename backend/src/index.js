// Express serves authenticated REST APIs; Socket.IO adds live events on the same HTTP server.
import "dotenv/config";
import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import multer from "multer";
import { createClient } from "redis";
import { createServer } from "http";
import { randomUUID } from "crypto";
import { mkdir, unlink } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

import { initializeDatabase, pool } from "./database.js";

const requiredEnvironment = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET"];
// Fail fast rather than letting the server start in a partially configured state.
const missingEnvironment = requiredEnvironment.filter(
  (key) => !process.env[key],
);
if (missingEnvironment.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvironment.join(", ")}`,
  );
}
if (process.env.JWT_SECRET.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long");
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDirectory = path.resolve(__dirname, "../uploads");
await mkdir(uploadDirectory, { recursive: true });

const app = express();
const httpServer = createServer(app);
// Socket.IO's Redis adapter needs separate publish and subscribe Redis connections.
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
pubClient.on("error", (error) =>
  console.error("Redis publisher error:", error.message),
);
subClient.on("error", (error) =>
  console.error("Redis subscriber error:", error.message),
);
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

// Socket.IO carries transient events; the Redis adapter forwards them across backend instances.
// Durable notification records are stored in PostgreSQL so disconnected users can catch up.
const JWT_SECRET = process.env.JWT_SECRET;
const PRESENCE_TTL_SECONDS = 90;
const allowedMediaTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "audio/webm",
  "application/pdf",
]);

// Multer writes uploads under generated names; original names are stored only as display metadata.
const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, uploadDirectory),
  filename: (_req, file, callback) => {
    const extension = path
      .extname(file.originalname)
      .toLowerCase()
      .slice(0, 12);
    callback(null, `${randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!allowedMediaTypes.has(file.mimetype)) {
      callback(new Error("Unsupported media type"));
      return;
    }
    callback(null, true);
  },
});

app.use(cors({ origin: process.env.CLIENT_ORIGIN || "http://localhost:5173" }));
app.use(express.json({ limit: "1mb" }));

// JWTs contain the user's id and are required by both HTTP routes and Socket.IO handshakes.
const createToken = (user) =>
  jwt.sign({ sub: user.id, name: user.name, email: user.email }, JWT_SECRET, {
    expiresIn: "7d",
  });

// Express 4 does not forward rejected async handlers automatically; this wrapper passes errors to middleware.
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

// Redis sorted sets track every live socket per user and expire when heartbeats stop.
const presenceKeyFor = (userId) => `presence:${userId}`;

const getPresenceCount = async (userId) => {
  const key = presenceKeyFor(userId);
  const expiryCutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;
  await pubClient.zRemRangeByScore(key, "-inf", expiryCutoff);
  return pubClient.zCard(key);
};

const refreshPresence = async (userId, socketId) => {
  const key = presenceKeyFor(userId);
  await pubClient.zAdd(key, { score: Date.now(), value: socketId });
  await pubClient.expire(key, PRESENCE_TTL_SECONDS);
};

const authenticate = asyncRoute(async (req, res, next) => {
  const authorizationHeader = req.headers.authorization ?? "";
  const token = authorizationHeader.startsWith("Bearer ")
    ? authorizationHeader.slice(7)
    : null;

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.TokenExpiredError
    ) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    throw error;
  }

  const result = await pool.query(
    "SELECT id, name, email FROM users WHERE id = $1",
    [payload.sub],
  );
  if (result.rowCount === 0) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  req.user = result.rows[0];
  next();
});

// Reuse this membership query for HTTP access checks and Socket.IO room authorization.
const requireChatMember = async (chatId, userId, client = pool) => {
  const result = await client.query(
    `SELECT c.id, c.last_message
       FROM chats c
       JOIN chat_participants cp ON cp.chat_id = c.id
      WHERE c.id = $1 AND cp.user_id = $2`,
    [chatId, userId],
  );
  return result.rows[0] ?? null;
};

const serializeMessage = (row) => ({
  id: row.id,
  chatId: row.chat_id,
  sender: row.sender_name,
  senderId: row.sender_id,
  text: row.text,
  time: new Date(row.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  }),
  createdAt: new Date(row.created_at).toISOString(),
  attachment: row.attachment_id
    ? {
        id: row.attachment_id,
        name: row.attachment_name,
        mimeType: row.attachment_mime_type,
      }
    : null,
});

// Keep the database's snake_case column names behind a shared query and serialize to the UI shape.
const messageSelect = `SELECT m.id, m.chat_id, m.sender_id, u.name AS sender_name,
                              m.text, m.created_at, m.attachment_id,
                              m.attachment_name, m.attachment_mime_type
                         FROM messages m
                         JOIN users u ON u.id = m.sender_id`;

const getPublicUsers = async (currentUserId) => {
  const result = await pool.query(
    "SELECT id, name, email FROM users WHERE id <> $1 ORDER BY name",
    [currentUserId],
  );

  return Promise.all(
    result.rows.map(async (user) => ({
      ...user,
      online: (await getPresenceCount(user.id)) > 0,
    })),
  );
};

// This app currently models direct chats, so each chat row resolves to the other participant.
const getUserChats = async (userId) => {
  const result = await pool.query(
    `SELECT c.id, c.last_message, other_user.id AS other_user_id,
            other_user.name AS other_user_name
       FROM chats c
       JOIN chat_participants current_member ON current_member.chat_id = c.id
       JOIN chat_participants other_member
         ON other_member.chat_id = c.id AND other_member.user_id <> current_member.user_id
       JOIN users other_user ON other_user.id = other_member.user_id
      WHERE current_member.user_id = $1
       ORDER BY c.updated_at DESC, c.id`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.other_user_name,
    lastMessage: row.last_message || "Start a conversation",
    unread: 0,
    participants: [userId, row.other_user_id],
  }));
};

const emitChatUpdates = async (chatId, lastMessage) => {
  const result = await pool.query(
    "SELECT user_id FROM chat_participants WHERE chat_id = $1",
    [chatId],
  );
  for (const participant of result.rows) {
    io.to(`user:${participant.user_id}`).emit("chat:update", {
      chatId,
      lastMessage,
    });
  }
};

// Health endpoint is used to verify database and Redis availability.
app.get(
  "/api/health",
  asyncRoute(async (_req, res) => {
    const database = await pool.query("SELECT 1");
    res.json({
      status: "ok",
      service: "thatsapp-backend",
      postgresql: database.rowCount === 1 ? "connected" : "disconnected",
      redis: pubClient.isReady ? "connected" : "disconnected",
    });
  }),
);

app.get("/api/auth/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

// Registration normalizes identifiers, hashes passwords, and returns a signed session token.
app.post(
  "/api/auth/register",
  asyncRoute(async (req, res) => {
    const { name, email, password } = req.body ?? {};
    const trimmedName = String(name ?? "").trim();
    const normalizedEmail = String(email ?? "")
      .trim()
      .toLowerCase();
    const safePassword = String(password ?? "");

    if (
      trimmedName.length < 2 ||
      trimmedName.length > 60 ||
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
      safePassword.length < 8 ||
      safePassword.length > 128
    ) {
      res.status(400).json({
        error:
          "Enter a valid name and email; password must be 8 to 128 characters",
      });
      return;
    }

    const passwordHash = await bcrypt.hash(safePassword, 12);
    try {
      const result = await pool.query(
        `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email`,
        [randomUUID(), trimmedName, normalizedEmail, passwordHash],
      );
      const user = result.rows[0];
      res.status(201).json({ token: createToken(user), user });
    } catch (error) {
      if (error.code === "23505") {
        res
          .status(409)
          .json({ error: "An account with that email already exists" });
        return;
      }
      throw error;
    }
  }),
);

// Login only returns a token after the stored bcrypt hash matches the supplied password.
app.post(
  "/api/auth/login",
  asyncRoute(async (req, res) => {
    const normalizedEmail = String(req.body?.email ?? "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password ?? "");
    const result = await pool.query(
      "SELECT id, name, email, password_hash FROM users WHERE email = $1",
      [normalizedEmail],
    );
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const publicUser = { id: user.id, name: user.name, email: user.email };
    res.json({ token: createToken(publicUser), user: publicUser });
  }),
);

// Load the signed-in user's chat list and contact list for the sidebar.
app.get(
  "/api/chats",
  authenticate,
  asyncRoute(async (req, res) => {
    res.json({
      chats: await getUserChats(req.user.id),
      users: await getPublicUsers(req.user.id),
    });
  }),
);

app.get(
  "/api/users",
  authenticate,
  asyncRoute(async (req, res) => {
    res.json(await getPublicUsers(req.user.id));
  }),
);

// Notifications are persisted; the capped list is for display, while unreadCount covers all rows.
app.get(
  "/api/notifications",
  authenticate,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT id, chat_id, message_id, actor_id, actor_name, preview, created_at, read_at, kind
       FROM notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
      [req.user.id],
    );
    const unreadResult = await pool.query(
      "SELECT count(*)::int AS unread_count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
      [req.user.id],
    );
    res.json({
      notifications: result.rows.map((row) => ({
        id: row.id,
        chatId: row.chat_id,
        messageId: row.message_id,
        actorId: row.actor_id,
        actorName: row.actor_name,
        preview: row.preview,
        createdAt: row.created_at,
        readAt: row.read_at,
        kind: row.kind,
      })),
      unreadCount: unreadResult.rows[0].unread_count,
    });
  }),
);

// Read state is account-wide, so broadcast updates to this user's connected devices.
app.patch(
  "/api/notifications/read-all",
  authenticate,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `UPDATE notifications
        SET read_at = now()
      WHERE user_id = $1 AND read_at IS NULL
      RETURNING id`,
      [req.user.id],
    );
    io.to(`user:${req.user.id}`).emit("notification:read-all");
    res.json({ updated: result.rowCount });
  }),
);

// Include the user id in the update condition so one account cannot mark another's notification.
app.patch(
  "/api/notifications/:notificationId/read",
  authenticate,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `UPDATE notifications
        SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND user_id = $2
      RETURNING id`,
      [req.params.notificationId, req.user.id],
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    io.to(`user:${req.user.id}`).emit("notification:read", {
      notificationId: req.params.notificationId,
    });
    res.json({ id: req.params.notificationId, read: true });
  }),
);

// The sorted participant ids make the direct-chat key identical regardless of who starts the chat.
app.post(
  "/api/chats",
  authenticate,
  asyncRoute(async (req, res) => {
    const contactId = String(req.body?.userId ?? "");
    if (!contactId || contactId === req.user.id) {
      res.status(400).json({ error: "A valid contact userId is required" });
      return;
    }

    const contactResult = await pool.query(
      "SELECT id, name FROM users WHERE id = $1",
      [contactId],
    );
    const contact = contactResult.rows[0];
    if (!contact) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const directKey = [req.user.id, contact.id].sort().join(":");
    const chatId = randomUUID();
    const client = await pool.connect();
    let created = false;

    try {
      await client.query("BEGIN");
      const insertResult = await client.query(
        `INSERT INTO chats (id, direct_key)
       VALUES ($1, $2)
       ON CONFLICT (direct_key) DO NOTHING
       RETURNING id`,
        [chatId, directKey],
      );
      const actualChatId = insertResult.rows[0]?.id;
      created = Boolean(actualChatId);

      const selectedChat = actualChatId
        ? { id: actualChatId }
        : (
            await client.query("SELECT id FROM chats WHERE direct_key = $1", [
              directKey,
            ])
          ).rows[0];

      if (!selectedChat)
        throw new Error("Could not create or retrieve direct chat");

      await client.query(
        `INSERT INTO chat_participants (chat_id, user_id)
       VALUES ($1, $2), ($1, $3)
       ON CONFLICT DO NOTHING`,
        [selectedChat.id, req.user.id, contact.id],
      );
      // Only a brand-new chat alerts the contact; reopening an existing chat must not re-notify.
      let chatNotification = null;
      if (created) {
        const notificationResult = await client.query(
          `INSERT INTO notifications
           (id, user_id, chat_id, message_id, actor_id, actor_name, preview, kind)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, 'chat')
         RETURNING id, user_id, chat_id, message_id, actor_id, actor_name,
                   preview, created_at, read_at, kind`,
          [
            randomUUID(),
            contact.id,
            selectedChat.id,
            req.user.id,
            req.user.name,
            "started a new chat with you",
          ],
        );
        chatNotification = notificationResult.rows[0];
      }
      await client.query("COMMIT");

      if (chatNotification) {
        io.to(`user:${chatNotification.user_id}`).emit("notification:new", {
          id: chatNotification.id,
          chatId: chatNotification.chat_id,
          messageId: chatNotification.message_id,
          actorId: chatNotification.actor_id,
          actorName: chatNotification.actor_name,
          preview: chatNotification.preview,
          createdAt: chatNotification.created_at,
          readAt: chatNotification.read_at,
          kind: chatNotification.kind,
        });
        await emitChatUpdates(selectedChat.id, "Start a conversation");
      }

      res.status(created ? 201 : 200).json({
        chat: {
          id: selectedChat.id,
          name: contact.name,
          lastMessage: "Start a conversation",
          unread: 0,
          participants: [req.user.id, contact.id],
        },
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

// Message history is only returned after confirming the requester belongs to the chat.
app.get(
  "/api/messages/:chatId",
  authenticate,
  asyncRoute(async (req, res) => {
    const chat = await requireChatMember(req.params.chatId, req.user.id);
    if (!chat) {
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    const result = await pool.query(
      `${messageSelect} WHERE m.chat_id = $1 ORDER BY m.created_at, m.id`,
      [chat.id],
    );
    res.json(result.rows.map(serializeMessage));
  }),
);

// Upload first, then persist metadata; remove the disk file if authorization or database insertion fails.
app.post(
  "/api/media",
  authenticate,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "A media file is required" });
      return;
    }

    const chatId = String(req.body?.chatId ?? "");
    const chat = await requireChatMember(chatId, req.user.id);
    if (!chat) {
      await unlink(req.file.path);
      res.status(404).json({ error: "Chat not found" });
      return;
    }

    try {
      const result = await pool.query(
        `INSERT INTO media_assets
         (id, chat_id, owner_id, file_path, original_name, mime_type, size_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, original_name, mime_type, size_bytes`,
        [
          randomUUID(),
          chat.id,
          req.user.id,
          req.file.path,
          req.file.originalname.slice(0, 255),
          req.file.mimetype,
          req.file.size,
        ],
      );
      const asset = result.rows[0];
      res.status(201).json({
        id: asset.id,
        name: asset.original_name,
        mimeType: asset.mime_type,
        size: asset.size_bytes,
      });
    } catch (error) {
      await unlink(req.file.path);
      throw error;
    }
  }),
);

// Media is streamed only to authenticated participants of the chat that owns it.
app.get(
  "/api/media/:mediaId",
  authenticate,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT ma.file_path, ma.mime_type
       FROM media_assets ma
       JOIN chat_participants cp ON cp.chat_id = ma.chat_id
      WHERE ma.id = $1 AND cp.user_id = $2`,
      [req.params.mediaId, req.user.id],
    );
    const asset = result.rows[0];
    if (!asset) {
      res.status(404).json({ error: "Media not found" });
      return;
    }

    res.type(asset.mime_type);
    res.sendFile(asset.file_path);
  }),
);

// Save the message and its notification in one transaction so they cannot become inconsistent.
app.post(
  "/api/messages",
  authenticate,
  asyncRoute(async (req, res) => {
    const chatId = String(req.body?.chatId ?? "");
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    const mediaId = req.body?.mediaId ? String(req.body.mediaId) : null;
    if ((!text && !mediaId) || text.length > 5000) {
      res
        .status(400)
        .json({
          error: "Message text or media is required (text limit: 5000)",
        });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const chat = await requireChatMember(chatId, req.user.id, client);
      if (!chat) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Chat not found" });
        return;
      }

      let attachment = null;
      if (mediaId) {
        const assetResult = await client.query(
          `SELECT id, original_name, mime_type
           FROM media_assets
          WHERE id = $1 AND chat_id = $2 AND owner_id = $3`,
          [mediaId, chat.id, req.user.id],
        );
        attachment = assetResult.rows[0];
        if (!attachment) {
          await client.query("ROLLBACK");
          res.status(404).json({ error: "Media not found" });
          return;
        }
      }

      const lastMessage =
        text || `Shared ${attachment.mime_type.split("/")[0]}`;
      const insertResult = await client.query(
        `INSERT INTO messages
         (id, chat_id, sender_id, text, attachment_id, attachment_name, attachment_mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, chat_id, sender_id, text, created_at, attachment_id,
                 attachment_name, attachment_mime_type`,
        [
          randomUUID(),
          chat.id,
          req.user.id,
          text,
          attachment?.id ?? null,
          attachment?.original_name ?? null,
          attachment?.mime_type ?? null,
        ],
      );
      const notificationPreview =
        text || `Shared ${attachment.mime_type.split("/")[0]}`;
      const notificationResult = await client.query(
        `INSERT INTO notifications
         (id, user_id, chat_id, message_id, actor_id, actor_name, preview)
       SELECT $1, cp.user_id, $2, $3, $4, $5, $6
         FROM chat_participants cp
        WHERE cp.chat_id = $2 AND cp.user_id <> $4
       RETURNING id, user_id, chat_id, message_id, actor_id, actor_name,
                 preview, created_at, read_at`,
        [
          randomUUID(),
          chat.id,
          insertResult.rows[0].id,
          req.user.id,
          req.user.name,
          notificationPreview.slice(0, 500),
        ],
      );
      await client.query(
        "UPDATE chats SET last_message = $1, updated_at = now() WHERE id = $2",
        [lastMessage, chat.id],
      );
      await client.query("COMMIT");

      const message = {
        ...insertResult.rows[0],
        sender_name: req.user.name,
      };
      const serializedMessage = serializeMessage(message);
      io.to(chat.id).emit("message:new", serializedMessage);
      // Notify only recipients; the sender already sees their message locally.
      for (const notification of notificationResult.rows) {
        io.to(`user:${notification.user_id}`).emit("notification:new", {
          id: notification.id,
          chatId: notification.chat_id,
          messageId: notification.message_id,
          actorId: notification.actor_id,
          actorName: notification.actor_name,
          preview: notification.preview,
          createdAt: notification.created_at,
          readAt: notification.read_at,
        });
      }
      await emitChatUpdates(chat.id, lastMessage);
      res.status(201).json(serializedMessage);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }),
);

io.use(async (socket, next) => {
  try {
    // The browser sends its JWT in the handshake; reject unauthenticated sockets before room access.
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || !token) {
      next(new Error("Authentication required"));
      return;
    }
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query(
      "SELECT id, name FROM users WHERE id = $1",
      [payload.sub],
    );
    if (result.rowCount === 0) {
      next(new Error("Invalid or expired token"));
      return;
    }
    socket.data.user = result.rows[0];
    next();
  } catch (error) {
    if (
      error instanceof jwt.JsonWebTokenError ||
      error instanceof jwt.TokenExpiredError
    ) {
      next(new Error("Invalid or expired token"));
      return;
    }
    next(error);
  }
});

// Each authenticated socket joins an account room for notifications and a chat room on demand.
io.on("connection", (socket) => {
  const { id: userId, name } = socket.data.user;
  // Personal rooms deliver account-wide events (notifications/presence) to all of a user's devices.
  const presenceKey = presenceKeyFor(userId);
  socket.join(`user:${userId}`);

  const registerPresence = async () => {
    // Redis tracks each live socket independently so one device disconnecting does not mark others offline.
    const wasOnline = (await getPresenceCount(userId)) > 0;
    await refreshPresence(userId, socket.id);
    if (!wasOnline) io.emit("presence:update", { userId, online: true });
  };
  registerPresence().catch((error) => {
    console.error("Failed to register socket presence:", error);
    socket.disconnect(true);
  });

  socket.on("presence:heartbeat", () => {
    refreshPresence(userId, socket.id).catch((error) => {
      console.error("Failed to refresh presence TTL:", error);
    });
  });

  socket.on("join-chat", (chatId) => {
    // Membership is checked before joining a room to prevent reading another chat's live messages.
    requireChatMember(chatId, userId)
      .then((chat) => {
        if (chat) socket.join(chatId);
      })
      .catch((error) => console.error("Failed to authorize chat room:", error));
  });

  socket.on("leave-chat", (chatId) => {
    if (typeof chatId === "string") socket.leave(chatId);
  });

  socket.on("typing", (payload = {}) => {
    // Typing is ephemeral and sent only to other members of the authorized chat room.
    const { chatId, isTyping } = payload ?? {};
    if (typeof isTyping !== "boolean") return;
    requireChatMember(chatId, userId)
      .then((chat) => {
        if (!chat) return;
        socket
          .to(chatId)
          .emit("typing:update", { chatId, userId, name, isTyping });
      })
      .catch((error) =>
        console.error("Failed to authorize typing event:", error),
      );
  });

  socket.on("disconnect", () => {
    // Remove only this socket from Redis; keep the user online while any other socket remains.
    const clearPresence = async () => {
      await pubClient.zRem(presenceKey, socket.id);
      if ((await getPresenceCount(userId)) === 0) {
        await pubClient.del(presenceKey);
        io.emit("presence:update", { userId, online: false });
      }
    };
    clearPresence().catch((error) => {
      console.error("Failed to clear socket presence:", error);
    });
  });
});

app.use((error, _req, res, _next) => {
  // Convert expected upload validation errors to client responses; log unexpected failures.
  if (error instanceof multer.MulterError) {
    const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(status).json({
      error:
        error.code === "LIMIT_FILE_SIZE"
          ? "File exceeds the 15 MB limit"
          : error.message,
    });
    return;
  }
  if (error.message === "Unsupported media type") {
    res.status(415).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "An unexpected server error occurred" });
});

const start = async () => {
  // Apply idempotent DDL and connect Redis before accepting API or Socket.IO traffic.
  await initializeDatabase();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  const port = Number(process.env.PORT || 5005);
  httpServer.listen(port, () => {
    console.log(`WhatsApp server running on http://localhost:${port}`);
  });
};

start().catch((error) => {
  console.error("Failed to start the WhatsApp server:", error);
  process.exitCode = 1;
});
