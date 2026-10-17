# Hentai Kitsu Bridge

Static Stremio addon on GitHub Pages. A GitHub Action runs daily, pulls the
HentaiStream addon's catalogs, matches titles to Kitsu IDs, and publishes
`manifest.json` + catalog files.

## Setup
1. Create a GitHub repo, upload these files (keep the `.github/workflows` folder).
2. Settings > Pages > Source: **GitHub Actions**.
3. Actions tab > "Build and deploy" > Run workflow (first run takes a while: it matches every title).
4. Install `https://YOURUSER.github.io/YOURREPO/manifest.json` in Stremio.

## Also install
- A Kitsu metadata addon (public one: anime-kitsu.strem.fun). It supplies the detail pages.
- Your scrapers with debrid (Torrentio, Knaben, Prowlarr/Jackett...) directly or via AIOStreams.

## ID sources (priority)
Kitsu > IMDb (needs optional `TMDB_KEY` repo secret) > MAL/AniList (only if `EXTRA_ANIME_IDS=1`).
AniList is used to find adult titles Kitsu lacks, then converted back to a Kitsu ID when possible.
First run resolves up to 1500 new titles; the rest are picked up on the following daily runs.
The cache file is `cache/matches-v2.json`.

## Change the source
Set env `SOURCE_ADDON` in the workflow, or edit `SOURCE_CATALOGS` in build.mjs.
Unmatched titles are cached and retried every 30 days. See `cache/matches.json`.
