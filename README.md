# GeoSabotage

A multiplayer GeoGuesser-style game with sabotage mechanics. One player hides by picking a location on the map, and the other players try to guess where it is using 360° street-level panoramas.

## Features

- **Hide & Seek gameplay** – The hider picks a spot on the world map; seekers view a 360° panorama and guess the location.
- **Betting system** – Before guessing, seekers choose a strategy (Safe or Bold) and wager points for higher rewards.
- **Sabotage powers** – Both hiders and seekers can spend points on sabotage abilities:
  - **Ink** – Splash ink blobs on a target's screen
  - **Smoke** – Cover a target's view with fog
  - **Magnetize** – Make a target's map clicks inaccurate
  - **Cleanse** – Remove all sabotage effects on yourself
- **Hints** – Seekers can buy hints (continent, country, region) at a score cost.
- **Heat system** – Hiders earn passive points based on proximity to major cities.
- **Real-time chat** and emoji reactions.

## Setup

```bash
npm install
npm start
```

Open `http://localhost:3000` in your browser.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENWEATHER_API_KEY` | OpenWeather API key for temperature clues |
| `MAPILLARY_ACCESS_TOKEN` | Mapillary API token for 360° panoramas |

## How to Play

1. Create a room and share the room code with friends.
2. The host starts the game.
3. Each round, one player is the **Hider** – they pick a spot on the world map.
4. The remaining players are **Seekers** – they view a 360° panorama and place a guess on the map.
5. Before guessing, seekers can bet on their confidence level.
6. During guessing, players can use sabotage powers or buy hints.
7. Points are awarded based on guess accuracy, betting strategy, and hider bonuses.
8. After all rounds, the player with the most points wins!
