# SKY PUSH — MVP prototype

**▶ Play it live: <https://sky-push.netlify.app>**
· mirror: <https://sol1deo.github.io/sky-push/>
· source: <https://github.com/sol1deo/sky-push>

First-person **clip-farm** party brawler: fast movement, instant bullets,
momentum-scaled knockback, cinematic ragdolls — built so a future **match
editor** (free cam / keyframes / POV replays) has something worth filming.

**The core rule: momentum = power.** Knockback scales with the *shooter's*
speed at fire time. The crosshair grows and shifts color as your shots get
scarier.

## How to run

Open **`index.html`** in Chrome/Edge/Firefox. No build, no server. Click PLAY
for a bot match — or go **🌐 ONLINE**.

## Multiplayer (real, browser-to-browser)

Peer-to-peer over WebRTC (PeerJS + its free public signaling cloud — no
account, no hosted server):

**Playing with a friend:** the game is deployed at
**<https://sky-push.netlify.app>** and mirrored at
**<https://sol1deo.github.io/sky-push/>** (use whichever isn't blocked
on your network — they interconnect, so one player can be on each).
Send a link, one of you hits 🌐 ONLINE → CREATE PRIVATE, shares the
4-letter code, the other JOINs (or both QUICK JOIN into the same public
lobby). No server, no account — the sites serve static files and gameplay
is P2P. Deploying updates: `git push` rebuilds the GitHub Pages mirror
automatically; `netlify deploy --prod --dir <staging>` updates Netlify.

- **Nickname** prompt on first online visit (stored locally, editable).
- **QUICK JOIN** probes the public lobby slots and joins the first open one —
  or creates a fresh public lobby if none exist.
- **CREATE PRIVATE** gives a 4-letter code to share; **JOIN** takes a code.
- In the **lobby**: player list, host picks map, mode & match rules (first-to-N
  rounds, lives, crown seconds — selection live-previews for everyone),
  optional bot-fill, START. The same rule selectors exist for bot matches.

Architecture: host-authoritative rules (lives, KOs, respawns, rounds, crown,
overtime, map events, loot), client-simulated movement + bullets streamed at
20 Hz, shooter-reported hits arbitrated by the host, interpolated remote
pawns. See `js/net.js`. Debug: open two browsers with
`?nethost=ABCD` / `?netjoin=ABCD`; add `?relay` to force TURN-only.

### Cross-country / strict-NAT play (TURN relay)

If both of you can CREATE lobbies but JOIN times out, both networks have
strict NATs and the P2P link needs a **TURN relay**. There is no reliable
free keyless TURN service anymore, so bring your own (2 minutes, free):

1. Create a free app at <https://www.metered.ca> (50 GB/month TURN free) —
   or any TURN provider.
2. Put its credentials URL into `TURN_FETCH_URL` at the top of `js/net.js`:
   `https://<app>.metered.live/api/v1/turn/credentials?apiKey=<KEY>`
   (this key is designed to be public in client code), or put static
   credentials into `TURN_STATIC`.
3. Redeploy. Both players automatically pick up the relay; verify with
   `?relay` (forces every connection through TURN).

Without TURN, STUN-only still connects the majority of NAT pairs — just not
the strict ones.

## Settings (menu and pause screen)

Every action rebindable (keys or mouse buttons), mouse sensitivity, FOV,
render scale, shadow quality (applies live), vignette toggle, FPS counter.
Persisted in localStorage.

## UI

Minimal design language: Inter (embedded, OFL), uppercase letterspaced
labels, hairline dividers, translucent blurred panels, white-pill selections.
No decorative chrome — everything in `index.html`'s stylesheet. The Tab
scoreboard shows per-player **ping** in online games.

## Maps — each with its own mood and a scripted EVENT

| Map | Setting | Event |
|---|---|---|
| **SKY** | golden-hour floating platforms | OVERTIME crumbles the outer platforms |
| **YACHT** | mega-yacht at sea — multi-deck elevation (main deck, bridge, sun roof, helipad, chase boat); water = KO | **BIG WAVE** — the whole deck lurches sideways |
| **CONVOY** | warm-afternoon highway — fight ON three semi-trucks driving forever | **BREAKDOWN** — a truck brakes, falls behind, catches back up |
| **FOUNDRY** | amber lava cavern | **ERUPTION** — telegraphed geysers launch everyone nearby |
| **ROOFTOPS** | blue-hour night, neon signs, plank bridges | **WIND GUST** — 2.5 s sideways shove |
| **TEMPLE** | bright daylight ruins with a walkable roof | **LIGHTNING** — telegraphed strike, big radial knock |
| **TERMINAL** | big cargo-port arena (two bomb sites, catwalk spine, container stacks) | none — it's the competitive map |

Events fire every ~10–20 s, twice as often in OVERTIME (45 s into a round).

## BOMB mode (CS-style, with ring-outs)

Attackers vs defenders (4v4, bots fill), on **Terminal**. **Buy phase** (8 s,
frozen — menu opens automatically, B toggles, click or press 1–0), then live:
the bomb carrier holds **X** on site A/B to plant (3.2 s); defenders hold X on
the bomb to defuse (5 s). Bomb pops in 35 s and yeets everyone near the site.
No respawns within a round; ring-outs count as kills. **Economy**: $800 start,
$300/kill, $300 plant, $3250 win / $1900 loss — spend it on the 7-weapon
arsenal and grenades. First to 4 round wins. Online play of this mode is
experimental.

## Replay editor (V)

The clip-farm dream, v2. The game constantly records the **last 30 s** of the
round (60 Hz snapshots of every player — including the ragdoll particles —
plus every effect and bullet). Press **V** mid-round (or at round/match end)
to open the editor:

- **Cursor-first UI** — the cursor is always visible; **hold LMB** on the
  world to look around, release to get the cursor back.
- **Timeline** — scrub, play/pause (Space), 0.25×–2× speeds, **wheel over the
  timeline zooms** for precise placement (double-click resets), `,` / `.`
  step single frames, Shift+arrows step 0.1 s.
- **Cameras** — **Free** fly (WASD + E/Q, Shift fast, wheel = FOV), **POV**
  of any player (shows their **viewmodel**, with a toggleable **crosshair** —
  the ⌖ pill), **Orbit** around them (wheel = distance), and **Keys**.
- **Keyframes** — **K** (or + Key) drops a camera key at the playhead;
  dropping on an existing key **overrides** it. Keys on the timeline are
  **clickable** (select + seek), **drag-able**, and deletable (Del key,
  Del button, or right-click). Adding a key never locks your movement —
  the path only drives the camera during playback/scrub in Keys mode.
- **Depth of field** — the DoF pills: **Auto** focuses the selected player
  (or whoever the POV player looks at), **Focus** gives a manual focus
  slider; Blur controls strength. Focus/blur are captured into camera
  keyframes and interpolate during Keys playback (focus pulls!).
- **H** hides the UI for clean footage, Esc exits. Offline matches only for
  now; the map itself stays frozen during playback.

## Match history (menu ▸ MATCHES)

CSGO-style demos: every finished round — **offline AND online** — archives
its replay buffer (map, mode, roster, winner, KO counts + the full 30 s clip;
each peer records its own local view). Moving platforms (Convoy trucks, the
Yacht chase boat, elevators) are recorded too and move during playback. The
**MATCHES** rail tab lists recent rounds — **WATCH** opens any of them in the
replay editor straight from the menu. History persists across reloads via
IndexedDB (last 10 rounds; falls back to session-only where unavailable).

## Grenades (G)

Everyone spawns with 2 **HE** in party modes; packs come from death rewards
or the bomb buy menu: **HE** (timed blast), **FIRE POOL** (ignites the ground,
repeatedly launches anyone standing in it), **VORTEX** (pulls everyone toward
its center for 2.6 s).

## Menu & servers

Left-rail navigation (Play / Online / Servers / Settings) with panels in the
center and the selected map previewing behind everything. The **Servers** tab
scans the public lobby slots and lists each one with its map, mode and player
count — join straight from the list.

## Gunplay (fast projectiles)

Bullets are glowing tracer darts with **real travel time** — near-instant up
close, dodgeable at range. Each gun's `projSpeed` sets the dial: pistol 46 m/s,
rifle 58, shotgun 36, **sniper 160** (near-hitscan), mega 68. Bullets leave
the **actual gun barrel** (viewmodel tip / the avatar's gun) and converge
onto the crosshair aim point. Every weapon has **ammo + reload** (R, or auto
when dry — the viewmodel does a backflip spin while reloading). **RMB
aims/zooms** — the 🎯 Longshot gets a full scope (no-scopes spray wild).
**Headshots** hit ~2× harder on a dedicated hitbox. **Any solid hit pops a
grounded victim airborne** (`TUNING.knock.groundPop`) so running along the
floor is no defense — friction can't eat the push. You **start with the Pop
Pistol**; the rest comes from death-reward cards (untimed pick, 1/2/3 or click).

## Ragdolls

Custom verlet puppet: **headshot** → crumple, flop, stand back up; **any hit
while airborne** → limp ragdoll until close to the ground. Ragdolled players
are stunned; the gameplay capsule stays authoritative. `TUNING.ragdoll`.

## Modes & rules

First to 2 round wins. **LAST STANDING** (3 lives, kill plane) or **CROWN
RUSH** (hold 👑 25 s total, infinite lives). Death rewards: weapons, powerups
(Speed Demon, Quick Hands, Long Arm, Moon Boots, Heavyweight) and abilities
(Double Jump, Air Dash on F); rarity improves with deaths. There is a 0.75 s
weapons-hold after GO! so nobody gets blasted at spawn.

## Controls

WASD move · Space jump (hold = bhop) · C slide · LMB fire · RMB aim/zoom ·
R reload · E grapple (hold to reel — a real pendulum rope: slack sags, taut
swings; grabs vehicles, and **hooking a player yanks THEM to YOU**) · Q air
cannon (blast-jump) · F dash (if earned) · 1/2/3 pick reward · T taunt ·
V replay editor · P reset · Tab scoreboard · Esc pause — **all rebindable
in ⚙ settings**.

## Cinematic rendering (cheap on purpose)

No post-processing — bloom was tried and rejected (overexposed + slow).
Instead: ACES tone mapping + **per-map mood lighting**, all tuned bright
enough to actually play: golden hour (Sky), warm late afternoon (Convoy),
amber forge glow (Foundry), blue-hour night with neon (Rooftops), sunset
storm (Temple). Gradient sky domes, colored fog, emissive accents, CSS
vignette. Pixel ratio capped at 1.5. Knobs: each map's `mood()` call in
`js/map.js`.

## Code map

Plain scripts, global `SKY`, physics at fixed 120 Hz:

| File | Owns |
|---|---|
| `js/config.js` | **all tuning** |
| `js/pawn.js` | movement physics, ammo/reload, ragdoll state machine |
| `js/characters.js` | stylized human puppets: FK animation + verlet ragdoll |
| `js/weapons.js` | projectile bullets, knockback, air cannon |
| `js/effects.js` | weapon models, tracers, muzzle light, particles, viewmodel |
| `js/map.js` | all seven maps, mood lighting, sky domes, events |
| `js/replay.js` | ring-buffer recorder + the replay editor (cameras, timeline) |
| `js/net.js` | PeerJS lobbies, host-authoritative sync |
| `js/world.js`, `js/bots.js`, `js/grapple.js`, `js/loot.js`, `js/grenades.js` | collision, AI, hook, rewards, grenades |
| `js/game.js`, `js/hud.js`, `js/audio.js`, `js/input.js`, `js/settings.js`, `js/main.js` | rounds/modes, HUD, synth SFX, input, binds, boot |

## Testing

`index.html?autotest` self-plays and writes a JSON report (incl. `ragdolls`
and a replay-editor smoke test: `replayFrames`/`replayOk`) into
`#boot-status`. Options: `autotest=<sec>`, `&map=convoy|foundry|rooftop|temple`,
`&mode=crown`, `&nopick`, `&noanim`.

## Asset credits

**Inter** font (SIL OFL, embedded) · three.js r147 (MIT) · PeerJS (MIT).
Everything else — characters, weapons, maps, sounds — is generated in code.

## Roadmap

Replay editor v2: replays of **online** matches, recorded map/mover motion
(so Convoy trucks and the Yacht wave move during playback), exporting clips
(WebM via `captureStream`), keyframe editing on the timeline (drag/delete
individual keys). Netcode: move the relay off PeerJS cloud if it ever gets
flaky.
