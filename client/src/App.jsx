import React, { useEffect, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
const FEEDBACK_DURATION_MS = 1000;
const socket = io(SERVER_URL, { autoConnect: true });
const AudioContextClass = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
let feedbackAudioContext = null;
let feedbackBuffersPromise = null;
let feedbackAudioUnlockPromise = Promise.resolve();

function unlockFeedbackAudio() {
  if (!AudioContextClass) return;

  // Create and resume the context inside a real user gesture. Creating it at
  // module load can leave some browsers with a permanently suspended context.
  if (!feedbackAudioContext) feedbackAudioContext = new AudioContextClass();

  if (!feedbackBuffersPromise) {
    feedbackBuffersPromise = Promise.all([
      ["success", "/sounds/slap-success.ogg"],
      ["penalty", "/sounds/slap-penalty.ogg"]
    ].map(async ([name, path]) => {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
      const data = await response.arrayBuffer();
      return [name, await feedbackAudioContext.decodeAudioData(data)];
    })).then(Object.fromEntries).catch(error => {
      console.error("Could not load slap feedback audio:", error);
      return {};
    });
  }

  if (feedbackAudioContext.state !== "running") {
    feedbackAudioUnlockPromise = feedbackAudioContext.resume().catch(error => {
      console.warn("Could not unlock slap feedback audio:", error);
    });
  }
}

// Unlock audio on the first interaction, before a slap acknowledgement arrives.
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", unlockFeedbackAudio, { once: true });
  window.addEventListener("keydown", unlockFeedbackAudio, { once: true });
}

function App() {
  const [inviteRoom] = useState(() => new URLSearchParams(window.location.search).get("room")?.trim().toUpperCase() || "");
  const [sessionIdentity] = useState(() => {
    const savedToken = sessionStorage.getItem("ers-player-token");
    const savedName = sessionStorage.getItem("ers-player-name");
    const savedRoom = sessionStorage.getItem("ers-room-code");
    const isReturningToInvite = Boolean(inviteRoom && savedRoom === inviteRoom && savedToken && savedName);
    const bytes = new Uint8Array(24);
    let token = isReturningToInvite || !inviteRoom ? savedToken : "";
    if (!token) {
      window.crypto.getRandomValues(bytes);
      token = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    }
    sessionStorage.setItem("ers-player-token", token);
    if (inviteRoom && !isReturningToInvite) {
      sessionStorage.removeItem("ers-player-name");
      sessionStorage.removeItem("ers-room-code");
    }
    return {
      token,
      name: inviteRoom && !isReturningToInvite ? "" : (savedName || ""),
      room: isReturningToInvite || !inviteRoom ? savedRoom : ""
    };
  });
  const [name, setName] = useState(sessionIdentity.name);
  const [playerToken] = useState(sessionIdentity.token);
  const [roomInput, setRoomInput] = useState(inviteRoom);
  const [roomCode, setRoomCode] = useState("");
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [feedback, setFeedback] = useState("");
  const [slapFx, setSlapFx] = useState(null);
  const [playFx, setPlayFx] = useState(null);
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
    const rejoinSavedRoom = () => {
      const savedCode = sessionStorage.getItem("ers-room-code");
      const savedName = sessionStorage.getItem("ers-player-name");
      if (!savedCode || !savedName) return;
      socket.emit("joinRoom", { code: savedCode, name: savedName, playerToken }, result => {
        if (!result?.ok) {
          sessionStorage.removeItem("ers-room-code");
          setError(result?.error || "Could not rejoin the previous room.");
          return;
        }
        setRoomCode(result.code);
        setError("");
      });
    };
    socket.on("connect", rejoinSavedRoom);
    if (socket.connected) rejoinSavedRoom();
    return () => socket.off("connect", rejoinSavedRoom);
  }, [playerToken, sessionIdentity.room]);

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
      if (event.key === keys.slap && state?.status === "playing" && state.myCards > 0 && state.pile.length >= 2) { event.preventDefault(); act("slap"); }
      else if (event.key === keys.play && state?.status === "playing" && state.turnPlayerId === socket.id && state.myCards > 0) { event.preventDefault(); act("playCard"); }
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
    if (state?.lastSlap) setSlapFx(state.lastSlap);
  }, [state?.lastSlap?.id]);

  useEffect(() => {
    if (state?.lastPlay) setPlayFx(state.lastPlay);
  }, [state?.lastPlay?.id]);



  const playSound = correct => {
    if (!feedbackAudioContext || !feedbackBuffersPromise) return;
    Promise.all([feedbackBuffersPromise, feedbackAudioUnlockPromise]).then(([buffers]) => {
      const buffer = buffers[correct ? "success" : "penalty"];
      if (!buffer || feedbackAudioContext.state !== "running") {
        console.warn("Slap feedback audio is unavailable or the audio context is not running.");
        return;
      }
      const source = feedbackAudioContext.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = buffer.duration / (FEEDBACK_DURATION_MS / 1000);
      source.connect(feedbackAudioContext.destination);
      source.start();
      source.stop(feedbackAudioContext.currentTime + FEEDBACK_DURATION_MS / 1000);
    }).catch(error => console.error("Could not play slap feedback audio:", error));
  };

  const me = state?.players.find(p => p.id === socket.id);
  const isHost = state?.players[0]?.id === socket.id;
  const isMyTurn = state?.turnPlayerId === socket.id;
  const winner = state?.players.find(p => p.id === state?.winnerId);
  const canSlap = state?.status === "playing" && state.myCards > 0 && state.pile.length >= 2;
  const canPlay = state?.status === "playing" && isMyTurn && state.myCards > 0;
  // Fixed top/bottom seats make the feedback direction deterministic.
  const slapPlayer = slapFx ? state.players.find(p => p.id === slapFx.playerId) : null;
  const slapFromBottom = slapPlayer?.id === socket.id;
  const slapAngle = slapFromBottom ? 0 : 180;
  const slapStart = slapFromBottom ? "42vh" : "-42vh";
  const slapEnd = slapFromBottom ? "90px" : "-90px";
  const playPlayer = playFx ? state.players.find(p => p.id === playFx.playerId) : null;
  const playFromBottom = playPlayer?.id === socket.id;
  const playAngle = playFromBottom ? 0 : 180;
  const playStart = playFromBottom ? "42vh" : "-42vh";

  const act = (event, payload = {}) => {
    if (event === "slap" && !canSlap) return;
    if (event === "playCard" && !canPlay) return;
    if (event === "slap") unlockFeedbackAudio();
    setError("");
    setNotice("");
    const eventPayload = event === "slap"
      ? { pileCardIds: state?.pile?.map(card => card.pileEntryId).filter(Boolean) ?? [] }
      : payload;
    socket.emit(event, eventPayload, result => {
      if (!result?.ok) setError(result?.error || "Something went wrong.");
      else if (event === "slap" && result.stale) {
        setNotice("Slap ignored: the pile had already changed.");
      } else if (event === "slap") {
        setNotice(result.correct ? `Correct slap: ${result.pattern}!` : `Wrong slap: +${result.penalty} penalty cards.`);
        setFeedback(result.correct ? "success" : "penalty");
        playSound(result.correct);
      }
    });
  };

  const create = () => {
    if (!name.trim()) return setError("Enter a player name.");
    socket.emit("createRoom", { name, playerToken }, result => {
      if (!result?.ok) return setError(result?.error || "Could not create room.");
      sessionStorage.setItem("ers-player-name", name.trim());
      sessionStorage.setItem("ers-room-code", result.code);
      setRoomCode(result.code);
      window.history.replaceState({}, "", result.invitePath || `/?room=${result.code}`);
      setError("");
    });
  };

  const join = () => {
    if (!name.trim() || !roomInput.trim()) return setError("Enter your name and room code.");
    const cleanName = name.trim();
    socket.emit("joinRoom", { name: cleanName, code: roomInput, playerToken }, result => {
      if (!result?.ok) return setError(result?.error || "Could not join room.");
      sessionStorage.setItem("ers-player-name", cleanName);
      sessionStorage.setItem("ers-room-code", result.code);
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
        <p className="tiny">2–40 players · Deck size is set by the room host · No one can see their own cards</p>
      </section>
    </main>;
  }

  return <main className="game-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">♠</span><span>TABLE<span className="muted">/</span>SLAP</span></div>
      <div className="room-pill">ROOM <strong>{roomCode}</strong><button onClick={copyInviteLink} aria-label="Copy invite link">Copy invite</button></div>
    </header>

    <section className="game-stage">
      {state.status === "lobby" ? <div className="panel lobby-card">
        <p className="eyebrow">ROOM {roomCode}</p><h2>Waiting for players</h2>
        <p className="sub">Share this invite link. Anyone who opens it can join this room.</p>
        <div className="big-code">{roomCode}</div>
        <a className="invite-url" href={inviteUrl}>{inviteUrl}</a><button className="secondary" onClick={copyInviteLink}>Copy invite link</button>
        <div className="deck-setting">
          <label htmlFor="card-copies">Copies of each number (0–9)</label>
          {isHost ? <select id="card-copies" value={state.cardCopies || 4} onChange={event => {
            const copies = Number(event.target.value);
            socket.emit("setCardCopies", { copies }, result => {
              if (!result?.ok) setError(result?.error || "Could not update deck settings.");
              else setError("");
            });
          }}>{Array.from({ length: 8 }, (_, index) => index + 1).map(copies => <option key={copies} value={copies}>{copies} {copies === 1 ? "copy" : "copies"} · {copies * 10} cards</option>)}</select> : <p className="deck-setting-value">{state.cardCopies || 4} copies · {(state.cardCopies || 4) * 10} cards total</p>}
        </div>
        {state.players.length > 10 * (state.cardCopies || 4) && <p className="error">Not enough cards for all players. Increase copies or remove players.</p>}
        <div className="lobby-players">{state.players.map(p => <span key={p.id}>{p.name}</span>)}</div>
        {isHost ? <button className="primary" disabled={state.players.length < 2 || state.players.length > 10 * (state.cardCopies || 2)} onClick={() => act("startGame")}>Start game</button> : <p className="tiny">Waiting for the host to start…</p>}
      </div> : <>
        <div className={`arena-heading ${state.status === "finished" ? "finished-heading" : ""}`}>
          {state.status === "finished" && <div className="winner-banner">{winner ? `${winner.name} WINS!` : "GAME OVER"}</div>}
          <div><p className="eyebrow">ROOM {roomCode}</p><h2>{state.status === "finished" ? "Round complete" : "Game in progress"}</h2></div>
          <div className="table-status"><span className={`status-dot ${state.status === "playing" ? "live" : ""}`}></span>{state.status === "finished" ? "GAME OVER" : "GAME IN PROGRESS"}</div>
        </div>
        <div className="arena" style={{ "--player-count": state.players.length }}>
          <div className="opponent-seats" aria-label="Other players">
            {state.players.filter(p => p.id !== socket.id).map(p => <div className={`arena-player compact-seat ${p.id === state.turnPlayerId ? "turn" : ""} ${!p.connected ? "disconnected" : ""}`} key={p.id}>
              <div className="human-avatar"><span className="human-head"></span><span className="human-body"></span></div>
              <strong title={p.name}>{p.name}</strong>
              <span className="player-card-count">{p.count}<small>CARDS</small></span>
              {p.id === state.turnPlayerId && <span className="turn-indicator">TURN</span>}
            </div>)}
          </div>
          <div className="table-center">
          <div className="middle-pile compact-pile">
            <div className="pile-label">MIDDLE DECK <span>{state.pile.length} cards</span></div>
            {state.pile.length ? <div className="card-fan compact-fan">
              {state.pile.slice(-3).map((card, i) => <div className={`playing-card compact-card ${card.hidden ? "hidden-card" : ""}`} key={`${card.id || "hidden"}-${state.pile.length}-${i}`} style={{ transform: `rotate(${(i - 1) * 6}deg) translateY(${Math.abs(i - 1) * 3}px)` }}>
                {card.hidden ? "?" : card.value}
              </div>)}
            </div> : <div className="empty-pile">Play begins here</div>}
            <div className="pile-total">{state.pile.length}<small>TOTAL</small></div>
          </div>
          </div>
          <div className="self-seat">
            <div className={`arena-player compact-seat self ${me.id === state.turnPlayerId ? "turn" : ""}`}>
              <div className="human-avatar"><span className="human-head"></span><span className="human-body"></span></div>
              <strong title={me.name}>{me.name} (You)</strong>
              <span className="player-card-count">{me.count}<small>CARDS</small></span>
              {me.id === state.turnPlayerId && <span className="turn-indicator">YOUR TURN</span>}
            </div>
          </div>
          {slapFx && <div className="slap-fx-layer" key={`slap-${slapFx.id}`} style={{ "--flight-angle": `${slapAngle}deg`, "--flight-start": slapStart, "--flight-end": slapEnd, "--winner-flight": slapFromBottom ? "38vh" : "-38vh" }}>
            <div className={`slap-hand ${slapFx.type}`}>👆</div>
            {slapFx.type === "penalty" && <div className="flight-cards penalty-flight">{(slapFx.cards || []).map((value, i) => <span key={i} style={{ "--flight-delay": `${i * 90}ms` }}>{value}</span>)}</div>}
            {slapFx.type === "win" && <div className="flight-cards win-flight">{(slapFx.cards || []).map((value, i) => <span key={i} style={{ "--flight-delay": `${i * 10}ms`, "--card-offset": `${(i % 5 - 2) * 3}px` }}>{value}</span>)}</div>}
            <div className={`slap-callout ${slapFx.type}`}>{slapFx.type === "win" ? "PILE CLAIMED" : "PENALTY CARDS"}</div>
          </div>}
          {playFx && <div className="play-fx-layer" key={playFx.id} style={{ "--flight-angle": `${playAngle}deg`, "--flight-start": playStart }}>
            <span className="play-flight-card">{playFx.value}</span>
          </div>}
        </div>
        <aside className="action-rail panel">
          <div className="rail-hand"><span className="eyebrow">YOUR HAND</span><strong>{state.myCards}</strong><small>cards remaining</small></div>
          <button className="primary play-btn" disabled={!canPlay} onClick={() => act("playCard")}>{isMyTurn ? "PLAY CARD" : "WAIT TURN"}</button>
          <button className="slap-btn" disabled={!canSlap} onClick={() => act("slap")}><span>SLAP</span><small>{state.myCards === 0 ? "No cards left" : state.pile.length < 2 ? "Need 2 cards in pile" : "Claim the pile"}</small></button>
        </aside>
        {state.status === "finished" && <div className="panel result"><p>{state.lastAction}</p></div>}
      </>}
      {state.lastAction && <div className="activity">{state.lastAction}</div>}
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}
    </section>

    <details className="rules panel">
      <summary>Slap rules, controls & settings</summary>
      <div className="rule-grid">
        <div><b>1. Play</b><p>On your turn, play one random card. You cannot see your own cards.</p></div>
        <div><b>2. Watch</b><p>Everyone can see the face-up middle pile and spot a valid pattern.</p></div>
        <div><b>3. Slap</b><p>Slap at any time. A correct slap wins the whole middle pile.</p></div>
        <div><b>4. Penalty</b><p>A wrong slap adds up to 2 face-up cards to the middle pile. They can be slapped immediately.</p></div>
      </div>
      <p className="patterns"><strong>Valid slaps:</strong> Doubles · Sandwich · Three consecutive numbers (ascending or descending, no wraparound) · Two cards adding up to 10.</p>
      <div className="settings-row"><div><b>Keyboard shortcuts</b><p>Shortcuts are saved in this browser. Click a key and press its replacement.</p></div><button className="secondary" onClick={() => setRemapping("slap")}>Slap: {keyName(keys.slap)} {remapping === "slap" ? "— press key…" : ""}</button><button className="secondary" onClick={() => setRemapping("play")}>Play: {keyName(keys.play)} {remapping === "play" ? "— press key…" : ""}</button><button className="secondary" onClick={() => { const defaults = { slap: " ", play: "Enter" }; setKeys(defaults); localStorage.setItem("ers-keys", JSON.stringify(defaults)); setRemapping(""); }}>Reset</button></div>
    </details>
  </main>;
}

export default App;
