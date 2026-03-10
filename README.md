# AuraConnect Backend

Single merged backend for AuraConnect, combining:

- notification/activity API from `render-api`
- call notification + live call feed from `server`

## Endpoints

- `GET /ping`
- `GET /`
- `GET /events`
- `POST /send-call`
- `POST /send-call-notification`
- `POST /send-chat`
- `POST /notify/message`
- `POST /notify/like`
- `POST /notify/follow`
- `POST /story/reply`
- `POST /activity/visit`

## Local Run

```bash
npm install
npm start
```

## Firebase Credentials

Preferred on Render:

- `FIREBASE_SERVICE_ACCOUNT_JSON`

You can provide it as:

- raw JSON string, or
- base64-encoded JSON string

Alternative env vars:

- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

## Render Deploy

This repo includes `render.yaml` for a single web service deployment.

After deploy, update the Flutter app backend URL in:

- `lib/config/app_config.dart`
