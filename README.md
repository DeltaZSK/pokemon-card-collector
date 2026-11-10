# Pokémon Card Collector

A standalone Pokémon card collector app and value tracker — no build step, no dependencies, just vanilla HTML/CSS/JS.

## What it does

- **Home** — browse all 177 Pokémon TCG sets, grouped by series (newest first), with List/Grid toggle. Grid mode shows circular set symbols with owned-count badges.
- **Set view** — open any set (e.g. Cosmic Eclipse) to see its logo, release date, owned/total progress bar, per-rarity breakdown, and a card grid/list with owned badges. Tap a card for a detail sheet with TCGplayer market prices per finish, finish and condition selectors, quantity stepper, Add to Collection, and Add to Wishes.
- **Search** — search the full catalog by card name, with live TCGplayer market prices.
- **Collection** — your owned cards with quantity, finish, condition, unit price and line total; total value and card count; sort by value, name, or date added.
- **Wishes** — wishlist with prices; move a card to your collection or remove it.
- **Portfolio** — total portfolio value, gain vs. your earliest snapshot, a teal area chart with 1D/7D/1M/3M/6M/ALL ranges, and a Most Valuable top-10 list with % change since each card was added. The **Refresh Prices** button re-fetches TCGplayer prices for owned cards and records a new value snapshot, so chart history builds over time.

## How to run

Just open `index.html` in a browser, or enable GitHub Pages on the repo (Settings → Pages → Deploy from branch) and open the published URL.

## Data & privacy

- Card data, images, and prices come from the free [Pokémon TCG API](https://pokemontcg.io) (`https://api.pokemontcg.io/v2`). **No API key is needed** (1,000 requests/day without one). Prices are TCGplayer market prices; the API occasionally returns a 500/502, so the app retries up to 3 times with backoff.
- Your collection, wishlist, and value snapshots are stored **only in your browser's localStorage** (`pcc_collection_v1`, `pcc_wishlist_v1`, `pcc_snapshots_v1`). Nothing is sent to any server other than the Pokémon TCG API. The collection starts empty.
- Set lists are cached for 6 hours; card lists are cached for the session.

## Files

- `index.html` — app shell and all views
- `styles.css` — dark navy theme
- `app.js` — all logic (API, collection, wishlist, portfolio chart)
- `README.md` — this file
