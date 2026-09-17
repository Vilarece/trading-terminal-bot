// Sept 17, 2026: the bot now runs inside ../app.mjs (webhook mode, same
// process as the trade page and order/execute relay). Kept so `npm run bot`
// (Render's existing start command for clearlane-telegram-bot) still works.
import "../app.mjs";
