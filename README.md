# GFun - 3D Assembly Design Platform

A **desktop-first** 3D CAD platform for designing and managing aluminum extrusion assemblies. GFun provides professional-grade tools for importing STEP models, editing dimensions, applying constraints, and generating bills of materials.

![GFun Platform](https://img.shields.io/badge/Platform-Desktop%20%7C%20Web-blue)
![Stack](https://img.shields.io/badge/Stack-Electron%20%7C%20FastAPI%20%7C%20Three.js-green)
![Status](https://img.shields.io/badge/Status-Active%20Development-orange)

## 🎯 Key Features

- **3D Viewport**: Interactive Three.js-based viewer with orbit controls, pan, zoom, and view reset
- **STEP Model Import**: Full support for industry-standard STEP files with complete geometry rendering
- **Dimension Editing**: Edit and modify part dimensions with real-time visual feedback
- **Constraint System**: Apply geometric and dimensional constraints between parts
- **Operation Timeline**: Track, manage, and undo editing operations
- **BOM Generation**: Automatically extract and export bills of materials
- **Professional CAD UI**: Tool ribbon, panelized workspace, and command palette

## 🏗️ Architecture

This is a **monorepo** with three main components:

### `apps/desktop` - Electron Desktop Application
- Full-featured desktop CAD shell (TypeScript)
- Professional ribbon toolbar with organized tool categories
- Panelized workspace layout (left panel for models, center viewport, right panel for properties)
- Command palette for quick access to tools
- Integrated Three.js renderer for 3D visualization

### `services/cad-api` - Python FastAPI Backend
The REST API powering CAD operations:
```
GET    /health              # API health check
POST   /models/upload       # Upload STEP file
GET    /models              # List all imported models
GET    /models/{id}         # Get model details and geometry
POST   /operations          # Execute CAD operations (edit dimensions, add constraints)
POST   /bom/generate        # Generate bill of materials from assembly
```

### `packages/contracts` - Shared Schemas
JSON schemas defining command and response contracts for API communication and validation.

## 🚀 Getting Started

### Prerequisites
- **Node.js 16+** (for Electron app and build tools)
- **Python 3.8+** (for CAD API service)
- **npm or yarn** (package managers)

### Quick Start (Recommended)

The easiest way to get started:

```bash
# Clone the repository
git clone https://github.com/swolem12/GFun.git
cd GFun

# Install all dependencies (both Node and Python)
npm install
cd services/cad-api && pip install -e . && cd ../..

# Launch in two terminals:
# Terminal 1:
npm run dev:api

# Terminal 2:
npm run dev:desktop
```

**That's it!** The application will:
- Start the API on `http://localhost:8000`
- Launch the Electron desktop app automatically
- Load sample models from the local library
- Show a working 3D viewer with lighting and shadows

### Installation

```bash
# Clone the repository
git clone <repo-url>
cd GFun

# Install all npm dependencies
npm install

# Install Python dependencies for CAD API
cd services/cad-api
pip install -e .
cd ../..
```

### Running the Development Environment

**Terminal 1: Start the CAD API Service**
```bash
npm run dev:api
```
The API will start at `http://localhost:8000` with interactive docs at `http://localhost:8000/docs`

**Terminal 2: Start the Desktop Application**
```bash
npm run dev:desktop
```
The Electron app will launch automatically with hot-reload support.

## 📁 Project Structure

```
GFun/
├── apps/
│   ├── desktop/              # Electron application
│   │   ├── src/
│   │   │   ├── main.ts       # Main process
│   │   │   ├── preload.ts    # Preload scripts
│   │   │   └── renderer/     # Renderer process & UI
│   │   └── package.json
│   └── web/                  # Web-based viewer (optional)
├── services/
│   └── cad-api/              # FastAPI backend
│       ├── src/cad_api/
│       │   ├── main.py       # FastAPI app entry
│       │   ├── models.py     # Data models
│       │   └── storage.py    # File management
│       └── pyproject.toml
├── packages/
│   └── contracts/            # Shared JSON schemas
│       └── schemas/
├── 3D Models/                # Sample STEP files for testing
├── docs/                     # Implementation documentation
└── README.md
```

## 📊 API Example Usage

### Upload a STEP Model
```bash
curl -X POST "http://localhost:8000/models/upload" \
  -F "file=@3D\ Models/GFA-802G.step"
```

### List All Models
```bash
curl "http://localhost:8000/models"
```

### Generate Bill of Materials
```bash
curl -X POST "http://localhost:8000/bom/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "model_id": "gfa-802g",
    "include_sub_assemblies": true
  }'
```

## 🔄 Current Implementation Status

### ✅ Completed
- Desktop CAD-style application shell with professional UI
- Electron window management with preload/context isolation
- Three.js 3D viewport with full camera controls and shadows
- STEP model import pipeline and display with proper lighting
- Model upload, list, and content retrieval endpoints
- Operation timeline for tracking edits and constraints
- Basic dimension editing and constraint application
- JSON schema validation for API contracts
- **NEW**: Local model library browser
- **NEW**: Auto-configured project ID handling
- **NEW**: Enhanced 3D rendering with better materials and lighting
- **NEW**: Comprehensive error handling and user feedback

### 🚧 In Progress
- STEP geometry rendering optimization
- Advanced constraint solver implementation
- Parametric feature editing system
- Assembly relationship management

### 📋 Planned
- Advanced constraint solver (OpenCascade integration)
- Parametric feature editing with recomputation
- Assembly tree and relationship visualization
- Drawing export (DXF, PDF)
- Collaborative editing features
- Custom plugin API

## 📝 Recent Fixes (February 23, 2026)

See [FIXES.md](FIXES.md) for comprehensive details on recent improvements:

- ✓ Fixed desktop app initialization (now boots with sensible defaults)
- ✓ Improved 3D rendering (better lighting, shadows, materials)
- ✓ Added local model library browser
- ✓ Better error handling and user feedback
- ✓ Robust default project ID handling
- ✓ API robustness improvements

## 🛠️ Development

### Building for Production
```bash
npm run build:desktop       # Build Electron app
```

### Running Tests
```bash
# Coming soon
```

### Troubleshooting

#### Desktop App Won't Launch
```bash
# Clear build and try again:
rm -rf apps/desktop/dist
npm run dev:desktop
```

If you see "renderer HTML not found":
- Build the project: `npm run build:desktop`
- Check that `apps/desktop/src/renderer/index.html` exists

#### API Won't Start or Shows Port Error
```bash
# Check if port 8000 is already in use:
lsof -i :8000

# Kill any process using port 8000, then restart:
npm run dev:api
```

#### "3D renderer unavailable" Message
- Make sure your browser/system supports WebGL
- Update your GPU drivers
- Check browser console (F12) for detailed errors

#### Models Won't Load from Library
- Ensure STEP files exist in the `3D Models/` directory
- Check that filenames end in `.step` or `.stp` (case-insensitive)
- Look at browser console for actual error messages

#### Upload Fails with "Only STEP files supported"
- Verify your file has `.step` or `.stp` extension
- Try renaming files if they have multiple dots
- Check file isn't corrupted by opening in another STEP viewer

For more issues, check the [FIXES.md](FIXES.md) documentation.

## 📚 Sample Models

The `3D Models/` directory includes sample aluminum extrusion components:

- **GFA-802G.step** - Base aluminum profile/extrusion
- **GFJ-*.step** - Various connectors and bracket parts (20+ variants)
- **GFN-*.step** - Specialized components and end caps

These can be used for testing the import pipeline and visualization.

## 📝 Documentation

For detailed implementation notes and architecture decisions, see:
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) - Architectural overview and development plan

## 🔗 Related Technologies

- **Electron** - Desktop application framework
- **Three.js** - 3D graphics and visualization
- **FastAPI** - High-performance Python API framework
- **TypeScript** - Type-safe JavaScript development
- **OpenCascade** - CAD kernel (planned integration)

## 📄 License

Proprietary - All rights reserved