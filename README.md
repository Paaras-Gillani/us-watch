# US Watch
Built by Maisam Gillani

A small web app for watching movies with friends — screen share your local media
player or an online stream, chat alongside it, no accounts, no history saved.

## Run it

```
npm install
npm start
```

Then open http://localhost:3000

To watch with friends over the internet (not just your local network), deploy
this to any free Node host (Render, Railway, Fly.io) — it's a single small
server with no database.

## How it works

- **Create a Room** generates a 5-character code and makes you the host.
- **Add Participants** (top bar, host only) gives you a code and a link —
  friends just enter their name and the code, or click the link, and they're in.
- **Start Screen Share** (host only): share your whole screen or just the
  browser tab where you've opened the movie/stream/local file. Whatever plays
  there — Netflix tab, a downloaded .mp4 opened in VLC or a browser tab, a
  YouTube video — is what everyone sees and hears. This is why there's no
  separate "local file" vs "online stream" mode: the screen share carries
  either one.
- **Chat** sits alongside the video the whole time.
- Nothing is stored. Rooms, participants, and chat all live in server memory
  and vanish the moment everyone leaves — there's no database and no history.

## Notes on scope

This is intentionally minimal:
- Video delivery is a WebRTC mesh (host connects directly to each viewer).
  That's fine for a handful of friends; it's not built to scale to large
  audiences.
- No login system, no persistence, no admin tools — just a code and a name.
- If you outgrow this later, the natural place to invest is a media server
  (e.g., an SFU) for the video path, but for a private friend group this
  keeps things simple and free to run.
