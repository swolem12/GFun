# GFun - 3D Assembly Design Studio

A desktop-first and web-based 3D CAD platform for designing aluminum extrusions and assemblies. GFun provides an intuitive interface for importing STEP models, editing dimensions, applying constraints, and generating bills of materials.

## 🎯 Features

- **3D Viewport**: Interactive Three.js-based 3D model viewer with orbit controls, pan, zoom, and reset capabilities
- **STEP Model Import**: Load and visualize STEP/STP 3D models with full geometry support
- **Model Library**: Browse and manage imported models with thumbnail previews
- **Dimension Editing**: Edit part lengths and dimensions with visual feedback
- **Constraint System**: Apply and manage constraints between parts and assemblies
- **Operation Timeline**: Track and undo editing operations with an integrated timeline
- **BOM Generation**: Automatically extract and export bills of materials
- **Real-time API**: FastAPI backend for model management and CAD operations
- **Ribbon Interface**: Professional CAD-style toolbar for quick access to tools

## 🏗️ Architecture

This is a **monorepo** containing multiple integrated applications:

- **`apps/desktop`**: Electron-based desktop application (TypeScript)
- **`apps/web`**: Browser-based web application with modern UI
- **`services/cad-api`**: Python FastAPI service for CAD operations and model management
- **`packages/contracts`**: Shared JSON schemas for API contracts

## 🚀 Getting Started

### Prerequisites
- Node.js 16+
- Python 3.8+
- npm or yarn

### Installation

```bash
# Install dependencies for all workspaces
npm install

# Or install specific workspace
cd apps/web
npm install
```

### Running the Development Environment

**Start the CAD API (Python backend):**
```bash
npm run dev:api
```
The API will be available at `http://localhost:8000`

**Start the Desktop Application:**
```bash
npm run dev:desktop
```

**Open the Web Application:**
The web app is in `apps/web/public/` - serve it with any HTTP server:
```bash
cd apps/web/public
python -m http.server 8001
```
Then open `http://localhost:8001` in your browser.

## 📁 Project Structure

```
GFun/
├── apps/
│   ├── desktop/          # Electron app with professional CAD UI
│   └── web/              # Browser-based viewer and editor
├── services/
│   └── cad-api/          # FastAPI backend for CAD operations
├── packages/
│   └── contracts/        # JSON schemas for API contracts
├── 3D Models/            # Sample STEP files for testing
└── docs/                 # Implementation documentation
```

## 🎨 Web UI Components

The web interface includes:

- **Menu Bar**: File operations, edit, view, and help menus
- **Ribbon Toolbar**: Quick access to common tools organized by category
- **Left Panel**: Model library and tree view of imported assemblies
- **3D Viewport**: Central interactive view with geometry display
- **Right Panel**: Properties panel for selected objects and settings
- **View Cube**: Quick orientation selection (Top, Front, Right, etc.)
- **Navigation Controls**: Zoom, Pan, Reset View buttons
- **Status Bar**: Real-time API connection status

## 📊 API Endpoints

The CAD API provides:

- `GET /health` - API health check
- `POST /models/upload` - Upload STEP file
- `GET /models` - List all models
- `GET /models/{id}` - Get model details
- `POST /operations` - Execute CAD operations (edit, constrain, etc.)
- `POST /bom/generate` - Generate bill of materials

## 🔄 Current Implementation Stage

This release includes:

- ✅ Desktop CAD-style shell with professional UI
- ✅ Web-based 3D viewer with Three.js
- ✅ STEP model import and display
- ✅ Model upload and management endpoints
- ✅ Operation timeline for edits and constraints
- ✅ BOM generation schema

## 🎯 Coming Soon

- [ ] Advanced constraint solver
- [ ] Parametric feature editing
- [ ] Assembly relationship management
- [ ] Drawing export (DXF, PDF)
- [ ] Collaborative editing
- [ ] Plugin API for custom tools

## 📝 Sample Models

The `3D Models/` directory contains sample aluminum extrusion files for testing:
- `GFA-802G.step` - Base profile
- `GFJ-*.step` - Various connector and bracket parts
- `GFN-*.step` - Specialized components

## 🛠️ Development

For detailed implementation notes and architecture decisions, see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)

## 📄 License

Proprietary - All rights reserved