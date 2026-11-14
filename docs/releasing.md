# Releasing

Releases are driven by Git tags and npm Trusted Publishing. The workflow is
`.github/workflows/release.yml`; it does not use a long-lived npm token.

## One-time npm configuration

The npm package must authorize this repository as a Trusted Publisher:

1. Sign in to npm as an owner of `deepseek-crawl`.
2. Open the package's Trusted Publisher settings.
3. Select GitHub Actions and enter:
   - Organization or user: `jsogn`
   - Repository: `deepseek-crawl`
   - Workflow filename: `release.yml`
   - Environment: leave empty

Packages published before Trusted Publishing was configured can add the same
GitHub relationship from the existing package settings.

## Release checklist

1. Update `CHANGELOG.md`.
2. Update the version in `package.json`, `package-lock.json`,
   `src/version.ts`, tests, and current-version documentation.
3. Run `npm run verify`. This formats, lints, type-checks, tests, packs, and
   installs the tarball into an isolated directory.
4. Merge the release changes, push `main`, and wait for every CI matrix job.
5. Create and push the matching annotated tag:

   ```bash
   git tag -a v0.8.1 -m "deepseek-crawl v0.8.1"
   git push origin v0.8.1
   ```

6. The Release workflow validates the tag, runs the full verification suite,
   publishes with provenance, and creates a GitHub Release. A repeated run skips
   a package version that is already on npm and only finishes missing release
   work.
7. Confirm the registry and provenance:

   ```bash
   npm view deepseek-crawl@0.8.1 version dist.integrity dist.attestations
   ```

Do not publish from a local machine with a classic npm token. Pushing the tag is
the explicit release action.
