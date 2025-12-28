/**
 * NPC BODYCAM POST-PROCESSING SHADER
 * Creates authentic bodycam footage aesthetic:
 * - Barrel distortion (fish-eye lens)
 * - Chromatic aberration (cheap sensor RGB split)
 * - Film grain & noise
 * - Interlacing artifacts
 * - Heavy vignette
 * - IR/Night vision color grading
 */
export const BodyCamShader = {
    uniforms: {
        'tDiffuse': { value: null },
        'time': { value: 0.0 },
        'intensity': { value: 1.0 },
        'distortion': { value: 0.3 },
        'aberration': { value: 0.0015 }
    },

    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `,

    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float time;
        uniform float intensity;
        uniform float distortion;
        uniform float aberration;
        varying vec2 vUv;

        // High-quality noise
        float hash(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
        }
        
        float noise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            
            float a = hash(i);
            float b = hash(i + vec2(1.0, 0.0));
            float c = hash(i + vec2(0.0, 1.0));
            float d = hash(i + vec2(1.0, 1.0));
            
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }

        void main() {
            vec2 uv = vUv;
            vec2 center = uv - 0.5;
            float dist = length(center);
            
            // === 1. BARREL DISTORTION (Fish-eye) ===
            float distortionAmount = dist * dist * distortion;
            vec2 distortedUv = uv + center * distortionAmount * 0.5;
            
            // Clamp to prevent edge artifacts
            if (distortedUv.x < 0.0 || distortedUv.x > 1.0 || 
                distortedUv.y < 0.0 || distortedUv.y > 1.0) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            // === 2. CHROMATIC ABERRATION ===
            // Subtle increase toward edges like real cheap lenses
            float chromaStrength = aberration * (1.0 + dist * 3.0);
            vec2 redOffset = vec2(chromaStrength, 0.0);
            vec2 blueOffset = vec2(-chromaStrength, 0.0);
            
            float r = texture2D(tDiffuse, distortedUv + redOffset).r;
            float g = texture2D(tDiffuse, distortedUv).g;
            float b = texture2D(tDiffuse, distortedUv + blueOffset).b;
            
            vec3 color = vec3(r, g, b);

            // === 3. INTERLACING / SCANLINES ===
            float scanline = sin(uv.y * 400.0) * 0.015;
            float interlace = step(0.5, fract(uv.y * 200.0 + time * 0.5)) * 0.01;
            color -= scanline + interlace;

            // === 4. TEMPORAL NOISE / GRAIN ===
            float grainTime = floor(time * 24.0) / 24.0; // 24fps grain
            float grain = (noise(uv * 500.0 + grainTime * 100.0) - 0.5) * 0.06;
            color += grain;
            
            // Occasional horizontal glitch lines
            float glitchLine = step(0.998, noise(vec2(time * 2.0, floor(uv.y * 50.0))));
            color += glitchLine * vec3(0.05, 0.025, 0.0);

            // === 5. COMPRESSION ARTIFACTS ===
            // Subtle blockiness
            vec2 blockUv = floor(uv * 120.0) / 120.0;
            float block = noise(blockUv + floor(time)) * 0.02;
            color += block;

            // === 6. VIGNETTE ===
            // Moderate vignette like bodycam housing
            float vignette = 1.0 - smoothstep(0.4, 1.0, dist * 1.2);
            vignette = pow(vignette, 1.2);
            color *= vignette;

            // === 7. COLOR GRADING ===
            // Slight desaturation for bodycam look
            float luma = dot(color, vec3(0.299, 0.587, 0.114));
            color = mix(color, vec3(luma), 0.25); // Partial desaturation
            
            // Slight warm tint
            color.r *= 1.02;
            color.b *= 0.98;
            
            // Lift shadows slightly for visibility
            color = smoothstep(vec3(-0.1), vec3(1.05), color);
            
            // === 8. TIMESTAMP BURN-IN SIMULATION ===
            // Slight brightness variation to simulate old CCD sensor
            float sensorNoise = sin(time * 60.0) * 0.01 + sin(time * 120.0) * 0.005;
            color += sensorNoise;

            // === 9. EDGE DARKENING (lens housing) ===
            float edgeDark = smoothstep(0.5, 0.65, dist);
            color *= 1.0 - edgeDark * 0.2;

            gl_FragColor = vec4(color, 1.0);
        }
    `
};
