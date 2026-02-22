// ── GFun Design Studio · app.js  v2 ─────────────────────────────────────────
import * as THREE from "./vendor/three/three.module.js";
import { OrbitControls }     from "./vendor/three/OrbitControls.js";
import { TransformControls } from "./vendor/three/TransformControls.js";
import { CSS2DRenderer, CSS2DObject } from "./vendor/three/CSS2DRenderer.js";

const BASE = window.location.origin;
const PROJECT_ID = "default-project";
const ASSEMBLY_ID = "workspace";

// ─────────────────────────────────────────────────────────────────────────────
// occt-import-js – lazy singleton WASM init (window.occtimportjs set by CDN script)
// ─────────────────────────────────────────────────────────────────────────────
let _occtPromise = null;
function getOcct() {
  if (!_occtPromise) {
    if (typeof window.occtimportjs !== "function") {
      _occtPromise = Promise.reject(new Error("occt-import-js not loaded"));
    } else {
      _occtPromise = window.occtimportjs();
    }
  }
  return _occtPromise;
}

/**
 * Fetch a STEP file from url and convert it to a THREE.Group using occt-import-js WASM.
 * Returns a Group containing one Mesh per solid/shell in the STEP file.
 */
async function loadStepGeometry(url) {
  const occt = await getOcct();
  const resp = await fetchWithTimeout(url, {}, 25000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const buffer    = await resp.arrayBuffer();
  const fileBytes = new Uint8Array(buffer);

  // occt-import-js v0.3+ returns plain JS arrays (not WASM vectors):
  //   result.meshes  → Array<{ name, attributes:{position,normal}, index, brep_faces }>
  //   mesh.attributes.position.array → flat Array of float64 (x,y,z triplets)
  //   mesh.index.array               → flat Array of uint32 indices (0-based)
  const result = occt.ReadStepFile(fileBytes, null);
  if (!result || !result.success)
    throw new Error("occt failed to parse STEP file");
  if (!Array.isArray(result.meshes) || result.meshes.length === 0)
    throw new Error("occt returned no meshes");

  const group = new THREE.Group();

  for (let mi = 0; mi < result.meshes.length; mi++) {
    const mesh = result.meshes[mi];
    if (!mesh || !mesh.attributes || !mesh.attributes.position || !mesh.index) continue;

    const posData  = mesh.attributes.position.array; // flat Array, float64, x/y/z triplets
    const normData = mesh.attributes.normal ? mesh.attributes.normal.array : null;
    const idxData  = mesh.index.array;               // flat Array, uint32, 0-based

    const posCount = posData.length;
    const idxCount = idxData.length;
    if (!posCount || posCount % 3 !== 0) continue;
    if (!idxCount || idxCount % 3 !== 0) continue;

    const vertCount = posCount / 3;

    // float64 → Float32 (Three.js needs Float32)
    const positions = new Float32Array(posCount);
    for (let k = 0; k < posCount; k++) positions[k] = posData[k];

    let normals = null;
    if (normData && normData.length === posCount) {
      normals = new Float32Array(posCount);
      for (let k = 0; k < posCount; k++) normals[k] = normData[k];
    }

    // Guard against any degenerate/out-of-range triangles
    const validIdx = [];
    for (let k = 0; k < idxCount; k += 3) {
      const a = idxData[k], b = idxData[k + 1], c = idxData[k + 2];
      if (a >= 0 && a < vertCount && b >= 0 && b < vertCount && c >= 0 && c < vertCount) {
        validIdx.push(a, b, c);
      }
    }
    if (!validIdx.length) continue;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (normals) geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(validIdx), 1));
    geometry.computeBoundingBox();
    if (!geometry.attributes.normal) geometry.computeVertexNormals();

    const threeMesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ metalness: 0.55, roughness: 0.25, envMapIntensity: 0.8 })
    );
    threeMesh.castShadow    = true;
    threeMesh.receiveShadow = true;
    group.add(threeMesh);
  }

  if (group.children.length === 0)
    throw new Error("STEP parse produced no valid mesh geometry");
  return group;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly state
// ─────────────────────────────────────────────────────────────────────────────
const assemblyMap     = new Map();   // sceneKey → { group, name, type, modelId, color, visible, locked }
let   sceneKeyCounter = 0;
let   selectedKey     = null;
let   hydrateInProgress = false;
let   persistAssemblyTimer = null;
let   hoveredKey = null;

// Face Mate tool state
const mateState       = { phase: 'idle', keyA: null, faceA: null };
const mateNormalArrows = [];

// View mode: 'shaded-edges' | 'shaded' | 'wireframe' | 'xray'
let viewMode = 'shaded-edges';

// PBR finish presets
const FINISHES = {
  'default':       { metalness: 0.62, roughness: 0.22, transparent: false, opacity: 1.0, depthWrite: true },
  'metal':         { metalness: 0.94, roughness: 0.10, transparent: false, opacity: 1.0, depthWrite: true },
  'brushed-metal': { metalness: 0.86, roughness: 0.46, transparent: false, opacity: 1.0, depthWrite: true },
  'aluminum':      { metalness: 0.80, roughness: 0.30, transparent: false, opacity: 1.0, depthWrite: true },
  'plastic':       { metalness: 0.04, roughness: 0.64, transparent: false, opacity: 1.0, depthWrite: true },
  'matte':         { metalness: 0.00, roughness: 0.90, transparent: false, opacity: 1.0, depthWrite: true },
  'rubber':        { metalness: 0.00, roughness: 0.96, transparent: false, opacity: 1.0, depthWrite: true },
  'glass':         { metalness: 0.00, roughness: 0.02, transparent: true,  opacity: 0.28, depthWrite: false },
};

const PART_COLORS = [0x4f8ef7, 0xf7874f, 0x4ff7a4, 0xf7e04f,
                     0xc44ff7, 0xf74fa8, 0x4fcdf7, 0xa8f74f];
let   colorIdx = 0;
function nextColor() { return PART_COLORS[colorIdx++ % PART_COLORS.length]; }

// ─────────────────────────────────────────────────────────────────────────────
// Undo / redo
// ─────────────────────────────────────────────────────────────────────────────
const undoStack   = [];
let   undoPointer = -1;

function pushUndo(entry) {
  undoStack.splice(undoPointer + 1);
  undoStack.push(entry);
  undoPointer = undoStack.length - 1;
  refreshUndoButtons();
  pushTimelineChip(entry.label);
}
function undoOp() {
  if (undoPointer < 0) return;
  undoStack[undoPointer].undo();
  undoPointer--;
  refreshUndoButtons();
  refreshTimelineChips();
}
function redoOp() {
  if (undoPointer >= undoStack.length - 1) return;
  undoPointer++;
  undoStack[undoPointer].redo();
  refreshUndoButtons();
  refreshTimelineChips();
}
window.undoOp = undoOp;
window.redoOp = redoOp;

function refreshUndoButtons() {
  const ub = g("undo-btn"); const rb = g("redo-btn");
  if (ub) ub.disabled = undoPointer < 0;
  if (rb) rb.disabled = undoPointer >= undoStack.length - 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────
let activeTool = "select";

// ─────────────────────────────────────────────────────────────────────────────
// Misc state that used to be top-level
// ─────────────────────────────────────────────────────────────────────────────
let leftHidden = false, rightHidden = false;
let pendingFile = null;
const panelStates = { library: true, uploaded: false, assembly: true };

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
const g = id => document.getElementById(id);
const toast = (msg, type = "info") => {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  g("toast-mount").appendChild(el);
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 220); }, 3200);
};
window._toast = toast;
window.toolComingSoon = name => toast(`${name} — coming soon`, "info");

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Register ALL window handlers HERE — before Three.js init — so that inline
// onclick= attributes work even if the WebGL renderer throws during init.
// (function declarations are hoisted in ES modules, so all functions below
//  are already available at this point even though their bodies appear later.)
// ─────────────────────────────────────────────────────────────────────────────
window.removePartFromScene = removePartFromScene;
window.toggleVisibility    = toggleVisibility;
window.toggleLock          = toggleLock;
window.applyTransformInput = applyTransformInput;
window.fitView             = fitView;
window.resetCamera         = resetCamera;
window.setView             = setView;
window.resolveAddScene     = resolveAddScene;
window.clearScene          = clearScene;
window.loadLocalModel      = loadLocalModel;
window.loadUploadedModel   = loadUploadedModel;
window.setTool             = setTool;
window.togglePanel         = togglePanel;
window.toggleSection       = toggleSection;
window.filterBrowser       = filterBrowser;
window.loadLocalModels     = loadLocalModels;
window.ctxAction           = ctxAction;
window.openUploadModal     = openUploadModal;
window.closeUploadModal    = closeUploadModal;
window.handleFileSelect    = handleFileSelect;
window.handleFileDrop      = handleFileDrop;
window.confirmUpload       = confirmUpload;
window.clearMeasure        = clearMeasure;
window.generateBOM         = generateBOM;
window.applyLengthEdit     = applyLengthEdit;
window.applySnap           = applySnap;
window.closeKbModal        = closeKbModal;
window.toggleFileMenu      = toggleFileMenu;
window.fileAction          = fileAction;
window.toggleWireframe     = toggleWireframe;
window.toggleGrid          = toggleGrid;
window.applyPartColor      = applyPartColor;
window.applyPartFinish     = applyPartFinish;
window.setViewMode         = setViewMode;
window.groundSnap          = groundSnap;
window.duplicatePart       = duplicatePart;
window.alignPart           = alignPart;
window.cancelMate          = cancelMate;
window.clearHistory        = clearHistory;

// ─────────────────────────────────────────────────────────────────────────────
// Three.js – renderer, CSS2DRenderer, scene, camera
// ─────────────────────────────────────────────────────────────────────────────
const canvas   = g("three-canvas");
let renderer;
let labelRenderer;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x17171c);
// No fog — professional CAD viewports stay crisp

const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100000);
camera.position.set(450, 300, 450);

let controls;
let xfCtrl;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled   = true;
  renderer.shadowMap.type      = THREE.PCFSoftShadowMap;
  renderer.toneMapping         = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;

  labelRenderer = new CSS2DRenderer({ element: g("css2d-mount") });

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping      = true;
  controls.dampingFactor      = 0.06;
  controls.rotateSpeed        = 0.7;
  controls.panSpeed           = 0.65;
  controls.zoomSpeed          = 1.2;
  controls.screenSpacePanning = true;
  controls.minDistance        = 0.5;

  xfCtrl = new TransformControls(camera, renderer.domElement);
  xfCtrl.size = 0.8;
  const xfHelper = xfCtrl.getHelper?.();
  if (xfHelper) scene.add(xfHelper);
  xfCtrl.addEventListener("dragging-changed", e => { controls.enabled = !e.value; });
  xfCtrl.addEventListener("objectChange", () => {
    if (selectedKey) {
      const entry = assemblyMap.get(selectedKey);
      if (entry) {
        const p = entry.group.position;
        g("tx").value = p.x.toFixed(3); g("ty").value = p.y.toFixed(3); g("tz").value = p.z.toFixed(3);
        g("tscale").value = entry.group.scale.x.toFixed(3);
        queuePersistAssembly();
      }
    }
  });
} catch (error) {
  console.error("3D initialization failed", error);
  toast(`3D initialization failed: ${error.message}`, "err");
  renderer = {
    domElement: canvas,
    shadowMap: { enabled: false, type: null },
    toneMapping: 0,
    toneMappingExposure: 1,
    setPixelRatio: () => {},
    setSize: () => {},
    render: () => {}
  };
  labelRenderer = { setSize: () => {}, render: () => {} };
  controls = {
    enabled: true,
    target: new THREE.Vector3(),
    update: () => {}
  };
  xfCtrl = {
    attach: () => {},
    detach: () => {},
    setMode: () => {},
    addEventListener: () => {},
    size: 0
  };
}

// ── Lighting – professional studio setup (Shapr3D / Fusion 360 style) ───────
scene.add(new THREE.AmbientLight(0x334455, 0.45));
const hemi = new THREE.HemisphereLight(0xc8dcff, 0x1a2030, 1.0); scene.add(hemi);
const keyL = new THREE.DirectionalLight(0xfff5ee, 2.2);
keyL.position.set(400, 600, 350); keyL.castShadow = true;
keyL.shadow.mapSize.set(4096, 4096);
keyL.shadow.camera.near  =   1; keyL.shadow.camera.far   = 8000;
keyL.shadow.camera.left  = keyL.shadow.camera.bottom = -1000;
keyL.shadow.camera.right = keyL.shadow.camera.top    =  1000;
keyL.shadow.bias = -0.0005;
scene.add(keyL);
const fill = new THREE.DirectionalLight(0x5070ff, 0.55); fill.position.set(-600, 300, -400); scene.add(fill);
const rim  = new THREE.DirectionalLight(0xffe0c0, 0.30); rim.position.set(100, -200, -600);  scene.add(rim);
const back = new THREE.DirectionalLight(0xd0e8ff, 0.20); back.position.set(0, 100, -600);   scene.add(back);

// ── Infinite procedural grid (Shapr3D / Fusion 360 / Blender style) ──────────
function createInfiniteGrid() {
  const mat = new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      varying vec3 vWorldPos;
      float gridLine(float c, float sz) {
        float f = abs(fract(c / sz + 0.5) - 0.5) / fwidth(c / sz);
        return clamp(1.0 - f, 0.0, 1.0);
      }
      void main() {
        float minor = max(gridLine(vWorldPos.x, 10.0), gridLine(vWorldPos.z, 10.0));
        float major = max(gridLine(vWorldPos.x, 100.0), gridLine(vWorldPos.z, 100.0));
        float dist  = length(vWorldPos.xz);
        float fade  = 1.0 - smoothstep(600.0, 1400.0, dist);
        vec3  col   = mix(vec3(0.20, 0.20, 0.26), vec3(0.40, 0.40, 0.52), major);
        float alpha = max(minor * 0.25, major * 0.60) * fade;
        // Origin axis lines
        float xFW = max(fwidth(vWorldPos.z) * 0.5, 0.6);
        float zFW = max(fwidth(vWorldPos.x) * 0.5, 0.6);
        float xAxis = clamp(1.0 - abs(vWorldPos.z) / xFW, 0.0, 1.0);
        float zAxis = clamp(1.0 - abs(vWorldPos.x) / zFW, 0.0, 1.0);
        if (xAxis > 0.4) { col = vec3(0.86, 0.26, 0.26); alpha = xAxis * 0.90 * fade; }
        if (zAxis > 0.4) { col = vec3(0.26, 0.50, 0.94); alpha = zAxis * 0.90 * fade; }
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true,
    depthWrite:  false,
    side: THREE.DoubleSide,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y  = 0.01;
  return m;
}
const grid = createInfiniteGrid();
scene.add(grid);

// Shadow receiver – invisible except for soft shadows cast onto it
const groundMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(4000, 4000),
  new THREE.ShadowMaterial({ opacity: 0.22, transparent: true }));
groundMesh.rotation.x = -Math.PI / 2; groundMesh.receiveShadow = true; scene.add(groundMesh);

// Ground plane for raycasting
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

// ─────────────────────────────────────────────────────────────────────────────
// Resize
// ─────────────────────────────────────────────────────────────────────────────
function resize() {
  const vp = g("viewport");
  const w  = vp.clientWidth;
  const h  = vp.clientHeight;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(g("viewport"));
resize();

// ─────────────────────────────────────────────────────────────────────────────
// Animation loop
// ─────────────────────────────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  drawViewCube();
  drawAxisIndicator();
}

// ─────────────────────────────────────────────────────────────────────────────
// ViewCube – camera-aligned isometric projection, clickable face snaps
// ─────────────────────────────────────────────────────────────────────────────
const vc    = g("viewcube");
const vcCtx = vc.getContext("2d");

function projectCubeVert(v3, mat) {
  const v = v3.clone().applyMatrix4(mat);
  return { x: 40 + v.x * 28, y: 40 - v.y * 28, z: v.z };
}

function drawViewCube() {
  vcCtx.clearRect(0, 0, 80, 80);
  const rotM = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse);
  const verts = [
    new THREE.Vector3(-1,-1,-1), new THREE.Vector3( 1,-1,-1),
    new THREE.Vector3( 1, 1,-1), new THREE.Vector3(-1, 1,-1),
    new THREE.Vector3(-1,-1, 1), new THREE.Vector3( 1,-1, 1),
    new THREE.Vector3( 1, 1, 1), new THREE.Vector3(-1, 1, 1),
  ].map(v => projectCubeVert(v, rotM));

  const FACES = [
    { idx:[3,2,6,7], label:"TOP",    base:"rgba(79,142,247,0.22)" },
    { idx:[0,1,2,3], label:"FRONT",  base:"rgba(79,142,247,0.13)" },
    { idx:[1,5,6,2], label:"RIGHT",  base:"rgba(79,142,247,0.10)" },
    { idx:[4,7,6,5], label:"BACK",   base:"rgba(79,142,247,0.08)" },
    { idx:[0,3,7,4], label:"LEFT",   base:"rgba(79,142,247,0.07)" },
    { idx:[4,5,1,0], label:"BOTTOM", base:"rgba(79,142,247,0.05)" },
  ];
  const sorted = FACES.map(f => ({ ...f, avgZ: f.idx.reduce((s,i) => s + verts[i].z, 0) / 4 }))
                      .sort((a, b) => a.avgZ - b.avgZ);

  for (const face of sorted) {
    const pts = face.idx.map(i => verts[i]);
    const e1x = pts[1].x-pts[0].x, e1y = pts[1].y-pts[0].y;
    const e2x = pts[3].x-pts[0].x, e2y = pts[3].y-pts[0].y;
    if (e1x*e2y - e1y*e2x > 0) continue;  // back-face cull
    vcCtx.beginPath();
    vcCtx.moveTo(pts[0].x, pts[0].y);
    for (let k=1;k<pts.length;k++) vcCtx.lineTo(pts[k].x, pts[k].y);
    vcCtx.closePath();
    vcCtx.fillStyle = face.base; vcCtx.fill();
    vcCtx.strokeStyle = "rgba(79,142,247,0.5)"; vcCtx.lineWidth = 1; vcCtx.stroke();
    const cx = pts.reduce((s,p) => s+p.x,0)/pts.length;
    const cy = pts.reduce((s,p) => s+p.y,0)/pts.length;
    vcCtx.fillStyle = "rgba(212,212,216,0.75)";
    vcCtx.font = "bold 7px Inter,sans-serif";
    vcCtx.textAlign = "center"; vcCtx.textBaseline = "middle";
    vcCtx.fillText(face.label, cx, cy);
  }
}

vc.addEventListener("click", e => {
  const r  = vc.getBoundingClientRect();
  const cx = e.clientX - r.left, cy = e.clientY - r.top;
  const rotM = new THREE.Matrix4().extractRotation(camera.matrixWorldInverse);
  const FACE_NORMS = [
    { n: new THREE.Vector3( 0, 1, 0), view:"top"    },
    { n: new THREE.Vector3( 0,-1, 0), view:"bottom" },
    { n: new THREE.Vector3( 0, 0, 1), view:"front"  },
    { n: new THREE.Vector3( 0, 0,-1), view:"back"   },
    { n: new THREE.Vector3( 1, 0, 0), view:"right"  },
    { n: new THREE.Vector3(-1, 0, 0), view:"left"   },
  ];
  let bestView = "iso", bestDist = Infinity;
  for (const { n, view } of FACE_NORMS) {
    const nCam = n.clone().applyMatrix4(rotM);
    if (nCam.z < 0) continue; // back-face cull
    const sx = 40 + nCam.x * 28, sy = 40 - nCam.y * 28;
    const d = Math.hypot(cx - sx, cy - sy);
    if (d < bestDist) { bestDist = d; bestView = view; }
  }
  setView(bestView);
});

// ─────────────────────────────────────────────────────────────────────────────
// Axis Indicator
// ─────────────────────────────────────────────────────────────────────────────
const axisCanvas = g("axis-indicator");
const axisCtx    = axisCanvas.getContext("2d");

function drawAxisIndicator() {
  axisCtx.clearRect(0, 0, 56, 56);
  axisCtx.save();
  axisCtx.translate(28, 28);
  const proj = v => {
    const v4 = new THREE.Vector4(v.x, v.y, v.z, 1);
    v4.applyMatrix4(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    return { x: v4.x / v4.w * 16, y: -v4.y / v4.w * 16 };
  };
  [{ dir: new THREE.Vector3(1,0,0), color:"#f87171", label:"X" },
   { dir: new THREE.Vector3(0,1,0), color:"#4ade80", label:"Y" },
   { dir: new THREE.Vector3(0,0,1), color:"#60a5fa", label:"Z" }].forEach(a => {
    const p = proj(a.dir);
    axisCtx.beginPath(); axisCtx.moveTo(0,0); axisCtx.lineTo(p.x,p.y);
    axisCtx.strokeStyle = a.color; axisCtx.lineWidth = 2; axisCtx.stroke();
    axisCtx.fillStyle = a.color; axisCtx.font = "bold 9px Inter,sans-serif";
    axisCtx.textAlign = "center"; axisCtx.textBaseline = "middle";
    axisCtx.fillText(a.label, p.x*1.4, p.y*1.4);
  });
  axisCtx.restore();
}

animate();

// ─────────────────────────────────────────────────────────────────────────────
// CAD edge lines + highlight helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Attach EdgesGeometry LineSegments to every mesh in a group for CAD look */
function addEdgeLines(group, color = 0x1e1e2e) {
  group.traverse(c => {
    if (!c.isMesh || c.userData.isEdgeLines) return;
    try {
      const edges = new THREE.EdgesGeometry(c.geometry, 18); // 18° crease threshold
      const mat   = new THREE.LineBasicMaterial({ color, linewidth: 1, transparent: true, opacity: 0.7, depthTest: true });
      const lines = new THREE.LineSegments(edges, mat);
      lines.userData.isEdgeLines = true;
      lines.raycast = () => {};             // never picked by raycaster
      lines.visible = (viewMode === 'shaded-edges');
      c.add(lines);
    } catch { /* skip malformed geometry */ }
  });
}

/** Apply selection/hover/none highlight emissive + edge colour to a part group */
function setPartHighlight(key, mode) {
  const entry = assemblyMap.get(key);
  if (!entry) return;
  const emissiveHex = mode === 'selected' ? 0x0d2454 : mode === 'hover' ? 0x071228 : 0x000000;
  const edgeColor   = mode === 'selected' ? 0x5b9cf6 : mode === 'hover' ? 0x2a3d70 : 0x1e1e2e;
  const edgeOpacity = mode === 'selected' ? 0.95 : mode === 'hover' ? 0.85 : 0.70;
  entry.group.traverse(c => {
    if (c.isMesh && c.material && !c.userData.isEdgeLines) {
      c.material.emissive = new THREE.Color(emissiveHex);
      c.material.emissiveIntensity = mode === 'selected' ? 0.8 : mode === 'hover' ? 0.4 : 0;
      c.material.needsUpdate = true;
    }
    if (c.isLineSegments && c.userData.isEdgeLines) {
      c.material.color.setHex(edgeColor);
      c.material.opacity = edgeOpacity;
    }
  });
}

/** Apply current viewMode display style to a single group */
function updateGroupViewMode(group) {
  group.traverse(c => {
    if (c.isLineSegments && c.userData.isEdgeLines) {
      c.visible = (viewMode === 'shaded-edges');
    }
    if (c.isMesh && !c.userData.isEdgeLines) {
      if (viewMode === 'wireframe') {
        c.material.wireframe = true;
        c.material.transparent = false;
        c.material.opacity = 1;
        c.material.depthWrite = true;
      } else if (viewMode === 'xray') {
        c.material.wireframe = false;
        c.material.transparent = true;
        c.material.opacity = 0.22;
        c.material.depthWrite = false;
      } else {
        c.material.wireframe = false;
        c.material.transparent = false;
        c.material.opacity = 1;
        c.material.depthWrite = true;
      }
      c.material.needsUpdate = true;
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Raycaster – selection + measure + ground coords
// ─────────────────────────────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse2D   = new THREE.Vector2();

function ndcFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  mouse2D.x = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
  mouse2D.y = ((e.clientY - rect.top)  / rect.height) * -2 + 1;
}

canvas.addEventListener("mousemove", e => {
  ndcFromEvent(e);
  raycaster.setFromCamera(mouse2D, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, hit)) {
    g("coords-display").textContent =
      `x: ${hit.x.toFixed(2).padStart(10)}  y: ${hit.y.toFixed(2).padStart(10)}  z: ${hit.z.toFixed(2).padStart(10)}`;
  }
  if (measureState.phase === "picking-b" && measureState.ptA) {
    raycaster.ray.intersectPlane(groundPlane, hit);
    updateMeasureLine(hit);
  }

  // Hover highlight (only when not measuring/dragging)
  if (activeTool !== "measure" && !mouseDownPos) {
    const groups = [...assemblyMap.values()].map(v => v.group);
    const hits2  = raycaster.intersectObjects(groups, true);
    let newHover = null;
    if (hits2.length) {
      let obj = hits2[0].object;
      while (obj.parent && !obj.userData.sceneKey) obj = obj.parent;
      if (obj.userData.sceneKey && obj.userData.sceneKey !== selectedKey)
        newHover = obj.userData.sceneKey;
    }
    if (newHover !== hoveredKey) {
      if (hoveredKey && hoveredKey !== selectedKey) setPartHighlight(hoveredKey, 'none');
      hoveredKey = newHover;
      if (hoveredKey && hoveredKey !== selectedKey) setPartHighlight(hoveredKey, 'hover');
      canvas.style.cursor = (hoveredKey && activeTool === 'select') ? 'pointer' : '';
    }
  }
});

// click dispatch (only fire on real clicks not drags)
let mouseDownPos = null;
canvas.addEventListener("mousedown", e => { mouseDownPos = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener("mouseup", e => {
  if (!mouseDownPos) return;
  const dx = e.clientX - mouseDownPos.x, dy = e.clientY - mouseDownPos.y;
  if (Math.hypot(dx, dy) > 4) return;
  handleCanvasClick(e);
  mouseDownPos = null;
});

function handleCanvasClick(e) {
  ndcFromEvent(e);
  raycaster.setFromCamera(mouse2D, camera);
  if (activeTool === "measure") { measureClick(e); return; }
  if (activeTool === "mate")    { mateClick();     return; }
  const groups = [...assemblyMap.values()].map(v => v.group);
  const hits   = raycaster.intersectObjects(groups, true);
  if (!hits.length) { deselectAll(); return; }
  let obj = hits[0].object;
  while (obj.parent && !obj.userData.sceneKey) obj = obj.parent;
  if (obj.userData.sceneKey) selectPart(obj.userData.sceneKey);
  else deselectAll();
}

function deselectAll() {
  if (selectedKey) setPartHighlight(selectedKey, hoveredKey === selectedKey ? 'hover' : 'none');
  selectedKey = null; xfCtrl.detach(); refreshAssemblyPanel(); updateInspector(null);
}

function selectPart(key) {
  if (selectedKey && selectedKey !== key) setPartHighlight(selectedKey, hoveredKey === selectedKey ? 'hover' : 'none');
  selectedKey = key;
  const entry = assemblyMap.get(key);
  if (!entry) return;
  setPartHighlight(key, 'selected');
  xfCtrl.detach();
  if (activeTool === "move")   { xfCtrl.setMode("translate"); xfCtrl.attach(entry.group); }
  if (activeTool === "rotate") { xfCtrl.setMode("rotate");    xfCtrl.attach(entry.group); }
  refreshAssemblyPanel();
  updateInspector(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly management
// ─────────────────────────────────────────────────────────────────────────────
function addPartToScene(name, type, modelId, mesh) {
  const key   = `part_${++sceneKeyCounter}`;
  const color = nextColor();
  const group = new THREE.Group();
  group.userData.sceneKey = key;
  if (mesh) {
    mesh.traverse(c => {
      if (c.isMesh) {
        c.castShadow    = true;
        c.receiveShadow = true;
        c.userData.sceneKey = key;  // propagate for raycasting
        c.material = new THREE.MeshStandardMaterial({ color, metalness:0.62, roughness:0.22, envMapIntensity:0.9 });
      }
    });
    group.add(mesh);
    addEdgeLines(group);           // CAD-style feature edges
  }
  scene.add(group);
  updateGroupViewMode(group);      // apply current display mode
  assemblyMap.set(key, { group, name, type, modelId, color, visible:true, locked:false, finish:'default' });
  refreshAssemblyPanel();
  if (assemblyMap.size > 0) g("viewport-info").style.display = "none";
  queuePersistAssembly();
  return key;
}

function removePartFromScene(key) {
  const entry = assemblyMap.get(key);
  if (!entry) return;
  scene.remove(entry.group);
  assemblyMap.delete(key);
  if (selectedKey === key) { selectedKey = null; xfCtrl.detach(); updateInspector(null); }
  if (hoveredKey === key) hoveredKey = null;
  refreshAssemblyPanel();
  if (assemblyMap.size === 0) g("viewport-info").style.display = "";
  queuePersistAssembly();
}
window.removePartFromScene = removePartFromScene;

function toggleVisibility(key) {
  const e = assemblyMap.get(key); if (!e) return;
  e.visible = !e.visible; e.group.visible = e.visible; refreshAssemblyPanel(); queuePersistAssembly();
}
function toggleLock(key) {
  const e = assemblyMap.get(key); if (!e) return;
  e.locked = !e.locked; refreshAssemblyPanel(); queuePersistAssembly();
}
window.toggleVisibility = toggleVisibility;
window.toggleLock       = toggleLock;

function refreshAssemblyPanel() {
  const list  = g("asm-list");
  const empty = g("asm-empty");
  g("asm-count").textContent = assemblyMap.size;
  list.querySelectorAll(".asm-row").forEach(r => r.remove());
  empty.style.display = assemblyMap.size ? "none" : "";

  for (const [key, entry] of assemblyMap) {
    const row = document.createElement("div");
    row.className = "asm-row" + (key === selectedKey ? " active" : "");
    const hex = "#" + entry.color.toString(16).padStart(6, "0");
    row.innerHTML = `
      <div class="asm-color" style="background:${hex}"></div>
      <span class="asm-name" title="${entry.name}">${entry.name}</span>
      <button class="asm-icon-btn" title="${entry.visible?'Hide':'Show'}" onclick="toggleVisibility('${key}');event.stopPropagation()">
        ${entry.visible
          ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><ellipse cx="6" cy="6" rx="5" ry="3.5" stroke="currentColor" stroke-width="1.1"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>`
          : `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 2l8 8" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M1 6s2-4 5-4 5 4 5 4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`}
      </button>
      <button class="asm-icon-btn" title="${entry.locked?'Unlock':'Lock'}" onclick="toggleLock('${key}');event.stopPropagation()">
        ${entry.locked
          ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="5" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.1"/><path d="M4 5V4a2 2 0 1 1 4 0v1" stroke="currentColor" stroke-width="1.1"/></svg>`
          : `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="5" width="8" height="6" rx="1" stroke="currentColor" stroke-width="1.1"/><path d="M4 5V4a2 2 0 1 1 4 0" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`}
      </button>
      <button class="asm-icon-btn" title="Remove" style="color:var(--err)" onclick="removePartFromScene('${key}');event.stopPropagation()">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      </button>`;
    row.addEventListener("click", () => selectPart(key));
    list.appendChild(row);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inspector panel
// ─────────────────────────────────────────────────────────────────────────────
function updateInspector(key) {
  const card   = g("selection-card");
  const xfSec  = g("transform-section");
  const matSec = g("material-section");
  const dimSec = g("dimensions-section");
  if (!key) {
    card.classList.add("empty");
    xfSec.style.display = "none";
    if (matSec) matSec.style.display = "none";
    if (dimSec) dimSec.style.display = "none";
    g("active-model-bar").textContent  = "";
    g("active-model-bar").style.display = "none";
    g("sb-model-name").textContent = "None";
    return;
  }
  const entry = assemblyMap.get(key);
  if (!entry) return;
  card.classList.remove("empty");
  card.querySelector(".sel-name").textContent = entry.name;
  card.querySelector(".sel-type").textContent = (entry.type === "local" ? "Library" : "Uploaded") + " · STEP";
  xfSec.style.display = "";
  const p = entry.group.position;
  g("tx").value = p.x.toFixed(3); g("ty").value = p.y.toFixed(3); g("tz").value = p.z.toFixed(3);
  g("tscale").value = entry.group.scale.x.toFixed(3);
  g("active-model-bar").textContent  = entry.name;
  g("active-model-bar").style.display = "block";
  g("sb-model-name").textContent = entry.name;

  // Material section
  if (matSec) {
    matSec.style.display = "";
    const hexStr = "#" + (entry.color >>> 0).toString(16).padStart(6, "0");
    const sw = g("mat-color-swatch");  if (sw) sw.style.background = hexStr;
    const hx = g("mat-color-hex");    if (hx) hx.textContent = hexStr;
    const ci = g("mat-color-input");   if (ci) ci.value = hexStr;
    const fi = g("part-finish");       if (fi) fi.value = entry.finish || "default";
  }

  // Dimensions + triangle count
  if (dimSec) {
    dimSec.style.display = "";
    const box = new THREE.Box3().setFromObject(entry.group);
    const sz  = box.getSize(new THREE.Vector3());
    const dEl = g("dims-readout");
    const tEl = g("tris-readout");
    if (dEl) dEl.innerHTML =
      `<div class="dim-row"><span class="dim-label">W</span><span class="dim-value">${sz.x.toFixed(2)} mm</span></div>` +
      `<div class="dim-row"><span class="dim-label">H</span><span class="dim-value">${sz.y.toFixed(2)} mm</span></div>` +
      `<div class="dim-row"><span class="dim-label">D</span><span class="dim-value">${sz.z.toFixed(2)} mm</span></div>`;
    let tris = 0, verts = 0;
    entry.group.traverse(c => {
      if (c.isMesh && c.geometry && !c.userData.isEdgeLines) {
        const idx = c.geometry.index;
        tris  += idx ? idx.count / 3 : (c.geometry.attributes.position?.count || 0) / 3;
        verts += c.geometry.attributes.position?.count || 0;
      }
    });
    if (tEl) tEl.textContent = `${Math.round(tris).toLocaleString()} tri  ·  ${Math.round(verts).toLocaleString()} vtx`;
  }
}

function applyTransformInput(axis, rawVal) {
  const val = parseFloat(rawVal);
  if (isNaN(val) || !selectedKey) return;
  const entry = assemblyMap.get(selectedKey);
  if (!entry || entry.locked) { toast("Part is locked", "warn"); return; }
  const old = { x:entry.group.position.x, y:entry.group.position.y, z:entry.group.position.z, s:entry.group.scale.x };
  const applyVal = () => {
    if (axis==="x") entry.group.position.x = val;
    else if (axis==="y") entry.group.position.y = val;
    else if (axis==="z") entry.group.position.z = val;
    else if (axis==="scale") entry.group.scale.set(val,val,val);
    updateInspector(selectedKey);
    queuePersistAssembly();
  };
  applyVal();
  pushUndo({ label:`Move ${entry.name}`,
    undo: () => { entry.group.position.set(old.x,old.y,old.z); entry.group.scale.set(old.s,old.s,old.s); updateInspector(selectedKey); },
    redo: applyVal,
  });
}
window.applyTransformInput = applyTransformInput;

// ─────────────────────────────────────────────────────────────────────────────
// Part appearance
// ─────────────────────────────────────────────────────────────────────────────
function applyPartColor(hexStr) {
  if (!selectedKey) return;
  const entry = assemblyMap.get(selectedKey);
  if (!entry) return;
  const hex = parseInt(hexStr.replace('#',''), 16);
  entry.color = hex;
  entry.group.traverse(c => {
    if (c.isMesh && c.material && !c.userData.isEdgeLines) {
      c.material.color.setHex(hex);
      c.material.needsUpdate = true;
    }
  });
  const sw = g("mat-color-swatch");  if (sw) sw.style.background = hexStr;
  const hx = g("mat-color-hex");    if (hx) hx.textContent = hexStr;
  refreshAssemblyPanel();
  queuePersistAssembly();
}
window.applyPartColor = applyPartColor;

function applyPartFinish(preset) {
  if (!selectedKey) return;
  const entry = assemblyMap.get(selectedKey);
  if (!entry) return;
  const props = FINISHES[preset] || FINISHES['default'];
  entry.finish = preset;
  entry.group.traverse(c => {
    if (c.isMesh && c.material && !c.userData.isEdgeLines) {
      Object.assign(c.material, props);
      c.material.needsUpdate = true;
    }
  });
  queuePersistAssembly();
}
window.applyPartFinish = applyPartFinish;

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.vmb').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  for (const { group } of assemblyMap.values()) updateGroupViewMode(group);
  // Edge lines also tracked on grid? No – only part groups
  toast(`Display: ${mode.replace('-', ' + ')}`, 'info');
}
window.setViewMode = setViewMode;

// ─────────────────────────────────────────────────────────────────────────────
// Camera utilities
// ─────────────────────────────────────────────────────────────────────────────
function sceneBox() {
  let box = new THREE.Box3();
  for (const { group } of assemblyMap.values()) box.expandByObject(group);
  if (box.isEmpty()) box = new THREE.Box3(new THREE.Vector3(-100,-100,-100), new THREE.Vector3(100,100,100));
  return box;
}

function fitView() {
  const box = sceneBox();
  const ctr = box.getCenter(new THREE.Vector3());
  const sz  = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(ctr);
  camera.position.set(ctr.x + sz, ctr.y + sz * 0.6, ctr.z + sz);
  camera.near = sz * 0.001; camera.far = sz * 20;
  camera.updateProjectionMatrix(); controls.update();
}
window.fitView = fitView;

function resetCamera() {
  controls.target.set(0,0,0); camera.position.set(450,300,450);
  camera.near = 0.1; camera.far = 50000;
  camera.updateProjectionMatrix(); controls.update();
}
window.resetCamera = resetCamera;

function setView(type) {
  const box = sceneBox();
  const ctr = box.getCenter(new THREE.Vector3());
  const sz  = box.getSize(new THREE.Vector3()).length() * 1.5;
  controls.target.copy(ctr);
  const p = ({top:[ctr.x,ctr.y+sz,ctr.z+.001],front:[ctr.x,ctr.y,ctr.z+sz],
               right:[ctr.x+sz,ctr.y,ctr.z],left:[ctr.x-sz,ctr.y,ctr.z],
               back:[ctr.x,ctr.y,ctr.z-sz],bottom:[ctr.x,ctr.y-sz,ctr.z+.001],
               iso:[ctr.x+sz,ctr.y+sz*.7,ctr.z+sz]})[type] || [ctr.x+sz,ctr.y+sz*.7,ctr.z+sz];
  camera.position.set(...p); controls.update();
}
window.setView = setView;

// ─────────────────────────────────────────────────────────────────────────────
// Pending "add vs replace" resolution
// ─────────────────────────────────────────────────────────────────────────────
let _pendingLoadResolve = null;
async function promptAddOrReplace(filename) {
  if (assemblyMap.size === 0) return "add";
  return new Promise(resolve => {
    _pendingLoadResolve = resolve;
    g("add-scene-filename").textContent = filename;
    g("add-scene-modal").classList.add("open");
  });
}
function resolveAddScene(choice) {
  g("add-scene-modal").classList.remove("open");
  if (_pendingLoadResolve) { _pendingLoadResolve(choice); _pendingLoadResolve = null; }
}
window.resolveAddScene = resolveAddScene;

// ─────────────────────────────────────────────────────────────────────────────
// Model loading
// ─────────────────────────────────────────────────────────────────────────────
function formatStepLoadError(err) {
  const msg = (err && err.message ? String(err.message) : String(err || "Unknown error")).toLowerCase();
  if (msg.includes("occt-import-js not loaded")) {
    return "STEP parser failed to initialize in browser";
  }
  if (msg.includes("occt returned no meshes")) {
    return "STEP file parsed but produced no renderable meshes";
  }
  if (msg.includes("abort") || msg.includes("wasm")) {
    return "STEP parser ran out of resources (WASM)";
  }
  return err?.message || "Unknown STEP parse error";
}

function clearScene() { for (const k of [...assemblyMap.keys()]) removePartFromScene(k); }
window.clearScene = clearScene;

function showVpLoading(msg) {
  const el = g("vp-loading"); if (!el) return;
  g("vp-loading-text").textContent = msg || "Loading…";
  el.style.display = "flex";
}
function hideVpLoading() { const el = g("vp-loading"); if (el) el.style.display = "none"; }

async function loadLocalModel(filename) {
  const choice = await promptAddOrReplace(filename);
  if (choice === "cancel") return;
  if (choice === "replace") clearScene();
  showVpLoading(`Parsing ${filename}…`);
  let mesh;
  try {
    mesh = await loadStepGeometry(`${BASE}/api/v1/local-models/${encodeURIComponent(filename)}`);
  } catch (err) {
    hideVpLoading();
    const reason = formatStepLoadError(err);
    console.error(`Failed to load STEP model ${filename}:`, err);
    toast(`Failed to load ${filename}: ${reason}`, "err");
    return;
  }
  hideVpLoading();
  toast(`Loaded ${filename}`, "ok");
  const key = addPartToScene(filename, "local", null, mesh);
  setTool("move");
  selectPart(key); fitView();
  pushUndo({ label:`Add ${filename}`,
    undo: () => { removePartFromScene(key); fitView(); },
    redo: () => { toast("Re-open model to restore", "info"); },
  });
}
window.loadLocalModel = loadLocalModel;

async function loadUploadedModel(modelId, filename) {
  const choice = await promptAddOrReplace(filename);
  if (choice === "cancel") return;
  if (choice === "replace") clearScene();
  showVpLoading(`Parsing ${filename}…`);
  let mesh;
  try {
    mesh = await loadStepGeometry(`${BASE}/api/v1/models/${modelId}/content`);
  } catch (err) {
    hideVpLoading();
    const reason = formatStepLoadError(err);
    console.error(`Failed to load STEP model ${filename}:`, err);
    toast(`Failed to load ${filename}: ${reason}`, "err");
    return;
  }
  hideVpLoading();
  toast(`Loaded ${filename}`, "ok");
  const key = addPartToScene(filename, "uploaded", modelId, mesh);
  setTool("move");
  selectPart(key); fitView();
  pushUndo({ label:`Add ${filename}`,
    undo: () => { removePartFromScene(key); fitView(); },
    redo: () => { toast("Re-open model to restore", "info"); },
  });
}
window.loadUploadedModel = loadUploadedModel;

// ─────────────────────────────────────────────────────────────────────────────
// Tool management
// ─────────────────────────────────────────────────────────────────────────────
function setTool(t) {
  if (activeTool === 'mate' && t !== 'mate') cancelMate();
  activeTool = t;
  document.querySelectorAll(".rtool").forEach(b => b.classList.remove("active"));
  const btn = g(`tool-${t}`);
  if (btn) btn.classList.add("active");
  if (g("sb-active-tool")) g("sb-active-tool").textContent = t.charAt(0).toUpperCase() + t.slice(1);
  controls.enableRotate = (t !== "pan");
  controls.enablePan    = (t === "pan" || t === "orbit");
  xfCtrl.detach();
  if ((t === "move" || t === "rotate") && selectedKey) {
    const entry = assemblyMap.get(selectedKey);
    if (entry) { xfCtrl.setMode(t === "move" ? "translate" : "rotate"); xfCtrl.attach(entry.group); }
  }
  canvas.style.cursor = t === "measure" ? "crosshair" : t === "mate" ? "cell" : "";
  const mh = g("mate-hint");
  const ms = g("mate-status");
  if (t === "measure") {
    measureState.phase = "picking-a";
    g("measure-hint").textContent = "Click first point…";
    g("measure-hint").style.display = "";
    if (mh) mh.style.display = "none";
    if (ms) ms.style.display = "none";
  } else if (t === "mate") {
    mateState.phase = 'idle'; mateState.keyA = null; mateState.faceA = null;
    g("measure-hint").style.display = "none";
    if (mh) { mh.textContent = "Click a face on the part to move…"; mh.style.display = ""; }
    if (ms) { ms.textContent = "Mate active — click a face on the part to move"; ms.style.display = ""; }
  } else {
    g("measure-hint").style.display = "none";
    if (mh) mh.style.display = "none";
    if (ms) ms.style.display = "none";
  }
}
window.setTool = setTool;

// ─────────────────────────────────────────────────────────────────────────────
// Panel toggles + section toggle + browser filter
// ─────────────────────────────────────────────────────────────────────────────
function togglePanel(side) {
  if (side === "left")  leftHidden  = !leftHidden;
  if (side === "right") rightHidden = !rightHidden;
  g("workarea").className = leftHidden && rightHidden ? "hide-both"
                          : leftHidden  ? "hide-left"
                          : rightHidden ? "hide-right" : "";
  setTimeout(resize, 160);
}
window.togglePanel = togglePanel;

function toggleSection(name) {
  panelStates[name] = !panelStates[name];
  const sec    = g(`section-${name}`);
  const header = sec && sec.querySelector(".tree-section-header");
  const bodyId = { library: "library-list", uploaded: "upload-list", assembly: "asm-list" }[name];
  const body   = bodyId ? g(bodyId) : null;
  if (header) header.classList.toggle("open", panelStates[name]);
  if (body)   body.classList.toggle("open",   panelStates[name]);
}
window.toggleSection = toggleSection;

function filterBrowser(q) {
  const lq = q.toLowerCase();
  document.querySelectorAll("#library-list .tree-item, #upload-list .tree-item").forEach(item => {
    item.style.display = (!q || item.dataset.name.toLowerCase().includes(lq)) ? "" : "none";
  });
}
window.filterBrowser = filterBrowser;

// ─────────────────────────────────────────────────────────────────────────────
// Load library models from API
// ─────────────────────────────────────────────────────────────────────────────
async function loadLocalModels() {
  const list = g("library-list");
  if (!list) return;
  list.innerHTML = `<div style="padding:12px;text-align:center;color:var(--text-muted);font-size:11.5px;"><div class="spin" style="margin:0 auto 8px;"></div>Loading…</div>`;
  try {
    const res   = await fetchWithTimeout(`${BASE}/api/v1/local-models`, {}, 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data  = await res.json();
    const files = (data.models || []).filter((f) => /\.(step|stp)$/i.test(f));
    g("library-count").textContent = files.length;
    if (!files.length) {
      list.innerHTML = `<div style="padding:10px 20px;color:var(--text-muted);font-size:11.5px;font-style:italic;">No models found</div>`;
      return;
    }
    list.innerHTML = "";
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "tree-item";
      item.dataset.name = f;
      item.innerHTML = `
        <svg class="item-icon" width="13" height="13" viewBox="0 0 13 13" fill="none">
          <path d="M6.5 1L1 4v5l5.5 3L12 9V4L6.5 1z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
        </svg>
        <span class="item-name" title="${f}">${f}</span>`;
      item.addEventListener("click", () => {
        document.querySelectorAll(".tree-item.active").forEach(e => e.classList.remove("active"));
        item.classList.add("active");
      });
      item.addEventListener("dblclick", () => loadLocalModel(f));
      item.addEventListener("contextmenu", e => showCtxMenu(e, f, "local", null));
      list.appendChild(item);
    }
    g("section-library").querySelector(".tree-section-header").classList.add("open");
    list.classList.add("open");
    panelStates.library = true;
  } catch(err) {
    list.innerHTML = `<div style="padding:10px 20px;color:var(--err);font-size:11.5px;">Failed to load models. <button id="retry-local-models" class="modal-btn" style="margin-left:8px;padding:2px 8px;font-size:11px;">Retry</button></div>`;
    list.querySelector("#retry-local-models")?.addEventListener("click", () => { loadLocalModels(); });
    console.error(err);
  }
}
window.loadLocalModels = loadLocalModels;

async function loadUploadedList() {
  try {
    const res    = await fetchWithTimeout(`${BASE}/api/v1/models?project_id=default-project`, {}, 10000);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data   = await res.json();
    const models = data.models || [];
    g("upload-count").textContent = models.length;
    const list = g("upload-list");
    const zone = list.querySelector(".upload-zone");
    list.querySelectorAll(".tree-item").forEach(n => n.remove());
    for (const m of models) {
      const item = document.createElement("div");
      item.className = "tree-item";
      item.dataset.name    = m.file_name;
      item.dataset.modelId = m.model_id;
      item.innerHTML = `
        <svg class="item-icon" width="13" height="13" viewBox="0 0 13 13" fill="none">
          <path d="M6.5 1L1 4v5l5.5 3L12 9V4L6.5 1z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
        </svg>
        <span class="item-name" title="${m.file_name}">${m.file_name}</span>`;
      item.addEventListener("click", () => {
        document.querySelectorAll(".tree-item.active").forEach(e => e.classList.remove("active"));
        item.classList.add("active");
      });
      item.addEventListener("dblclick", () => loadUploadedModel(m.model_id, m.file_name));
      item.addEventListener("contextmenu", e => showCtxMenu(e, m.file_name, "uploaded", m.model_id));
      list.insertBefore(item, zone);
    }
  } catch (err) {
    const list = g("upload-list");
    const zone = list?.querySelector(".upload-zone");
    if (list && zone) {
      list.querySelectorAll(".tree-item").forEach(n => n.remove());
      const msg = document.createElement("div");
      msg.className = "asm-empty";
      msg.style.color = "var(--err)";
      msg.textContent = "Failed to load uploaded models";
      list.insertBefore(msg, zone);
    }
    console.error(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context menu
// ─────────────────────────────────────────────────────────────────────────────
let ctxTarget = { name: null, type: null, modelId: null };

function showCtxMenu(e, name, type, modelId) {
  e.preventDefault();
  ctxTarget = { name, type, modelId };
  const menu = g("ctx-menu");
  menu.style.left    = e.clientX + "px";
  menu.style.top     = e.clientY + "px";
  menu.style.display = "block";
}

document.addEventListener("click", e => {
  if (e.target.closest("#ctx-menu")) return;
  const m = g("ctx-menu"); if (m) m.style.display = "none";
});

async function ctxAction(act) {
  g("ctx-menu").style.display = "none";
  if (!ctxTarget.name) return;
  if (act === "load") {
    ctxTarget.type === "uploaded"
      ? await loadUploadedModel(ctxTarget.modelId, ctxTarget.name)
      : await loadLocalModel(ctxTarget.name);
  }
  if (act === "copy-name") { navigator.clipboard.writeText(ctxTarget.name); toast("Copied to clipboard", "ok"); }
  if (act === "generate-bom") await generateBOM(ctxTarget.name, ctxTarget.type, ctxTarget.modelId);
  if (act === "delete" && ctxTarget.type === "uploaded" && ctxTarget.modelId) {
    try {
      const res = await fetch(`${BASE}/api/v1/models/${ctxTarget.modelId}`, { method: "DELETE" });
      if (res.ok) { toast("Model deleted", "ok"); loadUploadedList(); }
      else { const d = await res.json(); toast(d.detail || "Delete failed", "err"); }
    } catch (err) { toast("Delete failed: " + err.message, "err"); }
  }
}
window.ctxAction = ctxAction;

// ─────────────────────────────────────────────────────────────────────────────
// Upload modal
// ─────────────────────────────────────────────────────────────────────────────
function openUploadModal()  { g("upload-modal").classList.add("open"); }
function closeUploadModal() {
  g("upload-modal").classList.remove("open");
  pendingFile = null;
  g("modal-status").textContent = "";
  g("confirm-upload").disabled = true;
}
window.openUploadModal  = openUploadModal;
window.closeUploadModal = closeUploadModal;

function handleFileSelect(input) {
  if (!input.files.length) return;
  pendingFile = input.files[0];
  g("modal-status").textContent = `Selected: ${pendingFile.name}`;
  g("confirm-upload").disabled  = false;
}
window.handleFileSelect = handleFileSelect;

function handleFileDrop(e) {
  e.preventDefault();
  g("modal-drop").classList.remove("drag-over");
  const f = e.dataTransfer.files[0];
  if (!f) return;
  pendingFile = f;
  g("modal-status").textContent = `Selected: ${f.name}`;
  g("confirm-upload").disabled  = false;
}
window.handleFileDrop = handleFileDrop;

async function confirmUpload() {
  if (!pendingFile) return;
  g("modal-status").textContent = "Uploading…";
  g("confirm-upload").disabled  = true;
  const fd = new FormData();
  fd.append("file", pendingFile);
  try {
    const res  = await fetch(`${BASE}/api/v1/models/upload?project_id=default-project`, { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Upload failed");
    toast(`Uploaded ${pendingFile.name}`, "ok");
    closeUploadModal();
    await loadUploadedList();
    g("section-uploaded").querySelector(".tree-section-header").classList.add("open");
    g("upload-list").classList.add("open");
    panelStates.uploaded = true;
  } catch(err) {
    g("modal-status").textContent = `Error: ${err.message}`;
    g("confirm-upload").disabled  = false;
  }
}
window.confirmUpload = confirmUpload;

// ─────────────────────────────────────────────────────────────────────────────
// Measurement tool
// ─────────────────────────────────────────────────────────────────────────────
const measureState   = { phase: "idle", ptA: null, ptB: null };
const measureObjects = [];
let   measureLinePreview = null;

function measureClick(e) {
  ndcFromEvent(e);
  raycaster.setFromCamera(mouse2D, camera);
  let hitPt = null;
  const groups = [...assemblyMap.values()].map(v => v.group);
  const hits   = raycaster.intersectObjects(groups, true);
  if (hits.length) {
    hitPt = hits[0].point.clone();
  } else {
    const gp = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, gp)) hitPt = gp;
  }
  if (!hitPt) return;
  if (measureState.phase === "picking-a") {
    measureState.ptA   = hitPt;
    measureState.phase = "picking-b";
    g("measure-hint").textContent = "Click second point…";
    const dot = makeDotMarker(hitPt, 0x4f8ef7);
    scene.add(dot); measureObjects.push(dot);
  } else if (measureState.phase === "picking-b") {
    measureState.ptB = hitPt;
    finalizeMeasure();
  }
}

function updateMeasureLine(ptB) {
  if (!measureState.ptA || !ptB) return;
  if (measureLinePreview) { scene.remove(measureLinePreview); measureLinePreview = null; }
  measureLinePreview = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([measureState.ptA, ptB]),
    new THREE.LineBasicMaterial({ color: 0x4f8ef7 }));
  scene.add(measureLinePreview);
}

function finalizeMeasure() {
  const { ptA, ptB } = measureState;
  if (!ptA || !ptB) return;
  if (measureLinePreview) { scene.remove(measureLinePreview); measureLinePreview = null; }
  const dist = ptA.distanceTo(ptB);
  const mid  = new THREE.Vector3().addVectors(ptA, ptB).multiplyScalar(0.5);
  const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([ptA, ptB]),
    new THREE.LineBasicMaterial({ color: 0x4f8ef7 }));
  scene.add(line); measureObjects.push(line);
  const dotB = makeDotMarker(ptB, 0x4f8ef7);
  scene.add(dotB); measureObjects.push(dotB);
  const lbl = document.createElement("div");
  lbl.className = "measure-label";
  lbl.textContent = `${dist.toFixed(2)} mm`;
  const lblObj = new CSS2DObject(lbl);
  lblObj.position.copy(mid);
  scene.add(lblObj); measureObjects.push(lblObj);
  g("measure-result").style.display = "";
  g("measure-idle-hint").style.display = "none";
  g("measure-label").textContent = "Distance";
  g("measure-val").textContent   = `${dist.toFixed(3)} mm`;
  g("measure-sub").textContent   = `ΔX ${Math.abs(ptB.x-ptA.x).toFixed(2)}  ΔY ${Math.abs(ptB.y-ptA.y).toFixed(2)}  ΔZ ${Math.abs(ptB.z-ptA.z).toFixed(2)}`;
  measureState.phase = "idle";
  g("measure-hint").style.display = "none";
  canvas.style.cursor = "";
}

function clearMeasure() {
  measureState.phase = "idle"; measureState.ptA = null; measureState.ptB = null;
  for (const o of measureObjects) scene.remove(o);
  measureObjects.length = 0;
  if (measureLinePreview) { scene.remove(measureLinePreview); measureLinePreview = null; }
  g("measure-result").style.display  = "none";
  g("measure-idle-hint").style.display = "";
  g("measure-hint").style.display    = "none";
}
window.clearMeasure = clearMeasure;

function makeDotMarker(pos, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(2,8,8), new THREE.MeshBasicMaterial({ color }));
  m.position.copy(pos); return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// BOM generation
// ─────────────────────────────────────────────────────────────────────────────
async function generateBOM(name, type, modelId) {
  name    = name    || (selectedKey && assemblyMap.get(selectedKey)?.name);
  type    = type    || (selectedKey && assemblyMap.get(selectedKey)?.type);
  modelId = modelId || (selectedKey && assemblyMap.get(selectedKey)?.modelId);
  if (!name) { toast("Select a part first", "warn"); return; }
  toast("Generating BOM…", "info");
  try {
    let items = [];
    if (type === "uploaded" && modelId) {
      const r = await fetch(`${BASE}/api/v1/models/${modelId}/bom`);
      items = (await r.json()).items || [];
    } else {
      const r = await fetch(`${BASE}/api/v1/local-models/${encodeURIComponent(name)}/bom`);
      items = (await r.json()).items || [];
    }
    if (!items.length) {
      const r = await fetch(`${BASE}/api/v1/bom/generate`, { method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ project_id:"default-project", model_name:name, model_id:modelId }) });
      items = (await r.json()).items || [];
    }
    const bom = g("bom-result");
    bom.style.display = "block";
    bom.innerHTML = `<table><thead><tr><th>Part #</th><th>Name</th><th>Qty</th></tr></thead><tbody>${
      items.map(it => `<tr><td>${it.part_number}</td><td>${it.name}</td><td>${it.quantity}</td></tr>`).join("")
    }</tbody></table>`;
    toast(`BOM: ${items.length} parts`, "ok");
  } catch (err) { toast("BOM failed: " + err.message, "err"); }
}
window.generateBOM = generateBOM;

// ─────────────────────────────────────────────────────────────────────────────
// Commands – Length edit and Snap
// ─────────────────────────────────────────────────────────────────────────────
async function applyLengthEdit() {
  if (!selectedKey) { toast("Select a part first", "warn"); return; }
  const entry = assemblyMap.get(selectedKey);
  if (!entry?.modelId) { toast("Only works with uploaded models", "warn"); return; }
  const ref = g("length-ref").value || "face_0";
  const axis = g("length-axis").value || "z";
  const length = parseFloat(g("length-val").value);
  if (isNaN(length) || length <= 0) { toast("Enter a valid length", "err"); return; }
  const box3 = new THREE.Box3().setFromObject(entry.group);
  const size = box3.getSize(new THREE.Vector3());
  const currentDim = axis === "x" ? size.x : axis === "y" ? size.y : size.z;
  if (!currentDim || currentDim < 0.001) { toast("Cannot determine model size along " + axis, "err"); return; }
  const scaleFactor = length / currentDim;
  const oldScaleX = entry.group.scale.x, oldScaleY = entry.group.scale.y, oldScaleZ = entry.group.scale.z;
  if (axis==="x") entry.group.scale.x *= scaleFactor;
  else if (axis==="y") entry.group.scale.y *= scaleFactor;
  else entry.group.scale.z *= scaleFactor;
  queuePersistAssembly();
  try {
    await fetch(`${BASE}/api/v1/commands/execute`, { method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ model_id:entry.modelId, operation_type:"length_edit",
        parameters:{ face_ref:ref, axis, target_length_mm:length }}) });
    toast("Length edit applied", "ok");
    pushUndo({ label:`Length ${axis}:${length}`,
      undo:()=>{ entry.group.scale.set(oldScaleX, oldScaleY, oldScaleZ); },
      redo:()=>{
        if(axis==="x") entry.group.scale.x = oldScaleX * scaleFactor;
        else if(axis==="y") entry.group.scale.y = oldScaleY * scaleFactor;
        else entry.group.scale.z = oldScaleZ * scaleFactor;
      }, });
  } catch (err) { toast("Command failed: " + err.message, "err"); }
}
window.applyLengthEdit = applyLengthEdit;

// Keep for backwards compat (inspector may still call it)
function applySnap() { groundSnap(); }
window.applySnap = applySnap;

// ─────────────────────────────────────────────────────────────────────────────
// Assembly tools: Ground, Duplicate, Align
// ─────────────────────────────────────────────────────────────────────────────

/** Drop selected part so its bounding box bottom rests on Y=0 */
function groundSnap() {
  if (!selectedKey) { toast("Select a part first", "warn"); return; }
  const entry = assemblyMap.get(selectedKey);
  if (!entry || entry.locked) { toast("Part is locked", "warn"); return; }
  const box3  = new THREE.Box3().setFromObject(entry.group);
  const oldY  = entry.group.position.y;
  const delta = -box3.min.y;
  entry.group.position.y += delta;
  queuePersistAssembly();
  updateInspector(selectedKey);
  const ck = selectedKey;
  pushUndo({
    label: `Ground ${entry.name}`,
    undo: () => { const e2 = assemblyMap.get(ck); if (e2) { e2.group.position.y = oldY; updateInspector(ck); } },
    redo: () => { const e2 = assemblyMap.get(ck); if (e2) { const b2 = new THREE.Box3().setFromObject(e2.group); e2.group.position.y += -b2.min.y; updateInspector(ck); } },
  });
  toast("Snapped to ground", "ok");
}
window.groundSnap = groundSnap;

/** Clone selected part by re-loading its geometry, offset +15mm on X */
async function duplicatePart() {
  if (!selectedKey) { toast("Select a part first", "warn"); return; }
  const src = assemblyMap.get(selectedKey);
  if (!src) return;
  showVpLoading(`Duplicating ${src.name}…`);
  let mesh;
  try {
    const url = src.type === "uploaded" && src.modelId
      ? `${BASE}/api/v1/models/${encodeURIComponent(src.modelId)}/content`
      : `${BASE}/api/v1/local-models/${encodeURIComponent(src.name)}`;
    mesh = await loadStepGeometry(url);
  } catch (err) { hideVpLoading(); toast(`Duplicate failed: ${err.message}`, "err"); return; }
  hideVpLoading();
  const newKey = addPartToScene(src.name, src.type, src.modelId, mesh);
  const ne = assemblyMap.get(newKey);
  if (ne) {
    ne.group.position.copy(src.group.position);
    ne.group.rotation.copy(src.group.rotation);
    ne.group.scale.copy(src.group.scale);
    ne.group.position.x += 15;
    ne.color = src.color;
    ne.finish = src.finish || 'default';
    ne.group.traverse(c => {
      if (c.isMesh && c.material && !c.userData.isEdgeLines) {
        c.material.color.setHex(ne.color); c.material.needsUpdate = true;
      }
    });
  }
  selectPart(newKey);
  queuePersistAssembly();
  const ck = newKey;
  pushUndo({
    label: `Duplicate ${src.name}`,
    undo: () => removePartFromScene(ck),
    redo: () => toast("Re-duplicate manually", "info"),
  });
  toast(`Duplicated ${src.name}`, "ok");
}
window.duplicatePart = duplicatePart;

/** Snap selected part's rotation to nearest 90° on the given axis */
function alignPart(axis) {
  if (!selectedKey) { toast("Select a part first", "warn"); return; }
  const entry = assemblyMap.get(selectedKey);
  if (!entry || entry.locked) { toast("Part is locked", "warn"); return; }
  const old = entry.group.rotation.clone();
  const snap90 = v => Math.round(v / (Math.PI / 2)) * (Math.PI / 2);
  if      (axis === 'x') entry.group.rotation.x = snap90(entry.group.rotation.x);
  else if (axis === 'y') entry.group.rotation.y = snap90(entry.group.rotation.y);
  else                   entry.group.rotation.z = snap90(entry.group.rotation.z);
  const nr = entry.group.rotation.clone();
  queuePersistAssembly(); updateInspector(selectedKey);
  const ck = selectedKey;
  pushUndo({
    label: `Align ${entry.name}`,
    undo: () => { const e2 = assemblyMap.get(ck); if(e2){ e2.group.rotation.copy(old);  updateInspector(ck); } },
    redo: () => { const e2 = assemblyMap.get(ck); if(e2){ e2.group.rotation.copy(nr);   updateInspector(ck); } },
  });
  toast(`Aligned to ${axis.toUpperCase()} axis`, "ok");
}
window.alignPart = alignPart;

// ─────────────────────────────────────────────────────────────────────────────
// Face Mate tool — click-two-faces to snap parts together
// ─────────────────────────────────────────────────────────────────────────────

/** Extract world-space face center + outward normal from a raycaster hit */
function worldFaceHit(hit) {
  if (!hit || !hit.face || !hit.object) return null;
  const worldPt     = hit.point.clone();
  const nm          = new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld);
  const worldNormal = hit.face.normal.clone().applyMatrix3(nm).normalize();
  return { worldPt, worldNormal };
}

/** Quaternion aligning unit-vector `from` → `to`, handles antiparallel edge case */
function quatFromVectors(from, to) {
  const dot = from.dot(to);
  if (dot >  0.9999) return new THREE.Quaternion();
  if (dot < -0.9999) {
    const perp = Math.abs(from.x) < 0.9
      ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    return new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3().crossVectors(from, perp).normalize(), Math.PI);
  }
  return new THREE.Quaternion().setFromUnitVectors(from, to);
}

/**
 * Move+rotate groupA so faceA is flush against the face defined by (worldPtB, worldNormB).
 * Returns { oldPos, oldQuat } for undo.
 */
function doFaceMate(groupA, faceA, worldPtB, worldNormB) {
  const oldPos  = groupA.position.clone();
  const oldQuat = groupA.quaternion.clone();
  // Store face-A point in group-local coords BEFORE any rotation
  const ptA_local  = groupA.worldToLocal(faceA.worldPt.clone());
  // Rotate group so worldNormA aligns with -worldNormB (antiparallel = touching)
  const targetNorm = worldNormB.clone().negate();
  const q          = quatFromVectors(faceA.worldNormal.clone(), targetNorm);
  groupA.quaternion.premultiply(q);
  groupA.updateMatrixWorld(true);
  // Translate so face centers coincide
  const newWorldPtA = groupA.localToWorld(ptA_local.clone());
  groupA.position.add(worldPtB.clone().sub(newWorldPtA));
  groupA.updateMatrixWorld(true);
  return { oldPos, oldQuat };
}

/** Small sphere + arrow helper to visualise a face normal */
function makeFaceNormalMarker(pt, normal, color) {
  const grp = new THREE.Group();
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(2, 8, 8),
    new THREE.MeshBasicMaterial({ color, depthTest: false }));
  dot.position.copy(pt);
  grp.add(dot);
  grp.add(new THREE.ArrowHelper(normal.clone(), pt.clone(), 16, color, 5, 3));
  return grp;
}

function clearMateMarkers() {
  for (const m of mateNormalArrows) scene.remove(m);
  mateNormalArrows.length = 0;
}

function cancelMate() {
  mateState.phase = 'idle'; mateState.keyA = null; mateState.faceA = null;
  clearMateMarkers();
  const mh = g("mate-hint");   if (mh) mh.style.display = "none";
  const ms = g("mate-status"); if (ms) ms.style.display = "none";
}
window.cancelMate = cancelMate;

/** Handle a canvas click while in 'mate' tool mode */
function mateClick() {
  const targets = [];
  for (const entry of assemblyMap.values())
    entry.group.traverse(c => { if (c.isMesh && !c.userData.isEdgeLines) targets.push(c); });
  const hits = raycaster.intersectObjects(targets, false);
  if (!hits.length) return;
  const faceInfo = worldFaceHit(hits[0]);
  if (!faceInfo) return;
  // Resolve assembly key
  let obj = hits[0].object;
  while (obj.parent && !obj.userData.sceneKey) obj = obj.parent;
  const hitKey = obj.userData.sceneKey;
  if (!hitKey) return;

  const mh = g("mate-hint");
  const ms = g("mate-status");

  if (mateState.phase === 'idle') {
    // --- Phase 1: pick face A (the part to MOVE) ---
    mateState.phase = 'a-set';
    mateState.keyA  = hitKey;
    mateState.faceA = faceInfo;
    clearMateMarkers();
    const marker = makeFaceNormalMarker(faceInfo.worldPt, faceInfo.worldNormal, 0x00d4ff);
    scene.add(marker); mateNormalArrows.push(marker);
    const partName = assemblyMap.get(hitKey)?.name || hitKey;
    if (mh) mh.textContent  = `«${partName}» selected — now click a face on the target part…`;
    if (ms) { ms.textContent = `Step 2: click a face on the FIXED part`; ms.style.display = ""; }
    toast(`Face A on «${partName}» selected`, "info");

  } else if (mateState.phase === 'a-set') {
    if (hitKey === mateState.keyA) {
      // Same part — reselect face A
      mateState.faceA = faceInfo;
      clearMateMarkers();
      const m = makeFaceNormalMarker(faceInfo.worldPt, faceInfo.worldNormal, 0x00d4ff);
      scene.add(m); mateNormalArrows.push(m);
      toast("New face A selected — now click the target part", "info");
      return;
    }
    // --- Phase 2: pick face B (the FIXED part) and execute ---
    const entryA = assemblyMap.get(mateState.keyA);
    if (!entryA) { cancelMate(); return; }
    const markerB = makeFaceNormalMarker(faceInfo.worldPt, faceInfo.worldNormal, 0xff9500);
    scene.add(markerB); mateNormalArrows.push(markerB);

    const { oldPos, oldQuat } = doFaceMate(entryA.group, mateState.faceA, faceInfo.worldPt, faceInfo.worldNormal);
    const capturedKey = mateState.keyA;
    const newPos  = entryA.group.position.clone();
    const newQuat = entryA.group.quaternion.clone();
    queuePersistAssembly();
    updateInspector(capturedKey);
    pushUndo({
      label: `Mate ${entryA.name}`,
      undo: () => {
        const e2 = assemblyMap.get(capturedKey);
        if (e2) { e2.group.position.copy(oldPos); e2.group.quaternion.copy(oldQuat); e2.group.updateMatrixWorld(true); updateInspector(capturedKey); }
      },
      redo: () => {
        const e2 = assemblyMap.get(capturedKey);
        if (e2) { e2.group.position.copy(newPos); e2.group.quaternion.copy(newQuat); e2.group.updateMatrixWorld(true); updateInspector(capturedKey); }
      },
    });
    toast(`Mated «${entryA.name}»`, "ok");
    // Reset for next mate operation (stay in mate mode)
    mateState.phase = 'idle'; mateState.keyA = null; mateState.faceA = null;
    setTimeout(() => clearMateMarkers(), 1000);
    if (mh) mh.textContent  = "Mated! Click next face to move…";
    if (ms) ms.textContent  = "Mated — click next face to continue mating";
    setTimeout(() => {
      if (mh && activeTool === 'mate') mh.textContent = "Click a face on the part to move…";
      if (ms && activeTool === 'mate') ms.textContent = "Mate active — click a face on the part to move";
    }, 1800);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline — improved with op icons, step numbers, scrub cursor
// ─────────────────────────────────────────────────────────────────────────────

const OP_ICONS = {
  'Add':       `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1.5v8M1.5 5.5h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
  'Move':      `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 2L3 4.5M5.5 2L8 4.5M5.5 2v7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'Rotate':    `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M8.5 3A4 4 0 1 1 3 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M8 1l.5 2H6.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'Mate':      `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 5.5h7M7.5 3.5l2 2-2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'Ground':    `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 9h7M5.5 1.5v6M3.5 5.5l2 2 2-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'Duplicate': `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" stroke-width="1.1"/><path d="M3.5 3.5V2a.8.8 0 0 1 .8-.8h4a.8.8 0 0 1 .8.8v4a.8.8 0 0 1-.8.8H7.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  'Align':     `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M5.5 1.5v8M2 5.5l3.5-3.5 3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  'Length':    `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M1.5 5.5h8M1.5 3v5M9.5 3v5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  'Remove':    `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 2l7 7M9 2l-7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`,
};

function getOpIcon(label) {
  for (const [key, svg] of Object.entries(OP_ICONS))
    if (label.startsWith(key)) return svg;
  return `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><circle cx="5.5" cy="5.5" r="3.5" stroke="currentColor" stroke-width="1.1"/></svg>`;
}

function pushTimelineChip(label) {
  // Drop any future (overwritten) chips
  document.querySelectorAll(".tl-step").forEach(c => {
    if (parseInt(c.dataset.idx) > undoPointer - 1) c.remove();
  });
  document.querySelector(".tl-scrub")?.remove();
  const empty = g("tl-empty"); if (empty) empty.style.display = "none";

  const step = document.createElement("div");
  step.className   = "tl-step active-step";
  step.dataset.idx = undoPointer;
  step.innerHTML   = `<span class="tl-step-num">${undoPointer + 1}</span><span class="tl-step-icon">${getOpIcon(label)}</span><span class="tl-step-label">${label}</span>`;
  step.title       = `Step ${undoPointer + 1}: ${label} \u2014 click to jump here`;
  step.addEventListener("click", () => scrubToIndex(parseInt(step.dataset.idx)));
  g("tl-track").appendChild(step);

  const scrub = document.createElement("div");
  scrub.className = "tl-scrub";
  g("tl-track").appendChild(scrub);

  const cnt = g("tl-count"); if (cnt) cnt.textContent = undoStack.length;
  step.scrollIntoView({ block: "nearest", inline: "end" });
}

function refreshTimelineChips() {
  document.querySelectorAll(".tl-step").forEach(chip => {
    const idx = parseInt(chip.dataset.idx);
    chip.classList.toggle("active-step", idx <= undoPointer);
    chip.classList.toggle("future-step",  idx >  undoPointer);
  });
  document.querySelector(".tl-scrub")?.remove();
  const cur = [...document.querySelectorAll(".tl-step")].find(c => parseInt(c.dataset.idx) === undoPointer);
  if (cur) { const s = document.createElement("div"); s.className = "tl-scrub"; cur.after(s); }
  const cnt = g("tl-count"); if (cnt) cnt.textContent = undoStack.length;
}

function scrubToIndex(idx) {
  while (undoPointer > idx) undoOp();
  while (undoPointer < idx && undoPointer < undoStack.length - 1) redoOp();
}

function clearHistory() {
  undoStack.length = 0; undoPointer = -1;
  document.querySelectorAll(".tl-step, .tl-scrub").forEach(c => c.remove());
  const empty = g("tl-empty"); if (empty) empty.style.display = "";
  const cnt = g("tl-count");   if (cnt)  cnt.textContent  = "0";
  refreshUndoButtons();
}
window.clearHistory = clearHistory;

// ─────────────────────────────────────────────────────────────────────────────
// File menu
// ─────────────────────────────────────────────────────────────────────────────
function closeKbModal() { g("kb-modal").classList.remove("open"); }
window.closeKbModal = closeKbModal;

function toggleFileMenu() {
  const m = g("file-menu");
  m.classList.toggle("open");
  if (m.classList.contains("open")) {
    const r = g("file-menu-btn").getBoundingClientRect();
    m.style.left = r.left + "px";
    m.style.top  = (r.bottom + 2) + "px";
  }
}
window.toggleFileMenu = toggleFileMenu;
document.addEventListener("click", e => {
  if (!e.target.closest("#file-menu") && !e.target.closest("#file-menu-btn"))
    g("file-menu").classList.remove("open");
});

function fileAction(act) {
  g("file-menu").classList.remove("open");
  if (act === "open")        { openUploadModal(); return; }
  if (act === "clear-scene") { clearScene(); toast("Scene cleared", "ok"); return; }
  if (act === "shortcuts")   { g("kb-modal").classList.add("open"); return; }
  if (act === "export-bom")  exportBomCsv();
}
window.fileAction = fileAction;

async function exportBomCsv() {
  if (assemblyMap.size === 0) { toast("No models in scene", "warn"); return; }
  const rows = [["part_number","name","quantity"]];
  for (const [, entry] of assemblyMap) {
    try {
      const url = entry.type === "uploaded" && entry.modelId
        ? `${BASE}/api/v1/models/${entry.modelId}/bom`
        : `${BASE}/api/v1/local-models/${encodeURIComponent(entry.name)}/bom`;
      const data = await (await fetch(url)).json();
      for (const it of (data.items||[])) rows.push([it.part_number, it.name, it.quantity]);
    } catch { rows.push(["?", entry.name, 1]); }
  }
  const csv = rows.map(r => r.map(c => `"${c}"`).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: "data:text/csv;charset=utf-8," + encodeURIComponent(csv),
    download: "bom.csv",
  }); a.click();
  toast("BOM exported", "ok");
}

// ─────────────────────────────────────────────────────────────────────────────
// Wireframe & grid toggles
// ─────────────────────────────────────────────────────────────────────────────
let wireframeOn = false;
function toggleWireframe() {
  wireframeOn = !wireframeOn;
  for (const { group } of assemblyMap.values())
    group.traverse(c => { if (c.isMesh && c.material) c.material.wireframe = wireframeOn; });
  toast("Wireframe " + (wireframeOn ? "on" : "off"), "info");
}
let gridOn = true;
function toggleGrid() { gridOn = !gridOn; grid.visible = gridOn; groundMesh.visible = gridOn; }

function nudgeSelected(dx = 0, dy = 0, dz = 0, step = 1) {
  if (!selectedKey) return false;
  const entry = assemblyMap.get(selectedKey);
  if (!entry || entry.locked) return false;
  entry.group.position.x += dx * step;
  entry.group.position.y += dy * step;
  entry.group.position.z += dz * step;
  updateInspector(selectedKey);
  queuePersistAssembly();
  return true;
}

function serializeAssemblyState() {
  const parts = [];
  for (const entry of assemblyMap.values()) {
    parts.push({
      name: entry.name,
      source_type: entry.type,
      model_id: entry.modelId,
      color: entry.color,
      visible: !!entry.visible,
      locked: !!entry.locked,
      transform: {
        position: {
          x: entry.group.position.x,
          y: entry.group.position.y,
          z: entry.group.position.z,
        },
        rotation: {
          x: entry.group.rotation.x,
          y: entry.group.rotation.y,
          z: entry.group.rotation.z,
        },
        scale: {
          x: entry.group.scale.x,
          y: entry.group.scale.y,
          z: entry.group.scale.z,
        },
      },
    });
  }
  return { name: "Workspace", parts };
}

async function persistAssemblyNow() {
  if (hydrateInProgress) return;
  try {
    await fetchWithTimeout(
      `${BASE}/api/v1/assemblies/${encodeURIComponent(ASSEMBLY_ID)}?project_id=${encodeURIComponent(PROJECT_ID)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(serializeAssemblyState()),
      },
      10000
    );
  } catch (err) {
    console.warn("Assembly persist failed:", err);
  }
}

function queuePersistAssembly() {
  if (hydrateInProgress) return;
  clearTimeout(persistAssemblyTimer);
  persistAssemblyTimer = setTimeout(() => { persistAssemblyNow(); }, 600);
}

async function restoreAssemblyState() {
  let payload;
  try {
    const res = await fetchWithTimeout(
      `${BASE}/api/v1/assemblies/${encodeURIComponent(ASSEMBLY_ID)}?project_id=${encodeURIComponent(PROJECT_ID)}`,
      {},
      10000
    );
    if (!res.ok) return;
    payload = await res.json();
  } catch (err) {
    console.warn("Assembly restore skipped:", err);
    return;
  }

  const parts = payload?.assembly?.parts || [];
  if (!parts.length) return;

  hydrateInProgress = true;
  clearScene();
  let restoredCount = 0;
  for (const part of parts) {
    try {
      const sourceType = part.source_type === "uploaded" ? "uploaded" : "local";
      const url = sourceType === "uploaded"
        ? `${BASE}/api/v1/models/${encodeURIComponent(part.model_id)}/content`
        : `${BASE}/api/v1/local-models/${encodeURIComponent(part.name)}`;
      const mesh = await loadStepGeometry(url);
      const key = addPartToScene(part.name, sourceType, part.model_id || null, mesh);
      const entry = assemblyMap.get(key);
      if (!entry) continue;
      entry.visible = part.visible !== false;
      entry.locked = !!part.locked;
      entry.group.visible = entry.visible;
      if (typeof part.color === "number") {
        entry.color = part.color;
        entry.group.traverse((c) => {
          if (c.isMesh && c.material?.color) c.material.color.setHex(part.color);
        });
      }
      const t = part.transform || {};
      const p = t.position || {};
      const r = t.rotation || {};
      const s = t.scale || {};
      entry.group.position.set(Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0);
      entry.group.rotation.set(Number(r.x) || 0, Number(r.y) || 0, Number(r.z) || 0);
      entry.group.scale.set(Number(s.x) || 1, Number(s.y) || 1, Number(s.z) || 1);
      restoredCount += 1;
    } catch (err) {
      console.warn(`Failed restoring part ${part?.name || "unknown"}:`, err);
    }
  }
  hydrateInProgress = false;
  refreshAssemblyPanel();
  if (restoredCount > 0) {
    fitView();
    toast(`Restored assembly (${restoredCount} part${restoredCount === 1 ? "" : "s"})`, "info");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API health
// ─────────────────────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const res = await fetchWithTimeout(`${BASE}/health`, {}, 5000);
    if (res.ok) { g("status-dot").className = "ok"; g("status-text").textContent = "API connected"; }
    else throw 0;
  } catch {
    g("status-dot").className = "err";
    g("status-text").textContent = "API offline";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyboard shortcuts
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  const k = e.key;
  if (e.ctrlKey || e.metaKey) {
    if (k === "z") { e.preventDefault(); undoOp(); return; }
    if (k === "y" || k === "Y") { e.preventDefault(); redoOp(); return; }
    if (k === "d") { e.preventDefault(); duplicatePart(); return; }
  }
  switch (k) {
    case "ArrowLeft": {
      if (nudgeSelected(-1, 0, 0, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)) e.preventDefault();
      break;
    }
    case "ArrowRight": {
      if (nudgeSelected(1, 0, 0, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)) e.preventDefault();
      break;
    }
    case "ArrowUp": {
      if (nudgeSelected(0, 0, -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)) e.preventDefault();
      break;
    }
    case "ArrowDown": {
      if (nudgeSelected(0, 0, 1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)) e.preventDefault();
      break;
    }
    case "PageUp": {
      if (nudgeSelected(0, 1, 0, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)) e.preventDefault();
      break;
    }
    case "PageDown": {
      if (nudgeSelected(0, -1, 0, e.shiftKey ? 10 : e.altKey ? 0.1 : 1)) e.preventDefault();
      break;
    }
    case "s": case "S": setTool("select");   break;
    case "o": case "O": setTool("orbit");    break;
    case "t": case "T": setTool("move");     break;
    case "r": case "R": setTool("rotate");   break;
    case "m": case "M": setTool("measure");  break;
    case "l": case "L": setTool("length");   break;
    case "n": case "N": setTool("snap");     break;
    case "j": case "J": setTool("mate");     break;
    case "f": case "F": fitView();           break;
    case "h": case "H": resetCamera();       break;
    case "b": case "B": togglePanel("left"); break;
    case "i": case "I": togglePanel("right"); break;
    case "w": case "W": toggleWireframe();   break;
    case "g": case "G": toggleGrid();        break;
    case "?": g("kb-modal").classList.add("open"); break;
    case "Escape":
      if (g("kb-modal").classList.contains("open"))        { g("kb-modal").classList.remove("open"); break; }
      if (g("add-scene-modal").classList.contains("open")) { resolveAddScene("cancel"); break; }
      if (activeTool === "mate")    { cancelMate(); setTool("select"); break; }
      if (activeTool === "measure") { clearMeasure(); setTool("select"); break; }
      deselectAll(); xfCtrl.detach(); break;
    case "Delete": case "Backspace":
      if (selectedKey) {
        const entry = assemblyMap.get(selectedKey);
        if (entry && !entry.locked) { removePartFromScene(selectedKey); toast("Part removed", "info"); }
        else if (entry?.locked) toast("Part is locked", "warn");
      }
      break;
    case "1": setView("front"); break;
    case "2": setView("right"); break;
    case "3": setView("top");   break;
    case "4": setView("iso");   break;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  checkHealth(); // fire-and-forget — status pill updates independently; does not block library load
  await Promise.allSettled([loadLocalModels(), loadUploadedList()]);
  await restoreAssemblyState();
  refreshUndoButtons();
})();

setInterval(checkHealth, 30000);
window.toggleWireframe = toggleWireframe;
window.toggleGrid      = toggleGrid;

