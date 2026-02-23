import * as THREE from "./vendor/three/three.module.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";

const baseUrl = window.gfun?.cadApiBaseUrl ?? "http://127.0.0.1:8000";
const API_TIMEOUT_MS = 10000;
const DEFAULT_PROJECT_ID = "default-project";

let occtPromise = null;
const getOcct = async () => {
  if (!occtPromise) {
    if (typeof window.occtimportjs !== "function") {
      throw new Error("occt-import-js failed to load");
    }
    occtPromise = window.occtimportjs();
  }
  return occtPromise;
};

const fetchWithTimeout = (url, init = {}, timeoutMs = API_TIMEOUT_MS) => {
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs)
  });
};

const fetchJson = async (url, init = {}, timeoutMs = API_TIMEOUT_MS) => {
  const response = await fetchWithTimeout(url, init, timeoutMs);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`.trim());
  }
  return response.json();
};

const apiChip = document.getElementById("api-chip");
const statusText = document.getElementById("status-text");
const modelList = document.getElementById("model-list");
const projectIdInput = document.getElementById("project-id");
const selectedModelLabel = document.getElementById("selected-model");
const activeToolLabel = document.getElementById("active-tool");
const timeline = document.getElementById("timeline");
const viewportOverlay = document.getElementById("viewport-overlay");
const palette = document.getElementById("command-palette");
const commandInput = document.getElementById("command-input");
const stepInput = document.getElementById("model-file-input");
const lengthAxis = document.getElementById("length-axis");
const lengthTarget = document.getElementById("length-target");
const applyLengthEditButton = document.getElementById("apply-length-edit");
const snapConstraint = document.getElementById("snap-constraint");
const snapSource = document.getElementById("snap-source");
const snapTarget = document.getElementById("snap-target");
const applySnapButton = document.getElementById("apply-snap");

const viewportRoot = document.getElementById("viewport-canvas");
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0a1428");
scene.fog = new THREE.Fog(0x0a1428, 5000, 10000);

const camera = new THREE.PerspectiveCamera(55, viewportRoot.clientWidth / viewportRoot.clientHeight, 0.1, 10000);
camera.position.set(500, 350, 500);

let renderer;
let controls;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(viewportRoot.clientWidth, viewportRoot.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowShadowMap;
  viewportRoot.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 2;
} catch (error) {
  console.error("Failed to initialize 3D renderer", error);
  statusText.textContent = "3D renderer unavailable";
  viewportOverlay.textContent = "3D unavailable — menu actions still active";
  renderer = {
    domElement: viewportRoot,
    setPixelRatio: () => {},
    setSize: () => {},
    render: () => {}
  };
  controls = {
    enableDamping: false,
    dampingFactor: 0,
    update: () => {},
    target: new THREE.Vector3()
  };
}

const hemi = new THREE.HemisphereLight(0xb2ddff, 0x1b2238, 1.0);
const dir = new THREE.DirectionalLight(0xffffff, 1.4);
dir.position.set(300, 400, 250);
dir.castShadow = true;
dir.shadow.mapSize.width = 2048;
dir.shadow.mapSize.height = 2048;
dir.shadow.camera.near = 0.5;
dir.shadow.camera.far = 2000;
dir.shadow.camera.left = -1000;
dir.shadow.camera.right = 1000;
dir.shadow.camera.top = 1000;
dir.shadow.camera.bottom = -1000;
scene.add(hemi, dir);

const grid = new THREE.GridHelper(1500, 60, 0x2d4a70, 0x1a2f4a);
grid.position.y = 0;
scene.add(grid);

const axis = new THREE.AxesHelper(120);
scene.add(axis);

let loadedObject = null;
let selectedModelId = null;

const addEvent = (message) => {
  const entry = document.createElement("div");
  entry.className = "event";
  entry.textContent = message;
  timeline.prepend(entry);
};

const renderOperationTimeline = (operations) => {
  timeline.innerHTML = "";

  if (!operations.length) {
    const empty = document.createElement("div");
    empty.className = "event";
    empty.textContent = "Session initialized";
    timeline.appendChild(empty);
    return;
  }

  operations
    .slice()
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .forEach((operation) => {
      const entry = document.createElement("div");
      entry.className = "event";
      entry.textContent = `${operation.summary}`;
      timeline.appendChild(entry);
    });
};

const setStatus = (text) => {
  statusText.textContent = text;
};

const clearModel = () => {
  if (!loadedObject) {
    return;
  }

  scene.remove(loadedObject);
  loadedObject.traverse((node) => {
    if (node.isMesh) {
      node.geometry?.dispose();
      if (Array.isArray(node.material)) {
        node.material.forEach((mat) => mat.dispose());
      } else {
        node.material?.dispose();
      }
    }
  });
  loadedObject = null;
};

const fitCameraToObject = (object3D) => {
  const box = new THREE.Box3().setFromObject(object3D);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov = (camera.fov * Math.PI) / 180;
  const distance = maxDim / (2 * Math.tan(fov / 2));

  camera.position.set(center.x + distance * 1.2, center.y + distance * 0.9, center.z + distance * 1.2);
  camera.near = Math.max(0.1, maxDim / 1000);
  camera.far = Math.max(5000, maxDim * 15);
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
};

const parseStepBlob = async (blob) => {
  const occt = await getOcct();
  const buffer = await blob.arrayBuffer();
  const fileBytes = new Uint8Array(buffer);

  // occt-import-js v0.3+ returns plain JS arrays:
  //   result.meshes  → Array<{ name, attributes:{position,normal}, index, brep_faces }>
  //   mesh.attributes.position.array → flat Array of float64 (x,y,z triplets)
  //   mesh.index.array               → flat Array of uint32 indices (0-based)
  const result = occt.ReadStepFile(fileBytes, null);
  if (!result || !result.success)
    throw new Error("occt failed to parse STEP file.");
  if (!Array.isArray(result.meshes) || result.meshes.length === 0)
    throw new Error("No mesh data returned from STEP parser.");

  const group = new THREE.Group();

  for (let mi = 0; mi < result.meshes.length; mi++) {
    const mesh = result.meshes[mi];
    if (!mesh || !mesh.attributes || !mesh.attributes.position || !mesh.index) continue;

    const posData  = mesh.attributes.position.array;
    const normData = mesh.attributes.normal ? mesh.attributes.normal.array : null;
    const idxData  = mesh.index.array;

    const posCount = posData.length;
    const idxCount = idxData.length;
    if (!posCount || posCount % 3 !== 0) continue;
    if (!idxCount || idxCount % 3 !== 0) continue;

    const vertCount = posCount / 3;
    const positions = new Float32Array(posCount);
    for (let k = 0; k < posCount; k++) positions[k] = posData[k];

    let normals = null;
    if (normData && normData.length === posCount) {
      normals = new Float32Array(posCount);
      for (let k = 0; k < posCount; k++) normals[k] = normData[k];
    }

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
      new THREE.MeshStandardMaterial({ 
        color: 0x7ec7ff, 
        metalness: 0.45, 
        roughness: 0.35,
        side: THREE.DoubleSide
      })
    );
    threeMesh.castShadow = true;
    threeMesh.receiveShadow = true;
    group.add(threeMesh);
  }

  if (!group.children.length)
    throw new Error("STEP parse produced no valid mesh geometry.");

  return group;
};

const loadStepBlob = async (blob, label) => {
  setStatus("Parsing STEP...");

  const object = await parseStepBlob(blob);
  clearModel();

  loadedObject = object;
  scene.add(loadedObject);
  fitCameraToObject(loadedObject);

  viewportOverlay.textContent = `Loaded: ${label}`;
  selectedModelLabel.textContent = label;
  setStatus("Model ready");
  addEvent(`Model loaded: ${label}`);
};

const checkApi = async () => {
  try {
    const response = await fetchWithTimeout(`${baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`CAD API returned ${response.status}`);
    }
    apiChip.textContent = "CAD API online";
    apiChip.classList.remove("warn");
    apiChip.classList.add("ok");
  } catch (error) {
    apiChip.textContent = "CAD API offline";
    apiChip.classList.remove("ok");
    apiChip.classList.add("warn");
    setStatus("CAD API offline");
    console.error(error);
  }
};

const fetchModels = async () => {
  let projectId = projectIdInput.value.trim();
  if (!projectId) {
    projectId = DEFAULT_PROJECT_ID;
    projectIdInput.value = projectId;
  }

  try {
    setStatus("Fetching models...");
    const payload = await fetchJson(`${baseUrl}/api/v1/models?project_id=${encodeURIComponent(projectId)}`);
    modelList.innerHTML = "";

    if (!payload.models.length) {
      const empty = document.createElement("div");
      empty.className = "mono";
      empty.textContent = "No models uploaded for this project.";
      modelList.appendChild(empty);
      setStatus("No models in project");
      return;
    }

    payload.models.forEach((model) => {
      const row = document.createElement("button");
      row.className = "tree-item";
      row.innerHTML = `<span>${model.file_name}</span><span class="mono">${model.model_id}</span>`;
      row.addEventListener("click", async () => {
        try {
          setStatus("Downloading model...");
          const content = await fetchWithTimeout(`${baseUrl}/api/v1/models/${model.model_id}/content`);
          if (!content.ok) {
            throw new Error(`Model download failed (${content.status})`);
          }
          const blob = await content.blob();
          await loadStepBlob(blob, model.file_name);
          selectedModelId = model.model_id;
          [...document.querySelectorAll(".tree-item")].forEach((item) => item.classList.remove("active"));
          row.classList.add("active");
          await fetchOperationHistory();
        } catch (error) {
          setStatus("Model load failed");
          console.error(error);
        }
      });
      modelList.appendChild(row);
    });

    setStatus(`Loaded ${payload.models.length} model references`);
  } catch (error) {
    setStatus("Failed to load models");
    console.error(error);
  }
};

const fetchOperationHistory = async () => {
  if (!selectedModelId) {
    renderOperationTimeline([]);
    return;
  }

  const payload = await fetchJson(`${baseUrl}/api/v1/models/${selectedModelId}/operations`);
  renderOperationTimeline(payload.operations);
};

const executeCommand = async (operationType, parameters) => {
  if (!selectedModelId) {
    throw new Error("Load or select a model first.");
  }

  const response = await fetchWithTimeout(`${baseUrl}/api/v1/commands/execute`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model_id: selectedModelId,
      operation_type: operationType,
      parameters
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Command failed: ${detail}`);
  }

  return response.json();
};

const applyLengthEditPrototype = async () => {
  const axis = lengthAxis.value;
  const targetLength = Number(lengthTarget.value);
  if (!Number.isFinite(targetLength) || targetLength <= 0) {
    throw new Error("Target length must be a positive number.");
  }

  setStatus("Applying length edit...");
  const result = await executeCommand("length_edit", {
    axis,
    target_length_mm: targetLength
  });

  if (loadedObject) {
    const scaleFactor = Math.max(0.15, Math.min(5, targetLength / 1000));
    loadedObject.scale[axis] = scaleFactor;
  }

  addEvent(result.operation.summary);
  setStatus("Length edit applied");
  await fetchOperationHistory();
};

const applySnapPrototype = async () => {
  const constraint = snapConstraint.value;
  const sourceRef = snapSource.value.trim() || "source";
  const targetRef = snapTarget.value.trim() || "target";

  setStatus("Applying snap constraint...");
  const result = await executeCommand("snap_constraint", {
    constraint,
    source_ref: sourceRef,
    target_ref: targetRef
  });

  if (loadedObject) {
    if (constraint === "angle") {
      loadedObject.rotation.z += Math.PI / 18;
    } else if (constraint === "distance") {
      loadedObject.position.x += 12;
    } else {
      loadedObject.position.y += 6;
    }
  }

  addEvent(result.operation.summary);
  setStatus("Snap constraint applied");
  await fetchOperationHistory();
};

const uploadSelectedStep = async () => {
  let projectId = projectIdInput.value.trim();
  if (!projectId) {
    projectId = DEFAULT_PROJECT_ID;
    projectIdInput.value = projectId;
  }
  
  const file = stepInput.files?.[0];
  if (!file) {
    setStatus("No file selected");
    return;
  }

  const form = new FormData();
  form.append("file", file);
  setStatus("Uploading STEP...");

  try {
    const response = await fetchWithTimeout(`${baseUrl}/api/v1/models/upload?project_id=${encodeURIComponent(projectId)}`, {
      method: "POST",
      body: form
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Upload failed: ${detail}`);
    }

    addEvent(`Uploaded ${file.name}`);
    setStatus("Upload complete");
    await fetchModels();
  } catch (error) {
    setStatus("Upload failed");
    console.error(error);
  }
};

const fetchLocalModels = async () => {
  try {
    const response = await fetchJson(`${baseUrl}/api/v1/local-models`);
    const localModelsList = document.getElementById("local-models-list");
    if (!localModelsList) {
      return;
    }
    
    localModelsList.innerHTML = "";
    if (!response.models || response.models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mono";
      empty.textContent = "No local models available";
      localModelsList.appendChild(empty);
      return;
    }

    response.models.forEach((filename) => {
      const row = document.createElement("button");
      row.className = "tree-item";
      row.innerHTML = `<span>${filename}</span><span class="mono">library</span>`;
      row.addEventListener("click", async () => {
        try {
          setStatus(`Loading ${filename}...`);
          const content = await fetchWithTimeout(`${baseUrl}/api/v1/local-models/${filename}`);
          if (!content.ok) {
            throw new Error(`Load failed (${content.status})`);
          }
          const blob = await content.blob();
          await loadStepBlob(blob, filename);
          selectedModelId = filename;
          [...document.querySelectorAll("#local-models-list .tree-item")].forEach((item) => item.classList.remove("active"));
          row.classList.add("active");
        } catch (error) {
          setStatus("Failed to load local model");
          console.error(error);
        }
      });
      localModelsList.appendChild(row);
    });
  } catch (error) {
    console.warn("Local models not available", error);
  }
};

const hookUI = () => {
  document.getElementById("refresh-models").addEventListener("click", async () => {
    try {
      await fetchModels();
      await fetchOperationHistory();
    } catch (error) {
      setStatus("Model refresh failed");
      console.error(error);
    }
  });

  document.getElementById("upload-step").addEventListener("click", () => {
    stepInput.click();
  });

  stepInput.addEventListener("change", async () => {
    try {
      await uploadSelectedStep();
    } catch (error) {
      setStatus("Upload failed");
      console.error(error);
    }
  });

  applyLengthEditButton.addEventListener("click", async () => {
    try {
      await applyLengthEditPrototype();
    } catch (error) {
      setStatus("Length edit failed");
      console.error(error);
    }
  });

  applySnapButton.addEventListener("click", async () => {
    try {
      await applySnapPrototype();
    } catch (error) {
      setStatus("Snap failed");
      console.error(error);
    }
  });

  document.getElementById("load-sample").addEventListener("click", async () => {
    try {
      setStatus("Loading local STEP sample...");
      const response = await fetchWithTimeout(`${baseUrl}/api/v1/sample-step`);
      if (!response.ok) {
        throw new Error("Could not load local sample file.");
      }
      const blob = await response.blob();
      await loadStepBlob(blob, "GFA-802G.step");
      addEvent("Loaded local sample GFA-802G.step");
    } catch (error) {
      setStatus("Local sample load failed");
      console.error(error);
    }
  });

  document.querySelectorAll(".tool").forEach((toolButton) => {
    toolButton.addEventListener("click", () => {
      document.querySelectorAll(".tool").forEach((button) => button.classList.remove("active"));
      toolButton.classList.add("active");
      activeToolLabel.textContent = toolButton.dataset.tool;
      addEvent(`Tool switched: ${toolButton.dataset.tool}`);
    });
  });

  document.querySelectorAll("[data-toggle-panel]").forEach((toggleButton) => {
    toggleButton.addEventListener("click", () => {
      const panelId = toggleButton.getAttribute("data-toggle-panel");
      const panel = document.getElementById(panelId);
      panel.style.display = panel.style.display === "none" ? "block" : "none";
      addEvent(`Panel toggled: ${panelId}`);
    });
  });

  const openCommandPalette = () => {
    palette.classList.add("open");
    commandInput.focus();
  };

  const closeCommandPalette = () => {
    palette.classList.remove("open");
  };

  document.getElementById("open-command").addEventListener("click", openCommandPalette);
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openCommandPalette();
    }
    if (event.key === "Escape") {
      closeCommandPalette();
    }
  });

  commandInput.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }

    const cmd = commandInput.value.trim().toLowerCase();
    if (cmd === "list") {
      try {
        await fetchModels();
      } catch (error) {
        console.error(error);
      }
    } else if (cmd === "upload") {
      stepInput.click();
    } else if (cmd === "sample") {
      document.getElementById("load-sample").click();
    } else if (cmd === "length") {
      try {
        await applyLengthEditPrototype();
      } catch (error) {
        console.error(error);
      }
    } else if (cmd === "snap") {
      try {
        await applySnapPrototype();
      } catch (error) {
        console.error(error);
      }
    }
    addEvent(`Command: ${cmd || "(empty)"}`);
    closeCommandPalette();
    commandInput.value = "";
  });
};

const animate = () => {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
};

const resize = () => {
  const width = viewportRoot.clientWidth;
  const height = viewportRoot.clientHeight;
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
};

window.addEventListener("resize", resize);

const init = async () => {
  projectIdInput.value = DEFAULT_PROJECT_ID;
  setStatus("Initializing workspace");
  hookUI();
  void checkApi();
  setInterval(checkApi, 30000);
  try {
    await Promise.all([
      fetchModels(),
      fetchLocalModels(),
      fetchOperationHistory()
    ]);
  } catch (error) {
    setStatus("Initialization complete (some features may be limited)");
    console.error(error);
  }
  animate();
};

void init();
