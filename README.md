# WhatsApp-style Chat App

React + Node.js chat app with PostgreSQL persistence, JWT authentication, Redis-backed presence and typing indicators, and authenticated media uploads.

## Requirements

- Node.js 20.19+ (or 22.12+)
- Docker Desktop with Docker Compose, or PostgreSQL and Redis-compatible services installed directly on Windows

## Start locally with Docker

1. Install dependencies from the project root:

   ```powershell
   npm install
   ```

2. Create the backend environment file:

   ```powershell
   Copy-Item backend\.env.example backend\.env
   ```

   The example URLs use development-only credentials and ports configured below. Change `JWT_SECRET` to a random value of at least 32 characters before starting the app.

3. Start PostgreSQL and Redis:

   ```powershell
   docker compose up -d --wait
   ```

4. Run the frontend and backend:

   ```powershell
   npm run dev
   ```

Open http://localhost:5173. Register a user from the sign-in screen; users, chats, and messages are stored in PostgreSQL. The backend listens on http://localhost:5005.

Compose exposes PostgreSQL on `127.0.0.1:5433` and Redis on `127.0.0.1:6380` to avoid conflicts with local Windows services. The PostgreSQL password (`thatsapp_dev_password`) is for local development only. Do not use it in production.

## Windows setup without Docker

Install PostgreSQL and a Redis-compatible server as Windows services:

1. Install [PostgreSQL](https://www.postgresql.org/download/windows/) for Windows using the EDB installer. Set a password for the `postgres` superuser, keep the default port `5432`, and select the command-line tools.
2. Install [Memurai Developer Edition](https://www.memurai.com/get-memurai), a Redis-compatible server for Windows. Keep the default service and port (`Memurai`, `6379`).
3. In PowerShell, check that both services are running; start either service if needed:

   ```powershell
   Get-Service postgresql-x64-16, Memurai
   Get-Service postgresql-x64-16, Memurai |
     Where-Object Status -ne 'Running' |
     Start-Service
   ```

   Use the PostgreSQL service name shown by `Get-Service *postgres*` if it differs. `Start-Service` is only needed for services that are stopped; run PowerShell as Administrator if Windows requests elevation.
4. Install app dependencies and create the backend environment file:

   ```powershell
   cd d:\sample\ThatsAPP
   npm install
   Copy-Item backend\.env.example backend\.env
   ```

5. Create an app database and least-privilege login role in `psql` or pgAdmin, replacing the password placeholder with a strong unique password:

   ```sql
   CREATE ROLE thatsapp_app LOGIN PASSWORD 'replace-with-a-strong-password';
   CREATE DATABASE thatsapp OWNER thatsapp_app;
   ```

   Edit `backend\.env` and use these local service URLs:

   ```dotenv
   DATABASE_URL=postgresql://thatsapp_app:replace-with-a-strong-password@127.0.0.1:5432/thatsapp
   REDIS_URL=redis://127.0.0.1:6379
   ```

   Replace `JWT_SECRET` with a private random value of at least 32 characters. One way to generate a value is:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
   ```

6. Start the app:

   ```powershell
   npm run dev
   ```

Then open http://localhost:5173 and register an account. The backend creates its tables automatically; its health endpoint at http://localhost:5005/api/health reports PostgreSQL and Redis connection status. Docker is not needed for this setup.

## Features

- User registration and sign-in with bcrypt-hashed passwords and JWT-protected HTTP and Socket.IO connections
- PostgreSQL-backed users, direct chats, messages, and media metadata
- Persisted new-message notifications with unread counts, mark-read actions, and live Socket.IO delivery
- Redis-backed online presence, multi-device socket tracking, typing events, and Socket.IO scaling adapter
- Authenticated media upload and retrieval for images, video, audio, and PDF files (15 MB maximum per file)
- Search chats and registered users; start direct chats from the new-chat picker

Uploaded files are stored under `backend/uploads/` in this local-development setup. Keep this directory on a persistent volume when deploying, or replace it with an object-storage provider for multi-instance production uploads.

## Notifications and live events

Notifications are created in PostgreSQL for the other participants whenever a message is sent. They remain available after logout or disconnect; the notification panel shows the latest 50 and the unread count covers all unread notifications.

Authenticated notification API routes (send the usual `Authorization: Bearer <token>` header):

- `GET /api/notifications` — return `{ notifications, unreadCount }`
- `PATCH /api/notifications/:notificationId/read` — mark one of the current user's notifications read
- `PATCH /api/notifications/read-all` — mark all of the current user's notifications read

Socket.IO provides low-latency events while a user is connected; it is not the durable store. `message:new` delivers live chat messages, `notification:new` alerts all connected devices for the recipient, `typing:update` and `presence:update` carry temporary activity, and `chat:update` refreshes conversation previews. The Redis Socket.IO adapter forwards these events between backend instances. On reconnect, the app reads persisted notifications from the HTTP API.

## Environment variables

Configure these in `backend/.env`:

- `PORT` — backend HTTP port (default `5005`)
- `CLIENT_ORIGIN` — allowed browser origin (default `http://localhost:5173`)
- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection URL
- `JWT_SECRET` — private random secret, at least 32 characters

## Scripts

- `npm run dev` — start backend and frontend together
- `npm run build` — build the frontend for production
- `npm run start:backend` — start the backend only

The health endpoint at `/api/health` reports PostgreSQL and Redis connection status. MongoDB is no longer used by the app; the old local MongoDB service and data are left untouched.
