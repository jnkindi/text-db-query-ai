# Releasing

How to publish text-db-query-ai to npm. Releases are published by GitHub Actions with npm trusted publishing (OIDC): there is no npm token in the repository, and every version gets npm provenance.

The workflows:

- `.github/workflows/ci.yml` runs on pull requests and on pushes to `main`.
- `.github/workflows/publish.yml` runs when a `v*` tag is pushed. It builds, tests and packs, publishes that exact tarball, then creates the GitHub release.

## One-time setup

Do these once, before the first release from this workflow (0.1.0). Both need the owner accounts: the npm account that owns the package, with two-factor authentication on, and an admin of the GitHub repository.

### 1. GitHub: private vulnerability reporting

`SECURITY.md` asks reporters to use GitHub Security Advisories, which only works when private vulnerability reporting is enabled.

- In the repository, open **Settings**, then the security section of the sidebar (**Advanced Security**, or **Code security** on older layouts), and enable **Private vulnerability reporting**.
- Or with the GitHub CLI:

  ```bash
  gh api -X PUT repos/jnkindi/text-db-query-ai/private-vulnerability-reporting
  gh api repos/jnkindi/text-db-query-ai/private-vulnerability-reporting   # {"enabled": true}
  ```

- Check that https://github.com/jnkindi/text-db-query-ai/security/advisories/new opens a report form.

While there, enable Dependabot alerts. `.github/dependabot.yml` already proposes weekly updates; it deliberately ignores the `text-db-query-ai-legacy` alias (the 0.0.1 build the compatibility tests compare against), openai majors (openai 7 needs Node 22) and `@types/node` majors.

### 2. GitHub: protect `main`

Recommended: require pull requests for `main` and require these CI checks to pass:

- `Test (Node 22.x)`, `Test (Node 24.x)`, `Test (Node 26.x)`
- `Pack`
- `Consumer install (Node 18.x)` through `Consumer install (Node 26.x)`

### 3. npm: trusted publisher

On npmjs.com, open the package **text-db-query-ai**, then **Settings**, **Trusted Publisher**, **GitHub Actions**, and enter exactly (every field is case-sensitive):

| Field | Value |
|---|---|
| Organization or user | `jnkindi` |
| Repository | `text-db-query-ai` |
| Workflow filename | `publish.yml` |
| Environment name | leave blank (or `npm`, see [Optional: a human approval gate](#optional-a-human-approval-gate)) |
| Allowed actions | tick **npm publish** (settings created after 2026-09-03 allow only `npm stage publish` by default) |

The same with the CLI (npm 11.15.0 or later):

```bash
npm trust github text-db-query-ai --file publish.yml \
  --repo jnkindi/text-db-query-ai --allow-publish --allow-stage-publish
```

npm does not check the setting when it is saved. A mismatch only shows up in the publish job, as `ENEEDAUTH` or `E404`. A setting cannot be edited, only deleted and created again, so do not rename `publish.yml` without recreating it.

**Publish within 48 hours.** A trusted-publisher setting that has not been used for a successful publish within 48 hours of its creation expires, and must then be deleted and created again. Create it only when 0.1.0 is ready to tag.

## Releasing a version

### Before tagging

1. Merge everything for the release into `main` and wait for CI to pass on `main`.
2. Check that `version` in `package.json` is the version you are releasing. The publish workflow fails if the tag does not match it.
3. In `CHANGELOG.md`, replace `Unreleased` in the version heading with the release date (`## [0.1.0] - YYYY-MM-DD`) and commit it.
4. Optionally, check locally what will ship:

   ```bash
   npm ci
   npm run typecheck
   npm run build
   node scripts/check-dts.js
   npm test
   npm pack --dry-run
   ```

   The tarball holds only `package.json` and the `files` whitelist: `dist`, `README.md`, `LICENSE` and `NOTICE`. `CHANGELOG.md` and `SECURITY.md` stay in the repository unless they are added to `files`.

### Tag and push

For 0.1.0, the version is already in `package.json`:

```bash
git checkout main
git pull
git tag v0.1.0
git push origin v0.1.0
```

For later releases, let npm bump the version, commit and tag in one step:

```bash
npm version patch        # or minor; a prerelease: npm version prerelease --preid beta
git push origin main --follow-tags
```

A tag without a `-` (`v0.1.0`) publishes to the `latest` dist-tag; a prerelease tag (`v0.2.0-beta.1`) publishes to `next` and creates a prerelease on GitHub.

### What the publish workflow does

1. **Build, test and pack** (no publish credentials): checks that the tag matches `package.json`, runs `npm ci --ignore-scripts`, `npm audit signatures`, the build, `scripts/check-dts.js` (the public types must not reference the SDKs), the tests, and `npm pack`. It fails if the tarball contains anything outside the whitelist.
2. **Publish**: the only job with `id-token: write`. It checks that npm is 11.5.1 or later (needed for trusted publishing), downloads the tarball from step 1 and runs `npm publish <tarball> --access public --provenance`. No dependency, build or test code runs in this job.
3. **GitHub release**: creates the release for the tag with generated notes, if it does not exist yet. You can paste the CHANGELOG entry into it afterwards.

### After the first successful publish

1. On npmjs.com, open the package **Settings**, **Publishing access**, and choose **Require two-factor authentication and disallow tokens**. From then on, only the trusted publisher (and you, with 2FA) can publish.
2. Delete the old `NPM_TOKEN` repository secret if it still exists (**Settings**, **Secrets and variables**, **Actions**). Nothing uses it.
3. Check the release:

   ```bash
   npm view text-db-query-ai@0.1.0 version dist.integrity
   ```

   The package page on npmjs.com shows a provenance badge linking to the workflow run. In a project that installs it, `npm audit signatures` verifies the signatures and the provenance attestation.

The trusted-publisher setting stays valid after its first successful use; later releases only need a tag.

## Optional: a human approval gate

To require an approval before anything is published:

1. In GitHub, create an environment named `npm` (**Settings**, **Environments**) with required reviewers and a deployment rule that allows only `v*` tags.
2. Uncomment `environment: npm` in the `publish` job of `publish.yml`.
3. Recreate the npm trusted-publisher setting with `npm` as the environment name.

Alternatively, publish to staging only: replace `npm publish` with `npm stage publish` in `publish.yml` and approve each version with 2FA (`npm stage approve <id>`, or on npmjs.com).

## If something goes wrong

- **`ENEEDAUTH` or `E404` in the publish job**: the trusted-publisher setting does not match (user, repository, workflow file name, environment, or the allowed action), or it expired before the first publish. Delete it, create it again, and re-run the failed workflow run or push the tag again.
- **"Tag ... does not match package.json version"**: delete the tag (`git push origin :refs/tags/v0.1.0` and `git tag -d v0.1.0`), fix the version on `main`, and tag again.
- **Tests fail in the publish workflow**: nothing was published. Fix on `main`, move the tag to the fixed commit (delete and push it again), and the workflow runs again.
- **A bad version was published**: publish a fixed patch version, then deprecate the bad one with `npm deprecate text-db-query-ai@<version> "<reason>"`. Unpublishing is limited by npm's policy and breaks installs, so prefer deprecating.

Security fixes follow `SECURITY.md`: agree on a fix and a disclosure date with the reporter, prepare the patch in a private security advisory fork, publish the patch release, then publish the advisory.
