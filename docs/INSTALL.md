# Installing and running PAM

## Requirements

- Node.js 24 (`node -v` → v24.x), npm 11+.
- PostgreSQL 16 with a role that owns the application database.
- System tools used by the engines (Debian/Ubuntu package names): `poppler-utils tesseract-ocr tesseract-ocr-eng ffmpeg
  libreoffice pandoc imagemagick librsvg2-bin libimage-exiftool-perl sox fluidsynth fluid-soundfont-gm espeak-ng clamav
  apertium apertium-eng-spa python3-numpy` and `pip install pocketsphinx==5.1.1`. Without a tool, the affected operation
  reports `unavailable`; nothing is faked.
- The intake application (E02) runs separately from its own repository (`Secure-Intake-Case-Workflow-Engine`,
  `docs/PAM_INTEGRATION.md` there); link it with `PAM_INTAKE_LINKS`.

## Local installation (from a clean checkout)

```bash
git clone -b feature/pam-completion https://github.com/Justice-For-All-Movement/Public-Accountability-Machine pam
```

```bash
cd pam && cp .env.example .env
```

Edit `.env` (database URL, generated secrets, first administrator), then:

```bash
./scripts/start-local.sh
```

The script installs PAM, clones every engine at the exact revision in `engines.lock.json` (refusing unpinned engines),
migrates every engine's own schema, creates the first administrator and organization once, and serves the application
with its worker at `http://127.0.0.1:8080`. Restarting runs the same command; state is in PostgreSQL and `PAM_DATA_DIR`.

Separate processes are supported: `node src/app/main.ts serve` with `PAM_WORKER=off`, plus one or more
`node src/app/main.ts worker`.

## Tests

```bash
TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/postgres npm run check
```

```bash
TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/postgres npm run test:acceptance
```

Acceptance test A additionally needs the intake app built under `engines/intake` (`npm ci && npm run build` there) and
Playwright with Chromium available to Node.

## Backup and restore

Back up the PostgreSQL database (`pg_dump --format=custom`) and the object store (`PAM_DATA_DIR/objects` or the S3 bucket)
together. After restoring both, verify stored evidence against retained digests from the Evidence screen ("Verify all") or
with the evidence engine's `verifyAll`; acceptance test E performs exactly this, including detection of a corrupted object.

## Deployment

`render.yaml` and `Dockerfile` describe a private deployment (managed PostgreSQL, S3-compatible object storage, web and
worker services). They have **not** been applied or built: no deployment was authorized for billable resources, and no
Docker daemon was available to build the image. Before a hosted deployment: provide the secrets, an S3 bucket, a ClamAV
signature source, private jurisdiction packs and source catalogs, and the intake deployment.
