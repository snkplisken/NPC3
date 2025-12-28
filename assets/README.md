# Assets Folder

Place your custom GLB models and sounds here. The game will automatically use them if found, otherwise it falls back to procedural meshes (no sounds will play if not provided).

## Folder Structure

```
assets/
├── models/
│   ├── building_tall.glb
│   ├── building_medium.glb
│   ├── building_short.glb
│   ├── bus_stop.glb
│   ├── street_light.glb
│   ├── sidewalk.glb
│   ├── road.glb
│   ├── car_parked.glb
│   ├── car_flying.glb
│   ├── car_crashed.glb
│   ├── npc_main.glb          # The bodycam wearer (optional)
│   ├── npc_runner.glb        # Panicked running person
│   ├── npc_civilian.glb
│   ├── debris.glb
│   ├── muzzle_flash.glb
│   └── explosion_debris.glb
│
└── sounds/
    ├── city_ambience.mp3
    ├── wind.mp3
    ├── gunshot.mp3
    ├── explosion.mp3
    ├── car_crash.mp3
    ├── scream.mp3
    ├── helicopter.mp3
    ├── debris_fall.mp3
    ├── breathing_heavy.mp3
    ├── footsteps_run.mp3
    └── gasp.mp3
```

## Model Guidelines

- **Scale**: Models should be exported at real-world scale (1 unit = 1 meter)
- **Origin**: Center the model at the origin, with Y-up
- **Format**: GLB (binary glTF) is preferred for smaller file sizes
- **Materials**: PBR materials are supported

## Sound Guidelines

- **Format**: MP3 or WAV
- **Channels**: Mono or Stereo
- **Sample Rate**: 44.1kHz recommended

## Customizing Asset Paths

Edit the `ASSETS` object in `main.js` to change file paths:

```javascript
const ASSETS = {
    models: {
        flyingCar: 'models/my_custom_car.glb',
        // ... etc
    },
    sounds: {
        gunshot: 'sounds/my_gunshot.mp3',
        // ... etc
    }
};
```

## Privacy Note

This `assets/` folder is gitignored by default to keep your custom assets private. Add a `.gitignore` in this folder if needed.

