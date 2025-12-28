import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { BodyCamShader } from './BodyCamShader.js';

// --- CONFIGURATION ---
const CONFIG = {
    // Path to your single environment GLB file
    environmentModel: './environment.glb',
    
    // Chaos event timing
    chaosInterval: [8000, 18000],
    chaosChainChance: 0.25,
    
    // Debug visualization
    showDebug: false,
    
    // Fallback: if no GLB found, generate procedural environment
    useProcedural: true,
    proceduralSettings: {
        streetLength: 60,
        streetWidth: 12,
        sidewalkWidth: 4,
        buildingCount: 8
    }
};

/*
=============================================================================
NAMING CONVENTION FOR YOUR 3D MODEL (Blender/Maya/etc)
=============================================================================

Name your objects with these PREFIXES to automatically set up the scene:

COLLISION / PHYSICS:
  collider_*      - Static physics collider (invisible, blocks movement)
  collider_box_*  - Box-shaped collider
  
NAVIGATION:
  walkable_*      - Surface the NPC can walk on (used for nav grid)
  cover_*         - Hiding spot (NPC will run here when panicking)
  spawn_*         - NPC spawn point (uses first one found)
  
LIGHTING:
  light_point_*   - Point light (uses object position, set color in Blender)
  light_spot_*    - Spotlight
  light_street_*  - Streetlight with automatic glow effect
  
SPECIAL OBJECTS:
  intlight_*      - Interior light/window glow (emissive material)
  prop_*          - Decorative prop (no physics)
  vehicle_*       - Parked vehicle (gets physics collider)
  
EXAMPLES:
  - "walkable_sidewalk"     → NPC can walk here
  - "collider_building_01"  → Invisible wall
  - "cover_alley"           → Hiding spot
  - "light_street_lamp_01"  → Creates point light + glow
  - "spawn_main"            → NPC starts here

=============================================================================
*/

// --- ASSET PATHS ---
const ASSETS = {
    sounds: {
        // Ambient
        cityAmbience: 'sounds/city_ambience.mp3',
        wind: 'sounds/wind.mp3',
        
        // Events
        gunshot: 'sounds/gunshot.mp3',
        explosion: 'sounds/explosion.mp3',
        carCrash: 'sounds/car_crash.mp3',
        scream: 'sounds/scream.mp3',
        helicopter: 'sounds/helicopter.mp3',
        debris: 'sounds/debris_fall.mp3',
        
        // NPC reactions
        breathing: 'sounds/breathing_heavy.mp3',
        footsteps: 'sounds/footsteps_run.mp3',
        gasp: 'sounds/gasp.mp3',
    }
};

// --- LOADED ASSETS CACHE ---
const loadedSounds = {};
const gltfLoader = new GLTFLoader();

// Environment data extracted from GLB
let environmentData = {
    loaded: false,
    spawnPoint: new THREE.Vector3(0, 1, 0),
    lightPositions: [],
    coverPositions: []
};

// Sound loading and playback
function loadSound(key) {
    if (loadedSounds[key]) return loadedSounds[key];
    
    const path = ASSETS.sounds[key];
    if (!path) return null;
    
    try {
        const audio = new Audio(`./assets/${path}`);
        loadedSounds[key] = audio;
        return audio;
    } catch (e) {
        return null;
    }
}

function playSound(key, volume = 1.0, loop = false) {
    const sound = loadSound(key);
    if (sound) {
        const instance = sound.cloneNode();
        instance.volume = Math.min(1, Math.max(0, volume));
        instance.loop = loop;
        instance.play().catch(() => {});
        return instance;
    }
    return null;
}

function stopSound(audioInstance) {
    if (audioInstance) {
        audioInstance.pause();
        audioInstance.currentTime = 0;
    }
}

// --- ENVIRONMENT GLB LOADER ---
async function loadEnvironmentGLB() {
    try {
        console.log(`Loading environment from: ${CONFIG.environmentModel}`);
        const gltf = await gltfLoader.loadAsync(CONFIG.environmentModel);
        
        console.log('Environment GLB loaded, parsing tagged objects...');
        parseEnvironmentScene(gltf.scene);
        
        // Add the environment to the scene
        scene.add(gltf.scene);
        environmentData.loaded = true;
        
        return true;
    } catch (e) {
        console.warn('Environment GLB not found, using procedural fallback');
        return false;
    }
}

// Parse the GLB scene and set up physics, lights, nav based on object names
function parseEnvironmentScene(envScene) {
    const walkableSurfaces = [];
    
    envScene.traverse((child) => {
        const name = child.name.toLowerCase();
        
        // Enable shadows on all meshes
        if (child.isMesh) {
            child.castShadow = true;
            child.receiveShadow = true;
        }
        
        // --- COLLIDERS ---
        if (name.startsWith('collider')) {
            // Make collider invisible but keep for physics
            if (child.isMesh) {
                child.visible = false;
            }
            createColliderFromObject(child);
        }
        
        // --- WALKABLE SURFACES ---
        if (name.startsWith('walkable')) {
            walkableSurfaces.push(child);
            // Also create physics collider for walkable surfaces
            if (child.isMesh) {
                createColliderFromObject(child);
            }
        }
        
        // --- COVER SPOTS ---
        if (name.startsWith('cover')) {
            const pos = new THREE.Vector3();
            child.getWorldPosition(pos);
            coverSpots.push(pos);
            environmentData.coverPositions.push(pos.clone());
            
            if (CONFIG.showDebug) {
                const marker = new THREE.Mesh(
                    new THREE.SphereGeometry(0.3),
                    new THREE.MeshBasicMaterial({ color: 0x0000ff, wireframe: true })
                );
                marker.position.copy(pos);
                scene.add(marker);
            }
            console.log(`Cover spot found: ${child.name} at`, pos);
        }
        
        // --- SPAWN POINTS ---
        if (name.startsWith('spawn')) {
            const pos = new THREE.Vector3();
            child.getWorldPosition(pos);
            environmentData.spawnPoint.copy(pos);
            console.log(`Spawn point found: ${child.name} at`, pos);
        }
        
        // --- LIGHTS ---
        if (name.startsWith('light_point') || name.startsWith('light_street')) {
            const pos = new THREE.Vector3();
            child.getWorldPosition(pos);
            
            // Create point light at this position
            const light = new THREE.PointLight(0xffeedd, 40, 25);
            light.position.copy(pos);
            light.castShadow = true;
            light.shadow.mapSize.width = 256;
            light.shadow.mapSize.height = 256;
            scene.add(light);
            
            // Add glow sprite for streetlights
            if (name.includes('street')) {
                const glowMat = new THREE.SpriteMaterial({ 
                    color: 0xfff8e8, 
                    transparent: true, 
                    opacity: 0.6 
                });
                const glow = new THREE.Sprite(glowMat);
                glow.scale.set(1.5, 1.5, 1);
                glow.position.copy(pos);
                scene.add(glow);
            }
            
            environmentData.lightPositions.push(pos.clone());
            console.log(`Light created: ${child.name} at`, pos);
        }
        
        if (name.startsWith('light_spot')) {
            const pos = new THREE.Vector3();
            child.getWorldPosition(pos);
            
            const spotlight = new THREE.SpotLight(0xffffff, 30, 20, Math.PI / 6, 0.5);
            spotlight.position.copy(pos);
            spotlight.castShadow = true;
            scene.add(spotlight);
            scene.add(spotlight.target);
            
            console.log(`Spotlight created: ${child.name} at`, pos);
        }
        
        // --- VEHICLES (get physics) ---
        if (name.startsWith('vehicle')) {
            createColliderFromObject(child);
        }
        
        // --- INTERIOR LIGHTS / WINDOWS ---
        if (name.startsWith('intlight') || name.startsWith('window')) {
            // Make material emissive if it isn't already
            if (child.isMesh && child.material) {
                const mat = child.material.clone();
                mat.emissive = mat.color || new THREE.Color(0xfff5e0);
                mat.emissiveIntensity = 0.5;
                child.material = mat;
            }
        }
    });
    
    // Build navigation grid from walkable surfaces
    if (walkableSurfaces.length > 0) {
        buildNavGridFromSurfaces(walkableSurfaces);
    }
    
    console.log(`Environment parsed: ${coverSpots.length} cover spots, ${environmentData.lightPositions.length} lights`);
}

// Create a physics collider from a mesh object
function createColliderFromObject(obj) {
    if (!obj.isMesh) {
        // For empty objects, use position as a small box
        const pos = new THREE.Vector3();
        obj.getWorldPosition(pos);
        const shape = new CANNON.Box(new CANNON.Vec3(0.5, 0.5, 0.5));
        const body = new CANNON.Body({ mass: 0, shape });
        body.position.copy(pos);
        world.addBody(body);
        return;
    }
    
    // Get world-space bounding box
    const box = new THREE.Box3().setFromObject(obj);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    
    // Skip tiny objects
    if (size.x < 0.1 || size.y < 0.1 || size.z < 0.1) return;
    
    const shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));
    const body = new CANNON.Body({ mass: 0, shape });
    body.position.set(center.x, center.y, center.z);
    world.addBody(body);
}

// Build navigation grid by raycasting onto walkable surfaces
function buildNavGridFromSurfaces(surfaces) {
    console.log('Building navigation grid from walkable surfaces...');
    
    const raycaster = new THREE.Raycaster();
    const down = new THREE.Vector3(0, -1, 0);
    
    // Get bounds of all walkable surfaces
    const totalBounds = new THREE.Box3();
    surfaces.forEach(surf => {
        const box = new THREE.Box3().setFromObject(surf);
        totalBounds.union(box);
    });
    
    const min = totalBounds.min;
    const max = totalBounds.max;
    const step = 1.5; // Grid spacing
    
    for (let x = min.x; x <= max.x; x += step) {
        for (let z = min.z; z <= max.z; z += step) {
            const origin = new THREE.Vector3(x, max.y + 5, z);
            raycaster.set(origin, down);
            
            for (const surface of surfaces) {
                const intersects = raycaster.intersectObject(surface, true);
                if (intersects.length > 0) {
                    const hit = intersects[0];
                    // Only add if surface is relatively flat
                    if (hit.face && hit.face.normal.y > 0.7) {
                        navNodes.push(hit.point.clone());
                        
                        if (CONFIG.showDebug) {
                            const dot = new THREE.Mesh(
                                new THREE.SphereGeometry(0.1),
                                new THREE.MeshBasicMaterial({ color: 0x00ff00 })
                            );
                            dot.position.copy(hit.point);
                            dot.position.y += 0.1;
                            scene.add(dot);
                        }
                    }
                    break; // Only need one hit per grid point
                }
            }
        }
    }
    
    console.log(`Navigation grid built: ${navNodes.length} nodes from GLB surfaces`);
}

// --- GLOBALS ---
let scene, camera, renderer, composer, bodyCamPass;
let world, clock = new THREE.Clock();
let physicsBodies = [], physicsMeshes = [];
let startTime = Date.now();

// NPC AI STATE MACHINE
let npc = {
    body: null,
    mesh: null,
    status: 'IDLE', // IDLE, PANIC, COWERING, LOOKING, CAUTIOUS
    targetNode: null, 
    shake: 0,
    yaw: 0,      // Horizontal rotation (left/right)
    pitch: 0,    // Vertical rotation (up/down) - clamped to prevent flip
    panicTimer: 0,
    lastDangerPos: new THREE.Vector3(),
    crouchAmount: 0,  // 0 = standing, 1 = crouched
    coverDirection: new THREE.Vector3(), // Direction to face when hiding
    lastPos: new THREE.Vector3(),       // For stuck detection
    stuckTime: 0,                       // How long we've barely moved
    fleeAfterHide: false,               // After hiding, run far away from last danger before idling
    // Smarter AI additions
    dangerMemory: [],                   // Recent danger positions [{pos, time}]
    alertLevel: 0,                      // 0-1, how on-edge they are
    lastLookAroundTime: 0,              // For nervous glancing
    breathingPhase: 0,                  // For realistic breathing motion
    recentDangerCount: 0                // Track how many dangers recently
};

// NAVIGATION
let navNodes = [];
let coverSpots = []; // Special spots to hide

// CHAOS TRACKING
let activeChaosSources = [];

// --- INITIALIZATION ---
init();

async function init() {
    // 0. PRELOAD SOUNDS
    preloadSounds();
    
    // 1. SCENE SETUP
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.FogExp2(0x0a0a12, 0.018);

    // High FOV for bodycam aesthetic
    camera = new THREE.PerspectiveCamera(95, window.innerWidth / window.innerHeight, 0.1, 150);
    
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.8;
    document.body.appendChild(renderer.domElement);

    // 2. PHYSICS WORLD
    world = new CANNON.World();
    world.gravity.set(0, -20, 0);
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;

    // Ground plane (fallback)
    const groundBody = new CANNON.Body({ 
        type: CANNON.Body.STATIC, 
        shape: new CANNON.Plane() 
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // 3. LOAD ENVIRONMENT
    // Try to load GLB environment first, fall back to procedural if not found
    const glbLoaded = await loadEnvironmentGLB();
    
    if (!glbLoaded && CONFIG.useProcedural) {
        console.log('Building procedural environment...');
        buildStreetEnvironment();
        buildNavigationGrid();
    }
    
    // 4. CREATE NPC (at spawn point from GLB or default)
    createNPC(environmentData.spawnPoint);

    // 5. LIGHTING
    setupLighting();

    // 6. POST PROCESSING
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bodyCamPass = new ShaderPass(BodyCamShader);
    composer.addPass(bodyCamPass);

    // 7. START CHAOS DIRECTOR
    scheduleNextEvent();
    
    // 8. UI Updates
    setInterval(updateTimestamp, 100);
    
    // 9. Start render loop
    animate();
    
    // Hide loading
    document.getElementById('loading').style.display = 'none';
}

// --- ASSET PRELOADING ---
// Attempts to load all models in background - uses procedural fallbacks if not found
function preloadSounds() {
    // Preload sounds (non-blocking)
    const soundKeys = Object.keys(ASSETS.sounds);
    for (const key of soundKeys) {
        loadSound(key);
    }
    console.log('Sound preload initiated');
}

// --- NPC CREATION ---
function createNPC(spawnPoint = new THREE.Vector3(0, 1, 0)) {
    const sphereShape = new CANNON.Sphere(0.35);
    npc.body = new CANNON.Body({ 
        mass: 70, 
        shape: sphereShape,
        angularDamping: 0.99,
        linearDamping: 0.4
    });
    npc.body.position.set(spawnPoint.x, spawnPoint.y + 0.5, spawnPoint.z);
    world.addBody(npc.body);
    
    console.log(`NPC spawned at: ${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}, ${spawnPoint.z.toFixed(1)}`);
    
    // Visual representation (invisible but useful for debugging)
    if (CONFIG.showDebug) {
        const geo = new THREE.SphereGeometry(0.35);
        const mat = new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
        npc.mesh = new THREE.Mesh(geo, mat);
        scene.add(npc.mesh);
    }
}

// --- PROCEDURAL STREET ENVIRONMENT ---
function buildStreetEnvironment() {
    const streetLen = CONFIG.streetLength;
    const streetW = CONFIG.streetWidth;
    const sidewalkW = CONFIG.sidewalkWidth;
    
    // MATERIALS - brighter for visibility
    const asphaltMat = new THREE.MeshStandardMaterial({ 
        color: 0x2a2a2a, 
        roughness: 0.9,
        metalness: 0.1
    });
    
    const sidewalkMat = new THREE.MeshStandardMaterial({ 
        color: 0x4a4a4a, 
        roughness: 0.8 
    });
    
    const buildingMats = [
        new THREE.MeshStandardMaterial({ color: 0x3d3d3d, roughness: 0.7 }),
        new THREE.MeshStandardMaterial({ color: 0x353535, roughness: 0.8 }),
        new THREE.MeshStandardMaterial({ color: 0x2f2f2f, roughness: 0.75 }),
        new THREE.MeshStandardMaterial({ color: 0x434343, roughness: 0.65 })
    ];

    // ROAD
    const roadGeo = new THREE.PlaneGeometry(streetW, streetLen);
    const road = new THREE.Mesh(roadGeo, asphaltMat);
    road.rotation.x = -Math.PI / 2;
    road.receiveShadow = true;
    road.name = 'walkable_road';
    scene.add(road);
    
    // Road markings
    const lineGeo = new THREE.PlaneGeometry(0.15, streetLen);
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xffff00, emissive: 0x333300 });
    const centerLine = new THREE.Mesh(lineGeo, lineMat);
    centerLine.rotation.x = -Math.PI / 2;
    centerLine.position.y = 0.01;
    scene.add(centerLine);

    // SIDEWALKS (Both sides)
    [-1, 1].forEach(side => {
        const sidewalk = new THREE.Mesh(
            new THREE.BoxGeometry(sidewalkW, 0.15, streetLen),
            sidewalkMat
        );
        sidewalk.position.set(side * (streetW / 2 + sidewalkW / 2), 0.075, 0);
        sidewalk.receiveShadow = true;
        sidewalk.castShadow = true;
        sidewalk.name = 'walkable_sidewalk';
        scene.add(sidewalk);
        
        // Physics for sidewalk
        const swShape = new CANNON.Box(new CANNON.Vec3(sidewalkW / 2, 0.075, streetLen / 2));
        const swBody = new CANNON.Body({ mass: 0, shape: swShape });
        swBody.position.set(side * (streetW / 2 + sidewalkW / 2), 0.075, 0);
        world.addBody(swBody);
    });

    // BUILDINGS
    const buildingPositions = [];
    for (let i = 0; i < CONFIG.buildingCount; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const z = (i - CONFIG.buildingCount / 2) * (streetLen / CONFIG.buildingCount) + 5;
        
        const width = 6 + Math.random() * 4;
        const depth = 8 + Math.random() * 6;
        const height = 8 + Math.random() * 20;
        
        const mat = buildingMats[Math.floor(Math.random() * buildingMats.length)];
        const building = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
        
        const x = side * (streetW / 2 + sidewalkW + depth / 2 + 1);
        building.position.set(x, height / 2, z);
        building.castShadow = true;
        building.receiveShadow = true;
        scene.add(building);
        
        // Building physics
        const bShape = new CANNON.Box(new CANNON.Vec3(width / 2, height / 2, depth / 2));
        const bBody = new CANNON.Body({ mass: 0, shape: bShape });
        bBody.position.copy(building.position);
        world.addBody(bBody);
        
        buildingPositions.push({ x, z, side });
        
        // WINDOWS (emissive rectangles)
        const windowRows = Math.floor(height / 3);
        const windowCols = Math.floor(width / 2);
        for (let row = 0; row < windowRows; row++) {
            for (let col = 0; col < windowCols; col++) {
                if (Math.random() > 0.3) { // More windows lit
                    const winGeo = new THREE.PlaneGeometry(1.2, 1.8);
                    const litColor = Math.random() > 0.7 ? 0xfff5e0 : 0xe8f4ff;
                    const winMat = new THREE.MeshBasicMaterial({ 
                        color: litColor,
                        transparent: true,
                        opacity: 0.5 + Math.random() * 0.4
                    });
                    const win = new THREE.Mesh(winGeo, winMat);
                    
                    win.position.set(
                        x - side * (depth / 2 + 0.01),
                        2 + row * 3,
                        z + (col - windowCols / 2) * 2
                    );
                    win.rotation.y = side * Math.PI / 2;
                    scene.add(win);
                }
            }
        }
        
        // Cover spots near buildings
        coverSpots.push(new THREE.Vector3(
            side * (streetW / 2 + sidewalkW / 2),
            0.2,
            z
        ));
    }

    // STREET PROPS
    addStreetProps(streetLen, streetW, sidewalkW);
    
    // BUS STOP
    createBusStop(streetW / 2 + sidewalkW / 2, -5);
}

function addStreetProps(streetLen, streetW, sidewalkW) {
    // Lamp posts
    const lampPositions = [];
    for (let z = -streetLen / 2 + 5; z < streetLen / 2; z += 12) {
        [-1, 1].forEach(side => {
            const x = side * (streetW / 2 + 1);
            createLampPost(x, z);
            lampPositions.push({ x, z });
        });
    }
    
    // Trash cans
    for (let i = 0; i < 6; i++) {
        const side = Math.random() > 0.5 ? -1 : 1;
        const x = side * (streetW / 2 + sidewalkW / 2 + (Math.random() - 0.5) * 2);
        const z = (Math.random() - 0.5) * streetLen * 0.8;
        createTrashCan(x, z);
    }
    
    // Parked cars
    for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        const x = side * (streetW / 2 - 1.5);
        const z = -20 + i * 12;
        createParkedCar(x, z, side);
    }
}

function createLampPost(x, z) {
    const postGeo = new THREE.CylinderGeometry(0.08, 0.1, 5, 8);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8 });
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(x, 2.5, z);
    post.castShadow = true;
    scene.add(post);
    
    // Lamp head
    const headGeo = new THREE.BoxGeometry(0.6, 0.3, 0.4);
    const headMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.set(x, 5.1, z);
    scene.add(head);
    
    // Light - brighter streetlights
    const light = new THREE.PointLight(0xffeedd, 60, 30);
    light.position.set(x, 4.8, z);
    light.castShadow = true;
    light.shadow.mapSize.width = 256;
    light.shadow.mapSize.height = 256;
    scene.add(light);
    
    // Glow sprite
    const glowMat = new THREE.SpriteMaterial({ 
        color: 0xfff8e8, 
        transparent: true, 
        opacity: 0.6 
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.set(1.5, 1.5, 1);
    glow.position.set(x, 4.8, z);
    scene.add(glow);
}

function createTrashCan(x, z) {
    const canGeo = new THREE.CylinderGeometry(0.3, 0.25, 0.8, 12);
    const canMat = new THREE.MeshStandardMaterial({ color: 0x2a4a2a, roughness: 0.6 });
    const can = new THREE.Mesh(canGeo, canMat);
    can.position.set(x, 0.4, z);
    can.castShadow = true;
    scene.add(can);
    
    // Physics
    const canShape = new CANNON.Cylinder(0.3, 0.25, 0.8, 8);
    const canBody = new CANNON.Body({ mass: 0, shape: canShape });
    canBody.position.set(x, 0.4, z);
    world.addBody(canBody);
}

function createParkedCar(x, z, side) {
    const bodyGeo = new THREE.BoxGeometry(2, 1.2, 4.5);
    const carColors = [0x1a1a2e, 0x2e1a1a, 0x1a2e1a, 0x2a2a2a, 0x0a0a1a];
    const bodyMat = new THREE.MeshStandardMaterial({ 
        color: carColors[Math.floor(Math.random() * carColors.length)],
        metalness: 0.7,
        roughness: 0.3
    });
    
    const carBody = new THREE.Mesh(bodyGeo, bodyMat);
    carBody.position.set(x, 0.7, z);
    carBody.castShadow = true;
    scene.add(carBody);
    
    // Roof
    const roofGeo = new THREE.BoxGeometry(1.6, 0.8, 2.5);
    const roof = new THREE.Mesh(roofGeo, bodyMat);
    roof.position.set(x, 1.5, z - 0.3);
    roof.castShadow = true;
    scene.add(roof);
    
    // Wheels
    const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.2, 16);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
    [[-0.9, 1.5], [-0.9, -1.5], [0.9, 1.5], [0.9, -1.5]].forEach(([wx, wz]) => {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(x + wx, 0.35, z + wz);
        scene.add(wheel);
    });
    
    // Headlights
    const lightGeo = new THREE.CircleGeometry(0.15, 8);
    const lightMat = new THREE.MeshBasicMaterial({ color: 0x333322 });
    [-0.6, 0.6].forEach(offset => {
        const headlight = new THREE.Mesh(lightGeo, lightMat);
        headlight.position.set(x + offset, 0.6, z + 2.26);
        scene.add(headlight);
    });
    
    // Physics
    const carShape = new CANNON.Box(new CANNON.Vec3(1, 0.8, 2.25));
    const carPhys = new CANNON.Body({ mass: 0, shape: carShape });
    carPhys.position.set(x, 0.9, z);
    world.addBody(carPhys);
}

function createBusStop(x, z) {
    // Shelter frame
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x444444, metalness: 0.9 });
    
    // Posts
    [[-1.2, -1], [-1.2, 1], [1.2, 1]].forEach(([px, pz]) => {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.5, 8), frameMat);
        post.position.set(x + px, 1.25, z + pz);
        scene.add(post);
    });
    
    // Roof
    const roofGeo = new THREE.BoxGeometry(2.6, 0.1, 2.2);
    const roof = new THREE.Mesh(roofGeo, frameMat);
    roof.position.set(x, 2.5, z);
    roof.castShadow = true;
    scene.add(roof);
    
    // Bench
    const benchGeo = new THREE.BoxGeometry(2, 0.1, 0.4);
    const benchMat = new THREE.MeshStandardMaterial({ color: 0x5a3a2a });
    const bench = new THREE.Mesh(benchGeo, benchMat);
    bench.position.set(x, 0.5, z - 0.7);
    scene.add(bench);
    
    // Sign
    const signGeo = new THREE.BoxGeometry(0.8, 0.6, 0.05);
    const signMat = new THREE.MeshStandardMaterial({ color: 0x2244aa, emissive: 0x112244 });
    const sign = new THREE.Mesh(signGeo, signMat);
    sign.position.set(x + 1.5, 2, z);
    scene.add(sign);
    
    // This is a prime cover spot
    coverSpots.push(new THREE.Vector3(x, 0.2, z));
}

// --- LIGHTING ---
function setupLighting() {
    // Ambient - provides base visibility
    const ambient = new THREE.AmbientLight(0x404050, 1.2);
    scene.add(ambient);
    
    // Hemisphere light for natural sky/ground color variation
    const hemiLight = new THREE.HemisphereLight(0x6688bb, 0x333344, 1.0);
    scene.add(hemiLight);
    
    // Moon/Sky light - brighter for better visibility
    const moonLight = new THREE.DirectionalLight(0x8899cc, 0.8);
    moonLight.position.set(20, 40, 10);
    moonLight.castShadow = true;
    moonLight.shadow.mapSize.width = 1024;
    moonLight.shadow.mapSize.height = 1024;
    moonLight.shadow.camera.near = 0.5;
    moonLight.shadow.camera.far = 100;
    moonLight.shadow.camera.left = -50;
    moonLight.shadow.camera.right = 50;
    moonLight.shadow.camera.top = 50;
    moonLight.shadow.camera.bottom = -50;
    scene.add(moonLight);
    
    // Helicopter searchlight (dramatic)
    const heliLight = new THREE.SpotLight(0xffffff, 0, 100, Math.PI / 8, 0.5, 2);
    heliLight.position.set(0, 50, 0);
    heliLight.castShadow = true;
    heliLight.name = 'heliLight';
    scene.add(heliLight);
    scene.add(heliLight.target);
}

// --- NAVIGATION GRID ---
function buildNavigationGrid() {
    // Generate walkable nodes on sidewalks and road
    const streetLen = CONFIG.streetLength;
    const streetW = CONFIG.streetWidth;
    const sidewalkW = CONFIG.sidewalkWidth;
    
    // Sidewalk nodes
    for (let z = -streetLen / 2 + 2; z < streetLen / 2 - 2; z += 1.5) {
        [-1, 1].forEach(side => {
            const x = side * (streetW / 2 + sidewalkW / 2);
            navNodes.push(new THREE.Vector3(x, 0.2, z));
            
                    if (CONFIG.showDebug) {
                        const dot = new THREE.Mesh(
                    new THREE.SphereGeometry(0.1),
                    new THREE.MeshBasicMaterial({ color: 0x00ff00 })
                        );
                dot.position.set(x, 0.3, z);
                        scene.add(dot);
                    }
        });
                }
    
    // Road crossing nodes (sparse)
    for (let z = -streetLen / 2 + 10; z < streetLen / 2 - 10; z += 15) {
        for (let x = -streetW / 2 + 1; x < streetW / 2; x += 2) {
            navNodes.push(new THREE.Vector3(x, 0.05, z));
            }
        }
    
    console.log(`Navigation grid built: ${navNodes.length} nodes, ${coverSpots.length} cover spots`);
}

// --- AI LOGIC ---
function getSafeNode(dangerPos, npcPos) {
    // ALWAYS prioritize cover spots when panicking
    const safeCover = coverSpots.filter(spot => spot.distanceTo(dangerPos) > 8);
    
    if (safeCover.length > 0) {
        // Find the closest safe cover spot to the NPC
        let bestCover = safeCover[0];
        let bestScore = Infinity;
        
        for (const spot of safeCover) {
            // Score = distance to NPC (lower is better) - distance from danger (higher is better)
            const distToNpc = npcPos ? spot.distanceTo(npcPos) : 0;
            const distFromDanger = spot.distanceTo(dangerPos);
            const score = distToNpc - distFromDanger * 0.5; // Prioritize being far from danger
            
            if (score < bestScore) {
                bestScore = score;
                bestCover = spot;
            }
        }
        return bestCover;
    }
    
    // Fallback: find distant nav node
    const safeNodes = navNodes.filter(node => node.distanceTo(dangerPos) > 12);
    
    if (safeNodes.length === 0) {
        let furthest = navNodes[0];
        let maxDist = 0;
        for (const n of navNodes) {
            const d = n.distanceTo(dangerPos);
            if (d > maxDist) { maxDist = d; furthest = n; }
        }
        return furthest;
    }

    // Pick closest safe node to NPC
    if (npcPos) {
        let closest = safeNodes[0];
        let minDist = Infinity;
        for (const n of safeNodes) {
            const d = n.distanceTo(npcPos);
            if (d < minDist) { minDist = d; closest = n; }
        }
        return closest;
    }
    
    return safeNodes[Math.floor(Math.random() * safeNodes.length)];
}

function getFarSafeNode(dangerPos, npcPos) {
    // Prefer the spot that maximizes distance from danger, with a small bias toward not being absurdly far from the NPC.
    // This is meant for "post-hide fleeing" when the immediate danger has passed.
    const candidates = [];

    for (const spot of coverSpots) {
        if (spot.distanceTo(dangerPos) > 8) candidates.push(spot);
    }
    for (const node of navNodes) {
        if (node.distanceTo(dangerPos) > 12) candidates.push(node);
    }

    if (candidates.length === 0) {
        // Worst-case fallback: pick the furthest nav node from danger
        let furthest = navNodes[0];
        let maxDist = -Infinity;
        for (const n of navNodes) {
            const d = n.distanceTo(dangerPos);
            if (d > maxDist) { maxDist = d; furthest = n; }
        }
        return furthest;
    }

    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
        const distFromDanger = c.distanceTo(dangerPos);
        const distToNpc = npcPos ? c.distanceTo(npcPos) : 0;
        const score = distFromDanger - distToNpc * 0.15;
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }
    return best;
}

function getClosestNode(pos) {
    let closest = navNodes[0];
    let minDist = Infinity;
    for (const n of navNodes) {
        const d = n.distanceTo(pos);
        if (d < minDist) { minDist = d; closest = n; }
    }
    return closest;
}

// Safe camera look function - calculates yaw/pitch without flipping
function safeLookAt(targetPos, smoothing = 0.1) {
    const camPos = camera.position;
    const dx = targetPos.x - camPos.x;
    const dy = targetPos.y - camPos.y;
    const dz = targetPos.z - camPos.z;
    
    // Calculate target yaw (horizontal angle)
    const targetYaw = Math.atan2(dx, dz);
    
    // Calculate target pitch (vertical angle) - clamped to prevent flip
    const horizontalDist = Math.sqrt(dx * dx + dz * dz);
    const targetPitch = Math.atan2(dy, horizontalDist);
    const clampedPitch = THREE.MathUtils.clamp(targetPitch, -Math.PI / 3, Math.PI / 3);
    
    // Smoothly interpolate to target angles
    npc.yaw = THREE.MathUtils.lerp(npc.yaw, targetYaw, smoothing);
    npc.pitch = THREE.MathUtils.lerp(npc.pitch, clampedPitch, smoothing);
}

// Apply the camera rotation from yaw/pitch (call after safeLookAt)
function applyCameraRotation() {
    // Reset camera rotation
    camera.rotation.set(0, 0, 0);
    camera.rotation.order = 'YXZ'; // Yaw first, then pitch - prevents gimbal lock
    
    // Apply yaw (Y) and pitch (X)
    camera.rotation.y = -npc.yaw;
    camera.rotation.x = -npc.pitch;
    
    // Apply shake as roll only
    const shakeTime = clock.getElapsedTime();
    const rollShake = Math.sin(shakeTime * 12) * npc.shake * 0.02 
                    + Math.sin(shakeTime * 17) * npc.shake * 0.015;
    camera.rotation.z = rollShake;
}

function updateNPC(dt) {
    if (!navNodes.length) return;
    
    const pos = new THREE.Vector3(
        npc.body.position.x, 
        npc.body.position.y, 
        npc.body.position.z
    );
    
    // Sync debug mesh
    if (npc.mesh) {
        npc.mesh.position.copy(pos);
    }

    // Track movement to detect when we are stuck in place
    const moved = pos.distanceTo(npc.lastPos);
    if (moved < 0.02) {
        npc.stuckTime += dt;
    } else {
        npc.stuckTime = 0;
        npc.lastPos.copy(pos);
    }
    
    // Camera position (eye level - lower when crouching)
    camera.position.copy(pos);
    const standingHeight = 0.5;
    const crouchingHeight = -0.1; // Much lower when crouched
    camera.position.y += THREE.MathUtils.lerp(standingHeight, crouchingHeight, npc.crouchAmount);
    
    // Update panic timer
    if (npc.status === 'PANIC' || npc.status === 'COWERING') {
        npc.panicTimer -= dt;
        if (npc.panicTimer <= 0) {
            if (npc.status === 'COWERING') {
                // Danger "over": stop hiding and flee away from where it happened.
                npc.status = 'PANIC';
                npc.fleeAfterHide = true;
                npc.panicTimer = 5 + Math.random() * 5;
                npc.targetNode = null;
            } else {
                npc.status = 'IDLE';
                npc.fleeAfterHide = false;
                npc.targetNode = null;
            }
        }
    }
    
    // BEHAVIOR STATE MACHINE (each state calls safeLookAt)
    switch (npc.status) {
        case 'PANIC':
            handlePanicState(pos, dt);
            break;
            
        case 'COWERING':
            handleCoweringState(pos, dt);
            break;
            
        case 'LOOKING':
            handleLookingState(pos, dt);
            break;
            
        default:
            handleIdleState(pos, dt);
    }
    
    // Apply the safe camera rotation (never flips!)
    applyCameraRotation();
}

function handlePanicState(pos, dt) {
    // Update UI
    if (window.updateNPCStatus) window.updateNPCStatus(npc.fleeAfterHide ? 'FLEEING' : 'PANIC');

    // Make sure physics wakes up when panicking
    npc.body.wakeUp();
    
    // Keep alert level maxed while panicking
    npc.alertLevel = 1;
    
    // Find safe spot away from danger (considering all remembered dangers)
        if (!npc.targetNode) {
        // Find the most threatening danger position (closest or most recent)
        let primaryDanger = npc.lastDangerPos;
        if (npc.dangerMemory.length > 0) {
            let closestDist = Infinity;
            for (const danger of npc.dangerMemory) {
                const dist = pos.distanceTo(danger.pos);
                if (dist < closestDist) {
                    closestDist = dist;
                    primaryDanger = danger.pos;
                }
            }
        }
        
        npc.targetNode = npc.fleeAfterHide
            ? getFarSafeNode(primaryDanger, pos)
            : getSafeNode(primaryDanger, pos);
        
        // Calculate direction to face when hiding (away from danger)
        if (npc.targetNode) {
            npc.coverDirection.subVectors(npc.targetNode, primaryDanger).normalize();
        }
    }

    // If we've been stuck for a bit, pick a new escape node
    if (npc.stuckTime > 1 && npc.targetNode) {
        npc.targetNode = getSafeNode(npc.lastDangerPos, pos);
        npc.stuckTime = 0;
    }
    
        if (npc.targetNode) {
            const dir = new THREE.Vector3().subVectors(npc.targetNode, pos).normalize();
            
        // Run speed - faster when fleeing, slightly erratic
        const baseSpeed = npc.fleeAfterHide ? 8.5 : 7.5;
        const speedVariation = Math.sin(clock.getElapsedTime() * 8) * 0.5;
        const speed = baseSpeed + speedVariation;
            npc.body.velocity.x = dir.x * speed;
            npc.body.velocity.z = dir.z * speed;
            
        // Add a sideways nudge when we're not making progress to slip around obstacles
        if (npc.stuckTime > 0.4) {
            const sidestep = (Math.random() - 0.5) * 4;
            npc.body.velocity.x += -dir.z * sidestep;
            npc.body.velocity.z += dir.x * sidestep;
        }
        
        // Start crouching as we get closer to cover
        const distToCover = pos.distanceTo(npc.targetNode);
        if (!npc.fleeAfterHide && distToCover < 5) {
            npc.crouchAmount = THREE.MathUtils.lerp(npc.crouchAmount, 0.5, dt * 2);
        } else if (npc.fleeAfterHide) {
            // When fleeing after hiding, stand back up to sprint away.
            npc.crouchAmount = THREE.MathUtils.lerp(npc.crouchAmount, 0.0, dt * 3);
        }
        
        // Frantic looking behavior - checks surroundings more
        let lookTarget;
        const lookRoll = Math.random();
        
        if (lookRoll > 0.88) {
            // Look back at most recent danger
            lookTarget = npc.lastDangerPos.clone();
            lookTarget.y = camera.position.y;
        } else if (lookRoll > 0.80 && npc.dangerMemory.length > 1) {
            // Glance at another remembered danger
            const otherDanger = npc.dangerMemory[Math.floor(Math.random() * npc.dangerMemory.length)];
            lookTarget = otherDanger.pos.clone();
            lookTarget.y = camera.position.y;
        } else if (lookRoll > 0.75) {
            // Quick side glance while running
            const sideAngle = (Math.random() > 0.5 ? 1 : -1) * Math.PI / 3;
            const runAngle = Math.atan2(dir.x, dir.z);
            lookTarget = new THREE.Vector3(
                pos.x + Math.sin(runAngle + sideAngle) * 5,
                camera.position.y,
                pos.z + Math.cos(runAngle + sideAngle) * 5
            );
        } else {
            // Look where running
            lookTarget = new THREE.Vector3(npc.targetNode.x, camera.position.y, npc.targetNode.z);
        }
        
        // Add shake offset to look target - more intense when panicking
        const shakeTime = clock.getElapsedTime();
        const shakeIntensity = npc.fleeAfterHide ? 0.2 : 0.35;
        lookTarget.x += Math.sin(shakeTime * 15) * npc.shake * shakeIntensity;
        lookTarget.z += Math.cos(shakeTime * 13) * npc.shake * shakeIntensity;
        
        // Use safe look (faster smoothing when panicking)
        safeLookAt(lookTarget, 0.18);
        
        // Check arrival at cover
        if (distToCover < 1.5) {
            if (npc.fleeAfterHide) {
                // We've fled to a far spot; resume normal behavior.
                npc.status = 'IDLE';
                npc.fleeAfterHide = false;
                npc.targetNode = null;
                npc.panicTimer = 0;
            } else {
                // Transition to cowering/hiding
                npc.status = 'COWERING';
                npc.targetNode = null;
                npc.panicTimer = 6 + Math.random() * 6;
            }
        }
    }
    
    // High shake
    npc.shake = THREE.MathUtils.lerp(npc.shake, 2.5, dt * 3);
}

function handleCoweringState(pos, dt) {
    // Update UI
    if (window.updateNPCStatus) window.updateNPCStatus('HIDING');
    
    // Keep alert high while hiding
    npc.alertLevel = Math.max(0.7, npc.alertLevel);
    
    // Stop moving - pressed against cover (small trembling movements)
    const tremble = Math.sin(clock.getElapsedTime() * 20) * 0.1;
    npc.body.velocity.x = npc.body.velocity.x * 0.8 + tremble;
    npc.body.velocity.z = npc.body.velocity.z * 0.8 + tremble * 0.5;
    
    // CROUCH DOWN - lower camera significantly
    npc.crouchAmount = THREE.MathUtils.lerp(npc.crouchAmount, 1.0, dt * 3);
    
    // Safety: If coverDirection wasn't set, calculate it now (away from danger)
    if (npc.coverDirection.lengthSq() < 0.01) {
        npc.coverDirection.subVectors(pos, npc.lastDangerPos).normalize();
        // If still zero (danger is at same position), pick random direction
        if (npc.coverDirection.lengthSq() < 0.01) {
            npc.coverDirection.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
        }
    }
    
    const shakeTime = clock.getElapsedTime();
    
    // More dynamic peeking behavior
    let lookTarget;
    const peekPhase = Math.sin(shakeTime * 0.4);
    const nervousGlance = Math.sin(shakeTime * 2.3) > 0.9;
    
    if (peekPhase > 0.6 || nervousGlance) {
        // Peek back at danger - varies which danger we look at
        if (npc.dangerMemory.length > 1 && Math.random() > 0.6) {
            const danger = npc.dangerMemory[Math.floor(Math.random() * npc.dangerMemory.length)];
            lookTarget = danger.pos.clone();
    } else {
            lookTarget = npc.lastDangerPos.clone();
        }
        lookTarget.y = camera.position.y - 0.2;
        
        // Quick nervous peek, not a long stare
        if (nervousGlance) {
            lookTarget.x += (Math.random() - 0.5) * 3;
            lookTarget.z += (Math.random() - 0.5) * 3;
        }
    } else if (peekPhase < -0.5) {
        // Look down at hands/ground (thinking/processing)
        lookTarget = new THREE.Vector3(
            pos.x + npc.coverDirection.x * 0.5,
            camera.position.y - 1.2,
            pos.z + npc.coverDirection.z * 0.5
        );
    } else {
        // Face away from danger / toward wall
        lookTarget = new THREE.Vector3(
            pos.x + npc.coverDirection.x * 3,
            camera.position.y - 0.5,
            pos.z + npc.coverDirection.z * 3
        );
        
        // Small nervous head movements - faster when more dangers remembered
        const nervousness = 1 + npc.dangerMemory.length * 0.3;
        lookTarget.x += Math.sin(shakeTime * 3 * nervousness) * 0.5;
        lookTarget.z += Math.cos(shakeTime * 2.5 * nervousness) * 0.5;
    }
    
    // Add nervous jitter - more intense with more recent dangers
    const jitterIntensity = 0.08 + npc.recentDangerCount * 0.03;
    lookTarget.x += Math.sin(shakeTime * 12) * npc.shake * jitterIntensity;
    lookTarget.z += Math.cos(shakeTime * 13) * npc.shake * jitterIntensity;
    
    // Use safe look - slower when hiding
    safeLookAt(lookTarget, 0.06);
    
    // Trembling intensity based on recent danger count
    const targetShake = 1.0 + npc.recentDangerCount * 0.2;
    npc.shake = THREE.MathUtils.lerp(npc.shake, Math.min(targetShake, 2.0), dt * 2);
}

function handleLookingState(pos, dt) {
    // Update UI
    if (window.updateNPCStatus) window.updateNPCStatus('LOOKING');
    
    // Increase alertness while looking at danger
    npc.alertLevel = Math.min(1, npc.alertLevel + dt * 0.2);
    
    // Stand back up (but slowly, cautiously) - stay lower if very alert
    const targetCrouch = npc.alertLevel > 0.6 ? 0.2 : 0;
    npc.crouchAmount = THREE.MathUtils.lerp(npc.crouchAmount, targetCrouch, dt);
    
    // Stop and look at the chaos - slight backward drift
    npc.body.velocity.x *= 0.92;
    npc.body.velocity.z *= 0.92;
    
    // Subtle backing away if danger is close
    const dangerDist = pos.distanceTo(npc.lastDangerPos);
    if (dangerDist < 10) {
        const awayDir = new THREE.Vector3().subVectors(pos, npc.lastDangerPos).normalize();
        npc.body.velocity.x += awayDir.x * 0.5;
        npc.body.velocity.z += awayDir.z * 0.5;
    }
    
    const shakeTime = clock.getElapsedTime();
    let lookTarget;
    
    // Scan between different danger sources
    const scanPhase = Math.floor(shakeTime * 0.8) % (npc.dangerMemory.length + 1);
    
    if (scanPhase < npc.dangerMemory.length && npc.dangerMemory.length > 0) {
        lookTarget = npc.dangerMemory[scanPhase].pos.clone();
    } else {
        lookTarget = npc.lastDangerPos.clone();
    }
    lookTarget.y = camera.position.y;
    
    // Nervous jitter while watching - more intense with more dangers
    const jitter = 0.1 + npc.dangerMemory.length * 0.05;
    lookTarget.x += Math.sin(shakeTime * 8) * npc.shake * jitter;
    lookTarget.z += Math.cos(shakeTime * 9) * npc.shake * jitter;
    
    // Use safe look
    safeLookAt(lookTarget, 0.1);
    
    // Shake based on proximity to danger
    const targetShake = dangerDist < 15 ? 0.8 : 0.5;
    npc.shake = THREE.MathUtils.lerp(npc.shake, targetShake, dt);
    
    // Decision making - more likely to panic if multiple dangers or close
    const panicChance = 0.008 + npc.dangerMemory.length * 0.004 + (dangerDist < 12 ? 0.01 : 0);
    
    if (Math.random() < panicChance) {
        if (Math.random() > 0.35 || dangerDist < 10) {
            npc.status = 'PANIC';
            npc.panicTimer = 8 + Math.random() * 4;
            npc.targetNode = null;
        } else {
            npc.status = 'IDLE';
        }
    }
}

function handleIdleState(pos, dt) {
    // Update UI - show CAUTIOUS if alert level is high
    if (window.updateNPCStatus) {
        window.updateNPCStatus(npc.alertLevel > 0.3 ? 'CAUTIOUS' : 'IDLE');
    }
    
    // Decay alert level over time
    npc.alertLevel = Math.max(0, npc.alertLevel - dt * 0.05);
    
    // Clean old danger memories (older than 30 seconds)
    const now = Date.now();
    npc.dangerMemory = npc.dangerMemory.filter(d => now - d.time < 30000);
    
    // Breathing animation
    npc.breathingPhase += dt * (1.5 + npc.alertLevel * 2); // Faster when stressed
    
    // Stand back up (slower if nervous)
    const standSpeed = npc.alertLevel > 0.3 ? 1 : 2;
    npc.crouchAmount = THREE.MathUtils.lerp(npc.crouchAmount, 0, dt * standSpeed);
    
    // Wandering behavior changes with alert level
    const changeTargetChance = npc.alertLevel > 0.3 ? 0.99 : 0.997;
    if (!npc.targetNode || Math.random() > changeTargetChance) {
        // When nervous, stay closer / move less predictably
        const searchRadius = npc.alertLevel > 0.3 ? 8 : 15;
        const nearbyNodes = navNodes.filter(n => n.distanceTo(pos) < searchRadius);
        
        // Avoid recent danger zones when picking new targets
        let safeNodes = nearbyNodes;
        if (npc.dangerMemory.length > 0) {
            safeNodes = nearbyNodes.filter(n => {
                for (const danger of npc.dangerMemory) {
                    if (n.distanceTo(danger.pos) < 10) return false;
                }
                return true;
            });
        }
        
        npc.targetNode = safeNodes.length > 0 
            ? safeNodes[Math.floor(Math.random() * safeNodes.length)]
            : (nearbyNodes.length > 0 
                ? nearbyNodes[Math.floor(Math.random() * nearbyNodes.length)]
                : navNodes[Math.floor(Math.random() * navNodes.length)]);
    }
    
    const dir = new THREE.Vector3().subVectors(npc.targetNode, pos).normalize();
    
    // Walking speed varies with nervousness
    const walkSpeed = npc.alertLevel > 0.5 ? 2.8 : (npc.alertLevel > 0.2 ? 2.2 : 1.8);
    npc.body.velocity.x = dir.x * walkSpeed;
    npc.body.velocity.z = dir.z * walkSpeed;
    
    const shakeTime = clock.getElapsedTime();
    let lookTarget;
    
    // Nervous looking around behavior
    const timeSinceLastLook = shakeTime - npc.lastLookAroundTime;
    const lookAroundInterval = npc.alertLevel > 0.3 ? 2 : 5;
    
    if (timeSinceLastLook > lookAroundInterval && Math.random() > 0.95) {
        npc.lastLookAroundTime = shakeTime;
        
        // Look at a remembered danger location or random direction
        if (npc.dangerMemory.length > 0 && Math.random() > 0.4) {
            const danger = npc.dangerMemory[Math.floor(Math.random() * npc.dangerMemory.length)];
            lookTarget = danger.pos.clone();
            lookTarget.y = camera.position.y;
        } else {
            // Random nervous glance
            const glanceAngle = Math.random() * Math.PI * 2;
            lookTarget = new THREE.Vector3(
                pos.x + Math.cos(glanceAngle) * 10,
                camera.position.y + (Math.random() - 0.5) * 0.5,
                pos.z + Math.sin(glanceAngle) * 10
            );
        }
    } else {
        // Normal forward-looking with breathing sway
        const breathSway = Math.sin(npc.breathingPhase) * 0.1 * (1 + npc.alertLevel);
        lookTarget = new THREE.Vector3(
            npc.targetNode.x + Math.sin(shakeTime * 3) * npc.shake * 0.2 + breathSway,
            camera.position.y + 0.3 + Math.sin(npc.breathingPhase * 0.5) * 0.05,
            npc.targetNode.z + Math.cos(shakeTime * 3.5) * npc.shake * 0.2
        );
    }
    
    // Smoothing varies - faster head movement when nervous
    const lookSpeed = npc.alertLevel > 0.3 ? 0.08 : 0.05;
    safeLookAt(lookTarget, lookSpeed);
    
    // Shake increases with nervousness
    const targetShake = 0.15 + npc.alertLevel * 0.4;
    npc.shake = THREE.MathUtils.lerp(npc.shake, targetShake, dt);
}

// --- CHAOS DIRECTOR ---
function scheduleNextEvent() {
    const [min, max] = CONFIG.chaosInterval;
    // Events come faster when NPC is already stressed
    const stressMod = 1 - (npc.alertLevel * 0.3);
    const delay = (Math.random() * (max - min) + min) * stressMod;
    
    setTimeout(() => {
        triggerChaos();
        scheduleNextEvent();
        
        // Chaos chain - sometimes events come in rapid succession
        if (Math.random() < CONFIG.chaosChainChance) {
            setTimeout(() => triggerChaos(), 800 + Math.random() * 1500);
            if (Math.random() < 0.3) {
                setTimeout(() => triggerChaos(), 2000 + Math.random() * 2000);
            }
        }
    }, delay);
}

function triggerChaos() {
    const eventType = Math.random();
    
    if (eventType < 0.20) {
        spawnFlyingCar();
    } else if (eventType < 0.35) {
        spawnExplosion();
    } else if (eventType < 0.50) {
        spawnFallingDebris();
    } else if (eventType < 0.60) {
        activateHelicopterSearch();
    } else if (eventType < 0.72) {
        spawnGunshots();
    } else if (eventType < 0.82) {
        spawnScreaming();
    } else if (eventType < 0.92) {
        spawnCarCrash();
    } else {
        spawnRunningPerson();
    }
    
    // Track danger in NPC memory
    npc.recentDangerCount++;
    setTimeout(() => npc.recentDangerCount = Math.max(0, npc.recentDangerCount - 1), 10000);
    
    console.log("CHAOS EVENT TRIGGERED");
}

function spawnFlyingCar() {
    const carSize = new CANNON.Vec3(1, 0.7, 2);
    const carShape = new CANNON.Box(carSize);
    const carBody = new CANNON.Body({ mass: 1500, shape: carShape });
    
    // Spawn from one end of street
    const startZ = Math.random() > 0.5 ? -40 : 40;
    const direction = startZ > 0 ? -1 : 1;
    
    carBody.position.set(
        (Math.random() - 0.5) * 6,
        0.7 + Math.random() * 2,
        startZ
    );
    
    // Flying velocity
    carBody.velocity.set(
        (Math.random() - 0.5) * 10,
        5 + Math.random() * 8,
        direction * (30 + Math.random() * 20)
    );
    
    // Tumbling
    carBody.angularVelocity.set(
        Math.random() * 5,
        Math.random() * 3,
        Math.random() * 5
    );
    
    // Visual - use GLB model if available, fallback to procedural
    const carGeo = new THREE.BoxGeometry(carSize.x * 2, carSize.y * 2, carSize.z * 2);
    const carMat = new THREE.MeshStandardMaterial({ 
        color: 0x990000,
        metalness: 0.8,
        roughness: 0.3
    });
    
    registerPhysicsObjectWithModel(carBody, 'flyingCar', carGeo, carMat, 8000);
    
    // Play car crash sound
    playSound('carCrash', 0.8);
    
    // NPC reacts
    npc.lastDangerPos.set(carBody.position.x, carBody.position.y, carBody.position.z);
    npc.status = 'PANIC';
    npc.panicTimer = 10;
    npc.targetNode = null;
}

function spawnExplosion() {
    const pos = new THREE.Vector3(
        (Math.random() - 0.5) * CONFIG.streetWidth,
        0,
        (Math.random() - 0.5) * 30
    );
    
    // Play explosion sound
    playSound('explosion', 1.0);
    
    // Spawn multiple debris pieces
    for (let i = 0; i < 8; i++) {
        const size = 0.3 + Math.random() * 0.5;
    const shape = new CANNON.Box(new CANNON.Vec3(size, size, size));
        const body = new CANNON.Body({ mass: 20 + Math.random() * 30, shape });
        
        body.position.set(
            pos.x + (Math.random() - 0.5) * 2,
            0.5,
            pos.z + (Math.random() - 0.5) * 2
        );
        
        // Explosion force
        body.velocity.set(
            (Math.random() - 0.5) * 20,
            10 + Math.random() * 15,
            (Math.random() - 0.5) * 20
        );
        
        body.angularVelocity.set(
            Math.random() * 10,
            Math.random() * 10,
            Math.random() * 10
        );
        
        const geo = new THREE.BoxGeometry(size * 2, size * 2, size * 2);
        const colors = [0xff4400, 0xff6600, 0x333333, 0x222222];
        const mat = new THREE.MeshStandardMaterial({ 
            color: colors[Math.floor(Math.random() * colors.length)],
            emissive: Math.random() > 0.5 ? 0x331100 : 0x000000
        });
        
        registerPhysicsObjectWithModel(body, 'explosionDebris', geo, mat, 6000, 0.5 + Math.random() * 0.5);
    }
    
    // Flash effect
    const flash = new THREE.PointLight(0xff6600, 50, 30);
    flash.position.copy(pos);
    flash.position.y = 2;
    scene.add(flash);
    
    // Fade out flash
    const fadeFlash = () => {
        flash.intensity *= 0.85;
        if (flash.intensity > 0.1) {
            requestAnimationFrame(fadeFlash);
        } else {
            scene.remove(flash);
        }
    };
    fadeFlash();
    
    // NPC reacts
    npc.lastDangerPos.copy(pos);
    npc.status = 'PANIC';
    npc.panicTimer = 12;
    npc.targetNode = null;
}

function spawnFallingDebris() {
    const count = 3 + Math.floor(Math.random() * 4);
    
    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const size = 0.5 + Math.random() * 1.5;
            const shape = new CANNON.Box(new CANNON.Vec3(size / 2, size / 2, size / 2));
            const body = new CANNON.Body({ mass: 50 + Math.random() * 100, shape });
            
            const spawnX = npc.body.position.x + (Math.random() - 0.5) * 15;
            const spawnZ = npc.body.position.z + (Math.random() - 0.5) * 15;
            body.position.set(spawnX, 20 + Math.random() * 10, spawnZ);
            
            body.angularVelocity.set(
                Math.random() * 3,
                Math.random() * 3,
                Math.random() * 3
            );
            
            const geo = new THREE.BoxGeometry(size, size, size);
            const mat = new THREE.MeshStandardMaterial({ 
                color: 0x555555,
                roughness: 0.9
            });
            
            registerPhysicsObjectWithModel(body, 'debris', geo, mat, 8000, size * 0.5);
            
            // Play debris sound when spawned
            playSound('debris', 0.5 + Math.random() * 0.3);
        }, i * 300);
    }
    
    // NPC reaction - look up first, then panic
    npc.lastDangerPos.set(npc.body.position.x, 20, npc.body.position.z);
    npc.status = 'LOOKING';
    
    setTimeout(() => {
        if (npc.status === 'LOOKING') {
            npc.status = 'PANIC';
            npc.panicTimer = 8;
            npc.targetNode = null;
        }
    }, 1000);
}

function activateHelicopterSearch() {
    const heliLight = scene.getObjectByName('heliLight');
    if (!heliLight) return;
    
    heliLight.intensity = 100;
    
    // Play helicopter sound (looped)
    const heliSound = playSound('helicopter', 0.6, true);
    
    // Sweep the searchlight
    let angle = 0;
    const radius = 15;
    const sweep = setInterval(() => {
        angle += 0.05;
        heliLight.target.position.set(
            Math.sin(angle) * radius,
            0,
            Math.cos(angle) * radius
        );
        
        // Check if light is near NPC
        const npcPos = new THREE.Vector3(npc.body.position.x, 0, npc.body.position.z);
        const lightPos = heliLight.target.position;
        
        if (npcPos.distanceTo(lightPos) < 5 && npc.status === 'IDLE') {
            npc.status = 'COWERING';
            npc.panicTimer = 3;
            npc.lastDangerPos.copy(lightPos);
            
            // Calculate cover direction (away from the light)
            npc.coverDirection.subVectors(npcPos, lightPos).normalize();
        }
    }, 50);
    
    // Turn off after duration
    setTimeout(() => {
        clearInterval(sweep);
        heliLight.intensity = 0;
        stopSound(heliSound);
    }, 8000);
    
    npc.status = 'LOOKING';
    npc.lastDangerPos.set(0, 0, 0);
}

function spawnGunshots() {
    // Muzzle flashes from a random direction
    const angle = Math.random() * Math.PI * 2;
    const distance = 15 + Math.random() * 20;
    const shotPos = new THREE.Vector3(
        npc.body.position.x + Math.cos(angle) * distance,
        1 + Math.random() * 2,
        npc.body.position.z + Math.sin(angle) * distance
    );
    
    const shotCount = 3 + Math.floor(Math.random() * 5);
    
    for (let i = 0; i < shotCount; i++) {
        setTimeout(() => {
            // Muzzle flash light
            const flash = new THREE.PointLight(0xffaa00, 30, 15);
            flash.position.copy(shotPos);
            flash.position.x += (Math.random() - 0.5) * 2;
            flash.position.z += (Math.random() - 0.5) * 2;
            scene.add(flash);
            
            // Optional: Add muzzle flash model
            const muzzleModel = loadedModels['muzzleFlash'];
            if (muzzleModel) {
                const muzzle = muzzleModel.clone();
                muzzle.position.copy(flash.position);
                muzzle.scale.setScalar(0.5);
                scene.add(muzzle);
                setTimeout(() => scene.remove(muzzle), 50);
            }
            
            // Play gunshot sound
            playSound('gunshot', 0.7 + Math.random() * 0.3);
            
            setTimeout(() => scene.remove(flash), 50 + Math.random() * 50);
        }, i * (100 + Math.random() * 150));
    }
    
    // NPC immediately ducks and panics
    npc.lastDangerPos.copy(shotPos);
    npc.alertLevel = Math.min(1, npc.alertLevel + 0.4);
    
    // Play gasp sound
    playSound('gasp', 0.6);
    
    if (npc.status === 'IDLE' || npc.status === 'CAUTIOUS') {
        npc.status = 'PANIC';
        npc.panicTimer = 8 + Math.random() * 6;
        npc.targetNode = null;
    } else if (npc.status === 'COWERING') {
        // Stay down longer if already hiding
        npc.panicTimer += 4;
    }
    
    // Add to danger memory
    npc.dangerMemory.push({ pos: shotPos.clone(), time: Date.now(), type: 'gunshots' });
    if (npc.dangerMemory.length > 5) npc.dangerMemory.shift();
}

function spawnScreaming() {
    // Someone screaming nearby - NPC looks around nervously
    const angle = Math.random() * Math.PI * 2;
    const distance = 8 + Math.random() * 15;
    const screamPos = new THREE.Vector3(
        npc.body.position.x + Math.cos(angle) * distance,
        1,
        npc.body.position.z + Math.sin(angle) * distance
    );
    
    // Play scream sound
    playSound('scream', 0.7 + Math.random() * 0.3);
    
    npc.lastDangerPos.copy(screamPos);
    npc.alertLevel = Math.min(1, npc.alertLevel + 0.25);
    
    if (npc.status === 'IDLE') {
        // Look toward the scream, might panic
        npc.status = 'LOOKING';
        npc.panicTimer = 3;
        
        setTimeout(() => {
            if (npc.status === 'LOOKING' && Math.random() > 0.4) {
                npc.status = 'PANIC';
                npc.panicTimer = 6 + Math.random() * 4;
                npc.targetNode = null;
            }
        }, 1500);
    }
    
    npc.dangerMemory.push({ pos: screamPos.clone(), time: Date.now(), type: 'scream' });
    if (npc.dangerMemory.length > 5) npc.dangerMemory.shift();
}

function spawnCarCrash() {
    // Two cars colliding on the street
    const crashZ = (Math.random() - 0.5) * 40;
    const crashPos = new THREE.Vector3(0, 0.5, crashZ);
    
    // Play car crash sound
    playSound('carCrash', 1.0);
    
    // Spawn crashed car debris
    for (let i = 0; i < 6; i++) {
        const size = 0.4 + Math.random() * 0.8;
        const shape = new CANNON.Box(new CANNON.Vec3(size, size * 0.5, size));
        const body = new CANNON.Body({ mass: 100 + Math.random() * 200, shape });
        
        body.position.set(
            crashPos.x + (Math.random() - 0.5) * 4,
            0.5 + Math.random(),
            crashPos.z + (Math.random() - 0.5) * 4
        );
        
        body.velocity.set(
            (Math.random() - 0.5) * 15,
            3 + Math.random() * 8,
            (Math.random() - 0.5) * 15
        );
        
        body.angularVelocity.set(
            Math.random() * 8,
            Math.random() * 8,
            Math.random() * 8
        );
        
        const geo = new THREE.BoxGeometry(size * 2, size, size * 2);
        const colors = [0x222222, 0x333344, 0x880000, 0x004488];
        const mat = new THREE.MeshStandardMaterial({ 
            color: colors[Math.floor(Math.random() * colors.length)],
            metalness: 0.7,
            roughness: 0.4
        });
        
        registerPhysicsObjectWithModel(body, 'crashedCar', geo, mat, 10000, size);
    }
    
    // Bright flash from impact
    const flash = new THREE.PointLight(0xffffaa, 80, 40);
    flash.position.copy(crashPos);
    flash.position.y = 2;
    scene.add(flash);
    
    const fadeFlash = () => {
        flash.intensity *= 0.8;
        if (flash.intensity > 0.1) {
            requestAnimationFrame(fadeFlash);
        } else {
            scene.remove(flash);
        }
    };
    fadeFlash();
    
    // NPC reacts strongly
    npc.lastDangerPos.copy(crashPos);
    npc.alertLevel = Math.min(1, npc.alertLevel + 0.5);
    npc.status = 'PANIC';
    npc.panicTimer = 10 + Math.random() * 5;
    npc.targetNode = null;
    
    npc.dangerMemory.push({ pos: crashPos.clone(), time: Date.now(), type: 'crash' });
    if (npc.dangerMemory.length > 5) npc.dangerMemory.shift();
}

function spawnRunningPerson() {
    // Someone running past - makes NPC nervous
    const startSide = Math.random() > 0.5 ? -1 : 1;
    const runnerZ = npc.body.position.z + (Math.random() - 0.5) * 20;
    
    // Visual: Use GLB model if available, fallback to capsule
    let runner;
    const runnerModel = loadedModels['npcRunner'];
    if (runnerModel) {
        runner = runnerModel.clone();
        runner.scale.setScalar(1);
    } else {
        const runnerGeo = new THREE.CapsuleGeometry(0.3, 1.2, 4, 8);
        const runnerMat = new THREE.MeshStandardMaterial({ color: 0x111111 });
        runner = new THREE.Mesh(runnerGeo, runnerMat);
    }
    runner.position.set(startSide * 25, 1, runnerZ);
    runner.castShadow = true;
    scene.add(runner);
    
    // Play footsteps sound
    const footstepsSound = playSound('footsteps', 0.4, true);
    
    const runSpeed = 12 + Math.random() * 5;
    const direction = -startSide;
    
    const animateRunner = () => {
        runner.position.x += direction * runSpeed * 0.016;
        runner.position.y = 1 + Math.sin(Date.now() * 0.02) * 0.1; // Bobbing
        runner.rotation.y = direction > 0 ? Math.PI / 2 : -Math.PI / 2;
        
        if (Math.abs(runner.position.x) < 30) {
            requestAnimationFrame(animateRunner);
        } else {
            scene.remove(runner);
            stopSound(footstepsSound);
        }
    };
    animateRunner();
    
    // NPC notices and gets nervous
    const runnerPos = new THREE.Vector3(0, 1, runnerZ);
    npc.lastDangerPos.copy(runnerPos);
    npc.alertLevel = Math.min(1, npc.alertLevel + 0.15);
    
    if (npc.status === 'IDLE') {
        npc.status = 'LOOKING';
        npc.panicTimer = 2;
        
        // Might start running too
        setTimeout(() => {
            if (npc.status === 'LOOKING' && Math.random() > 0.6) {
                npc.status = 'PANIC';
                npc.panicTimer = 5;
                npc.targetNode = null;
            }
        }, 1000);
    }
}

// --- PHYSICS OBJECT MANAGEMENT ---

// Register physics object with optional GLB model support
function registerPhysicsObjectWithModel(body, modelKey, fallbackGeo, fallbackMat, lifetime = 10000, modelScale = 1) {
    world.addBody(body);
    
    // Try to use loaded GLB model, fallback to procedural mesh
    const model = loadedModels[modelKey];
    let mesh;
    
    if (model) {
        mesh = model.clone();
        mesh.scale.setScalar(modelScale);
        mesh.traverse(child => {
            if (child.isMesh) {
                child.castShadow = true;
                child.receiveShadow = true;
            }
        });
    } else {
        mesh = new THREE.Mesh(fallbackGeo, fallbackMat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
    }
    
    scene.add(mesh);
    
    const index = physicsBodies.length;
    physicsBodies.push(body);
    physicsMeshes.push(mesh);
    
    // Cleanup after lifetime
    setTimeout(() => {
        world.removeBody(body);
        scene.remove(mesh);
        physicsBodies[index] = null;
        physicsMeshes[index] = null;
    }, lifetime);
}

function registerPhysicsObject(body, geometry, material, lifetime = 10000) {
    world.addBody(body);
    
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    
    const index = physicsBodies.length;
    physicsBodies.push(body);
    physicsMeshes.push(mesh);
    
    // Cleanup with proper array management
    setTimeout(() => {
        world.removeBody(body);
        scene.remove(mesh);
        geometry.dispose();
        material.dispose();
        
        // Mark as null for cleanup
        const idx = physicsBodies.indexOf(body);
        if (idx !== -1) {
            physicsBodies[idx] = null;
            physicsMeshes[idx] = null;
        }
    }, lifetime);
}

// Periodic cleanup of null entries
setInterval(() => {
    physicsBodies = physicsBodies.filter(b => b !== null);
    physicsMeshes = physicsMeshes.filter(m => m !== null);
}, 5000);

// --- UI UPDATES ---
function updateTimestamp() {
    const elapsed = Date.now() - startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    const frames = Math.floor((elapsed % 1000) / 33);
    
    const pad = n => String(n).padStart(2, '0');
    document.getElementById('timestamp').textContent = 
        `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

// --- RENDER LOOP ---
function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1); // Cap delta to prevent physics explosions

    // Physics step
    world.step(1 / 60, dt, 3);

    // Sync physics visuals (skip nulls)
    for (let i = 0; i < physicsBodies.length; i++) {
        if (physicsBodies[i] && physicsMeshes[i]) {
        physicsMeshes[i].position.copy(physicsBodies[i].position);
        physicsMeshes[i].quaternion.copy(physicsBodies[i].quaternion);
        }
    }

    updateNPC(dt);

    // Update shader
    bodyCamPass.uniforms['time'].value = clock.getElapsedTime();
    
    composer.render();
}

// --- EVENT HANDLERS ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
});

// Prevent context menu on right click
window.addEventListener('contextmenu', e => e.preventDefault());
