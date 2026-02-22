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
- Three.js 3D viewport with full camera controls
- STEP model import pipeline and display
- Model upload, list, and content retrieval endpoints
- Operation timeline for tracking edits and constraints
- Basic dimension editing and constraint application
- JSON schema validation for API contracts

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

**API won't start:**
- Make sure port 8000 is available: `lsof -i :8000`
- Check Python installation: `python3 --version`

**Desktop app won't launch:**
- Clear build: `rm -rf apps/desktop/dist && npm run dev:desktop`
- Check Node version: `node --version`

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