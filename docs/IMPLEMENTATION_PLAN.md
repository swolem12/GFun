# Implementation Plan (Started)

## Phase 1 Foundation (in progress)

- [x] Monorepo layout created
- [x] Desktop shell scaffolded
- [x] CAD API scaffolded
- [x] Shared schema package scaffolded
- [x] Three.js viewport and STEP mesh loading (desktop shell)
- [x] Model upload/list/content API pipeline
- [ ] Constraint command execution pipeline
- [ ] BOM CSV export endpoint

## Run Locally

### 1) Python API

```bash
cd /workspaces/GFun
python -m venv .venv
source .venv/bin/activate
pip install -e services/cad-api
npm run dev:api
```

### 2) Desktop Shell

```bash
cd /workspaces/GFun
npm install
npm run dev:desktop
```

## Current API Endpoints

- `GET /health`
- `POST /api/v1/models/import`
- `POST /api/v1/models/upload?project_id=...`
- `GET /api/v1/models?project_id=...`
- `GET /api/v1/models/{model_id}/content`
- `GET /api/v1/models/{model_id}/operations`
- `POST /api/v1/commands/execute`
- `POST /api/v1/bom/generate`
