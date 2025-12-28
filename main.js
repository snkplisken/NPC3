import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BodyCamShader } from './BodyCamShader.js';

// --- CONFIGURATION ---
const CONFIG = {
    streetLength: 60,
    streetWidth: 12,
    sidewalkWidth: 4,
    buildingCount: 8,
    chaosInterval: [15000, 30000], // Random interval between events
    showDebug: false
};

// --- GLOBALS ---
let scene, camera, renderer, composer, bodyCamPass;
let world, clock = new THREE.Clock();
let physicsBodies = [], physicsMeshes = [];
let startTime = Date.now();

// NPC AI STATE MACHINE
let npc = {
    body: null,
    mesh: null,
    status: 'IDLE', // IDLE, PANIC, COWERING, LOOKING
    targetNode: null,
    shake: 0,
    baseRotation: new THREE.Euler(),
    panicTimer: 0,
    lastDangerPos: new THREE.Vector3()
};

// NAVIGATION
let navNodes = [];
let coverSpots = []; // Special spots to hide

// CHAOS TRACKING
let activeChaosSources = [];

// --- INITIALIZATION ---
init();
animate();

function init() {
    // 1. SCENE SETUP
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.FogExp2(0x0a0a12, 0.018); // Less dense fog

    // High FOV + slight offset for bodycam aesthetic
    camera = new THREE.PerspectiveCamera(95, window.innerWidth / window.innerHeight, 0.1, 150);
    
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Cap for performance
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.8; // Brighter exposure
    document.body.appendChild(renderer.domElement);

    // 2. PHYSICS WORLD
    world = new CANNON.World();
    world.gravity.set(0, -20, 0); // Slightly stronger for snappier feel
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;

    // Ground plane
    const groundBody = new CANNON.Body({ 
        type: CANNON.Body.STATIC, 
        shape: new CANNON.Plane() 
    });
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(groundBody);

    // 3. CREATE NPC
    createNPC();

    // 4. BUILD PROCEDURAL ENVIRONMENT
    buildStreetEnvironment();
    buildNavigationGrid();

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
    
    // Hide loading
    document.getElementById('loading').style.display = 'none';
}

// --- NPC CREATION ---
function createNPC() {
    const sphereShape = new CANNON.Sphere(0.35);
    npc.body = new CANNON.Body({ 
        mass: 70, 
        shape: sphereShape,
        angularDamping: 0.99,
        linearDamping: 0.4
    });
    npc.body.position.set(0, 1, 0);
    world.addBody(npc.body);
    
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
function getSafeNode(dangerPos) {
    // Prioritize cover spots when panicking
    const safeCover = coverSpots.filter(spot => spot.distanceTo(dangerPos) > 12);
    if (safeCover.length > 0 && Math.random() > 0.3) {
        return safeCover[Math.floor(Math.random() * safeCover.length)];
    }
    
    // Otherwise find distant nav node
    const safeNodes = navNodes.filter(node => node.distanceTo(dangerPos) > 15);
    
    if (safeNodes.length === 0) {
        let furthest = navNodes[0];
        let maxDist = 0;
        for (const n of navNodes) {
            const d = n.distanceTo(dangerPos);
            if (d > maxDist) { maxDist = d; furthest = n; }
        }
        return furthest;
    }
    
    return safeNodes[Math.floor(Math.random() * safeNodes.length)];
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
    
    // Camera position (eye level)
    camera.position.copy(pos);
    camera.position.y += 0.5;
    
    // Ensure camera stays upright
    camera.up.set(0, 1, 0);
    
    // Update panic timer
    if (npc.status === 'PANIC' || npc.status === 'COWERING') {
        npc.panicTimer -= dt;
        if (npc.panicTimer <= 0) {
            npc.status = 'IDLE';
            npc.targetNode = null;
        }
    }
    
    // BEHAVIOR STATE MACHINE
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
    
    // Apply camera shake (only roll for bodycam feel, no pitch/yaw modification)
    const shakeTime = clock.getElapsedTime();
    const rollShake = Math.sin(shakeTime * 12) * npc.shake * 0.02 
                    + Math.sin(shakeTime * 17) * npc.shake * 0.015;
    camera.rotation.z = rollShake;
}

function handlePanicState(pos, dt) {
    // Update UI
    if (window.updateNPCStatus) window.updateNPCStatus('PANIC');
    
    // Find safe spot away from danger
    if (!npc.targetNode) {
        npc.targetNode = getSafeNode(npc.lastDangerPos);
    }
    
    if (npc.targetNode) {
        const dir = new THREE.Vector3().subVectors(npc.targetNode, pos).normalize();
        
        // Run speed
        const speed = 7.5;
        npc.body.velocity.x = dir.x * speed;
        npc.body.velocity.z = dir.z * speed;
        
        // Look back at danger occasionally
        let lookTarget;
        if (Math.random() > 0.95) {
            lookTarget = npc.lastDangerPos.clone();
        } else {
            lookTarget = new THREE.Vector3(npc.targetNode.x, camera.position.y, npc.targetNode.z);
        }
        
        // Add shake offset to look target
        const shakeTime = clock.getElapsedTime();
        lookTarget.x += Math.sin(shakeTime * 15) * npc.shake * 0.3;
        lookTarget.y = camera.position.y + Math.sin(shakeTime * 12) * npc.shake * 0.15;
        lookTarget.z += Math.cos(shakeTime * 13) * npc.shake * 0.3;
        
        camera.lookAt(lookTarget);
        
        // Check arrival
        if (pos.distanceTo(npc.targetNode) < 2) {
            // Transition to cowering
            npc.status = 'COWERING';
            npc.targetNode = null;
            npc.panicTimer = 5 + Math.random() * 5;
        }
    }
    
    // High shake
    npc.shake = THREE.MathUtils.lerp(npc.shake, 2.5, dt * 3);
}

function handleCoweringState(pos, dt) {
    // Update UI
    if (window.updateNPCStatus) window.updateNPCStatus('COWERING');
    
    // Stop moving, look around nervously
    npc.body.velocity.x *= 0.9;
    npc.body.velocity.z *= 0.9;
    
    // Nervous looking around
    const shakeTime = clock.getElapsedTime();
    const lookTarget = new THREE.Vector3(
        pos.x + Math.sin(shakeTime * 2) * 5,
        camera.position.y + Math.sin(shakeTime * 3) * npc.shake * 0.1,
        pos.z + Math.cos(shakeTime * 1.5) * 5
    );
    
    // Add jitter
    lookTarget.x += Math.sin(shakeTime * 10) * npc.shake * 0.15;
    lookTarget.z += Math.cos(shakeTime * 11) * npc.shake * 0.15;
    
    camera.lookAt(lookTarget);
    
    // Moderate shake
    npc.shake = THREE.MathUtils.lerp(npc.shake, 1.2, dt * 2);
}

function handleLookingState(pos, dt) {
    // Update UI
    if (window.updateNPCStatus) window.updateNPCStatus('LOOKING');
    
    // Stop and look at the chaos
    npc.body.velocity.x *= 0.95;
    npc.body.velocity.z *= 0.95;
    
    // Look toward last danger with subtle shake
    const shakeTime = clock.getElapsedTime();
    const lookTarget = npc.lastDangerPos.clone();
    lookTarget.y = camera.position.y;
    
    // Subtle nervous jitter while watching
    lookTarget.x += Math.sin(shakeTime * 8) * npc.shake * 0.1;
    lookTarget.z += Math.cos(shakeTime * 9) * npc.shake * 0.1;
    
    camera.lookAt(lookTarget);
    
    npc.shake = THREE.MathUtils.lerp(npc.shake, 0.5, dt);
    
    // After a bit, decide to run or keep watching
    if (Math.random() < 0.01) {
        if (Math.random() > 0.5) {
            npc.status = 'PANIC';
            npc.panicTimer = 8;
        } else {
            npc.status = 'IDLE';
        }
    }
}

function handleIdleState(pos, dt) {
    // Update UI
    if (window.updateNPCStatus) window.updateNPCStatus('IDLE');
    
    // Wandering - waiting for the bus
    if (!npc.targetNode || Math.random() > 0.997) {
        // Pick nearby node
        const nearbyNodes = navNodes.filter(n => n.distanceTo(pos) < 15);
        npc.targetNode = nearbyNodes.length > 0 
            ? nearbyNodes[Math.floor(Math.random() * nearbyNodes.length)]
            : navNodes[Math.floor(Math.random() * navNodes.length)];
    }
    
    const dir = new THREE.Vector3().subVectors(npc.targetNode, pos).normalize();
    
    // Slow walk
    npc.body.velocity.x = dir.x * 1.8;
    npc.body.velocity.z = dir.z * 1.8;
    
    // Look where walking with subtle body sway
    const shakeTime = clock.getElapsedTime();
    const lookTarget = new THREE.Vector3(
        npc.targetNode.x + Math.sin(shakeTime * 3) * npc.shake * 0.2,
        camera.position.y + Math.sin(shakeTime * 4) * npc.shake * 0.05,
        npc.targetNode.z + Math.cos(shakeTime * 3.5) * npc.shake * 0.2
    );
    camera.lookAt(lookTarget);
    
    // Subtle body cam shake
    npc.shake = THREE.MathUtils.lerp(npc.shake, 0.15, dt);
}

// --- CHAOS DIRECTOR ---
function scheduleNextEvent() {
    const [min, max] = CONFIG.chaosInterval;
    const delay = Math.random() * (max - min) + min;
    
    setTimeout(() => {
        triggerChaos();
        scheduleNextEvent();
    }, delay);
}

function triggerChaos() {
    const eventType = Math.random();
    
    if (eventType < 0.35) {
        spawnFlyingCar();
    } else if (eventType < 0.6) {
        spawnExplosion();
    } else if (eventType < 0.8) {
        spawnFallingDebris();
    } else {
        activateHelicopterSearch();
    }
    
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
    
    // Visual
    const carGeo = new THREE.BoxGeometry(carSize.x * 2, carSize.y * 2, carSize.z * 2);
    const carMat = new THREE.MeshStandardMaterial({ 
        color: 0x990000,
        metalness: 0.8,
        roughness: 0.3
    });
    
    registerPhysicsObject(carBody, carGeo, carMat, 8000);
    
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
        
        registerPhysicsObject(body, geo, mat, 6000);
    }
    
    // Flash effect
    const flash = new THREE.PointLight(0xff6600, 50, 30);
    flash.position.copy(pos);
    flash.position.y = 2;
    scene.add(flash);
    
    // Fade out flash
    const startIntensity = 50;
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
            
            registerPhysicsObject(body, geo, mat, 8000);
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
        }
    }, 50);
    
    // Turn off after duration
    setTimeout(() => {
        clearInterval(sweep);
        heliLight.intensity = 0;
    }, 8000);
    
    npc.status = 'LOOKING';
    npc.lastDangerPos.set(0, 0, 0);
}

// --- PHYSICS OBJECT MANAGEMENT ---
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
