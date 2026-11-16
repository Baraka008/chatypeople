# ChatyPeople

A dark, mobile-friendly chat app with a shared Lounge, searchable one-to-one direct messages, and named groups of up to 32 people. Choosing a non-empty display name is required before chatting; each message shows its sender's name.

The app runs locally or deploys to Vercel or Netlify with a Neon Postgres database. When `.env.local` contains the Neon URLs, the local app and deployed functions use the shared Neon database. Without a Neon URL, the local server falls back to `messages.json`. Serverless filesystems are temporary, so hosted data is stored in Postgres.

## Start the chat

1. Install Node.js if it is not already installed.
2. Open PowerShell in this folder and run:

   ```powershell
   node server.js
   ```

3. On the laptop, open `http://localhost:3000`.
4. To join from a phone or another computer on the same Wi-Fi, open the `On your Wi-Fi` address printed in the terminal (for example, `http://192.168.1.25:3000`).

Keep the terminal open while using the local chat. If Windows Firewall asks, allow Node.js on your **private network** so devices on your Wi-Fi can connect. The local server is intended for a trusted local network.

Set a display name in the app, then choose **New** to find someone or make a group. People become searchable after registering a name from their own device. Enter sends; Shift+Enter adds a line. With Neon configured, chats are shared between the local app and the deployed app.

Run `npm run build` to build the static frontend into `dist`.

## Message actions, notifications, and install

- Use **Copy** on a message to copy its text. Your own messages also have **Edit** and **Delete** actions; deleting removes the message for everyone in that conversation.
- Use the bell in a conversation to enable or turn off notifications. The browser asks for permission. Browser notifications work while the app is open; background push requires a Neon-backed API and the `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and (optionally) `VAPID_SUBJECT` environment variables on the server. Never put the private key in frontend code or commit it.
- Use the download button when your browser offers installation. If it is unavailable, open the browser menu and choose **Install app** or **Add to Home Screen**. The app must be served from HTTPS to install on other devices; `localhost` is supported for local development.

Set a different port with the `PORT` environment variable if port 3000 is already in use:

```powershell
$env:PORT = "3001"
node server.js
```

## Deploy to Vercel

1. Create a Vercel account and a Neon Postgres database (for example, add Neon from the Vercel Marketplace and connect it to the project).
2. In the Vercel project settings, add the database's pooled connection string as the `DATABASE_URL` environment variable for Production, Preview, and Development. Do not commit the connection string.
3. Before deploying, you can import the local chat history. Create a private `.env.local` file in the project root (it is git-ignored) containing:

   ```powershell
   DATABASE_URL=your-Neon-pooled-connection-string
   ```

   Then run:

   ```powershell
   npm run push:neon
   ```

   The command imports local profiles, conversations, and messages by ID, and is safe to rerun. Keep the connection string private.
4. From this project folder, use the Vercel CLI:

   ```powershell
   npx vercel
   ```

   Sign in and link the project when prompted. Then deploy:

   ```powershell
   npx vercel --prod
   ```

5. Open the production URL from Vercel. The API creates its tables and the Lounge on its first request; the database role must be allowed to create tables.

The deployed database starts separately from local `messages.json`; local users, messages, and groups are not copied automatically. Vercel hosting makes the app internet-accessible. **Display names are not verified identities and this app does not yet have account authentication or invite controls**, so don't use it for sensitive conversations or treat a chosen name as proof of identity.

## Deploy to Netlify

1. In Netlify, create or select a site and connect this GitHub repository. Set the build command to `npm run build` and the publish directory to `dist` (also configured in `netlify.toml`).
2. In the Netlify site settings, add `DATABASE_URL` using the Neon pooled connection string. Keep it private; do not add it to Git or a client-side environment variable.
3. Trigger a deploy from Netlify. The `netlify/functions` API adapters and `netlify.toml` redirects route chat API requests to serverless functions backed by Neon.
4. Open the site's Netlify URL and test profile setup and a message in The Lounge.

The database role must be allowed to create tables on the first API request. Netlify and Vercel can both serve the same Neon database.
