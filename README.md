# GFun

Desktop-first 3D assembly platform for aluminum extrusion and profile design.

## Monorepo Layout

- `apps/desktop`: Electron desktop shell (TypeScript)
- `services/cad-api`: Python FastAPI service for CAD operations
- `packages/contracts`: Shared JSON schemas for command and response contracts
- `GFA-802G.step`: Example source part file

## Current Implementation Stage

This repository currently contains foundational scaffolding for:

- Desktop CAD-style shell startup (tool ribbon, panelized workspace, command palette)
- Three.js viewport with STEP loading flow
- CAD API health plus model upload/list/content endpoints
- Prototype command loop for length edits and snap constraints with operation timeline
- Shared import/BOM command schemas

## Next Build Targets

- STEP import pipeline and model registry
- Editable operation graph (length/feature edits)
- Constraint solver integration
- BOM extraction and export