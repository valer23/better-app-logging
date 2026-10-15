# Bundled fonts

Variable woff2 subsets (latin, latin-ext) from Fontsource 5.3.0, served from `/assets/fonts/`
(see `fonts.css`). All four families are under the SIL Open Font License 1.1; the licence
texts are the `OFL-*.txt` files, copied from each package's `LICENSE`.

CI re-hashes every file (`sha256sum -c SHA256SUMS` in this folder). To update a family,
download the new version under a new versioned file name, then update `fonts.css`, the
preload links in `viewer/applogs-viewer.html`, `FILES` in `src-tauri/src/viewer_assets.rs`,
`SHA256SUMS` and this table.

| File | Upstream | SHA-256 |
|---|---|---|
| `atkinson-hyperlegible-mono-5.3.0-latin-ext.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-mono@5.3.0/files/atkinson-hyperlegible-mono-latin-ext-wght-normal.woff2 | `3fa1fa7e990377c87018d62f356cc42b8db39fd88cee5724431e9f0d63b7f32f` |
| `atkinson-hyperlegible-mono-5.3.0-latin.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-mono@5.3.0/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2 | `2706b1ee4f452e744ea91f7e4908cbde9c5d35521bf5ffffc71a382a2de89613` |
| `atkinson-hyperlegible-next-5.3.0-latin-ext.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-next@5.3.0/files/atkinson-hyperlegible-next-latin-ext-wght-normal.woff2 | `7dae0c6c66af1aec82e096186aeb1f0e6fa36ab8061ed65422f2b7daf4dd93f3` |
| `atkinson-hyperlegible-next-5.3.0-latin.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-next@5.3.0/files/atkinson-hyperlegible-next-latin-wght-normal.woff2 | `18b2a1a39a2fa298b0ba5390aca68462669826c90925656f1c1f6796e0e1bbaf` |
| `geist-5.3.0-latin-ext.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/files/geist-latin-ext-wght-normal.woff2 | `824f485b5d26e2f2da3c2b236132ece1bc8e4e43373452950bb0e40548b4313f` |
| `geist-5.3.0-latin.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/files/geist-latin-wght-normal.woff2 | `19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1` |
| `jetbrains-mono-5.3.0-latin-ext.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-ext-wght-normal.woff2 | `79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e` |
| `jetbrains-mono-5.3.0-latin.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-wght-normal.woff2 | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |
| `OFL-atkinson-hyperlegible-mono.txt` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-mono@5.3.0/LICENSE | `05327050630a640eb824c8fcb7de8b2e605600d8863e4f531ca7c348239916c6` |
| `OFL-atkinson-hyperlegible-next.txt` | https://cdn.jsdelivr.net/npm/@fontsource-variable/atkinson-hyperlegible-next@5.3.0/LICENSE | `474a034e99845062f661855caaa505880d0e9009deddc2727a92795eab374955` |
| `OFL-geist.txt` | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/LICENSE | `71609cbb5c78b5870d712eab73a31d76622635c6ed034ab5cee3b9ecbda8685f` |
| `OFL-jetbrains-mono.txt` | https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/LICENSE | `403581b69dac5cff4079205e01c6b467e56af449ecbd7247693ddb1baafa005b` |
