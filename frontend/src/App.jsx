// App owns authentication, chat selection, messaging, live presence, and notification UI state.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { io } from "socket.io-client";
import "./App.css";

// Default to the page origin so the Vite proxy forwards /socket.io to the backend on any port or host.
const socket = io(import.meta.env.VITE_SOCKET_URL || window.location.origin, {
  autoConnect: false,
});
const sessionKey = "thatsapp-session";

// Socket.IO carries live chat events; PostgreSQL-backed APIs remain the source of truth after reconnects.
// Reject malformed local storage early so later UI code can rely on a valid token and user id.
function getStoredSession() {
  try {
    const value = localStorage.getItem(sessionKey);
    const session = value ? JSON.parse(value) : null;
    if (
      typeof session?.token !== "string" ||
      typeof session?.user?.id !== "string" ||
      typeof session?.user?.name !== "string"
    ) {
      localStorage.removeItem(sessionKey);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

// One shared AudioContext is created lazily; browsers keep it suspended until a user gesture.
let notificationAudioContext = null;
function getNotificationAudioContext() {
  if (!notificationAudioContext && window.AudioContext) {
    notificationAudioContext = new window.AudioContext();
  }
  return notificationAudioContext;
}

// Web Audio creates a short two-note tone without needing an external sound file.
async function playNotificationTone(audioContext) {
  if (!audioContext) return false;
  if (audioContext.state !== "running") await audioContext.resume();
  if (audioContext.state !== "running") return false;

  const oscillator = audioContext.createOscillator();
  const volume = audioContext.createGain();
  const startTime = audioContext.currentTime;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, startTime);
  oscillator.frequency.setValueAtTime(660, startTime + 0.14);
  volume.gain.setValueAtTime(0.0001, startTime);
  volume.gain.exponentialRampToValueAtTime(0.4, startTime + 0.015);
  volume.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.4);
  oscillator.connect(volume);
  volume.connect(audioContext.destination);
  oscillator.start(startTime);
  oscillator.stop(startTime + 0.41);
  return true;
}

function mergeMessages(...groups) {
  const uniqueMessages = new Map();
  for (const message of groups.flat()) uniqueMessages.set(message.id, message);
  return [...uniqueMessages.values()].sort((first, second) => {
    const timeDifference =
      new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime();
    return timeDifference || first.id.localeCompare(second.id);
  });
}

// Authenticated media cannot be loaded by a plain <img src>, so fetch it with the JWT and create a blob URL.
function MessageAttachment({ attachment, token }) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl;
    let cancelled = false;

    fetch(`/api/media/${attachment.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load attachment");
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, token]);

  if (failed) return <small>Attachment could not be loaded.</small>;
  if (!url) return <small>Loading {attachment.name}…</small>;

  if (attachment.mimeType.startsWith("image/")) {
    return <img className="message-media" src={url} alt={attachment.name} />;
  }
  if (attachment.mimeType.startsWith("video/")) {
    return <video className="message-media" src={url} controls />;
  }
  if (attachment.mimeType.startsWith("audio/")) {
    return <audio src={url} controls />;
  }
  return (
    <a className="attachment-link" href={url} target="_blank" rel="noreferrer">
      {attachment.name}
    </a>
  );
}

function App() {
  // State that affects rendering belongs in useState; refs hold values used by socket callbacks between renders.
  const [session, setSession] = useState(() => getStoredSession());
  const [authMode, setAuthMode] = useState("login");
  const [loginForm, setLoginForm] = useState({ email: "", password: "" });
  const [registerForm, setRegisterForm] = useState({
    name: "",
    email: "",
    password: "",
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [userSearch, setUserSearch] = useState("");
  const [users, setUsers] = useState([]);
  const [error, setError] = useState("");
  const [chats, setChats] = useState([]);
  const [selectedChatId, setSelectedChatId] = useState("");
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [selectedFile, setSelectedFile] = useState(null);
  const [showUserPicker, setShowUserPicker] = useState(false);
  const [typingName, setTypingName] = useState("");
  const [onlineUsers, setOnlineUsers] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [unreadNotificationCount, setUnreadNotificationCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [incomingAlert, setIncomingAlert] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const selectedChatIdRef = useRef("");
  const joinedChatIdRef = useRef("");
  const typingTimeoutRef = useRef(null);
  const notificationEventVersionRef = useRef(0);
  const notificationIdsRef = useRef(new Set());
  const alertTimeoutRef = useRef(null);
  const messageStackRef = useRef(null);
  const chatsRequestRef = useRef(0);
  const missingChatLookupsRef = useRef(new Set());

  const authHeaders = useMemo(
    () => (session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
    [session],
  );

  // Memoized derived values avoid duplicating the active chat and filtered search results in state.
  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? null,
    [chats, selectedChatId],
  );

  const refreshNotifications = useCallback(async () => {
    const response = await fetch("/api/notifications", { headers: authHeaders });
    if (!response.ok) throw new Error("Unable to refresh notifications");
    const data = await response.json();
    setNotifications(data.notifications);
    setUnreadNotificationCount(data.unreadCount);
    notificationIdsRef.current = new Set(
      data.notifications.map((notification) => notification.id),
    );
  }, [authHeaders]);

  // Browsers block audio until a user gesture, so the first interaction anywhere unlocks it for good.
  useEffect(() => {
    const events = ["pointerdown", "keydown", "touchstart"];
    const unlockAudio = () => {
      const audioContext = getNotificationAudioContext();
      if (!audioContext) return;
      audioContext
        .resume()
        .then(() => {
          if (audioContext.state === "running") {
            events.forEach((name) => window.removeEventListener(name, unlockAudio));
          }
        })
        .catch(() => {});
    };
    events.forEach((name) => window.addEventListener(name, unlockAudio));
    return () => {
      events.forEach((name) => window.removeEventListener(name, unlockAudio));
    };
  }, []);

  const dismissIncomingAlert = () => {
    if (alertTimeoutRef.current) window.clearTimeout(alertTimeoutRef.current);
    alertTimeoutRef.current = null;
    setIncomingAlert(null);
  };

  const filteredChats = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return chats;
    return chats.filter((chat) => chat.name.toLowerCase().includes(term));
  }, [chats, searchTerm]);

  const availableUsers = useMemo(() => {
    const term = userSearch.trim().toLowerCase();
    return users.filter(
      (user) =>
        user.id !== session?.user?.id &&
        (!term ||
          user.name.toLowerCase().includes(term) ||
          user.email.toLowerCase().includes(term)),
    );
  }, [session?.user?.id, userSearch, users]);

  // Sign-in lifecycle: load persisted data, connect the authenticated socket, and subscribe to live events.
  useEffect(() => {
    if (!session?.token) {
      socket.disconnect();
      return undefined;
    }

    let cancelled = false;
    const loadData = async () => {
      const notificationVersionAtStart = notificationEventVersionRef.current;
      const [chatResponse, notificationResponse] = await Promise.all([
        fetch("/api/chats", { headers: authHeaders }),
        fetch("/api/notifications", { headers: authHeaders }),
      ]);
      if (chatResponse.status === 401 || notificationResponse.status === 401) {
        localStorage.removeItem(sessionKey);
        setSession(null);
        return;
      }
      if (!chatResponse.ok) throw new Error("Unable to load chats");
      if (!notificationResponse.ok)
        throw new Error("Unable to load notifications");
      const [data, notificationData] = await Promise.all([
        chatResponse.json(),
        notificationResponse.json(),
      ]);
      if (cancelled) return;
      setChats(data.chats);
      setUsers(data.users);
      if (notificationVersionAtStart === notificationEventVersionRef.current) {
        setNotifications(notificationData.notifications);
        setUnreadNotificationCount(notificationData.unreadCount);
        notificationIdsRef.current = new Set(
          notificationData.notifications.map((notification) => notification.id),
        );
      } else {
        await refreshNotifications();
      }
      setOnlineUsers(
        Object.fromEntries(data.users.map((user) => [user.id, user.online])),
      );
      const nextChatId = selectedChatIdRef.current || data.chats[0]?.id || "";
      selectedChatIdRef.current = nextChatId;
      setSelectedChatId(nextChatId);
    };

    loadData().catch((requestError) => {
      if (!cancelled) setError(requestError.message);
    });

    socket.auth = { token: session.token };
    socket.connect();
    const handleConnect = () => {
      if (selectedChatIdRef.current) {
        socket.emit("join-chat", selectedChatIdRef.current);
        joinedChatIdRef.current = selectedChatIdRef.current;
      }
    };
    const handleIncomingMessage = (message) => {
      if (message.chatId !== selectedChatIdRef.current) return;
      setMessages((current) => mergeMessages(current, [message]));
      setChats((current) =>
        current.map((chat) =>
          chat.id === message.chatId
            ? { ...chat, lastMessage: message.text || "Shared media" }
            : chat,
        ),
      );
    };
    const handlePresence = ({ userId, online }) => {
      setOnlineUsers((current) => ({ ...current, [userId]: online }));
    };
    const handleNewNotification = (notification) => {
      notificationEventVersionRef.current += 1;
      if (notificationIdsRef.current.has(notification.id)) return;
      notificationIdsRef.current.add(notification.id);
      setNotifications((current) =>
        [notification, ...current].slice(0, 50),
      );
      setUnreadNotificationCount((current) => current + 1);
      setIncomingAlert(notification);
      // Audio stays on; it is silently skipped until the browser has seen a first user gesture.
      playNotificationTone(getNotificationAudioContext()).catch(() => {});
      if (alertTimeoutRef.current) window.clearTimeout(alertTimeoutRef.current);
      alertTimeoutRef.current = window.setTimeout(() => {
        setIncomingAlert(null);
        alertTimeoutRef.current = null;
      }, 6000);
    };
    const handleNotificationRead = () => {
      notificationEventVersionRef.current += 1;
      refreshNotifications().catch((requestError) =>
        setError(requestError.message),
      );
    };
    const handleAllNotificationsRead = () => {
      notificationEventVersionRef.current += 1;
      refreshNotifications().catch((requestError) =>
        setError(requestError.message),
      );
    };
    const handleTyping = ({ chatId, userId, name, isTyping }) => {
      if (chatId !== selectedChatIdRef.current || userId === session.user.id)
        return;
      setTypingName(isTyping ? name : "");
    };
    const handleChatUpdate = () => {
      const requestId = ++chatsRequestRef.current;
      fetch("/api/chats", { headers: authHeaders })
        .then((response) => {
          if (!response.ok) throw new Error("Unable to refresh chats");
          return response.json();
        })
        .then((data) => {
          if (cancelled || requestId !== chatsRequestRef.current) return;
          setChats(data.chats);
          setUsers(data.users);
          setOnlineUsers(
            Object.fromEntries(
              data.users.map((user) => [user.id, user.online]),
            ),
          );
        })
        .catch((requestError) => setError(requestError.message));
    };

    socket.on("connect", handleConnect);
    // Message payloads use the active chat room; notifications use the account room on every device.
    socket.on("message:new", handleIncomingMessage);
    socket.on("presence:update", handlePresence);
    socket.on("typing:update", handleTyping);
    socket.on("chat:update", handleChatUpdate);
    socket.on("notification:new", handleNewNotification);
    socket.on("notification:read", handleNotificationRead);
    socket.on("notification:read-all", handleAllNotificationsRead);
    // Periodic heartbeats refresh the Redis TTL while this authenticated client is connected.
    const heartbeat = window.setInterval(
      () => socket.emit("presence:heartbeat"),
      30000,
    );

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      if (alertTimeoutRef.current) window.clearTimeout(alertTimeoutRef.current);
      socket.off("connect", handleConnect);
      socket.off("message:new", handleIncomingMessage);
      socket.off("presence:update", handlePresence);
      socket.off("typing:update", handleTyping);
      socket.off("chat:update", handleChatUpdate);
      socket.off("notification:new", handleNewNotification);
      socket.off("notification:read", handleNotificationRead);
      socket.off("notification:read-all", handleAllNotificationsRead);
      socket.disconnect();
    };
  }, [authHeaders, refreshNotifications, session]);

  // Chat selection controls both the authorized Socket.IO room and the REST message-history request.
  useEffect(() => {
    if (!session?.token || !selectedChatId) {
      return undefined;
    }

    if (joinedChatIdRef.current && joinedChatIdRef.current !== selectedChatId) {
      socket.emit("leave-chat", joinedChatIdRef.current);
    }
    socket.emit("join-chat", selectedChatId);
    joinedChatIdRef.current = selectedChatId;

    let cancelled = false;
    fetch(`/api/messages/${selectedChatId}`, { headers: authHeaders })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load messages");
        return response.json();
      })
      .then((data) => {
        if (!cancelled) {
          setMessages((current) => mergeMessages(data, current));
        }
      })
      .catch((requestError) => {
        if (!cancelled) setError(requestError.message);
      });

    return () => {
      cancelled = true;
    };
  }, [authHeaders, selectedChatId, session?.token]);

  // Follow the conversation: scroll only the message list, never the page, when content changes.
  useEffect(() => {
    const stack = messageStackRef.current;
    if (stack) stack.scrollTop = stack.scrollHeight;
  }, [messages, typingName, selectedChatId]);

  // A selected chat that is absent from the list hides the composer, so fetch the list once for it.
  useEffect(() => {
    if (!session?.token || !selectedChatId) return undefined;
    if (chats.some((chat) => chat.id === selectedChatId)) return undefined;
    if (missingChatLookupsRef.current.has(selectedChatId)) return undefined;
    missingChatLookupsRef.current.add(selectedChatId);

    let cancelled = false;
    let finished = false;
    fetch("/api/chats", { headers: authHeaders })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to refresh chats");
        return response.json();
      })
      .then((data) => {
        finished = true;
        if (cancelled) return;
        setChats(data.chats);
        if (!data.chats.some((chat) => chat.id === selectedChatId)) {
          // The chat no longer exists for this user, so fall back to a valid conversation.
          const fallbackId = data.chats[0]?.id || "";
          selectedChatIdRef.current = fallbackId;
          setSelectedChatId(fallbackId);
        }
      })
      .catch((requestError) => {
        finished = true;
        if (!cancelled) setError(requestError.message);
      });
    return () => {
      cancelled = true;
      if (!finished) missingChatLookupsRef.current.delete(selectedChatId);
    };
  }, [authHeaders, chats, selectedChatId, session?.token]);

  // Authentication helpers keep login and registration requests on the same response/error path.
  const authenticate = async (endpoint, payload) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Authentication failed");
    return data;
  };

  const saveSession = (payload) => {
    const nextSession = { token: payload.token, user: payload.user };
    localStorage.setItem(sessionKey, JSON.stringify(nextSession));
    setSession(nextSession);
    setError("");
  };

  const login = async (event) => {
    event.preventDefault();
    setError("");
    try {
      saveSession(await authenticate("/api/auth/login", loginForm));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const register = async (event) => {
    event.preventDefault();
    setError("");
    try {
      saveSession(await authenticate("/api/auth/register", registerForm));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  // Clear both persistent credentials and per-user UI state when ending a session.
  const logout = () => {
    localStorage.removeItem(sessionKey);
    socket.disconnect();
    setSession(null);
    setChats([]);
    setUsers([]);
    setMessages([]);
    setNotifications([]);
    setUnreadNotificationCount(0);
    notificationIdsRef.current.clear();
    notificationEventVersionRef.current = 0;
    setShowNotifications(false);
    setSelectedChatId("");
    selectedChatIdRef.current = "";
    setShowUserPicker(false);
  };

  const selectChat = (chatId) => {
    // Re-selecting the open chat must keep its messages: the history effect only reruns on a chat change.
    if (chatId === selectedChatIdRef.current) {
      setTypingName("");
      return;
    }
    selectedChatIdRef.current = chatId;
    setSelectedChatId(chatId);
    setMessages([]);
    setTypingName("");
  };

  const markNotificationRead = async (notificationId) => {
    const response = await fetch(`/api/notifications/${notificationId}/read`, {
      method: "PATCH",
      headers: authHeaders,
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Unable to mark notification as read");
    await refreshNotifications();
  };

  // A notification links back to its chat and is marked read before navigating there.
  const openNotification = async (notification) => {
    try {
      if (!notification.readAt)
        await markNotificationRead(notification.id);
      selectChat(notification.chatId);
      setShowNotifications(false);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const markAllNotificationsRead = async () => {
    try {
      const response = await fetch("/api/notifications/read-all", {
        method: "PATCH",
        headers: authHeaders,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Unable to mark notifications as read");
      setNotifications((current) =>
        current.map((notification) => ({
          ...notification,
          readAt: notification.readAt || new Date().toISOString(),
        })),
      );
      setUnreadNotificationCount(0);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  // The server creates or reuses a direct chat, then the client opens it immediately.
  const startChatWithUser = async (contactId) => {
    try {
      const response = await fetch("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ userId: contactId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to start chat");
      setChats((current) =>
        current.some((chat) => chat.id === data.chat.id)
          ? current
          : [data.chat, ...current],
      );
      selectChat(data.chat.id);
      setShowUserPicker(false);
      setUserSearch("");
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  // Typing events are temporary socket messages and stop after a short idle timeout.
  const handleDraftChange = (event) => {
    const value = event.target.value;
    setDraft(value);
    if (!selectedChatId || !socket.connected) return;

    socket.emit("typing", {
      chatId: selectedChatId,
      isTyping: Boolean(value.trim()),
    });
    if (typingTimeoutRef.current) window.clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => {
      socket.emit("typing", { chatId: selectedChatId, isTyping: false });
    }, 1200);
  };

  // Upload an optional attachment first, then send its id alongside the message text.
  const submitMessage = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if ((!text && !selectedFile) || !selectedChatId || isSubmitting) return;

    setIsSubmitting(true);
    setError("");
    try {
      let mediaId;
      if (selectedFile) {
        const formData = new FormData();
        formData.append("file", selectedFile);
        formData.append("chatId", selectedChatId);
        const uploadResponse = await fetch("/api/media", {
          method: "POST",
          headers: authHeaders,
          body: formData,
        });
        const uploadData = await uploadResponse.json();
        if (!uploadResponse.ok)
          throw new Error(uploadData.error || "Media upload failed");
        mediaId = uploadData.id;
      }

      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ chatId: selectedChatId, text, mediaId }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Message could not be sent");

      setMessages((current) => mergeMessages(current, [data]));
      setChats((current) =>
        current.map((chat) =>
          chat.id === selectedChatId
            ? { ...chat, lastMessage: text || "Shared media" }
            : chat,
        ),
      );
      setDraft("");
      setSelectedFile(null);
      socket.emit("typing", { chatId: selectedChatId, isTyping: false });
      if (typingTimeoutRef.current)
        window.clearTimeout(typingTimeoutRef.current);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!session?.token) {
    // The unauthenticated branch renders either the login or account-registration form.
    return (
      <div
        className="auth-page"
      >
        <div className="auth-card">
          <div className="auth-header">
            <span className="auth-badge">
              {authMode === "login" ? "Secure Login" : "Create Account"}
            </span>
            <h1>
              {authMode === "login" ? "Welcome back" : "Create your account"}
            </h1>
            <p>
              {authMode === "login"
                ? "Sign in to continue messaging"
                : "Register to start connecting with people"}
            </p>
          </div>

          {authMode === "login" ? (
            <form onSubmit={login} className="auth-form">
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={loginForm.email}
                  onChange={(event) =>
                    setLoginForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  value={loginForm.password}
                  onChange={(event) =>
                    setLoginForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                />
              </label>
              {error && <p className="auth-error">{error}</p>}
              <button type="submit" className="auth-submit">
                Sign in
              </button>
            </form>
          ) : (
            <form onSubmit={register} className="auth-form">
              <label>
                Name
                <input
                  type="text"
                  autoComplete="name"
                  minLength={2}
                  maxLength={60}
                  required
                  value={registerForm.name}
                  onChange={(event) =>
                    setRegisterForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Email
                <input
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                  value={registerForm.email}
                  onChange={(event) =>
                    setRegisterForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required
                  value={registerForm.password}
                  onChange={(event) =>
                    setRegisterForm((current) => ({
                      ...current,
                      password: event.target.value,
                    }))
                  }
                />
              </label>
              {error && <p className="auth-error">{error}</p>}
              <button type="submit" className="auth-submit">
                Create account
              </button>
            </form>
          )}

          <button
            type="button"
            className="switch-auth"
            onClick={() => {
              setAuthMode((current) =>
                current === "login" ? "register" : "login",
              );
              setError("");
            }}
          >
            {authMode === "login"
              ? "Need an account? Register"
              : "Already registered? Sign in"}
          </button>
        </div>
      </div>
    );
  }

  // The authenticated view combines the chat/notification sidebar with the selected conversation.
  return (
    <>
      {incomingAlert &&
        createPortal(
          <div className="incoming-alert" role="status" aria-live="assertive">
            <button
              type="button"
              className="incoming-alert-message"
              onClick={() => openNotification(incomingAlert)}
            >
              <strong>
                {incomingAlert.kind === "chat"
                  ? `New chat from ${incomingAlert.actorName}`
                  : `New message from ${incomingAlert.actorName}`}
              </strong>
              <span>{incomingAlert.preview}</span>
            </button>
            <button
              type="button"
              className="incoming-alert-dismiss"
              aria-label="Dismiss new message alert"
              onClick={dismissIncomingAlert}
            >
              ×
            </button>
          </div>,
          document.body,
        )}
      <div
        className="app-shell"
      >
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">Chats</p>
            <h1>Messages</h1>
          </div>
          <div className="sidebar-actions">
            <span className="current-user">{session.user.name}</span>
            <button
              type="button"
              className="notification-toggle"
              aria-label={`Notifications, ${unreadNotificationCount} unread`}
              aria-expanded={showNotifications}
              onClick={() => setShowNotifications((current) => !current)}
            >
              <svg
                className="notification-icon"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {unreadNotificationCount > 0 && (
                <span className="notification-count">
                  {unreadNotificationCount > 99 ? "99+" : unreadNotificationCount}
                </span>
              )}
            </button>
            <button
              type="button"
              className="compose-button"
              aria-label="Start a new chat"
              onClick={() => setShowUserPicker((current) => !current)}
            >
              +
            </button>
          </div>
        </div>

        {/* Notification records come from the API and update live over the user's Socket.IO room. */}
        {showNotifications && (
          <section className="notification-panel" aria-label="Notifications">
            <div className="notification-panel-header">
              <strong>Notifications</strong>
              <button
                type="button"
                onClick={markAllNotificationsRead}
                disabled={unreadNotificationCount === 0}
              >
                Mark all read
              </button>
            </div>
            <div className="notification-list">
              {notifications.map((notification) => (
                <button
                  type="button"
                  key={notification.id}
                  className={`notification-item ${notification.readAt ? "" : "unread"}`}
                  onClick={() => openNotification(notification)}
                >
                  <strong>{notification.actorName}</strong>
                  <span>{notification.preview}</span>
                  <small>
                    {new Date(notification.createdAt).toLocaleString()}
                  </small>
                </button>
              ))}
              {notifications.length === 0 && (
                <p className="empty-hint">No notifications yet.</p>
              )}
            </div>
          </section>
        )}

        <div className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            aria-label="Search chats"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search chats"
          />
        </div>

        {showUserPicker && (
          <div className="user-picker">
            <div className="user-picker-header">
              <span>New chat</span>
              <button type="button" onClick={() => setShowUserPicker(false)}>
                Close
              </button>
            </div>
            <input
              type="search"
              aria-label="Find people"
              value={userSearch}
              onChange={(event) => setUserSearch(event.target.value)}
              placeholder="Find people"
            />
            <div className="user-list">
              {availableUsers.map((user) => (
                <button
                  type="button"
                  key={user.id}
                  onClick={() => startChatWithUser(user.id)}
                >
                  <span className="avatar small">
                    {user.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span>{user.name}</span>
                  <small>{onlineUsers[user.id] ? "Online" : "Offline"}</small>
                </button>
              ))}
              {availableUsers.length === 0 && (
                <p className="empty-hint">No people found.</p>
              )}
            </div>
          </div>
        )}

        {/* The sidebar chat list is searchable and selects the conversation displayed beside it. */}
        <ul className="chat-list">
          {filteredChats.map((chat) => (
            <li key={chat.id}>
              <button
                type="button"
                className={`chat-item ${chat.id === selectedChatId ? "active" : ""}`}
                onClick={() => selectChat(chat.id)}
              >
                <div className="avatar">
                  {chat.name.slice(0, 2).toUpperCase()}
                </div>
                <div className="chat-meta">
                  <div className="chat-row">
                    <strong>{chat.name}</strong>
                    <span>Now</span>
                  </div>
                  <div className="chat-row sub-row">
                    <small>{chat.lastMessage}</small>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="chat-panel">
        {activeChat ? (
          <>
            <header className="chat-header">
              <div className="avatar large">
                {activeChat.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="chat-contact">
                <h2>{activeChat.name}</h2>
                <p>
                  {typingName ||
                    (onlineUsers[
                      activeChat.participants.find(
                        (id) => id !== session.user.id,
                      )
                    ]
                      ? "Online now"
                      : "Offline")}
                </p>
              </div>
              <div className="header-actions">
                <button type="button" onClick={logout}>
                  Log out
                </button>
              </div>
            </header>

            {error && (
              <p className="app-error" role="alert">
                {error}
              </p>
            )}

            {/* Messages use a chat-scoped socket room; media attachments are fetched separately with auth. */}
            <section
              className="message-stack"
              aria-label="Messages"
              ref={messageStackRef}
            >
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`message-row ${message.senderId === session.user.id ? "outgoing" : "incoming"}`}
                >
                  <div className="message-bubble">
                    {message.text && <span>{message.text}</span>}
                    {message.attachment && (
                      <MessageAttachment
                        attachment={message.attachment}
                        token={session.token}
                      />
                    )}
                    <small>{message.time}</small>
                  </div>
                </div>
              ))}
              {typingName && (
                <p className="typing-indicator">{typingName} is typing…</p>
              )}
            </section>

            {/* Composer submits text, media, or both through the authenticated REST API. */}
            <form className="composer" onSubmit={submitMessage}>
              <label className="icon-button upload-button" title="Attach media">
                +
                <input
                  type="file"
                  accept="image/*,video/mp4,video/webm,audio/mpeg,audio/wav,audio/webm,application/pdf"
                  onChange={(event) =>
                    setSelectedFile(event.target.files?.[0] || null)
                  }
                  aria-label="Attach media"
                />
              </label>
              <div className="composer-fields">
                {selectedFile && (
                  <div className="selected-file">
                    <span>{selectedFile.name}</span>
                    <button
                      type="button"
                      onClick={() => setSelectedFile(null)}
                      aria-label="Remove attachment"
                    >
                      ×
                    </button>
                  </div>
                )}
                <input
                  type="text"
                  placeholder="Type a message"
                  value={draft}
                  onChange={handleDraftChange}
                  maxLength={5000}
                  aria-label="Message"
                />
              </div>
              <button
                type="submit"
                className="send-button"
                disabled={isSubmitting}
              >
                {isSubmitting ? "Sending…" : "Send"}
              </button>
            </form>
          </>
        ) : (
          <>
            <header className="chat-header">
              <div>
                <h2>Welcome, {session.user.name}</h2>
                <p>Choose a chat or start a new conversation.</p>
              </div>
              <div className="header-actions">
                <button type="button" onClick={logout}>
                  Log out
                </button>
              </div>
            </header>
            {error && (
              <p className="app-error" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </main>
      </div>
    </>
  );
}

export default App;
