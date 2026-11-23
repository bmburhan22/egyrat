import React, { useEffect, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
const FEEDBACK_DURATION_MS = 1000;
const socket = io(SERVER_URL, { autoConnect: true });
const feedbackSounds = {
  success: new Audio("/sounds/slap-success.ogg"),
  penalty: new Audio("/sounds/slap-penalty.ogg")
};
Object.values(feedbackSounds).forEach(sound => { sound.preload = "auto"; sound.load(); });

function App() {
  const [name, setName] = useState(() => localStorage.getItem("ers-player-name") || "");
  const [inviteRoom] = useState(() => new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() || "");
  const [inviteJoinAttempted, setInviteJoinAttempted] = useState(false);
  const [hasSavedPlayerName] = useState(() => Boolean(localStorage.getItem("ers-player-name")));
  const [roomInput, setRoomInput] = useState(() => new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() || "");
  const [roomCode, setRoomCode] = useState("");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [keys, setKeys] = useState(() => {
    try { return JSON.parse(localStorage.getItem("ers-keys")) || { slap: " ", play: "Enter" }; }
    catch { return { slap: " ", play: "Enter" }; }
  });
  const [remapping, setRemapping] = useState("");

  useEffect(() => {
    socket.on("state", setState);
    return () => socket.off("state", setState);
  }, []);

  useEffect(() => {
    const onKeyDown = event => {
      if (remapping) {
        event.preventDefault();
        const next = { ...keys, [remapping]: event.key };
        setKeys(next); localStorage.setItem("ers-keys", JSON.stringify(next)); setRemapping("");
        return;
      }
      if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.target?.matches?.("input, textarea, select, [contenteditable=true]")) return;
      if (event.key === keys.slap) { event.preventDefault(); act("slap"); }
      else if (event.key === keys.play) { event.preventDefault(); act("playCard"); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keys, remapping, state, roomCode]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(""), FEEDBACK_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    if (!inviteRoom || !hasSavedPlayerName || !name.trim() || roomCode || inviteJoinAttempted) return;
    const tryJoin = () => {
      setInviteJoinAttempted(true);
      socket.emit("joinRoom", { name: name.trim(), code: inviteRoom }, result => {
        if (!result?.ok) {
          setError(result?.error || "Could not join invited room.");
          return;
        }
        localStorage.setItem("ers-player-name", name.trim());
        setRoomCode(result.code);
        setError("");
      });
    };
    if (socket.connected) tryJoin();
    else socket.once("connect", tryJoin);
    return () => socket.off("connect", tryJoin);
  }, [inviteRoom, hasSavedPlayerName, name, roomCode, inviteJoinAttempted]);

  const playSound = correct => {
    const sound = feedbackSounds[correct ? "success" : "penalty"];
    try {
      sound.pause();
      sound.currentTime = 0;
      const playback = sound.play();
      const stopAtDuration = () => window.setTimeout(() => {
        sound.pause();
        sound.currentTime = 0;
      }, FEEDBACK_DURATION_MS);
      if (playback?.then) playback.then(stopAtDuration).catch(() => {});
      else stopAtDuration();
    } catch { /* Audio is optional. */ }
  };

  const me = state?.players.find(p => p.id === socket.id);
  const isHost = state?.players[0]?.id === socket.id;
  const isMyTurn = state?.turnPlayerId === socket.id;
  const winner = state?.players.find(p => p.id === state?.winnerId);
  const canSlap = state?.status === "playing" && state.myCards > 0 && state.pile.length >= 2;
  const canPlay = state?.status === "playing" && isMyTurn && state.myCards > 0;

  const act = (event, payload = {}) => {
    setError("");
    setNotice("");
    socket.emit(event, payload, result => {
      if (!result?.ok) setError(result?.error || "Something went wrong.");
      else if (event === "slap") {
        setNotice(result.correct ? `Correct slap: ${result.pattern}!` : `Wrong slap: +${result.penalty} penalty cards.`);
        setFeedback(result.correct ? "success" : "penalty");
        playSound(result.correct);
      }
    });
  };

  const create = () => {
    if (!name.trim()) return setError("Enter a player name.");
    socket.emit("createRoom", { name }, result => {
      if (!result?.ok) return setError(result?.error || "Could not create room.");
      localStorage.setItem("ers-player-name", name.trim());
      setRoomCode(result.code);
      window.history.replaceState({}, "", result.invitePath || `/?room=${result.code}`);
      setError("");
    });
  };

  const join = () => {
    if (!name.trim() || !roomInput.trim()) return setError("Enter your name and room code.");
    const cleanName = name.trim();
    socket.emit("joinRoom", { name: cleanName, code: roomInput }, result => {
      if (!result?.ok) return setError(result?.error || "Could not join room.");
      localStorage.setItem("ers-player-name", cleanName);
      setRoomCode(result.code);
      window.history.replaceState({}, "", result.invitePath || `/?room=${result.code}`);
      setError("");
    });
  };

  const keyName = key => key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;

  const inviteUrl = roomCode ? `${window.location.origin}/?room=${roomCode}` : "";

  const copyInviteLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setNotice("Invite link copied.");
    } catch {
      setNotice(inviteUrl);
    }
  };

  if (!state || !roomCode || !me) {
    return <main className="landing">
      <div className="brand"><span className="brand-mark">♠</span><span>TABLE<span className="muted">/</span>SLAP</span></div>
      <section className="panel landing-panel">
        <p className="eyebrow">REAL-TIME MULTIPLAYER</p>
        <h1>Egyptian Rat Screw</h1>
        <p className="sub">Flip blind. Watch the pile. Slap when you spot a pattern.</p>
        <label>Your display name</label>
        <input value={name} onChange={e => setName(e.target.value)} maxLength={18} placeholder="e.g. Alex" />
        <button className="primary full" onClick={create}>Create a room</button>
        <div className="or"><span>{inviteRoom ? `INVITED TO ROOM ${inviteRoom}` : "OR JOIN A ROOM"}</span></div>
        <input value={roomInput} onChange={e => setRoomInput(e.target.value.toUpperCase())} maxLength={5} placeholder="ROOM CODE" readOnly={Boolean(inviteRoom)} />
        <button className="secondary full" onClick={join}>{inviteRoom ? "Join invited room" : "Join room"}</button>
        {error && <p className="error">{error}</p>}
        <p className="tiny">2–40 players · Two copies of each number (0–9) · No one can see their own cards</p>
      </section>
    </main>;
  }

  return <main className="game-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">♠</span><span>TABLE<span className="muted">/</span>SLAP</span></div>
      <div className="room-pill">ROOM <strong>{roomCode}</strong><button onClick={copyInviteLink} aria-label="Copy invite link">Copy invite</button></div>
    </header>

    <div className="game-layout">
      <aside className="sidebar panel">
        <div className="section-head"><span>PLAYERS</span><span>{state.players.length}</span></div>
        {state.players.map((p, i) => <div className={`player-row ${p.id === socket.id ? "self" : ""} ${p.id === state.turnPlayerId ? "turn" : ""}`} key={p.id}>
          <div className="avatar">{p.name.slice(0,1).toUpperCase()}</div>
          <div className="player-meta"><strong>{p.name}{p.id === socket.id ? " (You)" : ""}</strong><small>{p.count === 0 ? "Out of cards" : p.id === state.turnPlayerId ? "Playing next" : p.connected ? "In game" : "Disconnected"}</small></div>
          <div className="count">{p.count}</div>
        </div>)}
        <div className="legend"><span className="dot"></span> Current turn</div>
      </aside>

      <section className={`table-area ${feedback}`} style={{ "--feedback-duration": `${FEEDBACK_DURATION_MS}ms` }}>
        {feedback && <div className={`impact-overlay ${feedback}`} aria-live="assertive"><span>{feedback === "success" ? "SLAP WIN!" : "BAD SLAP!"}</span><small>{feedback === "success" ? "YOU CLAIMED THE PILE" : "PENALTY CARDS ADDED"}</small></div>}
        <div className="table-status">
          <span className={`status-dot ${state.status === "playing" ? "live" : ""}`}></span>
          {state.status === "lobby" ? "WAITING IN LOBBY" : state.status === "finished" ? "GAME OVER" : "GAME IN PROGRESS"}
        </div>

        {state.status === "lobby" ? <div className="panel lobby-card">
          <p className="eyebrow">ROOM {roomCode}</p><h2>Waiting for players</h2>
          <p className="sub">Share this invite link. Anyone who opens it can join this room.</p>
          <div className="big-code">{roomCode}</div>
          <a className="invite-url" href={inviteUrl}>{inviteUrl}</a><button className="secondary" onClick={copyInviteLink}>Copy invite link</button>
          {isHost ? <button className="primary" disabled={state.players.length < 2} onClick={() => act("startGame")}>Start game</button> : <p className="tiny">Waiting for the host to start…</p>}
        </div> : <>
          <div className={`middle-pile ${feedback}`}>
            <div className="pile-label">MIDDLE DECK <span>{state.pile.length} cards</span></div>
            {state.pile.length ? <div className="card-fan">
              {state.pile.slice(-3).map((card, i) => <div className={`playing-card ${card.hidden ? "hidden-card" : ""}`} key={`${card.id || "hidden"}-${state.pile.length}-${i}`} style={{ transform: `rotate(${(i - 1) * 5}deg) translateY(${Math.abs(i - 1) * 3}px)` }}>
                {card.hidden ? <span>?</span> : <span>{card.value}</span>}
              </div>)}
            </div> : <div className="empty-pile">Cards played will appear here</div>}
            <div className="pile-total">{state.pile.length} <small>TOTAL CARDS</small></div>
          </div>
          <div className="my-hand panel">
            <div><span className="eyebrow">YOUR HAND</span><h2>{state.myCards} <small>cards remaining</small></h2></div>
            <div className="back-stack"><div></div><div></div><div></div></div>
            <button className="primary play-btn" disabled={!canPlay} onClick={() => act("playCard")}>
              {state.myCards === 0 ? "YOU ARE OUT OF CARDS" : isMyTurn ? "PLAY A RANDOM CARD" : "WAIT FOR YOUR TURN"}
            </button>
          </div>
          <button className="slap-btn" disabled={!canSlap} onClick={() => act("slap")}>
            <span>SLAP THE PILE</span><small>{state.myCards === 0 ? "You are out of cards" : state.pile.length < 2 ? "Need at least 2 cards in the pile" : "Claim the middle deck"}</small>
          </button>
          {state.status === "finished" && <div className="panel result"><h2>{winner ? `${winner.name} wins!` : "Game over"}</h2><p>{state.lastAction}</p></div>}
        </>}
        {state.lastAction && <div className="activity">{state.lastAction}</div>}
        {notice && <div className="notice">{notice}</div>}
        {error && <div className="error">{error}</div>}
      </section>
    </div>

    <section className="rules panel">
      <div className="section-head"><span>QUICK RULES</span><button className="settings-toggle" onClick={() => setShowSettings(v => !v)}> {showSettings ? "Hide settings" : "Controls & settings"} </button></div>
      <div className="rule-grid">
        <div><b>1. Play</b><p>On your turn, play one random card. You cannot see your own cards.</p></div>
        <div><b>2. Watch</b><p>Everyone can see the face-up middle pile and spot a valid pattern.</p></div>
        <div><b>3. Slap</b><p>Slap at any time. A correct slap wins the whole middle pile.</p></div>
        <div><b>4. Penalty</b><p>A wrong slap adds up to 2 cards from your hand face-down to the middle pile.</p></div>
      </div>
      <p className="patterns"><strong>Valid slaps:</strong> Doubles · Sandwich · Three consecutive numbers (ascending or descending, no wraparound) · Two cards adding up to 10.</p>
      {showSettings && <div className="settings-row"><div><b>Keyboard shortcuts</b><p>Shortcuts are saved in this browser. Click a key and press its replacement.</p><a className="sound-preview-link" href="https://pixabay.com/sound-effects/people-crowd-cheer-applause-victory-fanfare-clapping-236698/" target="_blank" rel="noreferrer">Preview crowd-cheer victory sound ↗</a></div><button className="secondary" onClick={() => setRemapping("slap")}>Slap: {keyName(keys.slap)} {remapping === "slap" ? "— press key…" : ""}</button><button className="secondary" onClick={() => setRemapping("play")}>Play: {keyName(keys.play)} {remapping === "play" ? "— press key…" : ""}</button><button className="secondary" onClick={() => { const defaults = { slap: " ", play: "Enter" }; setKeys(defaults); localStorage.setItem("ers-keys", JSON.stringify(defaults)); setRemapping(""); }}>Reset</button></div>}
    </section>
  </main>;
}

export default App;
