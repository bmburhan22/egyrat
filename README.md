# Egyptian Rat Screw Online

A minimal real-time multiplayer web implementation using React, Node.js, Express and Socket.IO.

## Included rules

- 2–40 players per room (the 40-card number deck limits the maximum).
- Host creates a room and shares its 5-character code.
- Host starts the game once at least two players have joined.
- Uses 40 UNO number cards: values 0–9 in red, yellow, green and blue. Action cards are excluded.
- Cards are shuffled and dealt evenly. Any remainder is dealt one at a time from the start of the player order.
- On a player's turn, the server randomly plays the top card from their hand. The player only sees their remaining card count.
- All players see the face-up middle pile.
- Any player can slap at any time.
- Valid patterns: doubles (last two values match), sandwich (first and third of the last three values match), three consecutive values (ascending or descending), and same colour on the last two cards.
- A correct slap awards the entire middle pile to the player and makes them the next player to play.
- An incorrect slap adds up to two cards from that player's hand face-down to the middle pile. If they have fewer than two cards, they pay what they have.
- Face-down penalty cards break the visible pattern sequence.
- The server validates turns and slaps; clients never receive their own hidden cards.

## Run locally

Requirements: Node.js 18+.

From the project root:

```bash
npm install
npm run install:all
npm run dev
```

Open `http://localhost:5173` in multiple browser tabs or devices on the same network. For other devices on your LAN, use your computer's LAN IP for the Vite page and set `VITE_SERVER_URL` to `http://YOUR_LAN_IP:3001`.

## Deploy online

Deploy the `server` folder as a Node service that supports WebSockets (for example, Render, Railway or Fly.io). Set `CLIENT_ORIGIN` to the frontend's deployed URL.

Deploy the `client` folder as a static Vite site. Set `VITE_SERVER_URL` to the public URL of the Node server, then build with:

```bash
npm run build
```

The server uses in-memory rooms. Restarting the server clears active rooms and games. This starter does not include persistent accounts, reconnect recovery, or anti-cheat rate limiting.

## Notes / current limitations

- Room capacity is capped at 20 players as a practical safeguard; this can be changed in `server/index.js`.
- A false slap puts up to two cards from the slapper's hand face-down onto the middle pile. If they have fewer than two cards, they pay what they have.
- A player with zero cards can still slap, but cannot play a card. A correct slap can bring them back into the game.
- The game ends when one player collects all 40 cards, or when nobody can play and no valid slap is available.
- Disconnected players remain in an active game with their cards but are skipped for turns. Reconnection is not implemented yet.
