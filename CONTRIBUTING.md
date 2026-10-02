# Contributing

Use Node.js 20 or newer. The project has no runtime dependencies.

```sh
npm ci
npm test
```

Tests use the built-in Node.js test runner. The API cases use a stub request function, so the test suite does not need `gh` or credentials. Keep coverage for missing pages, repeated job IDs, incomplete intervals, and run changes while collection is in progress.

## Demo media

The GIF is recorded from the real CLI fixture by VHS:

```sh
scripts/render-demo.sh
```

The social card is rendered from `assets/social-card.html` with Playwright Chromium. Install Playwright and Chromium outside the repository, then set `PLAYWRIGHT_MODULE` to the Playwright module path and `CHROME_EXECUTABLE` to a Chromium executable before running:

```sh
scripts/render-social-card.sh
```

The card uses local Liberation Sans and Liberation Mono. The VHS tape uses DejaVu Sans Mono. Font notices live under `assets/fonts`. Keep the media tape, scripts, font notices, and generated images together when changing its layout or timing.

## Snapshot reports

Snapshots retain run and job API responses, including repository, workflow, branch, commit, actor, job and step metadata. The CLI does not request log files or save authentication headers. Check the retained metadata before attaching a snapshot to an issue.

## License

By contributing, you agree that your changes are released under the MIT license in [LICENSE](LICENSE).
