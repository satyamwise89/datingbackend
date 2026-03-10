import bodyParser from "body-parser";
import cors from "cors";
import express from "express";
import admin from "firebase-admin";
import fs from "fs";
import { nanoid } from "nanoid";
import path from "path";

const {
  PORT = 3000,
  ALLOWED_ORIGINS = "",
  BACKEND_SHARED_SECRET = "",
} = process.env;
const APP_VERSION = process.env.RENDER_GIT_COMMIT || process.env.npm_package_version || "dev";
const allowedOrigins = ALLOWED_ORIGINS
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function parseServiceAccountFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch (_) {}

  try {
    return JSON.parse(raw);
  } catch (_) {}

  return null;
}

function parseServiceAccountFromParts() {
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } = process.env;

  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return null;
  }

  return {
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  };
}

function parseServiceAccountFromFile() {
  const localPath = path.join(process.cwd(), "firebase-service-account.json");
  if (!fs.existsSync(localPath)) return null;

  return JSON.parse(fs.readFileSync(localPath, "utf8"));
}

function initAdmin() {
  if (admin.apps.length) return admin.app();

  const serviceAccount =
    parseServiceAccountFromEnv() ??
    parseServiceAccountFromParts() ??
    parseServiceAccountFromFile();

  if (serviceAccount) {
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  console.warn(
    "Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID/FIREBASE_CLIENT_EMAIL/FIREBASE_PRIVATE_KEY."
  );
  return admin.initializeApp();
}

initAdmin();

const db = admin.firestore();
const messaging = admin.messaging();

const app = express();
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Origin not allowed by CORS"));
    },
  })
);
app.use(bodyParser.json({ limit: "10mb" }));
app.disable("x-powered-by");

const liveCalls = [];
const sseClients = new Set();
const rateLimitBuckets = new Map();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

app.use((req, res, next) => {
  const requestId = nanoid(10);
  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms ${requestId}`
    );
  });
  next();
});

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(data);
  }
}

function badRequest(res, error, requestId) {
  return res.status(400).json({ ok: false, error, requestId });
}

function internalError(res, error, requestId) {
  console.error(error);
  return res.status(500).json({
    ok: false,
    error: error.message || "internal",
    requestId,
  });
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => {
    const value = body[field];
    return value === undefined || value === null || value === "";
  });
  return missing;
}

function createRateLimit({ key, max, windowMs }) {
  return (req, res, next) => {
    const now = Date.now();
    const bucketKey = `${key}:${getClientIp(req)}`;
    const bucket = rateLimitBuckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      rateLimitBuckets.set(bucketKey, {
        count: 1,
        resetAt: now + windowMs,
      });
      return next();
    }

    if (bucket.count >= max) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((bucket.resetAt - now) / 1000)
      );
      res.setHeader("retry-after", retryAfterSeconds);
      return res.status(429).json({
        ok: false,
        error: "rate limit exceeded",
        requestId: req.requestId,
        retryAfterSeconds,
      });
    }

    bucket.count += 1;
    return next();
  };
}

function requireSharedSecret(req, res, next) {
  if (!BACKEND_SHARED_SECRET) {
    return next();
  }

  const headerValue = req.headers["x-backend-secret"];
  if (headerValue === BACKEND_SHARED_SECRET) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: "unauthorized",
    requestId: req.requestId,
  });
}

const notificationRateLimit = createRateLimit({
  key: "notify",
  max: 60,
  windowMs: 60 * 1000,
});

const callRateLimit = createRateLimit({
  key: "call",
  max: 20,
  windowMs: 60 * 1000,
});

async function pushActivity(userId, payload) {
  const ref = db.collection("activities").doc(userId).collection("items");
  await ref.add({
    ...payload,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    isRead: false,
  });
}

async function sendPushToUser(targetUserId, notification) {
  const userDoc = await db.collection("users").doc(targetUserId).get();
  const token = userDoc.exists ? userDoc.data().fcmToken : null;
  if (!token) return;
  await messaging.send({ token, ...notification });
}

async function messageAlreadyHandled(roomId, messageId) {
  if (!roomId || !messageId) return false;
  const doc = await db
    .collection("chats")
    .doc(roomId)
    .collection("messages")
    .doc(messageId)
    .get();
  return doc.exists;
}

async function likeAlreadyHandled(postId, actorId) {
  if (!postId || !actorId) return false;
  const doc = await db
    .collection("posts")
    .doc(postId)
    .collection("likes")
    .doc(actorId)
    .get();
  return doc.exists;
}

async function profileVisitAlreadyHandled(userId, visitorId) {
  if (!userId || !visitorId) return false;
  const doc = await db
    .collection("profileVisits")
    .doc(userId)
    .collection("visitors")
    .doc(visitorId)
    .get();
  return doc.exists;
}

app.get("/ping", (_req, res) => {
  res.json({
    ok: true,
    service: "auraconnect-backend",
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html>
<head>
  <title>AuraConnect Backend</title>
  <style>
    body { font-family: Arial, sans-serif; background:#0f0f0f; color:#fff; margin: 24px; }
    .card { border:1px solid #333; padding:12px; margin:10px 0; border-radius:8px; }
    .row { display:flex; justify-content:space-between; gap: 12px; }
    .badge { padding:2px 6px; border-radius:6px; background:#ff4081; color:#fff; font-size:12px; }
    code { color: #7ee7ff; }
  </style>
</head>
<body>
  <h2>AuraConnect Backend</h2>
  <p>Health: <code>/ping</code></p>
  <p>Live call feed: <code>/events</code></p>
  <div id="feed"></div>
<script>
  const feed = document.getElementById('feed');
  const evt = new EventSource('/events');
  evt.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = '<div class="row"><div><strong>' + ev.callerName +
      '</strong> -> <strong>' + ev.receiverId +
      '</strong></div><div class="badge">' + ev.status + '</div></div>' +
      '<div>callId: ' + ev.callId + '</div>' +
      '<div>channel: ' + ev.channelId + '</div>' +
      '<div>time: ' + new Date(ev.timestamp).toLocaleString() + '</div>';
    feed.prepend(div);
  };
</script>
</body>
</html>`);
});

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

app.post("/send-call", requireSharedSecret, callRateLimit, handleSendCall);
app.post("/send-call-notification", requireSharedSecret, callRateLimit, handleSendCall);

async function handleSendCall(req, res) {
  try {
    const {
      callId,
      callerId,
      callerName,
      callerPic = "",
      channelId,
      receiverFcmToken,
      receiverId = "<hidden>",
    } = req.body;

    const missing = requireFields(req.body, [
      "callId",
      "callerId",
      "callerName",
      "channelId",
      "receiverFcmToken",
    ]);
    if (missing.length > 0) {
      return badRequest(
        res,
        `missing fields: ${missing.join(", ")}`,
        req.requestId
      );
    }

    await messaging.send({
      token: receiverFcmToken,
      android: {
        priority: "high",
        notification: {
          title: callerName || "Incoming call",
          body: "Tap to answer",
          channelId: "calls_channel_v4",
          sound: "call_ringtone",
          priority: "max",
          visibility: "public",
        },
      },
      notification: {
        title: callerName || "Incoming call",
        body: "Tap to answer",
      },
      data: {
        type: "call",
        callId,
        callerId,
        callerName,
        callerPic,
        channelId,
      },
    });

    const event = {
      id: nanoid(),
      callId,
      callerId,
      callerName,
      callerPic,
      channelId,
      receiverId,
      status: "sent",
      timestamp: Date.now(),
    };
    liveCalls.unshift(event);
    broadcast(event);

    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    return internalError(res, error, req.requestId);
  }
}

app.post("/send-chat", requireSharedSecret, notificationRateLimit, async (req, res) => {
  try {
    const { receiverFcmToken, title, body, chatId, senderId, senderName } = req.body;
    const missing = requireFields(req.body, ["receiverFcmToken"]);
    if (missing.length > 0) {
      return badRequest(res, "receiverFcmToken required", req.requestId);
    }

    await messaging.send({
      token: receiverFcmToken,
      android: { priority: "high" },
      notification: {
        title: title || senderName || "New message",
        body: body || "",
      },
      data: {
        type: "chat",
        chatId: chatId || "",
        senderId: senderId || "",
        senderName: senderName || title || "",
        body: body || "",
      },
    });

    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    return internalError(res, error, req.requestId);
  }
});

app.post("/notify/message", requireSharedSecret, notificationRateLimit, async (req, res) => {
  try {
    const { roomId, messageId, senderId, receiverId, message, type } = req.body;
    const missing = requireFields(req.body, ["roomId", "senderId", "receiverId"]);
    if (missing.length > 0) {
      return badRequest(res, `missing fields: ${missing.join(", ")}`, req.requestId);
    }

    if (await messageAlreadyHandled(roomId, messageId)) {
      return res
        .status(202)
        .json({ ok: true, skipped: "handled_by_firestore_trigger", requestId: req.requestId });
    }

    const chatRef = db.collection("chats").doc(roomId);
    await chatRef.set(
      {
        roomId,
        participants: [senderId, receiverId],
        lastMessage: message || "[media]",
        lastMessageType: type || "text",
        lastMessageTime: admin.firestore.FieldValue.serverTimestamp(),
        unread: { [receiverId]: admin.firestore.FieldValue.increment(1) },
      },
      { merge: true }
    );

    await pushActivity(receiverId, {
      type: "message",
      actorId: senderId,
      message: message || "[media]",
      chatId: roomId,
    });
    await sendPushToUser(receiverId, {
      data: {
        type: "chat",
        sender: senderId,
        chatId: roomId,
        messageId: messageId || "",
      },
      notification: {
        title: "New message",
        body: message || "You have a new message",
      },
    });

    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    return internalError(res, error, req.requestId);
  }
});

app.post("/notify/like", requireSharedSecret, notificationRateLimit, async (req, res) => {
  try {
    const { postId, actorId } = req.body;
    const missing = requireFields(req.body, ["postId", "actorId"]);
    if (missing.length > 0) {
      return badRequest(res, `missing fields: ${missing.join(", ")}`, req.requestId);
    }

    if (await likeAlreadyHandled(postId, actorId)) {
      return res
        .status(202)
        .json({ ok: true, skipped: "handled_by_firestore_trigger", requestId: req.requestId });
    }

    const postDoc = await db.collection("posts").doc(postId).get();
    if (!postDoc.exists) {
      return res.status(404).json({ ok: false, error: "post not found", requestId: req.requestId });
    }

    const post = postDoc.data();
    await db
      .collection("posts")
      .doc(postId)
      .set(
        { likeCount: admin.firestore.FieldValue.increment(1) },
        { merge: true }
      );
    await pushActivity(post.ownerId, {
      type: "like",
      actorId,
      postId,
      mediaUrl: post.mediaUrl,
    });
    await sendPushToUser(post.ownerId, {
      data: { type: "like", actor: actorId, postId },
      notification: {
        title: "New like",
        body: "Someone liked your post",
      },
    });

    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    return internalError(res, error, req.requestId);
  }
});

app.post("/notify/follow", requireSharedSecret, notificationRateLimit, async (req, res) => {
  try {
    const { userId, followerId } = req.body;
    const missing = requireFields(req.body, ["userId", "followerId"]);
    if (missing.length > 0) {
      return badRequest(res, `missing fields: ${missing.join(", ")}`, req.requestId);
    }

    await pushActivity(userId, { type: "follow", actorId: followerId });
    await sendPushToUser(userId, {
      data: { type: "follow", actor: followerId },
      notification: {
        title: "New follower",
        body: "You have a new follower",
      },
    });

    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    return internalError(res, error, req.requestId);
  }
});

app.post("/story/reply", requireSharedSecret, notificationRateLimit, async (req, res) => {
  try {
    const { storyId, senderId, message } = req.body;
    const missing = requireFields(req.body, ["storyId", "senderId"]);
    if (missing.length > 0) {
      return badRequest(res, `missing fields: ${missing.join(", ")}`, req.requestId);
    }

    const storyDoc = await db.collection("stories").doc(storyId).get();
    if (!storyDoc.exists) {
      return res.status(404).json({ ok: false, error: "story not found", requestId: req.requestId });
    }

    const story = storyDoc.data();
    await pushActivity(story.ownerId, {
      type: "story_reply",
      actorId: senderId,
      storyId,
      message: message || "",
    });
    await sendPushToUser(story.ownerId, {
      data: { type: "story_reply", storyId, actor: senderId },
      notification: {
        title: "Story reply",
        body: message || "Someone replied to your story",
      },
    });

    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    return internalError(res, error, req.requestId);
  }
});

app.post("/activity/visit", requireSharedSecret, notificationRateLimit, async (req, res) => {
  try {
    const { userId, visitorId } = req.body;
    const missing = requireFields(req.body, ["userId", "visitorId"]);
    if (missing.length > 0) {
      return badRequest(res, `missing fields: ${missing.join(", ")}`, req.requestId);
    }

    if (await profileVisitAlreadyHandled(userId, visitorId)) {
      return res
        .status(202)
        .json({ ok: true, skipped: "handled_by_firestore_trigger", requestId: req.requestId });
    }

    await pushActivity(userId, { type: "profile_visit", actorId: visitorId });
    res.json({ ok: true, requestId: req.requestId });
  } catch (error) {
    return internalError(res, error, req.requestId);
  }
});

app.listen(PORT, () => {
  console.log(`AuraConnect backend listening on ${PORT}`);
});
