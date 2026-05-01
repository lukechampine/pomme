# 🥔 Pomme

A relay game that lives on [Sia](https://sia.storage) decentralized storage.

Start a chain by baking a hot potato, uploading it to your own Sia account, and sending the pass link to a friend. They have 24 hours to pass it on (adding their own artistic flourish) or the chain dies. After 5 hops, the potato cools and everyone wins.

[demo](https://github.com/user-attachments/assets/ad005aa1-ed3c-4121-b846-9f5505d87748)

## How it works

- The server tracks chains and hops, but never holds the artwork — each potato lives as an encrypted object in the holder's own Sia account.
- A pass link encodes a short-lived (24h) Sia share URL alongside a long-lived archive URL. The share URL's TTL is the round timer; if it expires before being retrieved and "passed," the chain dies.
- Each participant signs claims and passes with their unique ed25519 key, so you can't fake a pass or pass to someone who already held the potato.
- To discourage lame gameplay (namely, posting your link to social media in the hopes that at least one person will click it), the chain immediately dies if two different accounts accept your pass -- and you get the blame. Pick your target carefully!

## Running

```
make serve
```

This starts the server on `localhost:8765` serving the static frontend from `web/`.

Flags:

- `-addr` — listen address (default `localhost:8765`)
- `-dir` — web directory (default `web`)
- `-public-url` — public URL used in pass links (defaults to `http://<addr>`)

## License

MIT
