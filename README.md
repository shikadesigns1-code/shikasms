# Bulk SMS MVP
1. Push this folder to GitHub, then Netlify > Add new site > Import (or `npx netlify deploy --prod`).
2. Add env vars from `.env.example` (APP_PASSWORD, SESSION_SECRET, WEBHOOK_SECRET at minimum).
3. Open https://YOURSITE.netlify.app, sign in, test in mock mode.
4. Go live: create SMS account, register sender ID, set SMS_PROVIDER + SMS_API_KEY, redeploy.
5. Provider dashboard: point delivery reports to /api/dlr?secret=WEBHOOK_SECRET and inbound SMS to /api/inbound?secret=WEBHOOK_SECRET.
New provider: add a function to `providers` in netlify/functions/api.mjs.
